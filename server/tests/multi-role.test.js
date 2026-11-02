// One login, several roles: a person who teaches and studies uses both areas with one account, and the
// university sign-in creates a login (no password) for a person who has records but no login yet.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, login, prisma, request, PASSWORD } from './helpers.js';
import { startOidcProvider } from './oidcProvider.js';
import { clearOidcCache } from '../src/lib/oidc.js';

const APP = 'http://cc.test';
const KEYS = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_APP_URL', 'OIDC_ALLOW_HTTP', 'OIDC_INSTITUTION_SLUG', 'OIDC_JIT_ACCOUNTS'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let idp;
let admin;
let inst;
let programId;
let dual;        // { faculty, studentId, studentNumber, studentEmail }
const createdStudents = [];
const createdUsers = [];

async function signIn(claims, { returnTo } = {}) {
  const agent = request.agent(app);
  const start = await agent.get(`/api/app/auth/oidc/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`);
  const callback = new URL(idp.issueCode(new URL(start.headers.location).href, { claims }));
  const cb = await agent.get(`${callback.pathname}${callback.search}`);
  expect(cb.status).toBe(302);
  const dest = new URL(cb.headers.location);
  return { agent, dest, error: dest.searchParams.get('sso_error'), path: dest.pathname };
}

async function newStudent(extra = {}) {
  const n = Math.random().toString(36).slice(2, 8);
  const res = await admin.post('/api/app/admin/students', { firstName: 'Jit', lastName: `Person${n}`, email: `jit.${n}@students.feddrick.edu`, programId, createLogin: false, ...extra });
  expect(res.status).toBe(201);
  createdStudents.push(res.body.data.id);
  return prisma.student.findUnique({ where: { id: res.body.data.id } });
}

beforeAll(async () => {
  idp = await startOidcProvider({ clientId: 'campuscore', clientSecret: 'cc-test-secret' });
  Object.assign(process.env, { OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'campuscore', OIDC_CLIENT_SECRET: 'cc-test-secret', OIDC_APP_URL: APP, OIDC_ALLOW_HTTP: 'true', OIDC_INSTITUTION_SLUG: 'feddrick' });
  delete process.env.OIDC_JIT_ACCOUNTS;
  clearOidcCache();
  admin = await login('admin');
  inst = await prisma.institution.findUnique({ where: { slug: 'feddrick' } });
  programId = (await prisma.program.findFirst({ where: { institutionId: inst.id } })).id;
  // A lecturer who also enrols as a student: one person, one login.
  const faculty = await prisma.faculty.findFirst({ where: { institutionId: inst.id, status: 'ACTIVE', userId: { not: null }, person: { student: null } }, orderBy: { employeeNumber: 'asc' }, include: { user: true } });
  const studentEmail = `both.${faculty.employeeNumber.toLowerCase()}@students.feddrick.edu`;
  const res = await admin.post('/api/app/admin/students', { firstName: faculty.firstName, lastName: faculty.lastName, email: studentEmail, programId, personOfFacultyId: faculty.id });
  createdStudents.push(res.body.data.id);
  dual = { faculty, studentId: res.body.data.id, studentNumber: res.body.data.studentNumber, studentEmail };
});

afterAll(async () => {
  await prisma.userIdentityLink.deleteMany({ where: { issuer: idp.issuer } });
  await prisma.session.deleteMany({ where: { oidcIssuer: idp.issuer } });
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: [...createdStudents, ...createdUsers] } } });
  for (const id of createdStudents) await prisma.student.delete({ where: { id } }).catch(() => {});
  for (const id of createdUsers) await prisma.user.delete({ where: { id } }).catch(() => {});
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  clearOidcCache();
  await idp.close();
});

describe('one login, two roles', () => {
  it('a lecturer who studies holds FACULTY and STUDENT, both permission sets, and lands on the persona chooser', async () => {
    const me = await login(dual.faculty.user.email);
    expect(me.user.roles).toEqual(['FACULTY', 'STUDENT']);
    expect(me.user.home).toBe('/');
    expect(me.user.permissions).toEqual(expect.arrayContaining(['teaching.manage', 'self.service']));
    expect(me.user.permissions).not.toContain('users.manage');
    expect((await me.get('/api/app/faculty/sections')).status).toBe(200);
    const profile = await me.get('/api/app/student/profile');
    expect(profile.status).toBe(200);
    expect(profile.body.data.studentNumber).toBe(dual.studentNumber);
    expect((await me.get('/api/app/admin/students')).status).toBe(403);
  });

  it('a single-role account is unchanged: one role, its own home', async () => {
    const me = await login('student');
    expect(me.user.roles).toEqual(['STUDENT']);
    expect(me.user.home).toBe('/student');
    expect((await me.get('/api/app/faculty/sections')).status).toBe(403);
    const staff = await login('registrar');
    expect(staff.user.roles).toEqual(['REGISTRAR']);
  });

  it('the users list shows both roles and filters by either', async () => {
    const asFaculty = (await admin.get(`/api/app/admin/users?role=FACULTY&search=${encodeURIComponent(dual.faculty.user.email)}`)).body.data;
    expect(asFaculty[0].roles).toEqual(['FACULTY', 'STUDENT']);
    const asStudent = (await admin.get(`/api/app/admin/users?role=STUDENT&search=${encodeURIComponent(dual.faculty.user.email)}`)).body.data;
    expect(asStudent).toHaveLength(1);
  });

  it('university sign-in with both numbers (and the student address) reaches the same login and the chooser', async () => {
    const { agent, error, path } = await signIn({ sub: 'kc-dual', email: dual.studentEmail, email_verified: true, student_number: dual.studentNumber, employee_number: dual.faculty.employeeNumber });
    expect(error).toBeNull();
    expect(path).toBe('/');
    const me = (await agent.get('/api/app/auth/me')).body.user;
    expect(me.id).toBe(dual.faculty.userId);
    expect(me.roles).toEqual(['FACULTY', 'STUDENT']);
  });

  it('a returnTo picks the persona directly (e.g. the portal\'s "Student records" link)', async () => {
    const { path } = await signIn({ sub: 'kc-dual', email: dual.faculty.email, email_verified: true, employee_number: dual.faculty.employeeNumber }, { returnTo: '/student' });
    expect(path).toBe('/student');
  });
});

describe('SSO-first: a login is created at the first university sign-in', () => {
  it('without OIDC_JIT_ACCOUNTS a person with no login is refused', async () => {
    const s = await newStudent();
    const { error } = await signIn({ sub: `kc-${s.id}`, email: s.email, email_verified: true, student_number: s.studentNumber });
    expect(error).toBe('NO_CAMPUSCORE_LOGIN');
  });

  it('with it, the person gets one login without a password, attached to their record', async () => {
    process.env.OIDC_JIT_ACCOUNTS = 'true';
    const s = await newStudent();
    const { agent, error, path } = await signIn({ sub: `kc-${s.id}`, email: s.email, email_verified: true, student_number: s.studentNumber });
    expect(error).toBeNull();
    expect(path).toBe('/student');
    const user = await prisma.user.findUnique({ where: { email: s.email } });
    createdUsers.push(user.id);
    expect(user).toMatchObject({ personId: s.personId, passwordHash: null, role: 'STUDENT', status: 'ACTIVE' });
    expect((await prisma.student.findUnique({ where: { id: s.id } })).userId).toBe(user.id);
    const me = (await agent.get('/api/app/auth/me')).body;
    expect(me.user).toMatchObject({ roles: ['STUDENT'], hasPassword: false });
    const pw = await agent.post('/api/app/auth/change-password').set('X-CSRF-Token', me.csrfToken).send({ currentPassword: 'x', newPassword: 'abcdefghijk1' });
    expect(pw.status).toBe(409);
    expect(pw.body.error.code).toBe('sso_only_account');
    expect((await request(app).post('/api/app/auth/login').send({ email: s.email, password: PASSWORD })).status).toBe(401);
    expect(await prisma.auditEvent.count({ where: { entityId: user.id, action: 'auth.sso_account_created' } })).toBe(1);
    // The second sign-in uses the link; no second login.
    expect((await signIn({ sub: `kc-${s.id}`, email: s.email, email_verified: true, student_number: s.studentNumber })).error).toBeNull();
    expect(await prisma.user.count({ where: { personId: s.personId } })).toBe(1);
  });

  it('never for a person whose numbers belong to two people, an unverified or foreign email, or no current relationship', async () => {
    process.env.OIDC_JIT_ACCOUNTS = 'true';
    const a = await newStudent();
    const b = await newStudent();
    expect((await signIn({ sub: 'kc-two', email: a.email, email_verified: true, student_number: [a.studentNumber, b.studentNumber] })).error).toBe('AMBIGUOUS_RECORDS');
    expect((await signIn({ sub: 'kc-unverified', email: a.email, email_verified: false, student_number: a.studentNumber })).error).toBe('EMAIL_NOT_VERIFIED');
    expect((await signIn({ sub: 'kc-foreign', email: b.email, email_verified: true, student_number: a.studentNumber })).error).toBe('EVIDENCE_MISMATCH');
    await prisma.student.update({ where: { id: b.id }, data: { status: 'WITHDRAWN' } });
    expect((await signIn({ sub: 'kc-withdrawn', email: b.email, email_verified: true, student_number: b.studentNumber })).error).toBe('NO_CURRENT_RELATIONSHIP');
    expect(await prisma.user.count({ where: { personId: { in: [a.personId, b.personId] } } })).toBe(0);
  });

  it('never for a person excluded from identity provisioning', async () => {
    process.env.OIDC_JIT_ACCOUNTS = 'true';
    const s = await newStudent();
    await prisma.person.update({ where: { id: s.personId }, data: { identityExcluded: true } });
    expect((await signIn({ sub: 'kc-excluded', email: s.email, email_verified: true, student_number: s.studentNumber })).error).toBe('IDENTITY_EXCLUDED');
    expect(await prisma.user.count({ where: { personId: s.personId } })).toBe(0);
  });

  it('never creates a staff account, and never reuses an address another login already has', async () => {
    process.env.OIDC_JIT_ACCOUNTS = 'true';
    const s = await newStudent({ email: 'registrar@feddrick.edu' });
    expect((await signIn({ sub: 'kc-clash', email: 'registrar@feddrick.edu', email_verified: true, student_number: s.studentNumber })).error).toBe('EMAIL_IN_USE');
  });
});
