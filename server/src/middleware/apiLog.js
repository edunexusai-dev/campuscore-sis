import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';

// Records every /api/v1 request (after it completes) for the integration activity log.
export function apiRequestLog(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const client = req.integration?.client ?? res.locals.logClient;
    prisma.apiRequestLog.create({
      data: {
        institutionId: client?.institutionId ?? null,
        clientId: client?.id ?? null,
        method: req.method,
        path: req.originalUrl.split('?')[0].slice(0, 255),
        status: res.statusCode,
        durationMs: Date.now() - start,
        errorCode: res.locals.errorCode ?? null,
        ip: req.ip,
      },
    }).catch(() => {});
    // Rejected write attempts by an authenticated integration are audited too (outcome = REJECTED).
    if (req.integration && req.method !== 'GET' && res.statusCode >= 400 && res.statusCode < 500 && !req.path.startsWith('/oauth/')) {
      audit(req.actor, { action: 'integration.write_rejected', entityType: 'ApiRequest', entityId: null, outcome: 'REJECTED', summary: `${req.method} ${req.originalUrl.split('?')[0]} rejected with ${res.statusCode} ${res.locals.errorCode ?? ''}`.trim() }).catch(() => {});
    }
  });
  next();
}
