// Integration API: cross-system identity reconciliation and links.
//   POST /identity/reconcile             identity:read   classify external accounts (never links)
//   GET  /identity/resolve               identity:read   resolve one external account → SIS record(s) (per request; ?recordType=STUDENT|FACULTY)
//   GET  /identity/links                 identity:read   list links (filters, pagination)
//   POST /identity/links                 identity:write  + api.allowIdentityLinkWrites   (explicit confirmation)
//   POST /identity/links/:id/revoke      identity:write  + api.allowIdentityLinkWrites
//   PUT  /integration/write-preferences  integration:configure   narrow this client's own write operations
//   GET  /integration/write-preferences  (no scope)
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse, id, paginationQuery, paged } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { requireScope } from '../../middleware/integrationAuth.js';
import { idempotent } from '../../middleware/idempotency.js';
import { assertOperation, readPreferences, validatePreferences, evaluateCapabilities } from '../../services/capabilityService.js';
import * as identity from '../../services/identityService.js';

const system = z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{1,39}$/, 'externalSystem must be a lowercase identifier such as "edunexusai"').default('edunexusai');
const extUser = z.string().trim().min(1).max(128);
const recordType = z.enum(['STUDENT', 'FACULTY']);
const inst = (req) => req.integration.client.institutionId;

export function registerIdentityRoutes(router) {
  router.post('/identity/reconcile', requireScope('identity:read'), async (req, res) => {
    const body = parse(z.object({
      externalSystem: system,
      candidates: z.array(z.object({
        externalUserId: extUser, recordType,
        email: z.string().trim().email().max(200).optional(),
        institutionalId: z.string().trim().max(30).optional(),
        firstName: z.string().trim().max(80).optional(), lastName: z.string().trim().max(80).optional(),
      }).strict()).min(1).max(200),
    }).strict(), req.body);
    const results = await identity.reconcile(inst(req), body.externalSystem, body.candidates);
    const summary = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
    res.json({ data: results, summary });
  });

  router.get('/identity/resolve', requireScope('identity:read'), async (req, res) => {
    const q = parse(z.object({ externalSystem: system, externalUserId: extUser, recordType: recordType.optional() }), req.query);
    res.json({ data: await identity.resolve(inst(req), q.externalSystem, q.externalUserId, q.recordType) });
  });

  router.get('/identity/links', requireScope('identity:read'), async (req, res) => {
    const q = parse(paginationQuery.extend({ externalSystem: system.optional(), externalUserId: extUser.optional(), recordType: recordType.optional(), status: z.enum(['ACTIVE', 'REVOKED']).optional(), sisRecordId: id.optional() }), req.query);
    const { rows, total } = await identity.listLinks(inst(req), q);
    res.json(paged(rows, total, q));
  });

  router.post('/identity/links', requireScope('identity:write'), idempotent(), async (req, res) => {
    await assertOperation(req, 'identity.link');
    const body = parse(z.object({
      externalSystem: system, externalUserId: extUser, recordType, sisRecordId: id,
      externalEmail: z.string().trim().email().max(200).optional(), externalLabel: z.string().trim().max(160).optional(),
      confirm: z.literal(true, { errorMap: () => ({ message: 'Set confirm: true after an administrator has verified this identity.' }) }),
      evidenceMismatchReason: z.string().trim().min(10).max(500).optional(),
    }).strict(), req.body);
    const link = await identity.link(req.actor, { ...body, method: 'API_CONFIRMED', clientId: req.integration.client.id });
    res.status(201).json({ data: link });
  });

  router.post('/identity/links/:id/revoke', requireScope('identity:write'), async (req, res) => {
    await assertOperation(req, 'identity.link');
    const body = parse(z.object({ reason: z.string().trim().min(5).max(500) }).strict(), req.body);
    res.json({ data: await identity.revoke(req.actor, { linkId: req.params.id, reason: body.reason }) });
  });

  router.get('/integration/write-preferences', async (req, res) => {
    const { client, scopes } = req.integration;
    res.json({ data: { preferences: readPreferences(client), operations: await evaluateCapabilities(client, scopes) } });
  });

  router.put('/integration/write-preferences', requireScope('integration:configure'), async (req, res) => {
    const prefs = validatePreferences(req.body);
    const { client, scopes } = req.integration;
    const before = readPreferences(client);
    const updated = await prisma.$transaction(async (tx) => {
      const c = await tx.integrationClient.update({ where: { id: client.id }, data: { writePreferences: prefs } });
      await audit(req.actor, { action: 'integration.write_preferences_updated', entityType: 'IntegrationClient', entityId: client.id, summary: `Write preferences changed by the integration${req.actor.onBehalfOf ? ` (on behalf of ${req.actor.onBehalfOf})` : ''}`, before, after: prefs }, tx);
      return c;
    });
    res.json({ data: { preferences: readPreferences(updated), operations: await evaluateCapabilities(updated, scopes) } });
  });
}
