// University sign-in (OpenID Connect) for the CampusCore web app, against an in-process provider.
// Covers account linking (never email alone), CampusCore roles staying authoritative, refusals,
// administrator-verified links for staff, revocation, logout and back-channel logout.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, login, prisma, request, USERS } from './helpers.js';
import { startOidcProvider } from './oidcProvider.js';
import { clearOidcCache } from '../src/lib/oidc.js';

const APP = 'http://cc.test';
const KEYS = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_APP_URL', 'OIDC_ALLOW_HTTP', 'OIDC_INSTITUTION_SLUG', 'OIDC_DISPLAY_NAME'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let idp;
let people;

beforeAll(async () => {
  idp = await startOidcProvider({ clientId: 'campuscore', clientSecret: 'cc-test-secret' });
  Object.assign(process.env, { OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'campuscore', OIDC_CLIENT_SECRET: 'cc-test-secret', OIDC_APP_URL: APP, OIDC_ALLOW_HTTP: 'true', OIDC_INSTITUTION_SLUG: 'feddrick', OIDC_DISPLAY_NAME: 'Feddrick University ID' });
  clearOidcCache();
  const by = (email) => prisma.user.findUnique({ where: { email }, include: { student: true, faculty: true } });
  people = { faculty: await by(USERS.faculty), student: await by(USERS.student), registrar: await by(USERS.registrar), held: await by(USERS.heldStudent) };
});

afterAll(async () => {
  await prisma.userIdentityLink.deleteMany({ where: { issuer: idp.issuer } });
  await prisma.session.deleteMany({ where: { oidcIssuer: idp.issuer } });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  clearOidcCache();
  await idp.close();
});

/** The browser's journey through CampusCore: start → provider → callback. Returns the agent and where it landed. */
async function signIn(claims, { returnTo, mutate, providerError } = {}) {
  const agent = request.agent(app);
  const start = await agent.get(`/api/app/auth/oidc/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`);
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.location);
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorize.searchParams.get('client_id')).toBe('campuscore');
  expect(authorize.searchParams.has('prompt')).toBe(false);
  let callback = new URL(idp.issueCode(authorize.href, { claims, ...(mutate ?? {}) }));
  if (providerError) callback = new URL(`${callback.origin}${callback.pathname}?error=${providerError}&state=${callback.searchParams.get('state')}`);
  const cb = await agent.get(`${callback.pathname}${callback.search}`);
  expect(cb.status).toBe(302);
  const dest = new URL(cb.headers.location);
  return { agent, dest, error: dest.searchParams.get('sso_error') };
}

const facultyClaims = (extra = {}) => ({ sub: 'kc-faculty-1', email: people.faculty.email, email_verified: true, employee_number: people.faculty.faculty.employeeNumber, realm_access: { roles: ['faculty', 'it-admins', 'admin'] }, ...extra });
const studentClaims = (extra = {}) => ({ sub: 'kc-student-1', email: people.student.email, email_verified: true, student_number: people.student.student.studentNumber, ...extra });

describe('first sign-in links the CampusCore account on verified institutional IDs', () => {
  it('offers university sign-in', async () => {
    expect((await request(app).get('/api/app/auth/oidc/config')).body.data).toEqual({ enabled: true, displayName: 'Feddrick University ID' });
  });

  it('faculty: one CampusCore session with the CampusCore FACULTY role; provider roles grant nothing', async () => {
    const { agent, dest, error } = await signIn(facultyClaims());
    expect(error).toBeNull();
    expect(`${dest.origin}${dest.pathname}`).toBe(`${APP}/faculty`);
    const me = (await agent.get('/api/app/auth/me')).body.user;
    expect(me.email).toBe(people.faculty.email);
    expect(me.role).toBe('FACULTY');
    expect(me.signInMethod).toBe('SSO');
    expect(me.permissions).not.toContain('users.manage');
    expect((await agent.get('/api/app/admin/users')).status).toBe(403);
    const link = await prisma.userIdentityLink.findUnique({ where: { issuer_subject: { issuer: idp.issuer, subject: 'kc-faculty-1' } } });
    expect(link).toMatchObject({ userId: people.faculty.id, linkMethod: 'INSTITUTIONAL_ID' });
    const session = await prisma.session.findFirst({ where: { userId: people.faculty.id, authMethod: 'OIDC' }, orderBy: { createdAt: 'desc' } });
    expect(session.oidcSubject).toBe('kc-faculty-1');
    expect(session.idTokenSealed).toBeTruthy();
    expect(session.idTokenSealed.startsWith('eyJ')).toBe(false);
  });

  it('student: own records only; faculty and registrar areas refused', async () => {
    const { agent, error } = await signIn(studentClaims({ realm_access: { roles: ['faculty'] } }));
    expect(error).toBeNull();
    expect((await agent.get('/api/app/auth/me')).body.user.role).toBe('STUDENT');
    expect((await agent.get('/api/app/admin/students')).status).toBe(403);
    expect((await agent.get('/api/app/faculty/sections')).status).toBe(403);
  });

  it('returning sign-in uses the stored link; no new link, no duplicate account', async () => {
    const before = await prisma.user.count();
    const { error } = await signIn({ sub: 'kc-faculty-1', email: 'whatever@example.com', email_verified: false });
    expect(error).toBeNull();
    expect(await prisma.userIdentityLink.count({ where: { userId: people.faculty.id } })).toBe(1);
    expect(await prisma.user.count()).toBe(before);
  });

  it('only same-site return paths are followed', async () => {
    const ok = await signIn(facultyClaims(), { returnTo: '/faculty/sections' });
    expect(ok.dest.href).toBe(`${APP}/faculty/sections`);
    const evil = await signIn(facultyClaims(), { returnTo: '//evil.example/x' });
    expect(evil.dest.href).toBe(`${APP}/faculty`);
  });

  it('password sign-in is unchanged', async () => {
    const s = await login('faculty');
    expect(s.user.role).toBe('FACULTY');
  });
});

describe('refusals: nothing is linked, no session is created', () => {
  const refused = async (claims, reason) => {
    const sessionsBefore = await prisma.session.count();
    const r = await signIn(claims);
    expect(r.error).toBe(reason);
    expect(await prisma.session.count()).toBe(sessionsBefore);
  };
  it('email alone is never enough', () => refused({ sub: 'kc-x1', email: people.held.email, email_verified: true }, 'NO_INSTITUTIONAL_ID'));
  it('an unknown number', () => refused({ sub: 'kc-x2', email: 'a@b.c', email_verified: true, student_number: 'NOPE-404' }, 'NO_MATCHING_RECORD'));
  it('numbers of two different people', () => refused({ sub: 'kc-x3', email: people.held.email, email_verified: true, student_number: people.held.student.studentNumber, employee_number: people.faculty.faculty.employeeNumber }, 'AMBIGUOUS_RECORDS'));
  it('an unverified email', () => refused({ sub: 'kc-x4', email: people.held.email, email_verified: false, student_number: people.held.student.studentNumber }, 'EMAIL_NOT_VERIFIED'));
  it('an email that belongs to neither the account nor the record', () => refused({ sub: 'kc-x5', email: 'someone.else@feddrick.edu', email_verified: true, student_number: people.held.student.studentNumber }, 'EVIDENCE_MISMATCH'));
  it('a second university identity for an already-linked account', () => refused({ sub: 'kc-other-faculty', email: people.faculty.email, email_verified: true, employee_number: people.faculty.faculty.employeeNumber }, 'ACCOUNT_LINKED_TO_ANOTHER_IDENTITY'));
  it('a token signed with another key', async () => {
    const r = await signIn(studentClaims(), { mutate: { signWithRogueKey: true } });
    expect(r.error).toBe('VERIFICATION_FAILED');
  });
  it('a token for another client (audience)', async () => {
    const r = await signIn(studentClaims(), { mutate: { override: { aud: 'edunexusai' } } });
    expect(r.error).toBe('VERIFICATION_FAILED');
  });
  it('a cancelled sign-in', async () => {
    expect((await signIn(studentClaims(), { providerError: 'access_denied' })).error).toBe('CANCELLED');
  });
  it('a callback without the sign-in cookie', async () => {
    const res = await request(app).get('/api/app/auth/oidc/callback?code=abc&state=def');
    expect(new URL(res.headers.location).searchParams.get('sso_error')).toBe('INVALID_REQUEST');
  });
});

describe('staff accounts: only an administrator-verified link; CampusCore keeps the role', () => {
  let linkId;
  it('an administrator links the registrar’s university sign-in (not their own), with a note', async () => {
    const admin = await login('admin');
    expect((await admin.post(`/api/app/admin/users/${admin.user.id}/identity-links`, { subject: 'kc-admin', note: 'Verified in person at IT desk' })).status).toBe(403);
    expect((await admin.post(`/api/app/admin/users/${people.registrar.id}/identity-links`, { subject: 'kc-registrar' })).status).toBe(400);
    const res = await admin.post(`/api/app/admin/users/${people.registrar.id}/identity-links`, { subject: 'kc-registrar', note: 'Verified in person at IT desk' });
    expect(res.status).toBe(201);
    linkId = res.body.data.id;
    expect((await admin.post(`/api/app/admin/users/${people.registrar.id}/identity-links`, { subject: 'kc-registrar-2', note: 'Verified in person at IT desk' })).status).toBe(422);
    const registrar = await login('registrar');
    expect((await registrar.post(`/api/app/admin/users/${people.student.id}/identity-links`, { subject: 'kc-z', note: 'Verified in person at IT desk' })).status).toBe(403);
  });

  it('the registrar signs in with REGISTRAR permissions (not ADMIN), whatever the token claims', async () => {
    const { agent, error } = await signIn({ sub: 'kc-registrar', email: 'x@y.z', email_verified: false, realm_access: { roles: ['admin'] } });
    expect(error).toBeNull();
    const me = (await agent.get('/api/app/auth/me')).body.user;
    expect(me.role).toBe('REGISTRAR');
    expect(me.permissions).not.toContain('users.manage');
    expect((await agent.get('/api/app/admin/users')).status).toBe(403);
    expect((await agent.get('/api/app/admin/students')).status).toBe(200);
  });

  it('removing the link signs out its sessions at once and refuses the next sign-in', async () => {
    const { agent } = await signIn({ sub: 'kc-registrar', email: 'x@y.z', email_verified: false });
    expect((await agent.get('/api/app/auth/me')).status).toBe(200);
    const admin = await login('admin');
    expect((await admin.del(`/api/app/admin/users/${people.registrar.id}/identity-links/${linkId}`)).status).toBe(200);
    expect((await agent.get('/api/app/auth/me')).status).toBe(401);
    expect((await signIn({ sub: 'kc-registrar', email: people.registrar.email, email_verified: true })).error).toBe('NO_INSTITUTIONAL_ID');
  });
});

describe('disabled accounts, logout and back-channel logout', () => {
  it('a disabled CampusCore account cannot sign in through the university', async () => {
    const admin = await login('admin');
    expect((await admin.patch(`/api/app/admin/users/${people.student.id}`, { status: 'DISABLED' })).status).toBe(200);
    try {
      expect((await signIn(studentClaims())).error).toBe('ACCOUNT_DISABLED');
    } finally {
      await admin.patch(`/api/app/admin/users/${people.student.id}`, { status: 'ACTIVE' });
    }
  });

  it('sign out of CampusCore only: this session ends, nothing is sent to the provider', async () => {
    const { agent } = await signIn(facultyClaims());
    const csrf = (await agent.get('/api/app/auth/me')).body.csrfToken;
    expect((await agent.post('/api/app/auth/logout').set('X-CSRF-Token', csrf)).body).toEqual({ ok: true });
    expect((await agent.get('/api/app/auth/me')).status).toBe(401);
  });

  it('sign out of all university apps: session ends and the provider address carries the ID token hint', async () => {
    const { agent } = await signIn(facultyClaims());
    const csrf = (await agent.get('/api/app/auth/me')).body.csrfToken;
    expect((await agent.post('/api/app/auth/oidc/logout-everywhere')).status).toBe(403);
    const res = await agent.post('/api/app/auth/oidc/logout-everywhere').set('X-CSRF-Token', csrf);
    const url = new URL(res.body.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}/logout`);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${APP}/login`);
    expect(JSON.parse(Buffer.from(url.searchParams.get('id_token_hint').split('.')[1], 'base64url')).sub).toBe('kc-faculty-1');
    expect((await agent.get('/api/app/auth/me')).status).toBe(401);
  });

  it('the provider’s back-channel logout ends the matching session only; forged tokens end nothing', async () => {
    const a = await signIn(facultyClaims({ sid: 'kc-sess-A' }));
    const b = await signIn(studentClaims({ sid: 'kc-sess-B' }));
    const post = (body) => request(app).post('/api/app/auth/oidc/backchannel-logout').type('form').send(body);
    for (const bad of [{ logout_token: idp.logoutToken({ sid: 'kc-sess-A' }, { signWithRogueKey: true }) }, { logout_token: idp.logoutToken({ sid: 'kc-sess-A' }, { override: { aud: 'edunexusai' } }) }, { logout_token: idp.logoutToken({ sid: 'kc-sess-A', nonce: 'n' }) }, { logout_token: 'x' }, {}]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect((await a.agent.get('/api/app/auth/me')).status).toBe(200);
    expect((await post({ logout_token: idp.logoutToken({ sid: 'kc-sess-A' }) })).status).toBe(200);
    expect((await a.agent.get('/api/app/auth/me')).status).toBe(401);
    expect((await b.agent.get('/api/app/auth/me')).status).toBe(200);
  });
});
