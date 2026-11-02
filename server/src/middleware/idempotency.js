// Idempotency-Key support for integration writes (IETF draft "The Idempotency-Key HTTP Header Field").
// The first request with a key is executed and its final response stored; a retry with the same key and the
// same body replays that response instead of repeating the write. Same key + different body → 422.
// A concurrent duplicate while the first is still running → 409 (retryable). 5xx outcomes are not stored, so the
// client may safely retry. Keys are scoped to the integration client and expire after 24 hours.
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

const TTL_MS = 24 * 3600 * 1000;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export const idempotent = ({ required = false } = {}) => async (req, res, next) => {
  try {
    const key = req.get('idempotency-key');
    if (!key) {
      if (required) throw new AppError(400, 'idempotency_key_required', 'This operation requires an Idempotency-Key header (8–128 characters) so retries cannot create duplicates.');
      return next();
    }
    if (!KEY_RE.test(key)) throw new AppError(400, 'validation_error', 'Idempotency-Key must be 8–128 characters of letters, digits, _ . : or -.');
    const { client } = req.integration;
    const requestHash = crypto.createHash('sha256').update(`${req.method} ${req.baseUrl}${req.path}\n${JSON.stringify(req.body ?? {})}`).digest('hex');
    let record;
    try {
      record = await prisma.idempotencyRecord.create({ data: { institutionId: client.institutionId, clientId: client.id, key, method: req.method, path: `${req.baseUrl}${req.path}`, requestHash, expiresAt: new Date(Date.now() + TTL_MS) } });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const existing = await prisma.idempotencyRecord.findUnique({ where: { clientId_key: { clientId: client.id, key } } });
      if (existing.expiresAt < new Date()) {
        await prisma.idempotencyRecord.delete({ where: { id: existing.id } });
        return idempotent({ required })(req, res, next);
      }
      if (existing.requestHash !== requestHash) throw new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
      if (existing.state === 'IN_PROGRESS') { res.set('Retry-After', '1'); throw new AppError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed. Retry shortly.'); }
      res.set('Idempotent-Replayed', 'true');
      return res.status(existing.responseStatus).json(existing.responseBody);
    }
    // Capture the final response (success or business error) for replay.
    const json = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      const done = status >= 500
        ? prisma.idempotencyRecord.delete({ where: { id: record.id } })
        : prisma.idempotencyRecord.update({ where: { id: record.id }, data: { state: 'COMPLETED', responseStatus: status, responseBody: body ?? null } });
      done.catch(() => {}).finally(() => json(body));
      return res;
    };
    next();
  } catch (e) { next(e); }
};
