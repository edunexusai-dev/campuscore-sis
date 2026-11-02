// End to end through the real HTTP clients, against an in-process stand-in for the Keycloak Admin REST API and the
// CampusCore People API (just enough of each for the sync).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { CampusCoreClient, KeycloakAdminClient } from '../src/clients.js';
import { runSync } from '../src/sync.js';

const REALM = 'uni';
const ROLES = ['learner', 'faculty', 'alumni', 'it-admins', 'offline_access'].map((name) => ({ id: `role-${name}`, name }));

function keycloakStub() {
  const users = new Map();
  const roles = new Map();
  const seen = { tokens: 0, forbidden: false, expireNext: false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks).toString() : '';
    const send = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (url.pathname === `/realms/${REALM}/protocol/openid-connect/token`) {
      const p = new URLSearchParams(body);
      if (p.get('client_secret') !== 'kc-secret') return send(401, { error: 'invalid_client' });
      seen.tokens += 1;
      return send(200, { access_token: `tok-${seen.tokens}`, expires_in: 300 });
    }
    if (seen.expireNext) { seen.expireNext = false; return send(401, {}); }
    if (seen.forbidden) return send(403, {});
    const m = url.pathname.match(new RegExp(`^/admin/realms/${REALM}(/.*)$`));
    if (!m) return send(404, {});
    const path = m[1];
    const parsed = body ? JSON.parse(body) : null;
    if (path === '/users' && req.method === 'GET') {
      let rows = [...users.values()];
      if (url.searchParams.get('q')) {
        // Like Keycloak, a "contains" match: the client must re-check for exact values.
        const [k, v] = url.searchParams.get('q').split(':');
        rows = rows.filter((u) => (u.attributes?.[k] ?? []).some((x) => x.includes(v)));
      }
      if (url.searchParams.get('email')) rows = rows.filter((u) => u.email === url.searchParams.get('email').toLowerCase());
      if (url.searchParams.get('username')) rows = rows.filter((u) => u.username === url.searchParams.get('username'));
      return send(200, rows);
    }
    if (path === '/users' && req.method === 'POST') {
      if ([...users.values()].some((u) => u.username === parsed.username || u.email === parsed.email)) return send(409, {});
      const id = randomUUID();
      users.set(id, { ...parsed, id });
      roles.set(id, new Set());
      return send(201, undefined, { location: `http://kc/admin/realms/${REALM}/users/${id}` });
    }
    const um = path.match(/^\/users\/([^/]+)(\/.*)?$/);
    if (um) {
      const [, id, rest] = um;
      if (!users.has(id)) return send(404, {});
      if (!rest && req.method === 'GET') return send(200, users.get(id));
      if (!rest && req.method === 'PUT') {
        if ([...users.values()].some((u) => u.id !== id && u.email === parsed.email)) return send(409, {});
        users.set(id, { ...parsed, id });
        return send(204);
      }
      if (rest === '/role-mappings/realm/available' && req.method === 'GET') return send(200, ROLES.filter((r) => !roles.get(id).has(r.name)));
      if (rest === '/role-mappings/realm') {
        if (req.method === 'GET') return send(200, [...roles.get(id)].map((n) => ROLES.find((r) => r.name === n)));
        for (const r of parsed) (req.method === 'POST' ? roles.get(id).add(r.name) : roles.get(id).delete(r.name));
        return send(204);
      }
    }
    // As in Keycloak: reading the realm's roles needs view-realm, which the sync's service account does not hold.
    if (path.startsWith('/roles')) return send(403, {});
    return send(404, {});
  });
  return { server, users, roles, seen, add(user, userRoles = []) { const id = user.id ?? randomUUID(); users.set(id, { enabled: true, emailVerified: true, attributes: {}, ...user, id }); roles.set(id, new Set(userRoles)); return id; } };
}

function campuscoreStub(people) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/api/v1/oauth/token') return send(200, { access_token: 'cc', expires_in: 300 });
    if (req.headers.authorization !== 'Bearer cc') return send(401, {});
    if (url.pathname === '/api/v1/people') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 25);
      let rows = people;
      if (url.searchParams.get('personNumber')) rows = rows.filter((p) => p.personNumber === url.searchParams.get('personNumber'));
      return send(200, { data: rows.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / pageSize)) } });
    }
    return send(404, {});
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

const person = (n, over = {}) => ({ personNumber: n, firstName: 'Test', lastName: n, status: 'ACTIVE', primaryEmail: `${n.toLowerCase()}@students.uni.edu`, emails: [`${n.toLowerCase()}@students.uni.edu`], relationships: [{ type: 'STUDENT', number: `S${n.slice(1)}`, status: 'ACTIVE', current: true }], ...over });
const RAHUL = { personNumber: 'P0000210', firstName: 'Rahul', lastName: 'Multirole', status: 'ACTIVE', primaryEmail: 'rahul.multirole@feddrick.edu', emails: ['rahul.multirole@feddrick.edu', 'rahul.multirole@students.feddrick.edu'], relationships: [{ type: 'FACULTY', number: 'F01024', status: 'ACTIVE', current: true }, { type: 'STUDENT', number: 'S2600187', status: 'ACTIVE', current: true }] };
const KESHAV = person('P0000300', { firstName: 'Keshav', lastName: 'Jha', primaryEmail: 'keshav.jha@student.feddrick.edu', emails: ['keshav.jha@student.feddrick.edu'], relationships: [{ type: 'STUDENT', number: 'S2600188', status: 'ACTIVE', current: true }] });

let kc;
let kcUrl;
let ccServer;
let keycloak;
let campuscore;
let ids;

before(async () => {
  kc = keycloakStub();
  kcUrl = await listen(kc.server);
  // Accounts as they exist today: Rahul set up by hand with both numbers (and an extra attribute and role),
  // Keshav by hand without a number, an administrator account, and someone whose number merely CONTAINS Rahul's.
  ids = {
    rahul: kc.add({ username: 'rahul.multirole', email: 'rahul.multirole@feddrick.edu', firstName: 'Rahul', lastName: 'Multirole', attributes: { student_number: ['S2600187'], employee_number: ['F01024'], demo: ['synthetic'] } }, ['learner', 'faculty', 'offline_access']),
    keshav: kc.add({ username: 'keshav.jha', email: 'keshav.jha@student.feddrick.edu', firstName: 'Keshav', lastName: 'Jha', emailVerified: false }),
    admin: kc.add({ username: 'admin', email: 'admin@uni.edu', firstName: 'A', lastName: 'Dmin' }, ['it-admins']),
    lookalike: kc.add({ username: 'other', email: 'other@uni.edu', firstName: 'O', lastName: 'Ther', attributes: { student_number: ['S26001870'] } }),
  };
  ccServer = campuscoreStub([RAHUL, KESHAV, person('P0000400'), person('P0000500', { status: 'INACTIVE', relationships: [{ type: 'STUDENT', number: 'S0000500', status: 'WITHDRAWN', current: false }] })]);
  campuscore = new CampusCoreClient({ baseUrl: await listen(ccServer), clientId: 'sync', clientSecret: 'x' });
  keycloak = new KeycloakAdminClient({ baseUrl: kcUrl, realm: REALM, clientId: 'campuscore-identity-sync', clientSecret: 'kc-secret' });
});

after(() => { kc.server.close(); ccServer.close(); });

describe('identity sync against Keycloak', () => {
  it('a dry run reports and changes nothing', async () => {
    const before = JSON.stringify([...kc.users.values()]);
    const { results, summary } = await runSync({ people: campuscore.people(), keycloak });
    assert.equal(JSON.stringify([...kc.users.values()]), before);
    const by = Object.fromEntries(results.map((r) => [r.personNumber, r]));
    assert.deepEqual([by.P0000210.action, by.P0000210.via, by.P0000210.changed], ['ADOPT', 'INSTITUTIONAL_NUMBER', ['person_number']]);
    assert.deepEqual([by.P0000300.action, by.P0000300.reason], ['CONFLICT', 'EMAIL_IN_USE_WITHOUT_NUMBER']);
    assert.equal(by.P0000400.action, 'CREATE');
    assert.deepEqual([by.P0000500.action, by.P0000500.reason], ['SKIP', 'NO_CURRENT_RELATIONSHIP']);
    assert.deepEqual(summary, { ADOPT: 1, CONFLICT: 1, CREATE: 1, SKIP: 1 });
  });

  it('applying adopts Rahul without touching his other attribute or roles, and creates the new student', async () => {
    await runSync({ people: campuscore.people(), keycloak, apply: true });
    const rahul = kc.users.get(ids.rahul);
    assert.deepEqual(rahul.attributes, { student_number: ['S2600187'], employee_number: ['F01024'], demo: ['synthetic'], person_number: ['P0000210'] });
    assert.deepEqual([...kc.roles.get(ids.rahul)].sort(), ['faculty', 'learner', 'offline_access']);
    const created = [...kc.users.values()].find((u) => u.attributes?.person_number?.[0] === 'P0000400');
    assert.deepEqual([created.username, created.email, created.emailVerified, created.enabled, created.requiredActions], ['p0000400', 'p0000400@students.uni.edu', true, true, ['UPDATE_PASSWORD']]);
    assert.deepEqual([...kc.roles.get(created.id)], ['learner']);
    // Untouched: Keshav (needs confirmation), the administrator, the look-alike number.
    assert.deepEqual(kc.users.get(ids.keshav).attributes, {});
    assert.deepEqual([...kc.roles.get(ids.admin)], ['it-admins']);
    assert.deepEqual(kc.users.get(ids.lookalike).attributes, { student_number: ['S26001870'] });
    assert.equal([...kc.users.values()].filter((u) => u.attributes?.person_number).length, 2);
  });

  it('a second run is a no-op', async () => {
    const { summary } = await runSync({ people: campuscore.people(), keycloak, apply: true });
    assert.deepEqual(summary, { UNCHANGED: 2, CONFLICT: 1, SKIP: 1 });
  });

  it('an administrator confirms Keshav\'s hand-made account: it gets his number, a verified email and the learner role', async () => {
    const { results } = await runSync({ people: (async function* () { yield await campuscore.personByNumber('P0000300'); })(), keycloak, apply: true, adopt: { P0000300: ids.keshav } });
    assert.deepEqual([results[0].action, results[0].via], ['ADOPT', 'ADMIN_CONFIRMED']);
    const k = kc.users.get(ids.keshav);
    assert.deepEqual([k.attributes, k.emailVerified, k.username], [{ person_number: ['P0000300'], student_number: ['S2600188'] }, true, 'keshav.jha']);
    assert.deepEqual([...kc.roles.get(ids.keshav)], ['learner']);
  });

  it('lifecycle: Rahul stops studying (learner removed, still enabled), then leaves (disabled, never deleted)', async () => {
    const studying = { ...RAHUL, relationships: [RAHUL.relationships[0], { ...RAHUL.relationships[1], status: 'WITHDRAWN', current: false }] };
    await runSync({ people: [studying], keycloak, apply: true });
    assert.deepEqual([...kc.roles.get(ids.rahul)].sort(), ['faculty', 'offline_access']);
    assert.equal(kc.users.get(ids.rahul).enabled, true);
    const gone = { ...studying, status: 'INACTIVE', relationships: [{ ...RAHUL.relationships[0], status: 'DISABLED', current: false }, studying.relationships[1]] };
    await runSync({ people: [gone], keycloak, apply: true });
    assert.equal(kc.users.get(ids.rahul).enabled, false);
    assert.deepEqual([...kc.roles.get(ids.rahul)], ['offline_access']);
    assert.ok(kc.users.has(ids.rahul));
  });

  it('an email already used by another account is reported for that person; the run continues', async () => {
    const clash = person('P0000600', { primaryEmail: 'admin@uni.edu', emails: ['admin@uni.edu'] });
    const { results } = await runSync({ people: [clash, person('P0000700')], keycloak, apply: true });
    assert.deepEqual(results.map((r) => [r.personNumber, r.action, r.reason ?? null]), [['P0000600', 'CONFLICT', 'EMAIL_IN_USE_WITHOUT_NUMBER'], ['P0000700', 'CREATE', null]]);
  });

  it('an account created by an interrupted run (no roles yet) is completed by the next run, not duplicated', async () => {
    const partial = kc.add({ username: 'p0000800', email: 'p0000800@students.uni.edu', firstName: 'Test', lastName: 'P0000800', attributes: { person_number: ['P0000800'], student_number: ['S0000800'] }, requiredActions: ['UPDATE_PASSWORD'] });
    const { results } = await runSync({ people: [person('P0000800')], keycloak, apply: true });
    assert.deepEqual([results[0].action, results[0].addRoles, results[0].applied], ['UPDATE', ['learner'], true]);
    assert.deepEqual([...kc.roles.get(partial)], ['learner']);
    assert.equal([...kc.users.values()].filter((u) => u.attributes?.person_number?.[0] === 'P0000800').length, 1);
  });

  it('renews an expired token once; a missing realm-management role is a clear error per person', async () => {
    kc.seen.expireNext = true;
    const { summary } = await runSync({ people: [RAHUL], keycloak });
    assert.equal(summary.ERROR, undefined);
    kc.seen.forbidden = true;
    try {
      const { results } = await runSync({ people: [RAHUL], keycloak });
      assert.deepEqual([results[0].action, results[0].reason], ['ERROR', 'FORBIDDEN']);
      assert.match(results[0].message, /manage-users/);
    } finally { kc.seen.forbidden = false; }
  });

  it('wrong client credentials fail fast and name no secret', async () => {
    const bad = new KeycloakAdminClient({ baseUrl: kcUrl, realm: REALM, clientId: 'campuscore-identity-sync', clientSecret: 'wrong' });
    const { results } = await runSync({ people: [RAHUL], keycloak: bad });
    assert.equal(results[0].reason, 'AUTH_FAILED');
    assert.doesNotMatch(JSON.stringify(results), /wrong|kc-secret/);
  });
});
