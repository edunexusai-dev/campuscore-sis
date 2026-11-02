import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CampusCoreClient, CampusCoreAdapter, SisError } from '../src/index.js';

// Minimal fake of fetch: a queue of handlers, each returns { status, body, headers }.
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected request ${url}`);
    if (h instanceof Error) throw h;
    const r = typeof h === 'function' ? h(String(url), init) : h;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}
const tokenOk = (scope = 'students:read', ttl = 900) => ({ body: { access_token: `t${Math.random()}`, token_type: 'Bearer', expires_in: ttl, scope } });
const opts = (fetchImpl) => ({ baseUrl: 'http://sis', clientId: 'cid', clientSecret: 'sec', fetchImpl, maxRetries: 2 });

test('caches the token across requests', async () => {
  const f = fakeFetch([tokenOk(), { body: { data: [] } }, { body: { data: [] } }]);
  const c = new CampusCoreClient(opts(f));
  await c.get('/terms'); await c.get('/terms');
  assert.equal(c.stats.tokenRequests, 1);
  assert.match(f.calls[0].init.headers.Authorization, /^Basic /);
  assert.match(f.calls[1].init.headers.Authorization, /^Bearer t/);
});

test('refreshes the token once on 401 and retries', async () => {
  const f = fakeFetch([tokenOk(), { status: 401, body: { error: { code: 'invalid_token' } } }, tokenOk(), { body: { data: [1] } }]);
  const c = new CampusCoreClient(opts(f));
  const res = await c.get('/students');
  assert.deepEqual(res.data, [1]);
  assert.equal(c.stats.tokenRequests, 2);
});

test('retries 503 with backoff then succeeds', async () => {
  const f = fakeFetch([tokenOk(), { status: 503, headers: { 'retry-after': '0' }, body: {} }, { body: { ok: true } }]);
  const c = new CampusCoreClient(opts(f));
  assert.deepEqual(await c.get('/x'), { ok: true });
  assert.equal(c.stats.retries, 1);
});

test('retries network failures and reports sis_unavailable when exhausted', async () => {
  const f = fakeFetch([tokenOk(), new TypeError('ECONNREFUSED'), new TypeError('ECONNREFUSED'), new TypeError('ECONNREFUSED')]);
  const c = new CampusCoreClient({ ...opts(f), maxRetries: 2 });
  await assert.rejects(c.get('/x'), (e) => e instanceof SisError && e.code === 'sis_unavailable' && e.retryable);
});

test('does not retry business-rule errors and preserves the server code', async () => {
  const f = fakeFetch([tokenOk('registrations:write'), { status: 422, body: { error: { code: 'prerequisite_not_met', message: 'Requires CS 201', requestId: 'r1' } } }]);
  const c = new CampusCoreClient(opts(f));
  await assert.rejects(c.post('/registrations', {}), (e) => e.status === 422 && e.code === 'prerequisite_not_met' && !e.retryable && e.requestId === 'r1');
  assert.equal(f.calls.length, 2);
});

test('surfaces invalid client credentials from the token endpoint', async () => {
  const f = fakeFetch([{ status: 401, body: { error: 'invalid_client', error_description: 'Client authentication failed.' } }]);
  await assert.rejects(new CampusCoreClient(opts(f)).get('/x'), (e) => e.code === 'invalid_client' && !e.retryable);
});

test('adapter maps CampusCore DTOs to the canonical model and guards writes by scope', async () => {
  const student = { id: 's1', studentNumber: 'S1', firstName: 'Maya', lastName: 'Chen', preferredName: null, email: 'm@x', phone: null, status: 'ACTIVE', classLevel: 'JUNIOR', academicStanding: 'DEANS_LIST', program: { code: 'BS-CS', name: 'Computer Science', degreeType: 'BS' }, hasRegistrationHold: false };
  const f = fakeFetch([tokenOk('students:read'), { body: { data: student } }]);
  const a = new CampusCoreAdapter(opts(f));
  const s = await a.getStudent('s1');
  assert.deepEqual(s.source, { system: 'campuscore', id: 's1' });
  assert.equal(s.enrollmentStatus, 'active');
  assert.equal(s.standing, 'deans_list');
  assert.deepEqual(a.capabilities().writes, []);
  await assert.rejects(a.enroll('s1', 'sec1'), (e) => e.code === 'not_supported');
});

test('does not retry a non-idempotent write after a network failure (outcome unknown)', async () => {
  const f = fakeFetch([tokenOk('registrations:write'), new TypeError('socket hang up')]);
  const c = new CampusCoreClient(opts(f));
  await assert.rejects(c.post('/registrations', { a: 1 }), (e) => e.code === 'sis_outcome_unknown' && !e.retryable);
  assert.equal(f.calls.length, 2);
});

test('retries a write that carries an Idempotency-Key, sending the same key each time', async () => {
  const f = fakeFetch([tokenOk('students:create'), new TypeError('timeout'), { status: 201, body: { data: { id: 's1' } }, headers: { 'idempotent-replayed': 'true', etag: 'W/"1"' } }]);
  const c = new CampusCoreClient(opts(f));
  const r = await c.post('/students', { a: 1 }, { idempotencyKey: 'key-12345678', actingUser: 'edunexusai:7', withMeta: true });
  assert.equal(r.data.data.id, 's1');
  assert.equal(r.replayed, true);
  assert.equal(r.etag, 'W/"1"');
  assert.deepEqual(f.calls.slice(1).map((x) => x.init.headers['Idempotency-Key']), ['key-12345678', 'key-12345678']);
  assert.equal(f.calls[2].init.headers['X-Acting-User'], 'edunexusai:7');
});

test('concurrent requests share a single token request', async () => {
  const f = fakeFetch([tokenOk(), { body: { a: 1 } }, { body: { a: 2 } }, { body: { a: 3 } }]);
  const c = new CampusCoreClient(opts(f));
  await Promise.all([c.get('/x'), c.get('/y'), c.get('/z')]);
  assert.equal(c.stats.tokenRequests, 1);
});

test('refreshes shortly before expiry without a 401', async () => {
  const f = fakeFetch([tokenOk('students:read', 20), { body: {} }, tokenOk('students:read', 900), { body: {} }]);
  const c = new CampusCoreClient(opts(f));
  await c.get('/x'); await c.get('/y'); // 20 s token is inside the 30 s refresh margin → refreshed proactively
  assert.equal(c.stats.tokenRequests, 2);
});

test('never logs the token or the secret', async () => {
  const lines = [];
  const logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
  const f = fakeFetch([{ body: { access_token: 'tok-SECRETVALUE', token_type: 'Bearer', expires_in: 900, scope: 'x' } }, { status: 503, headers: { 'retry-after': '0' }, body: {} }, { body: {} }]);
  const c = new CampusCoreClient({ ...opts(f), clientSecret: 'sec-SECRETVALUE', logger });
  await c.get('/x');
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => !l.includes('SECRETVALUE')));
});
