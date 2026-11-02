// The two systems the sync talks to, each through its own least-privilege client-credentials client:
//   CampusCore: the integration API, scope people:read only;
//   Keycloak: the Admin REST API as a service account with realm-management manage-users / view-users / query-users.
// Tokens are cached until shortly before expiry and refreshed once on 401. Tokens and secrets are never logged.

export class SyncError extends Error {
  constructor(system, status, code, message) {
    super(message);
    this.name = 'SyncError';
    this.system = system;
    this.status = status;
    this.code = code;
  }
}

async function call(fetchImpl, system, url, init, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new SyncError(system, 0, 'UNAVAILABLE', `${system} is unreachable (${e.name === 'TimeoutError' ? 'timeout' : 'network error'}).`);
  }
  return res;
}

class TokenSource {
  constructor({ system, url, clientId, clientSecret, scope, fetchImpl, timeoutMs }) {
    Object.assign(this, { system, url, clientId, clientSecret, scope, fetchImpl, timeoutMs, token: null, expiresAt: 0 });
  }

  async get(force = false) {
    if (!force && this.token && Date.now() < this.expiresAt - 30_000) return this.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret, ...(this.scope ? { scope: this.scope } : {}) });
    const res = await call(this.fetchImpl, this.system, this.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, this.timeoutMs);
    if (!res.ok) throw new SyncError(this.system, res.status, 'AUTH_FAILED', `${this.system} refused the sync's client credentials (HTTP ${res.status}).`);
    const data = await res.json();
    this.token = data.access_token;
    this.expiresAt = Date.now() + (Number(data.expires_in) || 60) * 1000;
    return this.token;
  }
}

async function authorized(source, fetchImpl, system, url, init, timeoutMs) {
  let res = await call(fetchImpl, system, url, { ...init, headers: { ...init.headers, authorization: `Bearer ${await source.get()}` } }, timeoutMs);
  if (res.status === 401) res = await call(fetchImpl, system, url, { ...init, headers: { ...init.headers, authorization: `Bearer ${await source.get(true)}` } }, timeoutMs);
  return res;
}

export class CampusCoreClient {
  constructor({ baseUrl, clientId, clientSecret, fetchImpl = fetch, timeoutMs = 10_000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.tokens = new TokenSource({ system: 'CampusCore', url: `${this.baseUrl}/api/v1/oauth/token`, clientId, clientSecret, scope: 'people:read', fetchImpl, timeoutMs });
  }

  async get(path, query = {}) {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v instanceof Date ? v.toISOString() : String(v));
    const res = await authorized(this.tokens, this.fetchImpl, 'CampusCore', url, { method: 'GET', headers: { accept: 'application/json' } }, this.timeoutMs);
    if (!res.ok) throw new SyncError('CampusCore', res.status, res.status === 403 ? 'FORBIDDEN' : 'REQUEST_FAILED', `CampusCore answered HTTP ${res.status} for ${path}.`);
    return res.json();
  }

  /** Every person (or every person changed since `updatedSince`), page by page. */
  async *people({ updatedSince } = {}) {
    for (let page = 1; ; page += 1) {
      const body = await this.get('/people', { page, pageSize: 100, updatedSince });
      yield* body.data;
      if (page >= body.pagination.totalPages) return;
    }
  }

  async personByNumber(personNumber) {
    return (await this.get('/people', { personNumber })).data[0] ?? null;
  }
}

export class KeycloakAdminClient {
  constructor({ baseUrl, realm, clientId, clientSecret, fetchImpl = fetch, timeoutMs = 10_000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.realm = realm;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.tokens = new TokenSource({ system: 'Keycloak', url: `${this.baseUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`, clientId, clientSecret, fetchImpl, timeoutMs });
    this.roleCache = new Map();
  }

  async req(method, path, { query, body } = {}) {
    const url = new URL(`${this.baseUrl}/admin/realms/${encodeURIComponent(this.realm)}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    const res = await authorized(this.tokens, this.fetchImpl, 'Keycloak', url, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }, this.timeoutMs);
    if (res.status === 409) throw new SyncError('Keycloak', 409, 'CONFLICT', 'Keycloak refused the change because another account already uses that username or email.');
    if (res.status === 403) throw new SyncError('Keycloak', 403, 'FORBIDDEN', 'The sync client lacks a realm-management role (it needs manage-users, view-users and query-users).');
    if (!res.ok) throw new SyncError('Keycloak', res.status, 'REQUEST_FAILED', `Keycloak answered HTTP ${res.status} for ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}.`);
    return res;
  }

  async json(method, path, opts) {
    const res = await this.req(method, path, opts);
    return res.status === 204 ? null : res.json();
  }

  /** Accounts whose attribute `name` holds exactly `value` (Keycloak's search is re-checked here). */
  async byAttribute(name, value) {
    const rows = await this.json('GET', '/users', { query: { q: `${name}:${value}`, briefRepresentation: false, max: 20 } });
    return rows.filter((u) => (u.attributes?.[name] ?? []).includes(value));
  }

  async byEmail(email) {
    const rows = await this.json('GET', '/users', { query: { email, exact: true, briefRepresentation: false, max: 5 } });
    return rows.filter((u) => String(u.email ?? '').toLowerCase() === String(email).toLowerCase());
  }

  async usernameTaken(username) {
    const rows = await this.json('GET', '/users', { query: { username, exact: true, max: 2 } });
    return rows.some((u) => u.username === username);
  }

  getUser(id) { return this.json('GET', `/users/${id}`); }

  async updateUser(id, representation) { await this.req('PUT', `/users/${id}`, { body: representation }); }

  async createUser(representation) {
    const res = await this.req('POST', '/users', { body: representation });
    const id = res.headers.get('location')?.split('/').pop();
    if (!id) throw new SyncError('Keycloak', res.status, 'REQUEST_FAILED', 'Keycloak created the account but did not return its id.');
    return id;
  }

  async realmRoles(id) {
    return (await this.json('GET', `/users/${id}/role-mappings/realm`)).map((r) => r.name);
  }

  // Role ids, looked up through the user: the roles this client may map to them ("available") plus those already
  // mapped. A least-privilege service account (manage-users, view-users, query-users) may read these, but not the
  // realm's role list (/roles needs view-realm), which the sync deliberately does not hold.
  async roleRefs(userId, names) {
    if (names.some((n) => !this.roleCache.has(n))) {
      const [available, mapped] = await Promise.all([this.json('GET', `/users/${userId}/role-mappings/realm/available`), this.json('GET', `/users/${userId}/role-mappings/realm`)]);
      for (const r of [...available, ...mapped]) this.roleCache.set(r.name, { id: r.id, name: r.name });
    }
    return names.map((n) => {
      const ref = this.roleCache.get(n);
      if (!ref) throw new SyncError('Keycloak', 404, 'ROLE_NOT_FOUND', `The realm role "${n}" does not exist or may not be assigned by the sync client.`);
      return ref;
    });
  }

  async addRealmRoles(id, names) {
    if (names.length) await this.req('POST', `/users/${id}/role-mappings/realm`, { body: await this.roleRefs(id, names) });
  }

  async removeRealmRoles(id, names) {
    if (names.length) await this.req('DELETE', `/users/${id}/role-mappings/realm`, { body: await this.roleRefs(id, names) });
  }

  async sendSetupEmail(id) {
    await this.req('PUT', `/users/${id}/execute-actions-email`, { body: ['UPDATE_PASSWORD'] });
  }
}
