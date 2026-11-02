// Live end-to-end verification of the Feddrick ↔ EdunexusAI integration path against a RUNNING CampusCore.
// Uses only fictional test data:
//  - creates a dedicated "E2E verification" integration client (revoked at the end),
//  - creates ONE fictional student "E2E Verification <timestamp>" (left WITHDRAWN; nothing is hard-deleted),
//  - creates identity links for fictional external accounts "e2e-…" (revoked at the end, history kept),
//  - temporarily enables the student/identity write policies and restores their previous values afterwards.
// Requires admin credentials for the CampusCore portal (to create the test client and toggle policies):
//   CAMPUSCORE_BASE_URL, CAMPUSCORE_ADMIN_EMAIL, CAMPUSCORE_ADMIN_PASSWORD
import crypto from 'node:crypto';
import { CampusCoreAdapter, SisPortalService, SisError } from '../src/index.js';

const BASE = (process.env.CAMPUSCORE_BASE_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const EXPECTED = process.env.CAMPUSCORE_EXPECTED_INSTITUTION ?? 'feddrick';
const results = [];
const check = async (name, fn) => {
  try { const r = await fn(); results.push(['✓', name, r]); console.log(`  ✓ ${name}${r ? `: ${r}` : ''}`); }
  catch (e) { results.push(['✗', name, e.message]); console.log(`  ✗ ${name}: ${e.code ?? ''} ${e.message}`); }
};
const expectError = async (p, code) => { try { await p; } catch (e) { if (e.code === code) return `rejected with ${code}`; throw new Error(`expected ${code}, got ${e.code} ${e.message}`); } throw new Error(`expected ${code}, but the call succeeded`); };

// Minimal portal-session helper (cookie + CSRF) for the admin setup steps.
async function adminSession() {
  const r = await fetch(`${BASE}/api/app/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.CAMPUSCORE_ADMIN_EMAIL, password: process.env.CAMPUSCORE_ADMIN_PASSWORD }) });
  if (!r.ok) throw new Error(`Admin sign-in failed (${r.status})`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await r.json();
  const call = async (method, path, body) => {
    const res = await fetch(`${BASE}/api/app${path}`, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${j?.error?.message}`);
    return j;
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const POLICY_KEYS = ['api.allowStudentCreation', 'api.allowStudentProfileUpdates', 'api.studentProfileFields', 'api.allowStudentDeactivation', 'api.allowIdentityLinkWrites'];
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
console.log(`CampusCore end-to-end verification against ${BASE} (run ${stamp})`);
const admin = await adminSession();
const snapshot = Object.fromEntries((await admin.get('/admin/policies')).data.filter((p) => POLICY_KEYS.includes(p.key)).map((p) => [p.key, p.value]));
const created = await admin.post('/admin/integrations', { name: `E2E verification ${stamp}`, description: 'Temporary client created by connector/scripts/e2e-feddrick.js; revoked when the run ends.', scopes: ['institution:read', 'programs:read', 'terms:read', 'students:read', 'students:create', 'students:update', 'students:deactivate', 'identity:read', 'identity:write', 'audit:read', 'schedules:read', 'grades:read', 'registrations:read', 'faculty:read', 'sections:read'], tokenTtlSeconds: 3600 });
const sis = new CampusCoreAdapter({ baseUrl: BASE, clientId: created.client.clientId, clientSecret: created.clientSecret });
const portal = new SisPortalService({ adapter: sis, tenantKey: 'feddrick' });
const adminUser = { id: `e2e-admin-${stamp}`, role: 'ADMIN', tenantKey: 'feddrick' };
let studentId; let studentLink; let facultyLink; const studentEmail = `e2e.verification.${stamp}@students.feddrick.edu`;

try {
  await check('institution identity verified', async () => (await sis.verifyInstitution(EXPECTED)).name);
  await check('wrong-institution credentials are refused', () => expectError(sis.verifyInstitution('northbridge'), 'institution_mismatch'));
  await check('health report (no secrets)', async () => { const h = await sis.health(); if (!h.ok || JSON.stringify(h).includes(created.clientSecret)) throw new Error('bad health'); return `${h.institution.name}, ${h.scopes.length} scopes, ${h.latencyMs} ms`; });

  const programId = (await sis.client.get('/programs')).data.find((p) => p.code === 'BS-CS').id;
  const input = { firstName: 'E2E', lastName: `Verification ${stamp}`, email: studentEmail, programId, status: 'ACTIVE' };

  await admin.put('/admin/policies', { changes: { 'api.allowStudentCreation': false } });
  await check('creation blocked while policy is off (server-side)', () => expectError(portal.adminCreateStudent(adminUser, input, { idempotencyKey: `e2e-off-${stamp}` }), 'write_not_permitted'));
  await check('non-admin portal users cannot create', () => expectError(portal.adminCreateStudent({ ...adminUser, role: 'STUDENT' }, input, { idempotencyKey: `e2e-x-${stamp}` }), 'not_portal_admin'));

  await admin.put('/admin/policies', { changes: { 'api.allowStudentCreation': true, 'api.allowStudentProfileUpdates': true, 'api.studentProfileFields': ['phone', 'preferredName'], 'api.allowStudentDeactivation': true, 'api.allowIdentityLinkWrites': true } });
  const key = `e2e-create-${stamp}-${crypto.randomUUID()}`;
  await check('create student through the API', async () => { const r = await portal.adminCreateStudent(adminUser, input, { idempotencyKey: key }); studentId = r.student.source.id; return `${r.student.institutionalId} (${r.student.enrollmentStatus})`; });
  await check('retry with the same Idempotency-Key does not duplicate', async () => {
    const r = await portal.adminCreateStudent(adminUser, input, { idempotencyKey: key });
    const n = (await sis.findStudent({ email: studentEmail })).length;
    if (!r.replayed || r.student.source.id !== studentId || n !== 1) throw new Error(`replayed=${r.replayed} count=${n}`);
    return 'replayed, 1 record';
  });
  await check('duplicate email with a new key is rejected', () => expectError(portal.adminCreateStudent(adminUser, input, { idempotencyKey: `e2e-dup-${stamp}` }), 'duplicate_student'));
  await check('permitted profile update', async () => { const { etag } = await sis.getStudentForEdit(studentId); return (await portal.adminUpdateStudent(adminUser, studentId, { phone: '+1 (555) 010-2026' }, { etag })).changedFields.join(','); });
  await check('field outside policy is rejected', () => expectError(portal.adminUpdateStudent(adminUser, studentId, { firstName: 'Changed' }), 'field_not_permitted'));
  await check('protected field is rejected', () => expectError(portal.adminUpdateStudent(adminUser, studentId, { studentNumber: 'S0' }), 'validation_error'));

  const extStudent = `e2e-student-${stamp}`;
  await check('reconcile → CANDIDATE (not linked automatically)', async () => { const r = await portal.adminReconcile(adminUser, [{ externalUserId: extStudent, recordType: 'STUDENT', email: studentEmail }]); if (r.data[0].status !== 'CANDIDATE') throw new Error(r.data[0].status); return r.data[0].candidates[0].institutionalId; });
  await check('unmapped portal user sees UNMAPPED, not another record', async () => (await portal.studentOverview({ id: extStudent, role: 'STUDENT', tenantKey: 'feddrick' })).state);
  await check('admin links the account', async () => { studentLink = await portal.adminLinkIdentity(adminUser, { externalUserId: extStudent, externalEmail: studentEmail, recordType: 'STUDENT', sisRecordId: studentId }); return studentLink.status; });
  await check('mapped student retrieves their own SIS record', async () => {
    const o = await portal.studentOverview({ id: extStudent, role: 'STUDENT', tenantKey: 'feddrick' });
    if (o.state !== 'OK' || o.identity.sisId !== studentId || o.profile.data.source.id !== studentId) throw new Error(JSON.stringify(o).slice(0, 200));
    return `${o.profile.data.displayName}; schedule ${o.schedule.state}, grades ${o.grades.state}`;
  });
  await check('cross-tenant portal user rejected', () => expectError(portal.studentOverview({ id: extStudent, role: 'STUDENT', tenantKey: 'lakeshore' }), 'tenant_mismatch'));

  const vasquez = (await sis.client.get('/faculty', { search: 'Vasquez', pageSize: 1 })).data[0];
  const extFaculty = `e2e-faculty-${stamp}`;
  await check('faculty mapping + own roster', async () => {
    facultyLink = await portal.adminLinkIdentity(adminUser, { externalUserId: extFaculty, externalEmail: vasquez.email, recordType: 'FACULTY', sisRecordId: vasquez.id });
    const prof = { id: extFaculty, role: 'FACULTY', tenantKey: 'feddrick' };
    const t = await portal.facultyTeaching(prof);
    const sec = t.sections.data[0];
    return `${t.sections.data.length} sections; roster of ${sec.courseCode}-${sec.sectionCode}: ${(await portal.facultyRoster(prof, sec.source.id)).length} students`;
  });
  await check('faculty cannot read an unassigned roster', async () => {
    const other = (await sis.client.get('/sections', { search: 'ENGL 101', pageSize: 1 })).data[0];
    return expectError(portal.facultyRoster({ id: extFaculty, role: 'FACULTY', tenantKey: 'feddrick' }, other.id), 'not_section_instructor');
  });

  await check('deactivate (history retained)', async () => { const r = await portal.adminDeactivateStudent(adminUser, studentId, { reason: 'E2E verification complete', idempotencyKey: `e2e-deact-${stamp}` }); return `${r.student.enrollmentStatus}; ${r.retained}`; });
  await check('audit history attributes the acting portal admin', async () => {
    const a = await sis.getStudentAudit(studentId, { pageSize: 50 });
    const actions = a.data.map((e) => e.action);
    for (const need of ['student.created', 'student.updated', 'identity.linked', 'student.deactivated']) if (!actions.includes(need)) throw new Error(`missing ${need}`);
    if (!a.data.every((e) => e.onBehalfOf === `edunexusai:${adminUser.id}`)) throw new Error('onBehalfOf missing');
    return actions.join(', ');
  });
  await check('token revoked server-side → automatic recovery', async () => { await sis.client.revokeCurrentToken(); const before = sis.client.stats.tokenRequests; await sis.getCurrentTerm(); return `${sis.client.stats.tokenRequests - before} new token request`; });
} finally {
  // Clean-up that preserves history: revoke the test links and client, restore policies.
  for (const l of [studentLink, facultyLink].filter(Boolean)) await sis.revokeIdentityLink(l.id, 'E2E verification run finished').catch(() => {});
  await admin.put('/admin/policies', { changes: snapshot }).catch((e) => console.log('  ! policy restore failed:', e.message));
  await admin.post(`/admin/integrations/${created.client.id}/revoke`).catch(() => {});
  await check('policies restored to their previous values', async () => {
    const now = Object.fromEntries((await admin.get('/admin/policies')).data.filter((p) => POLICY_KEYS.includes(p.key)).map((p) => [p.key, p.value]));
    if (JSON.stringify(now) !== JSON.stringify(snapshot)) throw new Error(JSON.stringify(now));
    return 'ok';
  });
  await check('revoked E2E client can no longer authenticate', async () => {
    const res = await fetch(`${BASE}/api/v1/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${created.client.clientId}:${created.clientSecret}`).toString('base64')}` }, body: 'grant_type=client_credentials' });
    if (res.status !== 401) throw new Error(`status ${res.status}`);
    return '401 invalid_client';
  });
}
const failed = results.filter((r) => r[0] === '✗').length;
console.log(failed ? `\n${failed} check(s) failed.` : `\nAll ${results.length} checks passed. Test data left in place: student ${studentEmail} (WITHDRAWN), revoked links and client.`);
process.exit(failed ? 1 : 0);
void SisError;
