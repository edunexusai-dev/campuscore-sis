import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { login, getToken, api, prisma, seedData, setPolicy, request, app } from './helpers.js';
import { config } from '../src/config.js';

let admin, created, token;

beforeAll(async () => {
  admin = await login('admin');
});

describe('integration client management', () => {
  it('creates a client and reveals the secret exactly once', async () => {
    const res = await admin.post('/api/app/admin/integrations', { name: 'Test Portal', description: 'test', scopes: ['students:read', 'courses:read', 'registrations:read'] });
    expect(res.status).toBe(201);
    expect(res.body.clientSecret).toMatch(/^ccs_/);
    expect(res.headers['cache-control']).toBe('no-store');
    created = { id: res.body.client.id, clientId: res.body.client.clientId, secret: res.body.clientSecret };

    const list = await admin.get('/api/app/admin/integrations');
    expect(JSON.stringify(list.body)).not.toContain(created.secret);
    const row = await prisma.integrationClient.findUnique({ where: { id: created.id } });
    expect(row.secretHash).not.toContain(created.secret);
    expect(await prisma.auditEvent.findFirst({ where: { action: 'integration.created', entityId: created.id } })).toBeTruthy();
  });

  it('only administrators may create clients, with known scopes', async () => {
    const registrar = await login('registrar');
    expect((await registrar.post('/api/app/admin/integrations', { name: 'X', scopes: ['students:read'] })).status).toBe(403);
    expect((await admin.post('/api/app/admin/integrations', { name: 'Bad scopes', scopes: ['everything:write'] })).status).toBe(400);
  });
});

describe('token issuance (client credentials)', () => {
  it('issues a short-lived bearer token for valid credentials', async () => {
    const res = await getToken(created.clientId, created.secret);
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBe(900);
    expect(res.body.scope.split(' ').sort()).toEqual(['courses:read', 'registrations:read', 'students:read']);
    expect(res.headers['cache-control']).toBe('no-store');
    token = res.body.access_token;
  });

  it('supports HTTP Basic client authentication and scope down-selection', async () => {
    const res = await request(app).post('/api/v1/oauth/token').auth(created.clientId, created.secret).type('form').send({ grant_type: 'client_credentials', scope: 'courses:read' });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('courses:read');
  });

  it('rejects invalid credentials, grants and scopes', async () => {
    const wrong = await getToken(created.clientId, 'ccs_wrong');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_client');
    const unknown = await getToken('cc_unknown', created.secret);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe('invalid_client');
    const grant = await request(app).post('/api/v1/oauth/token').type('form').send({ grant_type: 'password', client_id: created.clientId, client_secret: created.secret });
    expect(grant.status).toBe(400);
    expect(grant.body.error).toBe('unsupported_grant_type');
    const scope = await getToken(created.clientId, created.secret, 'students:read grades:write');
    expect(scope.status).toBe(400);
    expect(scope.body.error).toBe('invalid_scope');
  });
});

describe('protected API access', () => {
  it('rejects missing, malformed, forged and expired tokens', async () => {
    const missing = await request(app).get('/api/v1/students');
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toMatch(/Bearer/);
    expect((await api('not-a-token').get('/api/v1/students')).status).toBe(401);
    const forged = jwt.sign({ scope: 'students:read', inst: 'x', sv: 1 }, 'some-other-secret-that-is-long-enough!!', { subject: created.clientId, jwtid: 'x', issuer: config.publicApiUrl, audience: `${config.publicApiUrl}/api/v1` });
    expect((await api(forged).get('/api/v1/students')).status).toBe(401);
    const expired = jwt.sign({ scope: 'students:read', inst: 'x', sv: 1, exp: Math.floor(Date.now() / 1000) - 60 }, config.jwtSecret, { subject: created.clientId, jwtid: 'y', issuer: config.publicApiUrl, audience: `${config.publicApiUrl}/api/v1` });
    const res = await api(expired).get('/api/v1/students');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/expired/);
  });

  it('returns paginated, validated data for a granted scope', async () => {
    const res = await api(token).get('/api/v1/students?pageSize=5&sort=-studentNumber');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.pagination).toMatchObject({ page: 1, pageSize: 5 });
    expect(res.body.pagination.total).toBeGreaterThan(100);
    // DTO excludes sensitive fields.
    const s = res.body.data[0];
    for (const k of ['dateOfBirth', 'addressLine', 'emergencyContactName', 'financialAccountRef', 'userId', 'institutionId']) expect(s).not.toHaveProperty(k);
    const bad = await api(token).get('/api/v1/students?pageSize=1000');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
    const badSort = await api(token).get('/api/v1/students?sort=passwordHash');
    expect(badSort.status).toBe(400);
  });

  it('returns 403 insufficient_scope for endpoints outside the granted scopes', async () => {
    const res = await api(token).get('/api/v1/students/abc/grades');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('insufficient_scope');
    expect(res.body.error.details.required).toEqual(['grades:read']);
  });

  it('a read-only client can never write, even with a valid token', async () => {
    const { demo, terms } = seedData();
    const section = await prisma.section.findFirst({ where: { termId: terms.next.id } });
    const res = await api(token).post('/api/v1/registrations', { studentId: demo.mayaId, sectionId: section.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('insufficient_scope');
    const patch = await api(token).patch(`/api/v1/students/${demo.mayaId}`, { phone: '1' });
    expect(patch.status).toBe(403);
  });

  it('logs API activity per client', async () => {
    const logs = await prisma.apiRequestLog.count({ where: { clientId: created.id } });
    expect(logs).toBeGreaterThan(3);
  });
});

describe('schedule DTO', () => {
  it('reports the registration status separately from the section status', async () => {
    const { clients, demo } = seedData();
    const edu = api((await getToken(clients.edunexus.clientId, clients.edunexus.clientSecret)).body.access_token);
    const res = await edu.get(`/api/v1/students/${demo.mayaId}/schedule`);
    expect(res.status).toBe(200);
    const cls = res.body.data.classes.find((c) => c.id === demo.fullSectionId);
    expect(['REGISTERED', 'COMPLETED']).toContain(cls.registrationStatus);
    expect(cls.status).toBe('OPEN');
  });
});

describe('authorised writes', () => {
  let edu;
  beforeAll(async () => {
    const { clients } = seedData();
    edu = api((await getToken(clients.edunexus.clientId, clients.edunexus.clientSecret)).body.access_token);
  });

  it('registers a student through the API, enforcing the same rules and auditing the change', async () => {
    const { terms } = seedData();
    // A first-year student with no next-term registrations, who therefore cannot have completed CS 350.
    const student = await prisma.student.findFirst({ where: { status: 'ACTIVE', classLevel: 'FRESHMAN', holds: { none: { releasedAt: null } }, registrations: { none: { OR: [{ section: { termId: terms.next.id } }, { section: { course: { code: { in: ['CS 350', 'HIST 102'] } } } }] } }, program: { level: 'UNDERGRADUATE' } } });
    const section = await prisma.section.findFirst({ where: { termId: terms.next.id, course: { code: 'HIST 102' } } });
    const res = await edu.post('/api/v1/registrations', { studentId: student.id, sectionId: section.id });
    expect(res.status).toBe(201);
    expect(res.body.data.source).toBe('API');
    const auditRow = await prisma.auditEvent.findFirst({ where: { entityId: res.body.data.id, actorType: 'INTEGRATION' } });
    expect(auditRow.actorLabel).toMatch(/EdunexusAI/);

    const blocked = await prisma.section.findFirst({ where: { termId: terms.next.id, course: { code: 'CS 495' } } });
    const rule = await edu.post('/api/v1/registrations', { studentId: student.id, sectionId: blocked.id });
    expect(rule.status).toBe(422);
    expect(rule.body.error.code).toBe('prerequisite_not_met');

    const drop = await edu.post(`/api/v1/registrations/${res.body.data.id}/drop`, { reason: 'Requested via portal' });
    expect(drop.status).toBe(200);
    expect(drop.body.data.status).toBe('DROPPED');
  });

  it('honours the policy kill-switch for API registration writes', async () => {
    await setPolicy('api.allowRegistrationWrites', false);
    const res = await edu.post('/api/v1/registrations', { studentId: 'a', sectionId: 'b' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('policy_disabled');
    await setPolicy('api.allowRegistrationWrites', true);
  });

  it('records attendance only on behalf of an assigned instructor', async () => {
    const { demo } = seedData();
    const reg = await prisma.registration.findFirst({ where: { sectionId: demo.fullSectionId, status: { in: ['REGISTERED', 'COMPLETED'] } } });
    const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const other = await prisma.faculty.findFirst({ where: { id: { not: demo.vasquezFacultyId } } });
    const denied = await edu.post(`/api/v1/sections/${demo.fullSectionId}/attendance`, { actingFacultyId: other.id, date, records: [{ studentId: reg.studentId, status: 'LATE' }] });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('not_section_instructor');
    const ok = await edu.post(`/api/v1/sections/${demo.fullSectionId}/attendance`, { actingFacultyId: demo.vasquezFacultyId, date, records: [{ studentId: reg.studentId, status: 'LATE' }] });
    expect(ok.status).toBe(200);
    const rec = await prisma.attendanceRecord.findFirst({ where: { registrationId: reg.id, date: new Date(`${date}T00:00:00Z`) } });
    expect(rec.status).toBe('LATE');
    expect(rec.recordedByType).toBe('INTEGRATION');
  });

  it('updates only contact fields on students', async () => {
    const { demo } = seedData();
    const rejected = await edu.patch(`/api/v1/students/${demo.mayaId}`, { phone: '+1 555 0100' });
    expect(rejected.status).toBe(403); // EdunexusAI demo client has no students:write
    const c = await admin.post('/api/app/admin/integrations', { name: 'Writer', scopes: ['students:read', 'students:write', 'grades:write', 'sections:read'] });
    const w = api((await getToken(c.body.client.clientId, c.body.clientSecret)).body.access_token);
    const bad = await w.patch(`/api/v1/students/${demo.mayaId}`, { studentNumber: 'S1', academicStanding: 'DEANS_LIST' });
    expect(bad.status).toBe(400);
    const good = await w.patch(`/api/v1/students/${demo.mayaId}`, { preferredName: 'May' });
    expect(good.status).toBe(200);
    expect(good.body.data.preferredName).toBe('May');
    expect(await prisma.auditEvent.findFirst({ where: { action: 'student.updated', entityId: demo.mayaId, actorType: 'INTEGRATION' } })).toBeTruthy();

    // Grade writes are disabled by default policy.
    const target = await prisma.registration.findFirst({ where: { status: 'REGISTERED', grade: null, section: { id: { not: demo.fullSectionId }, term: { isCurrent: true }, instructors: { some: { facultyId: demo.vasquezFacultyId } } } } });
    const body = { actingFacultyId: demo.vasquezFacultyId, grades: [{ studentId: target.studentId, letter: 'A-' }] };
    const disabled = await w.put(`/api/v1/sections/${target.sectionId}/grades`, body);
    expect(disabled.status).toBe(422);
    expect(disabled.body.error.code).toBe('policy_disabled');
    await setPolicy('api.allowGradeWrites', true);
    // Allowed: saved as a DRAFT attributed to the integration — never approved or published.
    const draft = await w.put(`/api/v1/sections/${target.sectionId}/grades`, body);
    expect(draft.status).toBe(200);
    const g = await prisma.grade.findUnique({ where: { registrationId: target.id } });
    expect(g).toMatchObject({ letter: 'A-', status: 'DRAFT', enteredByType: 'INTEGRATION' });
    // Once a grade is official, the API cannot change it.
    await prisma.grade.update({ where: { id: g.id }, data: { status: 'PUBLISHED' } });
    const locked = await w.put(`/api/v1/sections/${target.sectionId}/grades`, { ...body, grades: [{ studentId: target.studentId, letter: 'F' }] });
    expect(locked.status).toBe(422);
    expect(locked.body.error.code).toBe('grade_locked');
    await prisma.grade.delete({ where: { id: g.id } });
    await setPolicy('api.allowGradeWrites', false);
  });
});

describe('revocation and rotation', () => {
  it('revokes a single token via RFC 7009', async () => {
    const t = (await getToken(created.clientId, created.secret)).body.access_token;
    expect((await api(t).get('/api/v1/courses')).status).toBe(200);
    const rev = await request(app).post('/api/v1/oauth/revoke').type('form').send({ token: t, client_id: created.clientId, client_secret: created.secret });
    expect(rev.status).toBe(200);
    const res = await api(t).get('/api/v1/courses');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/revoked/);
  });

  it('disabling a client invalidates its tokens immediately', async () => {
    const t = (await getToken(created.clientId, created.secret)).body.access_token;
    await admin.patch(`/api/app/admin/integrations/${created.id}`, { enabled: false });
    expect((await api(t).get('/api/v1/courses')).status).toBe(401);
    expect((await getToken(created.clientId, created.secret)).status).toBe(401);
    await admin.patch(`/api/app/admin/integrations/${created.id}`, { enabled: true });
  });

  it('rotating the secret invalidates the old secret and outstanding tokens', async () => {
    const t = (await getToken(created.clientId, created.secret)).body.access_token;
    const rot = await admin.post(`/api/app/admin/integrations/${created.id}/rotate`);
    expect(rot.status).toBe(200);
    expect((await api(t).get('/api/v1/courses')).status).toBe(401);
    expect((await getToken(created.clientId, created.secret)).status).toBe(401);
    const fresh = await getToken(created.clientId, rot.body.clientSecret);
    expect(fresh.status).toBe(200);
    created.secret = rot.body.clientSecret;
  });

  it('narrowing scopes takes effect for existing tokens', async () => {
    const t = (await getToken(created.clientId, created.secret)).body.access_token;
    await admin.patch(`/api/app/admin/integrations/${created.id}`, { scopes: ['courses:read'] });
    expect((await api(t).get('/api/v1/students')).status).toBe(401);
    const t2 = (await getToken(created.clientId, created.secret)).body.access_token;
    expect((await api(t2).get('/api/v1/students')).status).toBe(403);
  });

  it('a revoked client can no longer obtain tokens', async () => {
    await admin.post(`/api/app/admin/integrations/${created.id}/revoke`);
    expect((await getToken(created.clientId, created.secret)).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  it("a client cannot see another institution's records", async () => {
    const { clients, demo } = seedData();
    const lake = api((await getToken(clients.lakeshore.clientId, clients.lakeshore.clientSecret)).body.access_token);
    expect((await lake.get(`/api/v1/students/${demo.mayaId}`)).status).toBe(404);
    const list = await lake.get('/api/v1/students');
    expect(list.body.pagination.total).toBe(2);
    expect(list.body.data.every((s) => s.email.endsWith('lakeshore.edu'))).toBe(true);
    const sections = await lake.get('/api/v1/sections');
    expect(sections.body.pagination.total).toBe(1);
    expect((await lake.get(`/api/v1/sections/${demo.fullSectionId}`)).status).toBe(404);
  });
});
