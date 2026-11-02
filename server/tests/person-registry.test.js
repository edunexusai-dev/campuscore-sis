// The person registry: one Person per human being, every student/faculty record and login points to it, and the
// v1 People API exposes it for identity provisioning.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { login, getToken, api, prisma, setPolicy } from './helpers.js';

let admin;
let inst;
let people;   // client with people:read
let noScope;  // client without it
const created = { students: [], faculty: [] };

async function client(scopes) {
  const c = await admin.post('/api/app/admin/integrations', { name: `Person registry ${Math.random().toString(36).slice(2, 7)}`, scopes });
  return api((await getToken(c.body.client.clientId, c.body.clientSecret)).body.access_token);
}

beforeAll(async () => {
  admin = await login('admin');
  inst = await prisma.institution.findUnique({ where: { slug: 'feddrick' } });
  people = await client(['people:read']);
  noScope = await client(['students:read']);
});

afterAll(async () => {
  // Records created here are removed again; their persons stay (person numbers are never reused).
  const ids = [...created.students, ...created.faculty];
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: ids } } });
  for (const id of created.students) await prisma.student.delete({ where: { id } }).catch(() => {});
  for (const id of created.faculty) await prisma.faculty.delete({ where: { id } }).catch(() => {});
});

describe('every record belongs to exactly one person', () => {
  it('students and faculty all have a person, and a login with records belongs to the same person as its records', async () => {
    expect(await prisma.student.count({ where: { institutionId: inst.id } })).toBeGreaterThan(0);
    const logins = await prisma.user.findMany({ where: { institutionId: inst.id, OR: [{ student: { isNot: null } }, { faculty: { isNot: null } }] }, include: { student: true, faculty: true } });
    for (const u of logins) {
      expect(u.personId).toBeTruthy();
      for (const r of [u.student, u.faculty].filter(Boolean)) expect(r.personId).toBe(u.personId);
    }
    const staff = await prisma.user.findMany({ where: { institutionId: inst.id, role: { in: ['ADMIN', 'REGISTRAR'] } } });
    expect(staff.every((u) => u.personId === null)).toBe(true);
  });

  it('person numbers are P + 7 digits and unique per institution', async () => {
    const rows = await prisma.person.findMany({ where: { institutionId: inst.id }, select: { personNumber: true } });
    expect(rows.every((r) => /^P\d{7}$/.test(r.personNumber))).toBe(true);
    expect(new Set(rows.map((r) => r.personNumber)).size).toBe(rows.length);
  });
});

describe('v1 People API', () => {
  it('needs the people:read scope', async () => {
    expect((await noScope.get('/api/v1/people')).status).toBe(403);
    expect((await people.get('/api/v1/people?pageSize=5')).status).toBe(200);
  });

  it('looks a person up by student number and shows the relationship, primary email and status', async () => {
    const s = await prisma.student.findFirst({ where: { institutionId: inst.id, status: 'ACTIVE' }, include: { person: true } });
    const res = await people.get(`/api/v1/people?studentNumber=${s.studentNumber}`);
    expect(res.body.data).toHaveLength(1);
    const p = res.body.data[0];
    expect(p).toMatchObject({ id: s.personId, personNumber: s.person.personNumber, primaryEmail: s.email.toLowerCase(), status: 'ACTIVE' });
    expect(p.relationships).toEqual([expect.objectContaining({ type: 'STUDENT', sisId: s.id, number: s.studentNumber, current: true })]);
    expect((await people.get(`/api/v1/people/${s.personId}`)).body.data.id).toBe(s.personId);
    expect((await people.get('/api/v1/people/nope')).status).toBe(404);
  });

  it('student and faculty DTOs carry their personId', async () => {
    const s = await prisma.student.findFirst({ where: { institutionId: inst.id } });
    const c = await client(['students:read']);
    expect((await c.get(`/api/v1/students/${s.id}`)).body.data.personId).toBe(s.personId);
  });
});

describe('one person, two relationships', () => {
  let faculty;
  let studentId;

  it('a faculty member enrolled as a student is ONE person with both relationships; the faculty email is primary', async () => {
    faculty = await prisma.faculty.findFirst({ where: { institutionId: inst.id, status: 'ACTIVE', userId: { not: null }, person: { student: null } }, orderBy: { employeeNumber: 'desc' } });
    const programId = (await prisma.program.findFirst({ where: { institutionId: inst.id } })).id;
    const res = await admin.post('/api/app/admin/students', { firstName: faculty.firstName, lastName: faculty.lastName, email: `dual.${faculty.employeeNumber.toLowerCase()}@students.feddrick.edu`, programId, personOfFacultyId: faculty.id });
    expect(res.status).toBe(201);
    studentId = res.body.data.id;
    created.students.push(studentId);
    const p = (await people.get(`/api/v1/people?employeeNumber=${faculty.employeeNumber}`)).body.data[0];
    expect(p.id).toBe(faculty.personId);
    expect(p.relationships.map((r) => r.type).sort()).toEqual(['FACULTY', 'STUDENT']);
    expect(p.primaryEmail).toBe(faculty.email.toLowerCase());
    expect(p.emails).toContain(`dual.${faculty.employeeNumber.toLowerCase()}@students.feddrick.edu`);
    // Both numbers find the same person.
    expect((await people.get(`/api/v1/people?studentNumber=${res.body.data.studentNumber}`)).body.data[0].id).toBe(faculty.personId);
  });

  it('appears in the incremental feed after a change', async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const feed = (await people.get(`/api/v1/people?updatedSince=${encodeURIComponent(since)}&pageSize=100`)).body.data;
    expect(feed.some((p) => p.id === faculty.personId)).toBe(true);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await people.get(`/api/v1/people?updatedSince=${encodeURIComponent(future)}`)).body.data).toHaveLength(0);
  });

  it('withdrawing the student record keeps the login (faculty still uses it); disabling faculty too then disables it', async () => {
    const c = await client(['students:deactivate']);
    await setPolicy('api.allowStudentDeactivation', true);
    expect((await c.post(`/api/v1/students/${studentId}/deactivate`, { reason: 'Left the program' }).set('Idempotency-Key', `pr-${Date.now()}`)).status).toBe(200);
    await setPolicy('api.allowStudentDeactivation', false);
    expect((await prisma.user.findUnique({ where: { id: faculty.userId } })).status).toBe('ACTIVE');
    // The person is still ACTIVE (faculty), the student relationship is no longer current.
    const p = (await people.get(`/api/v1/people/${faculty.personId}`)).body.data;
    expect(p.status).toBe('ACTIVE');
    expect(p.relationships.find((r) => r.type === 'STUDENT').current).toBe(false);
    expect((await admin.patch(`/api/app/admin/faculty/${faculty.id}`, { status: 'DISABLED' })).status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: faculty.userId } })).status).toBe('DISABLED');
    expect((await people.get(`/api/v1/people/${faculty.personId}`)).body.data.status).toBe('INACTIVE');
    // Reactivating the faculty record gives the login back.
    expect((await admin.patch(`/api/app/admin/faculty/${faculty.id}`, { status: 'ACTIVE' })).status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: faculty.userId } })).status).toBe('ACTIVE');
  });

  it('a student appointed as faculty joins the student\'s person and login', async () => {
    const student = await prisma.student.findFirst({ where: { institutionId: inst.id, status: 'ACTIVE', userId: { not: null }, person: { faculty: null } }, orderBy: { studentNumber: 'desc' } });
    const departmentId = (await prisma.department.findFirst({ where: { institutionId: inst.id } })).id;
    const before = await prisma.user.count();
    const res = await admin.post('/api/app/admin/faculty', { firstName: student.firstName, lastName: student.lastName, email: `ta.${student.studentNumber.toLowerCase()}@feddrick.edu`, title: 'Teaching Assistant', departmentId, personOfStudentId: student.id });
    expect(res.status).toBe(201);
    created.faculty.push(res.body.data.id);
    expect(res.body.temporaryPassword).toBeNull();
    expect(await prisma.user.count()).toBe(before);
    const f = await prisma.faculty.findUnique({ where: { id: res.body.data.id } });
    expect(f).toMatchObject({ personId: student.personId, userId: student.userId });
    expect((await admin.post('/api/app/admin/faculty', { firstName: 'A', lastName: 'B', email: `x.${Date.now()}@feddrick.edu`, title: 'Lecturer', departmentId, personOfStudentId: student.id })).body.error.code).toBe('person_already_faculty');
  });
});

describe('same person (administrator confirmation)', () => {
  it('refuses when both people have an active login', async () => {
    const [a, b] = await prisma.student.findMany({ where: { institutionId: inst.id, status: 'ACTIVE', userId: { not: null } }, take: 2, orderBy: { studentNumber: 'asc' } });
    const f = await prisma.faculty.findFirst({ where: { institutionId: inst.id, userId: { not: null }, person: { student: null } } });
    const res = await admin.post(`/api/app/admin/persons/${f.personId}/records`, { recordType: 'STUDENT', recordId: a.id, reason: 'Checked photo ID in person' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('two_active_logins');
    const same = await admin.post(`/api/app/admin/persons/${b.personId}/records`, { recordType: 'STUDENT', recordId: b.id, reason: 'Checked photo ID in person' });
    expect(same.body.error.code).toBe('already_same_person');
  });

  it('is limited to identity administrators', async () => {
    const faculty = await login('faculty');
    const s = await prisma.student.findFirst({ where: { institutionId: inst.id } });
    expect((await faculty.get(`/api/app/admin/persons/${s.personId}`)).status).toBe(403);
    expect((await admin.get(`/api/app/admin/persons/${s.personId}`)).body.data.id).toBe(s.personId);
  });
});

describe('identity provisioning exclusion', () => {
  let s;
  let linker;
  beforeAll(async () => {
    s = await prisma.student.findFirst({ where: { institutionId: inst.id, status: 'ACTIVE', person: { faculty: null, identityExcluded: false } }, orderBy: { studentNumber: 'asc' } });
    linker = await client(['identity:read', 'identity:write']);
    await setPolicy('api.allowIdentityLinkWrites', true);
  });
  afterAll(async () => {
    await prisma.person.update({ where: { id: s.personId }, data: { identityExcluded: false, identityExcludedReason: null, identityExcludedAt: null } });
    await prisma.externalIdentityLink.deleteMany({ where: { externalUserId: { startsWith: 'excl-' } } });
    await setPolicy('api.allowIdentityLinkWrites', false);
  });

  it('needs a reason and an identity administrator', async () => {
    expect((await admin.put(`/api/app/admin/persons/${s.personId}/identity-exclusion`, { excluded: true, reason: 'x' })).status).toBe(400);
    const faculty = await login('faculty');
    expect((await faculty.put(`/api/app/admin/persons/${s.personId}/identity-exclusion`, { excluded: true, reason: 'Not part of the demo set' })).status).toBe(403);
  });

  it('an excluded person disappears from the People API (list, lookup by number, by id, change feed); records stay', async () => {
    const before = await prisma.registration.count({ where: { studentId: s.id } });
    const res = await admin.put(`/api/app/admin/persons/${s.personId}/identity-exclusion`, { excluded: true, reason: 'Not part of the demo set' });
    expect(res.status).toBe(200);
    expect(res.body.data.identityExcluded).toBe(true);
    expect((await people.get(`/api/v1/people?studentNumber=${s.studentNumber}`)).body.data).toHaveLength(0);
    expect((await people.get(`/api/v1/people/${s.personId}`)).status).toBe(404);
    const since = new Date(Date.now() - 60_000).toISOString();
    expect((await people.get(`/api/v1/people?updatedSince=${encodeURIComponent(since)}&pageSize=100`)).body.data.some((p) => p.id === s.personId)).toBe(false);
    expect(await prisma.student.count({ where: { id: s.id, status: 'ACTIVE' } })).toBe(1);
    expect(await prisma.registration.count({ where: { studentId: s.id } })).toBe(before);
    expect(await prisma.auditEvent.count({ where: { entityId: s.personId, action: 'person.identity_excluded' } })).toBe(1);
  });

  it('no external account can be linked to an excluded person\'s record', async () => {
    const r = await linker.post('/api/v1/identity/links', { confirm: true, externalUserId: 'excl-1', recordType: 'STUDENT', sisRecordId: s.id, externalEmail: s.email });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('person_identity_excluded');
  });

  it('included again: back in the API and in the change feed, and linkable', async () => {
    const res = await admin.put(`/api/app/admin/persons/${s.personId}/identity-exclusion`, { excluded: false, reason: 'Back in the demo set' });
    expect(res.body.data.identityExcluded).toBe(false);
    const since = new Date(Date.now() - 5_000).toISOString();
    expect((await people.get(`/api/v1/people?updatedSince=${encodeURIComponent(since)}&pageSize=100`)).body.data.some((p) => p.id === s.personId)).toBe(true);
    expect((await linker.post('/api/v1/identity/links', { confirm: true, externalUserId: 'excl-2', recordType: 'STUDENT', sisRecordId: s.id, externalEmail: s.email })).status).toBe(201);
  });
});
