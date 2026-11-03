// An in-process stand-in for the parts of the Keycloak Admin REST API the provisioning worker uses (a test realm,
// never a real one), with switches to simulate an outage and a lost response.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export const REALM = 'campuscore-test';
export const CLIENT_ID = 'campuscore-identity-sync';
export const CLIENT_SECRET = 'test-only-sync-secret';
const ROLES = ['learner', 'faculty', 'alumni', 'it-admins', 'offline_access'].map((name) => ({ id: `role-${name}`, name }));

export async function startKeycloakStub() {
  const users = new Map();
  const roles = new Map();
  const state = { down: false, loseNextCreateResponse: false, emails: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks).toString() : '';
    const send = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (state.down) return send(503, { error: 'unavailable' });
    if (url.pathname === `/realms/${REALM}/protocol/openid-connect/token`) {
      const p = new URLSearchParams(body);
      if (p.get('client_id') !== CLIENT_ID || p.get('client_secret') !== CLIENT_SECRET) return send(401, { error: 'invalid_client' });
      return send(200, { access_token: 'test-token', expires_in: 300 });
    }
    if (req.headers.authorization !== 'Bearer test-token') return send(401, {});
    const m = url.pathname.match(new RegExp(`^/admin/realms/${REALM}(/.*)$`));
    if (!m) return send(404, {});
    const path = m[1];
    const parsed = body ? JSON.parse(body) : null;
    if (path === '/users' && req.method === 'GET') {
      let rows = [...users.values()];
      if (url.searchParams.get('q')) {
        const [k, v] = url.searchParams.get('q').split(':'); // "contains", like Keycloak: callers re-check
        rows = rows.filter((u) => (u.attributes?.[k] ?? []).some((x) => x.includes(v)));
      }
      if (url.searchParams.get('email')) rows = rows.filter((u) => u.email === url.searchParams.get('email').toLowerCase());
      if (url.searchParams.get('username')) rows = rows.filter((u) => u.username === url.searchParams.get('username'));
      return send(200, rows);
    }
    if (path === '/users' && req.method === 'POST') {
      if ([...users.values()].some((u) => u.username === parsed.username || (parsed.email && u.email === parsed.email))) return send(409, {});
      const id = randomUUID();
      users.set(id, { ...parsed, id });
      roles.set(id, new Set());
      if (state.loseNextCreateResponse) { state.loseNextCreateResponse = false; return send(500, {}); }
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
      if (rest === '/execute-actions-email' && req.method === 'PUT') { state.emails.push({ id, actions: parsed }); return send(204); }
    }
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    state,
    /** Accounts carrying `name` = `value` (exact). */
    find: (name, value) => [...users.values()].filter((u) => (u.attributes?.[name] ?? []).includes(value)),
    rolesOf: (id) => [...(roles.get(id) ?? [])].sort(),
    /** An account made by hand in Keycloak (not by the worker). */
    addUser(user) { const id = randomUUID(); users.set(id, { enabled: true, attributes: {}, ...user, id }); roles.set(id, new Set()); return id; },
    update(id, patch) { users.set(id, { ...users.get(id), ...patch }); },
    count: () => users.size,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
