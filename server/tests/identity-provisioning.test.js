// Automatic university-account provisioning: record changes queue the person in the same transaction (database
// triggers), the worker reconciles their account in a test Keycloak (tests/keycloakStub.js, never a real realm),
// and every failure leaves the CampusCore records untouched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { KeycloakAdminClient } from '@campuscore/identity-sync/clients';
import { login, prisma } from './helpers.js';
import { runOnce } from '../src/services/identityProvisioningService.js';
import { startKeycloakStub, REALM, CLIENT_ID, CLIENT_SECRET } from './keycloakStub.js';

let kc;
let keycloak;
let admin;
let registrar;
let inst;
let department;
const tag = Math.random().toString(36).slice(2, 7);
let n = 0;

const run = (personIds, opts = {}) => runOnce({ keycloak, personIds, maxAttempts: 3, sendSetupEmail: false, ...opts });
const rowOf = (personId) => prisma.identityProvisioning.findUnique({ where: { personId } });
const due = (personId) => prisma.identityProvisioning.update({ where: { personId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
const audits = (personId, action) => prisma.auditEvent.findMany({ where: { entityId: personId, action } });
const personNumberOf = async (personId) => (await prisma.person.findUnique({ where: { id: personId } })).personNumber;

async function newStudent(over = {}) {
  n += 1;
  const res = await admin.post('/api/app/admin/students', { firstName: 'Ada', lastName: `Prov${tag}${n}`, email: `ada.${tag}.${n}@students.feddrick.edu`, createLogin: false, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return prisma.student.findUnique({ where: { id: res.body.data.id } });
}

async function newFaculty(over = {}) {
  n += 1;
  const res = await admin.post('/api/app/admin/faculty', { firstName: 'Grace', lastName: `Prov${tag}${n}`, email: `grace.${tag}.${n}@feddrick.edu`, title: 'Lecturer', departmentId: department.id, createLogin: false, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return prisma.faculty.findUnique({ where: { id: res.body.data.id } });
}

beforeAll(async () => {
  kc = await startKeycloakStub();
  keycloak = new KeycloakAdminClient({ baseUrl: kc.baseUrl, realm: REALM, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, timeoutMs: 2000 });
  admin = await login('admin');
  registrar = await login('registrar');
  inst = await prisma.institution.findUnique({ where: { slug: 'feddrick' } });
  department = await prisma.department.findFirst({ where: { institutionId: inst.id } });
});

afterAll(async () => {
  await kc.close();
});

describe('1. a new student is queued in the same transaction', () => {
  it('creating a student records a PENDING provisioning request for their person', async () => {
    const s = await newStudent();
    const row = await rowOf(s.personId);
    expect(row).toMatchObject({ status: 'PENDING', institutionId: inst.id, attempts: 0, keycloakUserId: null });
  });

  it('a record change that rolls back leaves no request behind (no request without a committed change)', async () => {
    const personNumber = `PX${tag}`;
    await expect(prisma.$transaction(async (tx) => {
      const p = await tx.person.create({ data: { institutionId: inst.id, personNumber } });
      await tx.student.create({ data: { institutionId: inst.id, personId: p.id, studentNumber: `SX${tag}`, firstName: 'Roll', lastName: 'Back', email: `roll.${tag}@students.feddrick.edu` } });
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await prisma.person.findFirst({ where: { personNumber } })).toBeNull();
    expect(await prisma.identityProvisioning.count({ where: { person: { personNumber } } })).toBe(0);
  });
});

describe('2. the worker creates the university account', () => {
  it('one account with the institutional identifiers, a verified address, the learner role and no password', async () => {
    const s = await newStudent();
    const [result] = await run([s.personId]);
    expect(result).toMatchObject({ status: 'PROVISIONED', action: 'CREATE' });
    const row = await rowOf(s.personId);
    expect(row.status).toBe('PROVISIONED');
    const account = kc.find('person_number', await personNumberOf(s.personId));
    expect(account).toHaveLength(1);
    expect(row.keycloakUserId).toBe(account[0].id);
    expect(account[0]).toMatchObject({ email: s.email, emailVerified: true, enabled: true, firstName: s.firstName, lastName: s.lastName, requiredActions: ['UPDATE_PASSWORD'] });
    expect(account[0].attributes).toEqual({ person_number: [await personNumberOf(s.personId)], student_number: [s.studentNumber] });
    expect(account[0].credentials).toBeUndefined();
    expect(kc.rolesOf(account[0].id)).toEqual(['learner']);
    expect(await audits(s.personId, 'identity.account_created')).toHaveLength(1);
  });

  it('sends Keycloak\'s own set-your-password email only when enabled (needs realm SMTP)', async () => {
    const s = await newStudent();
    await run([s.personId], { sendSetupEmail: true });
    const id = (await rowOf(s.personId)).keycloakUserId;
    expect(kc.state.emails).toContainEqual({ id, actions: ['UPDATE_PASSWORD'] });
    expect((await rowOf(s.personId)).setupEmailSentAt).not.toBeNull();
  });
});

describe('3. changes to a person\'s identity attributes follow automatically', () => {
  it('a name and address change updates the same account', async () => {
    const s = await newStudent();
    await run([s.personId]);
    const id = (await rowOf(s.personId)).keycloakUserId;
    const res = await admin.patch(`/api/app/admin/students/${s.id}`, { lastName: `Renamed${tag}`, email: `renamed.${tag}@students.feddrick.edu` });
    expect(res.status).toBe(200);
    expect((await rowOf(s.personId)).status).toBe('PENDING');
    const [result] = await run([s.personId]);
    expect(result).toMatchObject({ status: 'PROVISIONED', action: 'UPDATE' });
    const account = kc.find('person_number', await personNumberOf(s.personId));
    expect(account.map((a) => a.id)).toEqual([id]);
    expect(account[0]).toMatchObject({ lastName: `Renamed${tag}`, email: `renamed.${tag}@students.feddrick.edu` });
    expect((await rowOf(s.personId)).lastResult.changed).toEqual(expect.arrayContaining(['email', 'lastName']));
  });

  it('a change that does not affect the account (contact details) does not queue anything', async () => {
    const s = await newStudent();
    await run([s.personId]);
    const before = await rowOf(s.personId);
    await admin.patch(`/api/app/admin/students/${s.id}`, { phone: '555-0100', city: 'Springfield' });
    const after = await rowOf(s.personId);
    expect([after.status, after.requestedVersion]).toEqual(['PROVISIONED', before.requestedVersion]);
  });

  it('a withdrawn student keeps the account, disabled and without the learner role (never deleted)', async () => {
    const s = await newStudent();
    await run([s.personId]);
    expect((await admin.post(`/api/app/admin/students/${s.id}/status`, { status: 'WITHDRAWN', reason: 'Withdrew for personal reasons' })).status).toBe(200);
    await run([s.personId]);
    const [account] = kc.find('person_number', await personNumberOf(s.personId));
    expect(account.enabled).toBe(false);
    expect(kc.rolesOf(account.id)).toEqual([]);
  });
});

describe('4. a person who studies and teaches has one university account', () => {
  it('appointing a student as faculty adds the employee number and faculty role to the same account', async () => {
    const s = await newStudent();
    await run([s.personId]);
    const accounts = kc.count();
    const f = await newFaculty({ personOfStudentId: s.id });
    expect(f.personId).toBe(s.personId);
    const [result] = await run([s.personId]);
    expect(result).toMatchObject({ status: 'PROVISIONED', action: 'UPDATE' });
    expect(kc.count()).toBe(accounts);
    const [account] = kc.find('person_number', await personNumberOf(s.personId));
    expect(account.attributes).toMatchObject({ student_number: [s.studentNumber], employee_number: [f.employeeNumber] });
    expect(kc.rolesOf(account.id)).toEqual(['faculty', 'learner']);
    expect(account.email).toBe(f.email); // the institution addresses a person who teaches and studies as staff
  });
});

describe('5–7. existing accounts are adopted only on institutional identifiers', () => {
  it('5. adopts a hand-made account that carries the student number and the student\'s address', async () => {
    const s = await newStudent();
    const existing = kc.addUser({ username: `hand.${tag}.5`, email: s.email, attributes: { student_number: [s.studentNumber] } });
    const accounts = kc.count();
    const [result] = await run([s.personId]);
    expect(result).toMatchObject({ status: 'PROVISIONED', action: 'ADOPT' });
    expect(kc.count()).toBe(accounts);
    expect((await rowOf(s.personId)).keycloakUserId).toBe(existing);
    expect(kc.find('person_number', await personNumberOf(s.personId)).map((a) => a.id)).toEqual([existing]);
    expect(await audits(s.personId, 'identity.account_adopted')).toHaveLength(1);
  });

  it('6. never adopts on email alone: the account is left untouched and the person needs review', async () => {
    const s = await newStudent();
    const existing = kc.addUser({ username: `hand.${tag}.6`, email: s.email });
    const accounts = kc.count();
    const [result] = await run([s.personId]);
    expect(result).toMatchObject({ status: 'NEEDS_REVIEW', reason: 'EMAIL_IN_USE_WITHOUT_NUMBER' });
    expect(kc.count()).toBe(accounts);
    expect(kc.find('person_number', await personNumberOf(s.personId))).toHaveLength(0);
    expect(await audits(s.personId, 'identity.provisioning_needs_review')).toHaveLength(1);

    // Reprocessing does not repeat the review event; an administrator (not a registrar) can confirm the account.
    await prisma.identityProvisioning.update({ where: { personId: s.personId }, data: { status: 'PENDING' } });
    await run([s.personId]);
    expect(await audits(s.personId, 'identity.provisioning_needs_review')).toHaveLength(1);
    const body = { accountId: existing, reason: 'Checked the account with the student in person' };
    expect((await registrar.post(`/api/app/admin/persons/${s.personId}/identity-provisioning/adopt`, body)).status).toBe(403);
    expect((await admin.post(`/api/app/admin/persons/${s.personId}/identity-provisioning/adopt`, body)).status).toBe(200);
    const [adopted] = await run([s.personId]);
    expect(adopted).toMatchObject({ status: 'PROVISIONED', action: 'ADOPT' });
    expect((await rowOf(s.personId)).adoptAccountId).toBeNull();
    expect(kc.find('person_number', await personNumberOf(s.personId)).map((a) => a.id)).toEqual([existing]);
  });

  it('7. duplicate or conflicting institutional identifiers go to review, never to automatic adoption', async () => {
    const twice = await newStudent();
    kc.addUser({ username: `dup.${tag}.a`, email: twice.email, attributes: { student_number: [twice.studentNumber] } });
    kc.addUser({ username: `dup.${tag}.b`, email: `other.${tag}@students.feddrick.edu`, attributes: { student_number: [twice.studentNumber] } });
    expect((await run([twice.personId]))[0]).toMatchObject({ status: 'NEEDS_REVIEW', reason: 'AMBIGUOUS_ACCOUNTS' });

    const taken = await newStudent();
    kc.addUser({ username: `taken.${tag}`, email: taken.email, attributes: { person_number: ['P9999999'], student_number: [taken.studentNumber] } });
    expect((await run([taken.personId]))[0]).toMatchObject({ status: 'NEEDS_REVIEW', reason: 'NUMBER_HELD_BY_OTHER_PERSON' });

    const foreign = await newStudent();
    kc.addUser({ username: `foreign.${tag}`, email: `someone.${tag}@elsewhere.edu`, attributes: { student_number: [foreign.studentNumber] } });
    expect((await run([foreign.personId]))[0]).toMatchObject({ status: 'NEEDS_REVIEW', reason: 'EVIDENCE_MISMATCH' });

    const twoPeople = await newStudent();
    kc.addUser({ username: `pn.${tag}.a`, attributes: { person_number: [await personNumberOf(twoPeople.personId)] } });
    kc.addUser({ username: `pn.${tag}.b`, attributes: { person_number: [await personNumberOf(twoPeople.personId)] } });
    expect((await run([twoPeople.personId]))[0]).toMatchObject({ status: 'NEEDS_REVIEW', reason: 'DUPLICATE_PERSON_NUMBER' });
  });
});

describe('8. Keycloak downtime: retried with backoff, nothing lost', () => {
  it('the record is saved, the request waits, and is provisioned once Keycloak is back', async () => {
    kc.state.down = true;
    try {
      const s = await newStudent();
      expect(s).toBeTruthy();
      const [result] = await run([s.personId]);
      expect(result.status).toBe('PENDING');
      const row = await rowOf(s.personId);
      expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(row.lastErrorCode).toBeTruthy();
      expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
      expect(await run([s.personId])).toEqual([]); // not due yet: no hammering
      expect(await audits(s.personId, 'identity.provisioning_failed')).toHaveLength(1);
      expect(await prisma.student.findUnique({ where: { id: s.id } })).not.toBeNull();

      kc.state.down = false;
      await due(s.personId);
      expect((await run([s.personId]))[0]).toMatchObject({ status: 'PROVISIONED', action: 'CREATE' });
      expect((await rowOf(s.personId)).attempts).toBe(0);
    } finally {
      kc.state.down = false;
    }
  });

  it('an unreachable Keycloak is retried too; after the last attempt it is FAILED until an administrator retries', async () => {
    const s = await newStudent();
    const unreachable = new KeycloakAdminClient({ baseUrl: 'http://127.0.0.1:9', realm: REALM, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, timeoutMs: 1000 });
    expect((await runOnce({ keycloak: unreachable, personIds: [s.personId], maxAttempts: 2 }))[0]).toMatchObject({ status: 'PENDING', errorCode: 'UNAVAILABLE' });
    await due(s.personId);
    expect((await runOnce({ keycloak: unreachable, personIds: [s.personId], maxAttempts: 2 }))[0]).toMatchObject({ status: 'FAILED', errorCode: 'UNAVAILABLE' });
    expect(await run([s.personId])).toEqual([]); // FAILED is not picked up automatically

    const retried = await registrar.post(`/api/app/admin/persons/${s.personId}/identity-provisioning/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.data).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(await audits(s.personId, 'identity.provisioning_retried')).toHaveLength(1);
    expect((await run([s.personId]))[0]).toMatchObject({ status: 'PROVISIONED', action: 'CREATE' });
  });

  it('a configuration problem (refused credentials) fails at once instead of retrying for hours', async () => {
    const s = await newStudent();
    const wrong = new KeycloakAdminClient({ baseUrl: kc.baseUrl, realm: REALM, clientId: CLIENT_ID, clientSecret: 'not-the-secret', timeoutMs: 1000 });
    expect((await runOnce({ keycloak: wrong, personIds: [s.personId], maxAttempts: 5 }))[0]).toMatchObject({ status: 'FAILED', errorCode: 'AUTH_FAILED' });
  });
});

describe('9. processing again never duplicates an account', () => {
  it('a redelivered request reconciles to UNCHANGED', async () => {
    const s = await newStudent();
    await run([s.personId]);
    const accounts = kc.count();
    await prisma.identityProvisioning.update({ where: { personId: s.personId }, data: { status: 'PENDING' } });
    expect((await run([s.personId]))[0]).toMatchObject({ status: 'PROVISIONED', action: 'UNCHANGED' });
    expect(kc.count()).toBe(accounts);
  });

  it('an account created whose response was lost is found again by person number, not created twice', async () => {
    const s = await newStudent();
    const accounts = kc.count();
    kc.state.loseNextCreateResponse = true;
    expect((await run([s.personId]))[0].status).toBe('PENDING');
    expect(kc.count()).toBe(accounts + 1);
    await due(s.personId);
    expect((await run([s.personId]))[0]).toMatchObject({ status: 'PROVISIONED', action: 'UPDATE' });
    expect(kc.count()).toBe(accounts + 1);
    const [account] = kc.find('person_number', await personNumberOf(s.personId));
    expect(kc.rolesOf(account.id)).toEqual(['learner']);
  });

  it('a change made while the person is being processed is processed again afterwards', async () => {
    const s = await newStudent();
    let changed = false;
    const changing = new Proxy(keycloak, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== 'byAttribute') return typeof value === 'function' ? value.bind(target) : value;
        return async (...args) => {
          if (!changed) { changed = true; await prisma.student.update({ where: { id: s.id }, data: { lastName: `During${tag}` } }); }
          return value.apply(target, args);
        };
      },
    });
    await runOnce({ keycloak: changing, personIds: [s.personId], maxAttempts: 3 });
    expect((await rowOf(s.personId)).status).toBe('PENDING');
    expect((await run([s.personId]))[0]).toMatchObject({ status: 'PROVISIONED', action: 'UPDATE' });
    expect(kc.find('person_number', await personNumberOf(s.personId))[0].lastName).toBe(`During${tag}`);
  });
});

describe('10. person merges keep one account per person', () => {
  it('each was provisioned separately: the survivor keeps its account, the merged one needs review until disabled', async () => {
    const s = await newStudent();
    const f = await newFaculty();
    await run([s.personId, f.personId]);
    const studentAccount = (await rowOf(s.personId)).keycloakUserId;
    const facultyAccount = (await rowOf(f.personId)).keycloakUserId;
    const res = await admin.post(`/api/app/admin/persons/${f.personId}/records`, { recordType: 'STUDENT', recordId: s.id, reason: 'Same human being, verified ID card' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await rowOf(s.personId)).status).toBe('PENDING');
    expect((await rowOf(f.personId)).status).toBe('PENDING');
    const results = Object.fromEntries((await run([s.personId, f.personId])).map((r) => [r.personId, r]));
    expect(results[f.personId]).toMatchObject({ status: 'PROVISIONED', action: 'UPDATE' });
    expect(results[s.personId]).toMatchObject({ status: 'NEEDS_REVIEW', reason: 'MERGED_PERSON_HAS_ACCOUNT' });
    const [survivor] = kc.find('person_number', await personNumberOf(f.personId));
    expect(survivor.id).toBe(facultyAccount);
    expect(survivor.attributes).toMatchObject({ student_number: [s.studentNumber], employee_number: [f.employeeNumber] });
    expect(kc.rolesOf(survivor.id)).toEqual(['faculty', 'learner']);

    kc.update(studentAccount, { enabled: false }); // the administrator disables the extra account in Keycloak
    await admin.post(`/api/app/admin/persons/${s.personId}/identity-provisioning/retry`);
    expect((await run([s.personId]))[0]).toMatchObject({ status: 'SKIPPED', reason: 'MERGED_PERSON' });
  });

  it('only the merged person had an account: the survivor adopts it (same human being) instead of creating another', async () => {
    const s = await newStudent();
    await run([s.personId]);
    const studentAccount = (await rowOf(s.personId)).keycloakUserId;
    const f = await newFaculty();
    expect((await admin.post(`/api/app/admin/persons/${f.personId}/records`, { recordType: 'STUDENT', recordId: s.id, reason: 'Same human being, verified ID card' })).status).toBe(200);
    const accounts = kc.count();
    const results = Object.fromEntries((await run([f.personId, s.personId])).map((r) => [r.personId, r]));
    expect(results[f.personId]).toMatchObject({ status: 'PROVISIONED', action: 'ADOPT' });
    expect(results[s.personId]).toMatchObject({ status: 'SKIPPED', reason: 'MERGED_PERSON' });
    expect(kc.count()).toBe(accounts);
    const [account] = kc.find('person_number', await personNumberOf(f.personId));
    expect(account.id).toBe(studentAccount);
    expect(account.attributes.person_number).toEqual([await personNumberOf(f.personId)]);
    expect((await rowOf(f.personId)).keycloakUserId).toBe(studentAccount);
  });
});

describe('11. staff accounts and excluded people are not provisioned through this flow', () => {
  it('creating an ADMIN or REGISTRAR account queues nothing (staff logins have no person)', async () => {
    const before = await prisma.identityProvisioning.count();
    for (const role of ['ADMIN', 'REGISTRAR']) {
      const res = await admin.post('/api/app/admin/users', { email: `${role.toLowerCase()}.${tag}@feddrick.edu`, firstName: 'Staff', lastName: role, role });
      expect(res.status).toBe(201);
      expect((await prisma.user.findUnique({ where: { id: res.body.data.id } })).personId).toBeNull();
    }
    expect(await prisma.identityProvisioning.count()).toBe(before);
  });

  it('the worker only manages learner/faculty/alumni: an adopted account keeps its other roles, none are added', async () => {
    const f = await newFaculty();
    const existing = kc.addUser({ username: `itadmin.${tag}`, email: f.email, attributes: { employee_number: [f.employeeNumber] } });
    await keycloak.addRealmRoles(existing, ['it-admins']);
    await run([f.personId]);
    expect(kc.rolesOf(existing)).toEqual(['faculty', 'it-admins']);
  });

  it('a person excluded from identity provisioning gets no account', async () => {
    const s = await newStudent();
    expect((await admin.put(`/api/app/admin/persons/${s.personId}/identity-exclusion`, { excluded: true, reason: 'Visiting researcher, no university account' })).status).toBe(200);
    expect((await run([s.personId]))[0]).toMatchObject({ status: 'SKIPPED', reason: 'IDENTITY_EXCLUDED' });
    expect(kc.find('person_number', await personNumberOf(s.personId))).toHaveLength(0);
  });
});

describe('administration', () => {
  it('status and the review queue are visible to identity managers only', async () => {
    const s = await newStudent();
    kc.addUser({ username: `queue.${tag}`, email: s.email });
    await run([s.personId]);
    const status = await registrar.get(`/api/app/admin/persons/${s.personId}/identity-provisioning`);
    expect(status.body.data).toMatchObject({ status: 'NEEDS_REVIEW', reason: 'EMAIL_IN_USE_WITHOUT_NUMBER' });
    const queue = await admin.get('/api/app/admin/identity-provisioning');
    expect(queue.body.data.some((r) => r.personId === s.personId && r.status === 'NEEDS_REVIEW')).toBe(true);
    const faculty = await login('faculty');
    expect((await faculty.get(`/api/app/admin/persons/${s.personId}/identity-provisioning`)).status).toBe(403);
    expect((await faculty.post(`/api/app/admin/persons/${s.personId}/identity-provisioning/retry`)).status).toBe(403);
  });

  it('the server refuses to start provisioning with the sign-in client\'s credentials', () => {
    const env = { ...process.env, NODE_ENV: 'test', IDENTITY_SYNC_ENABLED: 'true', IDENTITY_SYNC_KEYCLOAK_URL: 'https://auth.example.edu', IDENTITY_SYNC_KEYCLOAK_REALM: 'r', IDENTITY_SYNC_CLIENT_ID: 'campuscore', IDENTITY_SYNC_CLIENT_SECRET: 'x', OIDC_CLIENT_ID: 'campuscore' };
    const r = spawnSync(process.execPath, ['-e', "import('./src/config.js')"], { env, cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not the sign-in client');
  });
});
