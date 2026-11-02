// Feddrick University / EdunexusAI integration requirements: institution identity, scoped student writes,
// configurable write policies, idempotency, deactivation that preserves history, identity reconciliation and links.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { login, getToken, api, prisma, seedData, setPolicy, request, app } from './helpers.js';

const ALL_NEW = ['students:read', 'students:create', 'students:update', 'students:academic', 'students:deactivate', 'identity:read', 'identity:write', 'audit:read', 'integration:configure', 'registrations:read'];
let admin, inst, programId, otherProgramId;

async function client(scopes, name = `Test ${Math.random().toString(36).slice(2, 7)}`) {
  const c = await admin.post('/api/app/admin/integrations', { name, scopes });
  const tok = (await getToken(c.body.client.clientId, c.body.clientSecret)).body.access_token;
  return { id: c.body.client.id, clientId: c.body.client.clientId, secret: c.body.clientSecret, call: api(tok), token: tok };
}
const key = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const newStudent = (over = {}) => ({ firstName: 'Testy', lastName: `Created${Math.random().toString(36).slice(2, 6)}`, email: `t.${Math.random().toString(36).slice(2, 10)}@students.feddrick.edu`, programId, ...over });

beforeAll(async () => {
  admin = await login('admin');
  inst = await prisma.institution.findUnique({ where: { slug: 'feddrick' } });
  programId = (await prisma.program.findFirst({ where: { institutionId: inst.id, code: 'BS-CS' } })).id;
  otherProgramId = (await prisma.program.findFirst({ where: { institutionId: inst.id, code: 'BBA' } })).id;
});
afterAll(async () => {
  for (const k of ['api.allowStudentCreation', 'api.allowStudentProfileUpdates', 'api.allowStudentAcademicUpdates', 'api.allowStudentDeactivation', 'api.allowIdentityLinkWrites']) await setPolicy(k, false);
});

describe('institution configuration', () => {
  it('identifies Feddrick University through the API and the sign-in branding', async () => {
    const c = await client(['institution:read']);
    const res = await c.call.get('/api/v1/institution');
    expect(res.body.data).toMatchObject({ slug: 'feddrick', name: 'Feddrick University', emailDomain: 'feddrick.edu', studentEmailDomain: 'students.feddrick.edu' });
    const me = await c.call.get('/api/v1/me');
    expect(me.body.institution).toMatchObject({ slug: 'feddrick', name: 'Feddrick University' });
    const b = await request(app).get('/api/app/auth/branding');
    expect(b.body.data.name).toBe('Feddrick University');
    expect(Object.keys(b.body.data).sort()).toEqual(['emailDomain', 'name', 'shortName', 'studentEmailDomain']);
  });
});

describe('write capabilities = scope ∧ institutional policy ∧ client preference', () => {
  it('reports each layer and enforces it on the server', async () => {
    const c = await client(['students:read', 'students:create', 'integration:configure']);
    await setPolicy('api.allowStudentCreation', false);
    let caps = (await c.call.get('/api/v1/capabilities')).body.data.operations;
    expect(caps.find((o) => o.operation === 'student.create')).toMatchObject({ scopeGranted: true, policyEnabled: false, effective: false });
    expect(caps.find((o) => o.operation === 'student.deactivate')).toMatchObject({ scopeGranted: false, effective: false });
    const off = await c.call.post('/api/v1/students', newStudent()).set('Idempotency-Key', key());
    expect(off.status).toBe(422);
    expect(off.body.error.code).toBe('policy_disabled');

    await setPolicy('api.allowStudentCreation', true);
    await c.call.put('/api/v1/integration/write-preferences', { disabledOperations: ['student.create'] });
    caps = (await c.call.get('/api/v1/capabilities')).body.data.operations;
    expect(caps.find((o) => o.operation === 'student.create')).toMatchObject({ policyEnabled: true, clientEnabled: false, effective: false });
    const pref = await c.call.post('/api/v1/students', newStudent()).set('Idempotency-Key', key());
    expect(pref.status).toBe(403);
    expect(pref.body.error.code).toBe('disabled_by_client_preference');

    // Preferences can never broaden: re-enabling the preference while policy is off still denies.
    await c.call.put('/api/v1/integration/write-preferences', { disabledOperations: [] });
    await setPolicy('api.allowStudentCreation', false);
    expect((await c.call.post('/api/v1/students', newStudent()).set('Idempotency-Key', key())).status).toBe(422);
    expect(await prisma.auditEvent.findFirst({ where: { action: 'integration.write_preferences_updated', entityId: c.id } })).toBeTruthy();
  });

  it('a client without the scope cannot create, update or deactivate, regardless of policy', async () => {
    for (const k of ['api.allowStudentCreation', 'api.allowStudentProfileUpdates', 'api.allowStudentDeactivation']) await setPolicy(k, true);
    const ro = await client(['students:read']);
    const { demo } = seedData();
    const c = await ro.call.post('/api/v1/students', newStudent()).set('Idempotency-Key', key());
    expect(c.status).toBe(403); expect(c.body.error.code).toBe('insufficient_scope');
    const u = await ro.call.patch(`/api/v1/students/${demo.mayaId}`, { phone: '1' });
    expect(u.status).toBe(403); expect(u.body.error.code).toBe('insufficient_scope');
    const d = await ro.call.post(`/api/v1/students/${demo.mayaId}/deactivate`, { reason: 'should not work' });
    expect(d.status).toBe(403);
  });

  it('narrowing a client\'s scopes invalidates tokens that carried the removed scope', async () => {
    const c = await client(['students:read', 'students:create']);
    await admin.patch(`/api/app/admin/integrations/${c.id}`, { scopes: ['students:read'] });
    expect((await c.call.get('/api/v1/students?pageSize=1')).status).toBe(401);
    const fresh = api((await getToken(c.clientId, c.secret)).body.access_token);
    expect((await fresh.post('/api/v1/students', newStudent()).set('Idempotency-Key', key())).status).toBe(403);
  });
});

describe('student creation', () => {
  let c;
  beforeAll(async () => { c = await client(ALL_NEW); await setPolicy('api.allowStudentCreation', true); });

  it('requires an Idempotency-Key', async () => {
    const res = await c.call.post('/api/v1/students', newStudent());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('idempotency_key_required');
  });

  it('creates a student, records the acting user, and replays retries without duplicating', async () => {
    const body = newStudent();
    const k = key();
    const first = await c.call.post('/api/v1/students', body).set('Idempotency-Key', k).set('X-Acting-User', 'edunexus-admin:42|ops@feddrick.edu');
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ firstName: 'Testy', status: 'ADMITTED', program: { id: programId } });
    expect(first.headers.etag).toMatch(/^W\//);
    const retry = await c.call.post('/api/v1/students', body).set('Idempotency-Key', k);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await prisma.student.count({ where: { email: body.email } })).toBe(1);
    const reused = await c.call.post('/api/v1/students', { ...body, firstName: 'Other' }).set('Idempotency-Key', k);
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('idempotency_key_reused');
    const ev = await prisma.auditEvent.findFirst({ where: { action: 'student.created', entityId: first.body.data.id } });
    expect(ev).toMatchObject({ actorType: 'INTEGRATION', onBehalfOf: 'edunexus-admin:42|ops@feddrick.edu' });
  });

  it('concurrent retries with one key create exactly one student', async () => {
    const body = newStudent();
    const k = key();
    const results = await Promise.all([1, 2, 3, 4].map(() => c.call.post('/api/v1/students', body).set('Idempotency-Key', k)));
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect(await prisma.student.count({ where: { email: body.email } })).toBe(1);
  });

  it('detects duplicates and validates relationships', async () => {
    const body = newStudent();
    await c.call.post('/api/v1/students', body).set('Idempotency-Key', key());
    const dupEmail = await c.call.post('/api/v1/students', { ...body, lastName: 'Else' }).set('Idempotency-Key', key());
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error.code).toBe('duplicate_student');
    expect(dupEmail.body.error.details.existingId).toBeTruthy();
    const maya = await prisma.student.findUnique({ where: { id: seedData().demo.mayaId } });
    const dupNum = await c.call.post('/api/v1/students', newStudent({ studentNumber: maya.studentNumber })).set('Idempotency-Key', key());
    expect(dupNum.status).toBe(409);
    expect(dupNum.body.error.code).toBe('duplicate_student_number');
    const lakeProgram = await prisma.program.findFirst({ where: { institution: { slug: 'lakeshore' } } });
    const foreignProgram = await prisma.program.create({ data: { institutionId: (await prisma.institution.findUnique({ where: { slug: 'lakeshore' } })).id, departmentId: (await prisma.department.findFirst({ where: { institution: { slug: 'lakeshore' } } })).id, code: `LX${Date.now() % 10000}`, name: 'Lakeshore Program', degreeType: 'AA', level: 'UNDERGRADUATE', requiredCredits: 60 } });
    void lakeProgram;
    const cross = await c.call.post('/api/v1/students', newStudent({ programId: foreignProgram.id })).set('Idempotency-Key', key());
    expect(cross.status).toBe(422);
    expect(cross.body.error.code).toBe('invalid_program');
    const protectedField = await c.call.post('/api/v1/students', newStudent({ academicStanding: 'DEANS_LIST' })).set('Idempotency-Key', key());
    expect(protectedField.status).toBe(400);
  });
});

describe('student updates', () => {
  let c, sid;
  beforeAll(async () => {
    c = await client(ALL_NEW);
    await setPolicy('api.allowStudentCreation', true);
    sid = (await c.call.post('/api/v1/students', newStudent()).set('Idempotency-Key', key())).body.data.id;
  });

  it('applies field-level policy and returns per-field reasons', async () => {
    await setPolicy('api.allowStudentProfileUpdates', false);
    const off = await c.call.patch(`/api/v1/students/${sid}`, { phone: '+1 555 0101' });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('field_not_permitted');
    await setPolicy('api.allowStudentProfileUpdates', true);
    await setPolicy('api.studentProfileFields', ['phone', 'preferredName']);
    const ok = await c.call.patch(`/api/v1/students/${sid}`, { phone: '+1 555 0101', preferredName: 'Tes' });
    expect(ok.status).toBe(200);
    expect(ok.body.meta.changedFields.sort()).toEqual(['phone', 'preferredName']);
    const name = await c.call.patch(`/api/v1/students/${sid}`, { firstName: 'Renamed' });
    expect(name.status).toBe(403);
    expect(name.body.error.details[0].field).toBe('firstName');
    const prot = await c.call.patch(`/api/v1/students/${sid}`, { studentNumber: 'S9', status: 'GRADUATED' });
    expect(prot.status).toBe(400);
  });

  it('client preferences narrow the field list', async () => {
    await setPolicy('api.allowStudentProfileUpdates', true);
    await setPolicy('api.studentProfileFields', ['phone', 'preferredName']);
    await c.call.put('/api/v1/integration/write-preferences', { disabledOperations: [], profileFields: ['preferredName'] });
    expect((await c.call.patch(`/api/v1/students/${sid}`, { phone: '+1 555 0199' })).status).toBe(403);
    expect((await c.call.patch(`/api/v1/students/${sid}`, { preferredName: 'T.' })).status).toBe(200);
    await c.call.put('/api/v1/integration/write-preferences', { disabledOperations: [] });
  });

  it('academic attributes need students:academic, the policy and valid references', async () => {
    await setPolicy('api.allowStudentAcademicUpdates', true);
    await setPolicy('api.studentAcademicFields', ['programId', 'expectedGraduation']);
    const ok = await c.call.patch(`/api/v1/students/${sid}`, { programId: otherProgramId, expectedGraduation: 'Spring 2031' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.program.id).toBe(otherProgramId);
    const bad = await c.call.patch(`/api/v1/students/${sid}`, { programId: 'does-not-exist' });
    expect(bad.status).toBe(422);
    const noTerm = await c.call.patch(`/api/v1/students/${sid}`, { admitTermId: 'x' });
    expect(noTerm.status).toBe(403); // admitTermId is not in the enabled academic field list
  });

  it('rejects stale updates with If-Match', async () => {
    const get = await c.call.get(`/api/v1/students/${sid}`);
    const etag = get.headers.etag;
    await c.call.patch(`/api/v1/students/${sid}`, { preferredName: 'Changed' });
    const stale = await c.call.patch(`/api/v1/students/${sid}`, { preferredName: 'Stale' }).set('If-Match', etag);
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe('precondition_failed');
  });
});

describe('student deactivation preserves history', () => {
  let c;
  beforeAll(async () => { c = await client(ALL_NEW); await setPolicy('api.allowStudentDeactivation', true); });

  it('refuses while the student is registered in a term in progress', async () => {
    const res = await c.call.post(`/api/v1/students/${seedData().demo.mayaId}/deactivate`, { reason: 'Testing in-progress rule' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('active_term_registrations');
    expect((await prisma.student.findUnique({ where: { id: seedData().demo.mayaId } })).status).not.toBe('WITHDRAWN');
  });

  it('withdraws a student with graded history and keeps registrations, grades and transcript', async () => {
    const s = await prisma.student.findFirst({ where: { institutionId: inst.id, status: 'LEAVE_OF_ABSENCE', registrations: { some: { grade: { status: 'PUBLISHED' } } } } });
    const before = { regs: await prisma.registration.count({ where: { studentId: s.id } }), grades: await prisma.grade.count({ where: { registration: { studentId: s.id } } }) };
    const res = await c.call.post(`/api/v1/students/${s.id}/deactivate`, { reason: 'Student left the university' }).set('X-Acting-User', 'edunexus-admin:7');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('WITHDRAWN');
    expect(res.body.meta.changed).toBe(true);
    expect(await prisma.registration.count({ where: { studentId: s.id } })).toBe(before.regs);
    expect(await prisma.grade.count({ where: { registration: { studentId: s.id } } })).toBe(before.grades);
    const record = await c.call.get(`/api/v1/students/${s.id}/audit`);
    expect(record.body.data.some((e) => e.action === 'student.deactivated' && e.onBehalfOf === 'edunexus-admin:7')).toBe(true);
    const again = await c.call.post(`/api/v1/students/${s.id}/deactivate`, { reason: 'Second request' });
    expect(again.status).toBe(200);
    expect(again.body.meta.changed).toBe(false);
    if (s.userId) expect((await prisma.user.findUnique({ where: { id: s.userId } })).status).toBe('DISABLED');
    const gradesClient = await client(['grades:read']);
    const rec = await gradesClient.call.get(`/api/v1/students/${s.id}/academic-record`);
    expect(rec.status).toBe(200);
    expect(rec.body.data.creditsEarned).toBeGreaterThan(0);
  });

  it('requires explicit consent to drop upcoming-term registrations', async () => {
    await setPolicy('api.allowStudentCreation', true);
    const sid = (await c.call.post('/api/v1/students', newStudent({ status: 'ACTIVE' })).set('Idempotency-Key', key())).body.data.id;
    const registrar = await login('registrar');
    const sec = await prisma.section.findFirst({ where: { termId: seedData().terms.next.id, course: { prerequisites: { none: {} } } } });
    expect((await registrar.post('/api/app/admin/registrations', { studentId: sid, sectionId: sec.id })).status).toBe(201);
    const blocked = await c.call.post(`/api/v1/students/${sid}/deactivate`, { reason: 'Changed plans' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('future_registrations');
    const ok = await c.call.post(`/api/v1/students/${sid}/deactivate`, { reason: 'Changed plans', dropFutureRegistrations: true });
    expect(ok.status).toBe(200);
    expect(ok.body.meta.droppedRegistrations).toBe(1);
    const reg = await prisma.registration.findFirst({ where: { studentId: sid }, include: { events: true } });
    expect(reg.status).toBe('DROPPED');
    expect(reg.events.some((e) => e.reason?.includes('Student deactivated'))).toBe(true);
  });
});

describe('identity reconciliation and links', () => {
  let c, maya, jordan;
  beforeAll(async () => {
    c = await client(ALL_NEW);
    maya = await prisma.student.findUnique({ where: { id: seedData().demo.mayaId } });
    jordan = await prisma.student.findUnique({ where: { id: seedData().demo.jordanId } });
  });

  it('classifies accounts using strong identifiers only and never links automatically', async () => {
    const res = await c.call.post('/api/v1/identity/reconcile', { candidates: [
      { externalUserId: 'enx-1', recordType: 'STUDENT', email: maya.email },
      { externalUserId: 'enx-2', recordType: 'STUDENT', email: maya.email, institutionalId: jordan.studentNumber },
      { externalUserId: 'enx-3', recordType: 'STUDENT', email: 'nobody@example.org' },
      { externalUserId: 'enx-4', recordType: 'STUDENT', firstName: maya.firstName, lastName: maya.lastName },
    ] });
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => r.status)).toEqual(['CANDIDATE', 'AMBIGUOUS', 'UNMATCHED', 'UNMATCHED']);
    expect(res.body.data[0].candidates[0]).toMatchObject({ sisId: maya.id, evidence: { emailMatch: true } });
    expect(await prisma.externalIdentityLink.count({ where: { externalUserId: { in: ['enx-1', 'enx-2', 'enx-3', 'enx-4'] } } })).toBe(0);
  });

  it('links only with policy, confirmation and matching evidence; prevents duplicates', async () => {
    await setPolicy('api.allowIdentityLinkWrites', false);
    const off = await c.call.post('/api/v1/identity/links', { externalUserId: 'enx-1', recordType: 'STUDENT', sisRecordId: maya.id, externalEmail: maya.email, confirm: true });
    expect(off.status).toBe(422);
    await setPolicy('api.allowIdentityLinkWrites', true);
    const noConfirm = await c.call.post('/api/v1/identity/links', { externalUserId: 'enx-1', recordType: 'STUDENT', sisRecordId: maya.id });
    expect(noConfirm.status).toBe(400);
    const mismatch = await c.call.post('/api/v1/identity/links', { externalUserId: 'enx-1', recordType: 'STUDENT', sisRecordId: maya.id, externalEmail: 'someone.else@feddrick.edu', confirm: true });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('identity_evidence_mismatch');
    const ok = await c.call.post('/api/v1/identity/links', { externalUserId: 'enx-1', recordType: 'STUDENT', sisRecordId: maya.id, externalEmail: maya.email, confirm: true }).set('X-Acting-User', 'edunexus-admin:1');
    expect(ok.status).toBe(201);
    const dupAccount = await c.call.post('/api/v1/identity/links', { externalUserId: 'enx-1', recordType: 'STUDENT', sisRecordId: jordan.id, externalEmail: jordan.email, confirm: true });
    expect(dupAccount.status).toBe(409);
    expect(dupAccount.body.error.code).toBe('identity_already_linked');
    const dupRecord = await c.call.post('/api/v1/identity/links', { externalUserId: 'enx-9', recordType: 'STUDENT', sisRecordId: maya.id, externalEmail: maya.email, confirm: true });
    expect(dupRecord.status).toBe(409);
    expect(dupRecord.body.error.code).toBe('record_already_linked');
    const resolved = await c.call.get('/api/v1/identity/resolve?externalUserId=enx-1');
    expect(resolved.body.data).toMatchObject({ status: 'LINKED', recordType: 'STUDENT', sisId: maya.id, institutionalId: maya.studentNumber, recordStatus: maya.status });
    const recon = await c.call.post('/api/v1/identity/reconcile', { candidates: [{ externalUserId: 'enx-1', recordType: 'STUDENT', email: maya.email }, { externalUserId: 'enx-5', recordType: 'STUDENT', email: maya.email }] });
    expect(recon.body.data.map((r) => r.status)).toEqual(['LINKED', 'AMBIGUOUS']);
    expect(await prisma.auditEvent.findFirst({ where: { action: 'identity.linked', entityId: maya.id, onBehalfOf: 'edunexus-admin:1' } })).toBeTruthy();
  });

  it('a mapping changes only through audited revoke-then-link', async () => {
    const link = (await c.call.get('/api/v1/identity/links?externalUserId=enx-1&status=ACTIVE')).body.data[0];
    const rev = await c.call.post(`/api/v1/identity/links/${link.id}/revoke`, { reason: 'Linked to the wrong account during testing' });
    expect(rev.status).toBe(200);
    expect(rev.body.data.status).toBe('REVOKED');
    expect((await c.call.get('/api/v1/identity/resolve?externalUserId=enx-1')).body.data.status).toBe('UNMAPPED');
    const relink = await c.call.post('/api/v1/identity/links', { externalUserId: 'enx-1', recordType: 'STUDENT', sisRecordId: maya.id, externalEmail: maya.email, confirm: true });
    expect(relink.status).toBe(201);
    expect((await c.call.get('/api/v1/identity/links?externalUserId=enx-1')).body.data.length).toBe(2);
  });

  it('identity data never crosses tenants', async () => {
    const lake = await prisma.institution.findUnique({ where: { slug: 'lakeshore' } });
    const lc = await prisma.integrationClient.findFirst({ where: { institutionId: lake.id } });
    const { clients } = seedData();
    void lc;
    const tok = (await getToken(clients.lakeshore.clientId, clients.lakeshore.clientSecret)).body.access_token;
    // Grant identity scopes to the Lakeshore client through the Lakeshore admin.
    const lakeAdmin = await login('lakeAdmin');
    const created = await lakeAdmin.post('/api/app/admin/integrations', { name: 'Lakeshore identity', scopes: ['identity:read', 'identity:write'] });
    const l = api((await getToken(created.body.client.clientId, created.body.clientSecret)).body.access_token);
    expect((await l.get('/api/v1/identity/resolve?externalUserId=enx-1')).body.data.status).toBe('UNMAPPED');
    const recon = await l.post('/api/v1/identity/reconcile', { candidates: [{ externalUserId: 'x', recordType: 'STUDENT', email: maya.email }] });
    expect(recon.body.data[0].status).toBe('UNMATCHED');
    await prisma.policy.upsert({ where: { institutionId_key: { institutionId: lake.id, key: 'api.allowIdentityLinkWrites' } }, create: { institutionId: lake.id, key: 'api.allowIdentityLinkWrites', value: true }, update: { value: true } });
    const cross = await l.post('/api/v1/identity/links', { externalUserId: 'lx', recordType: 'STUDENT', sisRecordId: maya.id, confirm: true });
    expect(cross.status).toBe(404);
    expect(tok).toBeTruthy();
  });

  it('CampusCore staff manage links in the portal; faculty and students cannot', async () => {
    const registrar = await login('registrar');
    const list = await registrar.get('/api/app/admin/identity-links?externalUserId=enx-1');
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    const linkJordan = await registrar.post('/api/app/admin/identity-links', { externalUserId: 'enx-jordan', recordType: 'STUDENT', sisRecordId: jordan.id, externalEmail: jordan.email });
    expect(linkJordan.status).toBe(201);
    expect(linkJordan.body.data.method).toBe('MANUAL_ADMIN');
    for (const who of ['faculty', 'student']) expect((await (await login(who)).get('/api/app/admin/identity-links')).status).toBe(403);
  });
});

describe('audit attribution and rejected writes', () => {
  it('records rejected integration writes and validates X-Acting-User', async () => {
    const c = await client(['students:read', 'students:create']);
    await setPolicy('api.allowStudentCreation', false);
    await c.call.post('/api/v1/students', newStudent()).set('Idempotency-Key', key()).set('X-Acting-User', 'edunexus-admin:99');
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.auditEvent.findFirst({ where: { action: 'integration.write_rejected', actorId: c.id, outcome: 'REJECTED', onBehalfOf: 'edunexus-admin:99' } })).toBeTruthy();
    const bad = await c.call.get('/api/v1/students?pageSize=1').set('X-Acting-User', '<script>');
    expect(bad.status).toBe(400);
  });
});
