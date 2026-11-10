// Integration clients (OAuth 2.0 client-credentials) and access-token lifecycle.
// Secrets: shown once at creation/rotation; only an HMAC hash is stored.
// Tokens: short-lived HS256 JWTs whose `jti` is recorded so they can be revoked server-side. A token is also
// invalidated if the client is disabled/revoked or its secret is rotated (secretVersion mismatch).
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { hashClientSecret, randomToken, safeEqualHex } from '../lib/crypto.js';
import { AppError, notFound, ruleViolation } from '../lib/errors.js';

export const SCOPES = {
  'institution:read': 'Institution profile and settings metadata',
  'terms:read': 'Academic years and terms',
  'calendar:read': 'Academic calendar events',
  'programs:read': 'Colleges, departments and academic programs',
  'courses:read': 'Course catalog and prerequisites',
  'sections:read': 'Course sections, meeting times and instructors',
  'students:read': 'Student directory and academic profile (no date of birth or emergency contacts)',
  'students:write': 'Legacy: update student contact details only (policy-controlled)',
  'students:create': 'Create student records (policy-controlled; idempotent)',
  'students:update': 'Update policy-selected student profile fields',
  'students:academic': 'Update policy-selected academic attributes (program, admit term, expected graduation)',
  'students:deactivate': 'Deactivate (withdraw) a student record; history is retained',
  'identity:read': 'Reconcile and resolve external accounts to CampusCore student/faculty records',
  'identity:write': 'Link and unlink external accounts to CampusCore records (policy-controlled)',
  'audit:read': 'Read the audit history of individual student records',
  'integration:configure': "Narrow this client's own write preferences (can never broaden access)",
  'faculty:read': 'Faculty directory and teaching assignments',
  'people:read': 'Person registry: one entry per human being with their student/faculty relationships, primary email and status (for identity provisioning)',
  'registrations:read': 'Registrations, waitlists and class rosters',
  'registrations:write': 'Register and drop students (all registration rules apply)',
  'schedules:read': 'Student and faculty class schedules',
  'grades:read': 'Published grades, GPA and academic standing',
  'grades:write': 'Post draft grades on behalf of an assigned instructor (policy-controlled; never publishes)',
  'attendance:read': 'Attendance records',
  'attendance:write': 'Record attendance on behalf of an assigned instructor (policy-controlled)',
  'announcements:read': "Institution-wide announcements, and class announcements for a student's registered sections",
  'finance:read': "A student's account: balance, assessed fees, transactions, invoices and payment deadlines",
};
export const SCOPE_NAMES = Object.keys(SCOPES);

const oauthError = (status, error, description) => Object.assign(new AppError(status, error, description), { oauth: true });

function clientDto(c) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    clientId: c.clientId,
    secretHint: `••••${c.secretHint}`,
    scopes: c.scopes,
    enabled: c.enabled,
    revoked: !!c.revokedAt,
    revokedAt: c.revokedAt,
    tokenTtlSeconds: c.tokenTtlSeconds,
    createdAt: c.createdAt,
    secretRotatedAt: c.secretRotatedAt,
    lastUsedAt: c.lastUsedAt,
    lastUsedIp: c.lastUsedIp,
    writePreferences: c.writePreferences ?? null,
  };
}

function newSecret() {
  const secret = `ccs_${randomToken(32)}`;
  return { secret, secretHash: hashClientSecret(secret), secretHint: secret.slice(-4) };
}

export async function listClients(institutionId) {
  const clients = await prisma.integrationClient.findMany({ where: { institutionId }, orderBy: { createdAt: 'desc' } });
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const usage = await prisma.apiRequestLog.groupBy({ by: ['clientId'], where: { institutionId, createdAt: { gte: since } }, _count: true });
  const errs = await prisma.apiRequestLog.groupBy({ by: ['clientId'], where: { institutionId, createdAt: { gte: since }, status: { gte: 400 } }, _count: true });
  const activeTokens = await prisma.accessToken.groupBy({ by: ['clientId'], where: { client: { institutionId }, revokedAt: null, expiresAt: { gt: new Date() } }, _count: true });
  const map = (rows) => Object.fromEntries(rows.map((r) => [r.clientId, r._count]));
  const u = map(usage), e = map(errs), t = map(activeTokens);
  return clients.map((c) => ({ ...clientDto(c), stats: { requests24h: u[c.id] ?? 0, errors24h: e[c.id] ?? 0, activeTokens: t[c.id] ?? 0 } }));
}

export async function getClient(institutionId, id) {
  const c = await prisma.integrationClient.findFirst({ where: { id, institutionId } });
  if (!c) throw notFound('Integration client');
  return clientDto(c);
}

export async function createClient(actor, { name, description, scopes, tokenTtlSeconds }) {
  const { secret, secretHash, secretHint } = newSecret();
  const clientId = `cc_${crypto.randomBytes(12).toString('hex')}`;
  const c = await prisma.integrationClient.create({
    data: { institutionId: actor.institutionId, name, description, clientId, secretHash, secretHint, scopes, tokenTtlSeconds, createdById: actor.id },
  });
  await audit(actor, { action: 'integration.created', entityType: 'IntegrationClient', entityId: c.id, summary: `Created integration client "${name}" with scopes: ${scopes.join(', ') || '(none)'}`, after: { scopes, tokenTtlSeconds } });
  return { client: clientDto(c), clientSecret: secret };
}

export async function updateClient(actor, id, changes) {
  const before = await prisma.integrationClient.findFirst({ where: { id, institutionId: actor.institutionId } });
  if (!before) throw notFound('Integration client');
  if (before.revokedAt) throw ruleViolation('client_revoked', 'Revoked clients cannot be modified. Create a new client instead.');
  const c = await prisma.$transaction(async (tx) => {
    const updated = await tx.integrationClient.update({ where: { id }, data: changes });
    // Narrowing scopes or disabling a client must take effect immediately: revoke outstanding tokens.
    const scopesNarrowed = changes.scopes && before.scopes.some((s) => !changes.scopes.includes(s));
    if (changes.enabled === false || scopesNarrowed) {
      await tx.accessToken.updateMany({ where: { clientId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await audit(actor, { action: 'integration.updated', entityType: 'IntegrationClient', entityId: id, summary: `Updated integration client "${before.name}"${changes.enabled === false ? ' (disabled)' : changes.enabled === true ? ' (enabled)' : ''}`, before: { name: before.name, scopes: before.scopes, enabled: before.enabled, tokenTtlSeconds: before.tokenTtlSeconds }, after: changes }, tx);
    return updated;
  });
  return clientDto(c);
}

export async function rotateSecret(actor, id) {
  const before = await prisma.integrationClient.findFirst({ where: { id, institutionId: actor.institutionId } });
  if (!before) throw notFound('Integration client');
  if (before.revokedAt) throw ruleViolation('client_revoked', 'Revoked clients cannot be rotated.');
  const { secret, secretHash, secretHint } = newSecret();
  const c = await prisma.$transaction(async (tx) => {
    const updated = await tx.integrationClient.update({ where: { id }, data: { secretHash, secretHint, secretVersion: { increment: 1 }, secretRotatedAt: new Date() } });
    await tx.accessToken.updateMany({ where: { clientId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(actor, { action: 'integration.secret_rotated', entityType: 'IntegrationClient', entityId: id, summary: `Rotated client secret for "${before.name}"; all outstanding tokens revoked` }, tx);
    return updated;
  });
  return { client: clientDto(c), clientSecret: secret };
}

export async function revokeClient(actor, id) {
  const before = await prisma.integrationClient.findFirst({ where: { id, institutionId: actor.institutionId } });
  if (!before) throw notFound('Integration client');
  const c = await prisma.$transaction(async (tx) => {
    const updated = await tx.integrationClient.update({ where: { id }, data: { revokedAt: new Date(), enabled: false } });
    await tx.accessToken.updateMany({ where: { clientId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(actor, { action: 'integration.revoked', entityType: 'IntegrationClient', entityId: id, summary: `Permanently revoked integration client "${before.name}"` }, tx);
    return updated;
  });
  return clientDto(c);
}

export async function revokeAllTokens(actor, id) {
  const client = await prisma.integrationClient.findFirst({ where: { id, institutionId: actor.institutionId } });
  if (!client) throw notFound('Integration client');
  const { count } = await prisma.accessToken.updateMany({ where: { clientId: id, revokedAt: null, expiresAt: { gt: new Date() } }, data: { revokedAt: new Date() } });
  await audit(actor, { action: 'integration.tokens_revoked', entityType: 'IntegrationClient', entityId: id, summary: `Revoked ${count} active token(s) for "${client.name}"` });
  return { revoked: count };
}

export async function listTokens(institutionId, id) {
  const client = await prisma.integrationClient.findFirst({ where: { id, institutionId } });
  if (!client) throw notFound('Integration client');
  const tokens = await prisma.accessToken.findMany({ where: { clientId: id }, orderBy: { issuedAt: 'desc' }, take: 50 });
  const now = new Date();
  return tokens.map((t) => ({ jti: t.jti, scopes: t.scopes, issuedAt: t.issuedAt, expiresAt: t.expiresAt, revokedAt: t.revokedAt, ip: t.ip, state: t.revokedAt ? 'REVOKED' : t.expiresAt < now ? 'EXPIRED' : t.secretVersion !== client.secretVersion ? 'SUPERSEDED' : 'ACTIVE' }));
}

// ── Token endpoint (RFC 6749 §4.4 client credentials) ──
export async function issueToken({ grantType, clientId, clientSecret, scope, ip }) {
  if (grantType !== 'client_credentials') throw oauthError(400, 'unsupported_grant_type', 'Only the client_credentials grant is supported.');
  if (!clientId || !clientSecret) throw oauthError(401, 'invalid_client', 'Client authentication failed.');
  const client = await prisma.integrationClient.findUnique({ where: { clientId } });
  // Same error for unknown client, wrong secret, disabled or revoked: no client enumeration.
  if (!client || !safeEqualHex(client.secretHash, hashClientSecret(clientSecret)) || !client.enabled || client.revokedAt) {
    if (client) await audit({ type: 'INTEGRATION', id: client.id, label: `Integration: ${client.name}`, institutionId: client.institutionId, ip }, { action: 'integration.auth_failed', entityType: 'IntegrationClient', entityId: client.id, summary: `Token request rejected for "${client.name}" (${!client.enabled || client.revokedAt ? 'client disabled or revoked' : 'invalid secret'})` });
    throw oauthError(401, 'invalid_client', 'Client authentication failed.');
  }
  let granted = client.scopes;
  if (scope) {
    const requested = [...new Set(String(scope).split(/\s+/).filter(Boolean))];
    const notAllowed = requested.filter((s) => !client.scopes.includes(s));
    if (notAllowed.length) throw oauthError(400, 'invalid_scope', `Scope(s) not permitted for this client: ${notAllowed.join(' ')}`);
    granted = requested;
  }
  const jti = crypto.randomUUID();
  const expiresIn = client.tokenTtlSeconds;
  const accessToken = jwt.sign(
    { scope: granted.join(' '), inst: client.institutionId, sv: client.secretVersion },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn, subject: client.clientId, jwtid: jti, issuer: config.publicApiUrl, audience: `${config.publicApiUrl}/api/v1` },
  );
  await prisma.$transaction([
    prisma.accessToken.create({ data: { jti, clientId: client.id, scopes: granted, secretVersion: client.secretVersion, expiresAt: new Date(Date.now() + expiresIn * 1000), ip } }),
    prisma.integrationClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date(), lastUsedIp: ip } }),
  ]);
  return { client, access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, scope: granted.join(' ') };
}

// Verifies a bearer token and returns { client, scopes, jti }. Throws OAuth-style 401 errors.
export async function verifyToken(token) {
  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: config.publicApiUrl, audience: `${config.publicApiUrl}/api/v1` });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw oauthError(401, 'invalid_token', 'The access token has expired.');
    throw oauthError(401, 'invalid_token', 'The access token is invalid.');
  }
  const record = await prisma.accessToken.findUnique({ where: { jti: claims.jti }, include: { client: true } });
  if (!record) throw oauthError(401, 'invalid_token', 'The access token is invalid.');
  if (record.revokedAt) throw oauthError(401, 'invalid_token', 'The access token has been revoked.');
  const { client } = record;
  if (!client.enabled || client.revokedAt) throw oauthError(401, 'invalid_token', 'The integration client is disabled or revoked.');
  if (client.secretVersion !== claims.sv) throw oauthError(401, 'invalid_token', 'The client credentials were rotated; request a new token.');
  // Effective scopes = scopes on the token ∩ scopes currently granted to the client.
  const scopes = record.scopes.filter((s) => client.scopes.includes(s));
  return { client, scopes, jti: claims.jti, expiresAt: record.expiresAt };
}

// RFC 7009 token revocation, authenticated by the owning client.
export async function revokeTokenByClient({ token, clientId, clientSecret }) {
  const client = await prisma.integrationClient.findUnique({ where: { clientId: clientId ?? '' } });
  if (!client || !clientSecret || !safeEqualHex(client.secretHash, hashClientSecret(clientSecret))) throw oauthError(401, 'invalid_client', 'Client authentication failed.');
  const decoded = jwt.decode(token);
  if (decoded?.jti) await prisma.accessToken.updateMany({ where: { jti: decoded.jti, clientId: client.id, revokedAt: null }, data: { revokedAt: new Date() } });
  // Per RFC 7009 the response is 200 whether or not the token was valid.
}

export async function apiActivity(institutionId, { clientId, page, pageSize }) {
  const where = { institutionId, ...(clientId ? { clientId } : {}) };
  const [rows, total] = await Promise.all([
    prisma.apiRequestLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { client: { select: { name: true } } } }),
    prisma.apiRequestLog.count({ where }),
  ]);
  return { data: rows.map((r) => ({ id: r.id, client: r.client?.name ?? null, clientId: r.clientId, method: r.method, path: r.path, status: r.status, durationMs: r.durationMs, errorCode: r.errorCode, ip: r.ip, createdAt: r.createdAt })), pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}
