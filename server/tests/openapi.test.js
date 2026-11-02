import { describe, it, expect, beforeAll } from 'vitest';
import { openapi } from '../src/openapi/spec.js';
import v1Router from '../src/routes/v1/index.js';
import { login, getToken, api, request, app } from './helpers.js';

// Collect "METHOD /path" for every route registered on the v1 router.
function implementedRoutes() {
  const out = new Set();
  for (const layer of v1Router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) out.add(`${method.toUpperCase()} /api/v1${layer.route.path.replace(/:(\w+)/g, '{$1}')}`);
  }
  return out;
}

function documentedRoutes() {
  const out = new Set();
  for (const [path, ops] of Object.entries(openapi.paths)) for (const m of Object.keys(ops)) out.add(`${m.toUpperCase()} ${path}`);
  return out;
}

describe('OpenAPI documentation', () => {
  let call;
  beforeAll(async () => {
    const admin = await login('admin');
    const scopes = (await admin.get('/api/app/admin/integrations/scopes')).body.data.map((s) => s.scope);
    const c = await admin.post('/api/app/admin/integrations', { name: 'Docs check', scopes });
    const token = (await getToken(c.body.client.clientId, c.body.clientSecret)).body.access_token;
    call = api(token);
  });

  it('documents every implemented v1 route', () => {
    const missing = [...implementedRoutes()].filter((r) => !documentedRoutes().has(r));
    expect(missing).toEqual([]);
  });

  it('every documented route is implemented', async () => {
    for (const route of documentedRoutes()) {
      const [method, path] = route.split(' ');
      const url = path.replace(/\{\w+\}/g, 'nonexistent-id');
      const res = path.includes('/oauth/')
        ? await request(app)[method.toLowerCase()](url).type('form').send({})
        : await call[method === 'DELETE' ? 'del' : method.toLowerCase()](url, {});
      expect(res.body?.error?.code, route).not.toBe('route_not_found');
    }
  });

  it('serves the spec and interactive docs', async () => {
    expect((await request(app).get('/api/openapi.json')).body.openapi).toBe('3.1.0');
    expect((await request(app).get('/api/docs/')).status).toBe(200);
  });

  it('redirects /api/docs to /api/docs/ so the relative Swagger UI assets resolve under /api/docs/', async () => {
    const bare = await request(app).get('/api/docs');
    expect(bare.status).toBe(301);
    expect(bare.headers.location).toBe('/api/docs/');
    expect((await request(app).get('/api/docs?x=1')).headers.location).toBe('/api/docs/?x=1');
    const html = await request(app).get('/api/docs/');
    expect(html.headers['content-type']).toMatch(/text\/html/);
    for (const asset of ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js', 'swagger-ui-init.js']) {
      expect(html.text, asset).toContain(`./${asset}`);
      const res = await request(app).get(`/api/docs/${asset}`);
      expect(res.status, asset).toBe(200);
      expect(res.headers['content-type'], asset).toMatch(asset.endsWith('.css') ? /text\/css/ : /javascript/);
    }
    const init = await request(app).get('/api/docs/swagger-ui-init.js');
    expect(init.text).toContain('CampusCore');
  });
});
