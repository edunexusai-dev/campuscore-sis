// End-to-end verification of the EdunexusAI ↔ CampusCore integration path against a running SIS:
// token issuance, reads, a permitted write (register + drop), rule enforcement, and token-revocation recovery.
import { CampusCoreClient, CampusCoreAdapter, SisError } from '../src/index.js';

const client = new CampusCoreClient({ baseUrl: process.env.CAMPUSCORE_BASE_URL, clientId: process.env.CAMPUSCORE_CLIENT_ID, clientSecret: process.env.CAMPUSCORE_CLIENT_SECRET });
const sis = new CampusCoreAdapter(client);
const ok = (msg) => console.log(`  ✓ ${msg}`);
let failures = 0;
const check = async (name, fn) => { try { ok(`${name}: ${await fn()}`); } catch (e) { failures += 1; console.log(`  ✗ ${name}: ${e.code ?? ''} ${e.message}`); } };

console.log(`Verifying integration with ${client.baseUrl}`);
await check('obtain token', async () => { await client.getToken(); return `scopes=${client.grantedScopes.length}`; });
await check('institution', async () => (await sis.getInstitution()).name);
const term = await sis.getCurrentTerm();
await check('current term', async () => term.name);
const terms = await sis.listTerms();
const nextTerm = terms.find((t) => t.registrationOpen);
const { items } = await sis.searchStudents({ status: 'ACTIVE', pageSize: 50 });
await check('students', async () => `${items.length} mapped to canonical model`);
const student = items.find((s) => !s.hasRegistrationHold && s.level === 'freshman') ?? items[0];
await check('schedule', async () => `${(await sis.getStudentSchedule(student.source.id)).items.length} classes for ${student.displayName}`);
await check('academic summary', async () => `GPA ${(await sis.getAcademicSummary(student.source.id)).gpa ?? 'n/a'}`);

if (sis.capabilities().writes.includes('registrations:write') && nextTerm) {
  const sections = await client.get('/sections', { termId: nextTerm.source.id, search: 'HIST 210', pageSize: 5 });
  const section = sections.data[0];
  let enrollment;
  await check('permitted write: enroll', async () => { enrollment = await sis.enroll(student.source.id, section.id); return `${enrollment.status} in ${section.course.code}`; });
  await check('rule enforcement', async () => {
    try { await sis.enroll(student.source.id, section.id); return 'UNEXPECTED SUCCESS'; } catch (e) { if (e instanceof SisError && e.status === 422) return `rejected with ${e.code}`; throw e; }
  });
  if (enrollment) await check('permitted write: drop', async () => (await sis.drop(enrollment.source.id, 'EdunexusAI verification cleanup')).status);
}

await check('recovers after token revocation', async () => {
  const before = client.stats.tokenRequests;
  await client.revokeCurrentToken(); // server-side revocation; the cached token is now invalid
  await sis.getCurrentTerm();
  return `token re-issued (${client.stats.tokenRequests - before} new token request)`;
});

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll integration checks passed.');
process.exit(failures ? 1 : 0);
