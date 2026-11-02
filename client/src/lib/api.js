// Thin fetch wrapper for the portal API. Session cookie is HttpOnly; the CSRF token lives only in memory.
let csrfToken = null;
export const setCsrfToken = (t) => { csrfToken = t; };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || body?.error_description || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code || body?.error;
    this.details = body?.error?.details;
  }
}

async function request(method, path, body, { raw } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(path.startsWith('/api') ? path : `/api/app${path}`, { method, headers, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return res;
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('cc:unauthorized'));
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
  raw: (method, p, b) => request(method, p, b, { raw: true }),
};

export const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return s ? `?${s}` : '';
};
