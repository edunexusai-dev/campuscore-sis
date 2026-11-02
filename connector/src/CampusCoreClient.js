// Low-level HTTP client for the CampusCore SIS integration API (OAuth 2.0 client credentials).
//  - Caches the access token and refreshes it shortly before expiry.
//  - On 401 invalid_token (expired, revoked, rotated) it fetches a new token once and retries.
//  - Retries 429/502/503/504 and network failures with exponential backoff + jitter (honours Retry-After).
//  - Never retries 4xx business errors: those are returned as SisError with the server's code.
import { SisError } from './errors.js';

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CampusCoreClient {
  #clientSecret;

  constructor({ baseUrl, clientId, clientSecret, scope, timeoutMs = 10_000, maxRetries = 3, fetchImpl = globalThis.fetch, logger = null } = {}) {
    if (!baseUrl || !clientId || !clientSecret) throw new Error('CampusCoreClient requires baseUrl, clientId and clientSecret (server-side configuration).');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.clientId = clientId;
    this.#clientSecret = clientSecret; // private: never serialised or logged
    this.scope = scope;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.token = null; // { value, expiresAt, scopes }
    this.inflightToken = null;
    this.stats = { tokenRequests: 0, requests: 0, retries: 0, lastError: null, lastSuccessAt: null };
  }

  #basic() { return Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.#clientSecret)}`).toString('base64'); }

  toJSON() { return { baseUrl: this.baseUrl, clientId: this.clientId, scopes: this.grantedScopes, stats: this.stats }; }

  // Revokes the cached token at CampusCore (RFC 7009) and forgets it locally.
  async revokeCurrentToken() {
    if (!this.token) return false;
    const res = await this.#raw(`${this.baseUrl}/api/v1/oauth/revoke`, { method: 'POST', headers: { Authorization: `Basic ${this.#basic()}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: this.token.value }) });
    if (!res.ok) throw new SisError(`Token revocation failed (${res.status})`, { status: res.status, code: 'revoke_failed' });
    return true;
  }

  get grantedScopes() { return this.token?.scopes ?? []; }

  async #raw(url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try { return await this.fetch(url, { ...init, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  }

  async getToken({ force = false } = {}) {
    if (!force && this.token && Date.now() < this.token.expiresAt - 30_000) return this.token.value;
    // Coalesce concurrent refreshes into one token request.
    this.inflightToken ??= (async () => {
      this.stats.tokenRequests += 1;
      const body = new URLSearchParams({ grant_type: 'client_credentials', ...(this.scope ? { scope: this.scope } : {}) });
      const basic = this.#basic();
      let res;
      try {
        res = await this.#raw(`${this.baseUrl}/api/v1/oauth/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
      } catch (e) {
        throw new SisError(`CampusCore token endpoint unreachable: ${e.message}`, { code: 'sis_unavailable', retryable: true });
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new SisError(json.error_description || `Token request failed (${res.status})`, { status: res.status, code: json.error || 'token_error', retryable: RETRY_STATUS.has(res.status) });
      }
      this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000, scopes: json.scope.split(' ') };
      this.logger?.info?.(`[campuscore] token issued, scopes=${json.scope}, expires_in=${json.expires_in}s`);
      return this.token.value;
    })().finally(() => { this.inflightToken = null; });
    return this.inflightToken;
  }

  // options: query, body, idempotencyKey, actingUser, ifMatch, withMeta (→ { data, etag, replayed, status })
  // Retry safety: GET requests and writes carrying an Idempotency-Key are retried on network errors and
  // 429/502/503/504. Other writes are NOT retried after they may have reached the server, because a lost
  // response does not prove the write failed. A 401 is always safe to retry once (the request was rejected
  // before any processing) after fetching a new token.
  async request(method, path, { query, body, idempotencyKey, actingUser, ifMatch, withMeta = false } = {}) {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    const retrySafe = method === 'GET' || method === 'HEAD' || !!idempotencyKey;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      let res;
      this.stats.requests += 1;
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (body) headers['Content-Type'] = 'application/json';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      if (actingUser) headers['X-Acting-User'] = actingUser;
      if (ifMatch) headers['If-Match'] = ifMatch;
      try {
        res = await this.#raw(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        if (retrySafe && attempt < this.maxRetries) { await this.#backoff(attempt); continue; }
        throw this.#fail(new SisError(retrySafe ? `CampusCore unreachable: ${e.message}` : `CampusCore did not respond to a ${method} request. The outcome is unknown; check the record before retrying, or send writes with an Idempotency-Key.`, { code: retrySafe ? 'sis_unavailable' : 'sis_outcome_unknown', retryable: retrySafe }));
      }
      if (res.status === 401 && !refreshed) {
        // Token expired, revoked or superseded by a secret rotation: get a fresh one and retry once.
        refreshed = true;
        this.token = null;
        continue;
      }
      const retryable = RETRY_STATUS.has(res.status) || (res.status === 409 && idempotencyKey && res.headers.get('retry-after'));
      if (retryable && retrySafe && attempt < this.maxRetries) {
        await this.#backoff(attempt, res.headers.get('retry-after'));
        continue;
      }
      const json = res.status === 204 ? null : await res.json().catch(() => null);
      if (!res.ok) {
        const err = json?.error ?? {};
        throw this.#fail(new SisError(err.message || `CampusCore request failed (${res.status})`, { status: res.status, code: (typeof json?.error === 'string' ? json.error : err.code) || 'sis_error', details: err.details, requestId: err.requestId ?? res.headers.get('x-request-id'), retryable: RETRY_STATUS.has(res.status) || res.status >= 500 }));
      }
      this.stats.lastSuccessAt = new Date().toISOString();
      return withMeta ? { data: json, status: res.status, etag: res.headers.get('etag'), replayed: res.headers.get('idempotent-replayed') === 'true' } : json;
    }
  }

  // Integration health for status pages. Never includes the token or secret.
  async health() {
    const started = Date.now();
    try {
      const me = await this.get('/me');
      return { ok: true, latencyMs: Date.now() - started, baseUrl: this.baseUrl, institution: me.institution, client: { clientId: me.clientId, name: me.name }, scopes: me.scopes, tokenExpiresAt: this.token ? new Date(this.token.expiresAt).toISOString() : null, stats: { ...this.stats } };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, baseUrl: this.baseUrl, error: { code: e.code, status: e.status, message: e.message, retryable: e.retryable }, stats: { ...this.stats } };
    }
  }

  async #backoff(attempt, retryAfter) {
    this.stats.retries += 1;
    const ms = retryAfter ? Number(retryAfter) * 1000 : Math.min(8000, 250 * 2 ** attempt) + Math.random() * 200;
    this.logger?.warn?.(`[campuscore] retrying in ${Math.round(ms)}ms (attempt ${attempt + 1})`);
    await sleep(ms);
  }

  #fail(err) {
    this.stats.lastError = { at: new Date().toISOString(), code: err.code, status: err.status, message: err.message };
    return err;
  }

  get(path, query, opts) { return this.request('GET', path, { query, ...opts }); }
  post(path, body, opts) { return this.request('POST', path, { body, ...opts }); }
  put(path, body, opts) { return this.request('PUT', path, { body, ...opts }); }
  patch(path, body, opts) { return this.request('PATCH', path, { body, ...opts }); }

  // Iterates every page of a paginated collection.
  async *paginate(path, query = {}, pageSize = 100) {
    for (let page = 1; ; page++) {
      const res = await this.get(path, { ...query, page, pageSize });
      yield* res.data;
      if (page >= res.pagination.totalPages) return;
    }
  }
}
