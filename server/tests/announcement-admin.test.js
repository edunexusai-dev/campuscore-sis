import { describe, it, expect, beforeAll } from 'vitest';
import { login, prisma } from './helpers.js';

// What CampusCore Admin shows for class announcement publishing: the scope (Integrations → client → Access &
// settings → Write access), the operation (→ Write capabilities) and the policy (Policies → Integration API).
// Nothing is granted or switched on by default; every layer stays independently required.
let admin;
beforeAll(async () => { admin = await login('admin'); });

describe('class announcement publishing in CampusCore Admin', () => {
  it('lists announcements:write among the write scopes a client can be granted', async () => {
    const res = await admin.get('/api/app/admin/integrations/scopes');
    expect(res.status).toBe(200);
    expect(res.body.data.find((s) => s.scope === 'announcements:write')).toMatchObject({ write: true, description: expect.stringMatching(/on behalf of an assigned instructor/) });
  });

  it('exposes the institutional policy under Integration API, off by default', async () => {
    const res = await admin.get('/api/app/admin/policies');
    expect(res.status).toBe(200);
    expect(res.body.data.find((p) => p.key === 'api.allowAnnouncementWrites')).toMatchObject({ category: 'Integration API', type: 'boolean', default: false, label: 'Allow integrations to publish class announcements' });
  });

  it('the seeded EdunexusAI client is not granted the scope, and its other write scopes are unchanged', async () => {
    const client = await prisma.integrationClient.findFirst({ where: { name: 'EdunexusAI Campus Portal' } });
    expect(client.scopes).not.toContain('announcements:write');
    expect(client.scopes.filter((s) => s.endsWith(':write')).sort()).toEqual(['attendance:write', 'registrations:write']);
    const detail = await admin.get(`/api/app/admin/integrations/${client.id}`);
    expect(detail.body.data.operationLabels['announcement.write']).toBe('Publish class announcements');
    expect(detail.body.data.capabilities.find((o) => o.operation === 'announcement.write')).toMatchObject({ scope: 'announcements:write', policy: 'api.allowAnnouncementWrites', scopeGranted: false, effective: false });
  });

  it('a new client gets the scope only when an administrator ticks it, and its own preference can switch it off', async () => {
    const created = await admin.post('/api/app/admin/integrations', { name: 'Announcement admin check', scopes: ['announcements:read'] });
    const id = created.body.client.id;
    let caps = (await admin.get(`/api/app/admin/integrations/${id}`)).body.data.capabilities;
    expect(caps.find((o) => o.operation === 'announcement.write')).toMatchObject({ scopeGranted: false, effective: false });

    const granted = await admin.patch(`/api/app/admin/integrations/${id}`, { scopes: ['announcements:read', 'announcements:write'] });
    expect(granted.status).toBe(200);
    caps = (await admin.get(`/api/app/admin/integrations/${id}`)).body.data.capabilities;
    expect(caps.find((o) => o.operation === 'announcement.write')).toMatchObject({ scopeGranted: true, clientEnabled: true });

    const narrowed = await admin.patch(`/api/app/admin/integrations/${id}`, { writePreferences: { disabledOperations: ['announcement.write'] } });
    expect(narrowed.status).toBe(200);
    caps = (await admin.get(`/api/app/admin/integrations/${id}`)).body.data.capabilities;
    expect(caps.find((o) => o.operation === 'announcement.write')).toMatchObject({ scopeGranted: true, clientEnabled: false, effective: false });
  });
});
