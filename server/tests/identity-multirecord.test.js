// One external account, two relationships: a faculty member who is also a student holds ONE active faculty link
// and ONE active student link, only when both records belong to the same CampusCore person.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { login, getToken, api, prisma, setPolicy } from './helpers.js';

let admin;
let c;
let inst;
let faculty;       // the person's faculty record (has a CampusCore user)
let sameStudent;   // a student record moved onto the SAME CampusCore user for this test
let otherStudent;  // a student record of a different person
let noUserStudent; // a student record with no CampusCore user
const restore = [];

async function client(scopes) {
  const created = await admin.post('/api/app/admin/integrations', { name: `Multi-record ${Math.random().toString(36).slice(2, 7)}`, scopes });
  const tok = (await getToken(created.body.client.clientId, created.body.clientSecret)).body.access_token;
  return { call: api(tok) };
}
const link = (body) => c.call.post('/api/v1/identity/links', { confirm: true, ...body });

beforeAll(async () => {
  admin = await login('admin');
  inst = await prisma.institution.findUnique({ where: { slug: 'feddrick' } });
  c = await client(['identity:read', 'identity:write']);
  await setPolicy('api.allowIdentityLinkWrites', true);
  faculty = await prisma.faculty.findFirst({ where: { institutionId: inst.id, userId: { not: null }, status: 'ACTIVE' }, orderBy: { employeeNumber: 'desc' } });
  const students = await prisma.student.findMany({ where: { institutionId: inst.id, userId: { not: null }, status: 'ACTIVE' }, orderBy: { studentNumber: 'desc' }, take: 3 });
  [sameStudent, otherStudent, noUserStudent] = students;
  for (const s of [sameStudent, noUserStudent]) restore.push({ id: s.id, userId: s.userId, personId: s.personId });
  // Test-database fixture: this student record now belongs to the faculty member's person (and login).
  sameStudent = await prisma.student.update({ where: { id: sameStudent.id }, data: { personId: faculty.personId, userId: faculty.userId } });
  // ...and this one is a person of its own with no CampusCore login.
  await prisma.user.update({ where: { id: noUserStudent.userId }, data: { personId: null } });
  noUserStudent = await prisma.student.update({ where: { id: noUserStudent.id }, data: { userId: null } });
});

afterAll(async () => {
  await prisma.externalIdentityLink.deleteMany({ where: { externalUserId: { startsWith: 'multi-' } } });
  for (const r of restore) {
    await prisma.student.update({ where: { id: r.id }, data: { userId: r.userId, personId: r.personId } });
    await prisma.user.update({ where: { id: r.userId }, data: { personId: r.personId } });
    await prisma.person.update({ where: { id: r.personId }, data: { mergedIntoId: null } });
  }
  await setPolicy('api.allowIdentityLinkWrites', false);
});

describe('one account, a student link and a faculty link', () => {
  it('links the faculty record, then the same person\'s student record (email of the linked record is accepted)', async () => {
    const f = await link({ externalUserId: 'multi-1', recordType: 'FACULTY', sisRecordId: faculty.id, externalEmail: faculty.email });
    expect(f.status).toBe(201);
    const s = await link({ externalUserId: 'multi-1', recordType: 'STUDENT', sisRecordId: sameStudent.id, externalEmail: faculty.email });
    expect(s.status).toBe(201);
    expect(s.body.data.evidence).toMatchObject({ samePerson: 'CAMPUSCORE_PERSON', emailMatch: true });
  });

  it('resolves each relationship by record type, and fails closed without one', async () => {
    const asStudent = (await c.call.get('/api/v1/identity/resolve?externalUserId=multi-1&recordType=STUDENT')).body.data;
    expect(asStudent).toMatchObject({ status: 'LINKED', recordType: 'STUDENT', sisId: sameStudent.id, institutionalId: sameStudent.studentNumber });
    const asFaculty = (await c.call.get('/api/v1/identity/resolve?externalUserId=multi-1&recordType=FACULTY')).body.data;
    expect(asFaculty).toMatchObject({ status: 'LINKED', recordType: 'FACULTY', sisId: faculty.id, institutionalId: faculty.employeeNumber });
    const unspecified = (await c.call.get('/api/v1/identity/resolve?externalUserId=multi-1')).body.data;
    expect(unspecified.status).toBe('LINKED_MULTIPLE');
    expect(unspecified.sisId).toBeUndefined();
    expect(unspecified.links.map((l) => l.recordType).sort()).toEqual(['FACULTY', 'STUDENT']);
  });

  it('never a second link of the same type for one account', async () => {
    const dup = await link({ externalUserId: 'multi-1', recordType: 'STUDENT', sisRecordId: otherStudent.id, externalEmail: otherStudent.email });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('identity_already_linked');
  });

  it('refuses a student record that belongs to a different person', async () => {
    await link({ externalUserId: 'multi-2', recordType: 'FACULTY', sisRecordId: (await prisma.faculty.findFirst({ where: { institutionId: inst.id, userId: { not: null }, id: { not: faculty.id }, status: 'ACTIVE' } })).id, confirm: true });
    const res = await link({ externalUserId: 'multi-2', recordType: 'STUDENT', sisRecordId: otherStudent.id, externalEmail: otherStudent.email, evidenceMismatchReason: 'even with a reason' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('identity_different_person');
  });

  it('a record of another person is refused, even with a reason, until CampusCore confirms the same person', async () => {
    const without = await link({ externalUserId: 'multi-2', recordType: 'STUDENT', sisRecordId: noUserStudent.id, externalEmail: noUserStudent.email, evidenceMismatchReason: 'Registrar verified ID in person' });
    expect(without.status).toBe(422);
    expect(without.body.error.code).toBe('identity_different_person');
    const multi2Faculty = (await c.call.get('/api/v1/identity/resolve?externalUserId=multi-2&recordType=FACULTY')).body.data;
    const facultyPerson = (await prisma.faculty.findUnique({ where: { id: multi2Faculty.sisId } })).personId;
    const short = await admin.post(`/api/app/admin/persons/${facultyPerson}/records`, { recordType: 'STUDENT', recordId: noUserStudent.id, reason: 'same' });
    expect(short.status).toBe(400);
    const merged = await admin.post(`/api/app/admin/persons/${facultyPerson}/records`, { recordType: 'STUDENT', recordId: noUserStudent.id, reason: 'Registrar compared photo ID with both records' });
    expect(merged.status).toBe(200);
    expect((await prisma.person.findUnique({ where: { id: noUserStudent.personId } })).mergedIntoId).toBe(facultyPerson);
    const withPerson = await link({ externalUserId: 'multi-2', recordType: 'STUDENT', sisRecordId: noUserStudent.id, externalEmail: noUserStudent.email });
    expect(withPerson.status).toBe(201);
    expect(withPerson.body.data.evidence.samePerson).toBe('CAMPUSCORE_PERSON');
  });

  it('a student record already linked elsewhere cannot be linked again', async () => {
    const res = await link({ externalUserId: 'multi-3', recordType: 'STUDENT', sisRecordId: sameStudent.id, externalEmail: sameStudent.email });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('record_already_linked');
  });

  it('an account with a single link resolves exactly as before', async () => {
    const one = (await c.call.get('/api/v1/identity/resolve?externalUserId=multi-3')).body.data;
    expect(one.status).toBe('UNMAPPED');
    const f = await link({ externalUserId: 'multi-4', recordType: 'STUDENT', sisRecordId: otherStudent.id, externalEmail: otherStudent.email });
    expect(f.status).toBe(201);
    const resolved = (await c.call.get('/api/v1/identity/resolve?externalUserId=multi-4')).body.data;
    expect(resolved).toMatchObject({ status: 'LINKED', recordType: 'STUDENT', sisId: otherStudent.id });
    expect((await c.call.get('/api/v1/identity/resolve?externalUserId=multi-4&recordType=FACULTY')).body.data.status).toBe('UNMAPPED');
  });
});

describe('registrar enrols an existing faculty member as a student (same person)', () => {
  let created;
  afterAll(async () => {
    if (created) {
      await prisma.auditEvent.deleteMany({ where: { entityId: created } });
      await prisma.student.delete({ where: { id: created } });
    }
  });

  it('creates the student record on the faculty member\'s own CampusCore account, without a second login', async () => {
    const programId = (await prisma.program.findFirst({ where: { institutionId: inst.id } })).id;
    const person = await prisma.faculty.findFirst({ where: { institutionId: inst.id, userId: { not: null }, id: { not: faculty.id }, person: { student: null } }, orderBy: { employeeNumber: 'asc' } });
    const before = await prisma.user.count();
    const res = await admin.post('/api/app/admin/students', { firstName: person.firstName, lastName: person.lastName, email: `enrolled.${person.employeeNumber.toLowerCase()}@students.feddrick.edu`, programId, personOfFacultyId: person.id });
    expect(res.status).toBe(201);
    created = res.body.data.id;
    expect(res.body.temporaryPassword).toBeNull();
    expect(await prisma.user.count()).toBe(before);
    const student = await prisma.student.findUnique({ where: { id: created } });
    expect(student.userId).toBe(person.userId);
    expect(student.personId).toBe(person.personId);
    const again = await admin.post('/api/app/admin/students', { firstName: 'X', lastName: 'Y', email: `again.${Date.now()}@students.feddrick.edu`, programId, personOfFacultyId: person.id });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('person_already_student');
  });
});
