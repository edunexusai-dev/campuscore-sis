// Automatic provisioning of university accounts (Keycloak) from the person registry.
//
// Flow: a record change commits together with its IdentityProvisioning row (database triggers, migration
// 20261103100000) → this worker claims due rows → reconciles each person's account with the identity sync's own
// rules (@campuscore/identity-sync: one account per person, found by person_number; an existing account is
// adopted only on an institutional number AND one of the person's addresses, never on email alone) → records the
// outcome on the row and in the audit log. Keycloak being down never touches the records: the row waits and is
// retried with backoff. The worker reconciles the person's CURRENT state, so processing a row twice is harmless.
//
// What it never does: delete accounts, set passwords, provision staff-only logins (ADMIN/REGISTRAR have no
// person), or grant CampusCore roles (CampusCore decides those from its own records at sign-in).
import { Prisma } from '@prisma/client';
import { syncPerson } from '@campuscore/identity-sync';
import { KeycloakAdminClient } from '@campuscore/identity-sync/clients';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { notFound, conflict } from '../lib/errors.js';
import { personInclude, personDto } from './personService.js';

const CLAIM_SECONDS = 300;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 3_600_000;

const systemActor = (institutionId) => ({ type: 'SYSTEM', id: null, label: 'System (identity provisioning)', institutionId });

// Temporary: the identity provider is unreachable, overloaded or failing. Anything else from Keycloak (refused
// credentials, a missing realm-management role, a bad request) needs a person to fix configuration first.
export function isTransient(error) {
  if (error?.name !== 'SyncError') return true; // unexpected: retried (bounded by maxAttempts), never lost
  if (error.code === 'UNAVAILABLE') return true;
  return (error.code === 'REQUEST_FAILED' || error.code === 'AUTH_FAILED') && (error.status >= 500 || error.status === 429);
}

export const backoffMs = (attempts) => Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_MS);

/** Claim up to `limit` due rows (PENDING and due, or PROCESSING with an expired claim). Safe with several workers. */
async function claim({ limit, personIds }) {
  return prisma.$queryRaw`
    UPDATE "IdentityProvisioning" p
    SET "status" = 'PROCESSING', "lockedUntil" = (now() AT TIME ZONE 'utc') + make_interval(secs => ${CLAIM_SECONDS}), "updatedAt" = now() AT TIME ZONE 'utc'
    FROM (
      SELECT ip."personId" FROM "IdentityProvisioning" ip JOIN "Person" pe ON pe."id" = ip."personId"
      WHERE ((ip."status" = 'PENDING' AND ip."nextAttemptAt" <= now() AT TIME ZONE 'utc') OR (ip."status" = 'PROCESSING' AND ip."lockedUntil" < now() AT TIME ZONE 'utc'))
      ${personIds ? Prisma.sql`AND ip."personId" IN (${Prisma.join(personIds)})` : Prisma.empty}
      -- A merge queues both people at once: the surviving person first, so it can adopt the merged person's account
      -- before the merged person is checked for a leftover account.
      ORDER BY ip."nextAttemptAt", (pe."mergedIntoId" IS NOT NULL)
      LIMIT ${limit}
      FOR UPDATE OF ip SKIP LOCKED
    ) due
    WHERE p."personId" = due."personId"
    RETURNING p."personId", p."institutionId", p."requestedVersion", p."attempts", p."adoptAccountId", p."keycloakUserId", p."lastAction", p."reason"`;
}

/** Decide and apply one person's account. Returns the outcome to record (never throws for Keycloak failures). */
async function reconcile(row, { keycloak, sendSetupEmail, maxAttempts }) {
  const person = await prisma.person.findUnique({ where: { id: row.personId }, include: personInclude });
  if (!person) return { status: 'SKIPPED', lastAction: 'SKIP', reason: 'PERSON_NOT_FOUND' };
  if (person.identityExcluded) return { status: 'SKIPPED', lastAction: 'SKIP', reason: 'IDENTITY_EXCLUDED', personNumber: person.personNumber };
  const dto = personDto(person);
  try {
    if (person.mergedIntoId) {
      // The human being now lives under another person number. An account still carrying this one (made before
      // the merge) is left for an administrator: disable it, or let the surviving person adopt it.
      const accounts = (await keycloak.byAttribute('person_number', person.personNumber)).filter((a) => a.enabled !== false);
      return accounts.length
        ? { status: 'NEEDS_REVIEW', lastAction: 'CONFLICT', reason: 'MERGED_PERSON_HAS_ACCOUNT', keycloakUserId: accounts[0].id, personNumber: person.personNumber }
        : { status: 'SKIPPED', lastAction: 'SKIP', reason: 'MERGED_PERSON', personNumber: person.personNumber };
    }
    const former = await prisma.person.findMany({ where: { mergedIntoId: person.id }, select: { personNumber: true } });
    const adopt = row.adoptAccountId ? { [person.personNumber]: row.adoptAccountId } : {};
    const result = await syncPerson({ ...dto, formerPersonNumbers: former.map((p) => p.personNumber) }, { keycloak, apply: true, adopt, sendSetupEmail, knownAccountId: row.keycloakUserId });
    const lastResult = Object.fromEntries(Object.entries({ via: result.via, changed: result.changed, addRoles: result.addRoles, removeRoles: result.removeRoles, roles: result.roles }).filter(([, v]) => v !== undefined));
    const base = { personNumber: person.personNumber, lastAction: result.action, lastResult, clearAdopt: Boolean(row.adoptAccountId) };
    if (result.action === 'CONFLICT') return { ...base, status: 'NEEDS_REVIEW', reason: result.reason };
    if (result.action === 'SKIP') return { ...base, status: 'SKIPPED', reason: result.reason };
    return { ...base, status: 'PROVISIONED', reason: null, keycloakUserId: result.accountId, setupEmailSent: result.action === 'CREATE' && sendSetupEmail };
  } catch (error) {
    const code = error?.name === 'SyncError' ? error.code : 'UNEXPECTED';
    const message = error?.name === 'SyncError' ? error.message : 'Unexpected error while provisioning.';
    if (code === 'CONFLICT') return { status: 'NEEDS_REVIEW', lastAction: 'CONFLICT', reason: 'KEYCLOAK_USERNAME_OR_EMAIL_TAKEN', error: { code, message }, personNumber: person.personNumber };
    const attempts = row.attempts + 1;
    if (isTransient(error) && attempts < maxAttempts) {
      return { status: 'PENDING', retry: true, attempts, nextAttemptAt: new Date(Date.now() + backoffMs(attempts)), error: { code, message }, personNumber: person.personNumber };
    }
    return { status: 'FAILED', attempts, error: { code, message }, personNumber: person.personNumber };
  }
}

async function record(row, outcome) {
  const now = new Date();
  const data = {
    status: outcome.status,
    lockedUntil: null,
    attempts: outcome.retry || outcome.status === 'FAILED' ? outcome.attempts : 0,
    nextAttemptAt: outcome.nextAttemptAt ?? now,
    lastErrorCode: outcome.error?.code ?? null,
    lastError: outcome.error?.message ?? null,
    ...(outcome.lastAction !== undefined ? { lastAction: outcome.lastAction } : {}),
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    ...(outcome.lastResult ? { lastResult: outcome.lastResult } : {}),
    ...(outcome.keycloakUserId ? { keycloakUserId: outcome.keycloakUserId } : {}),
    ...(outcome.status === 'PROVISIONED' ? { provisionedAt: now } : {}),
    ...(outcome.setupEmailSent ? { setupEmailSentAt: now } : {}),
    ...(outcome.clearAdopt ? { adoptAccountId: null } : {}),
  };
  const who = outcome.personNumber ?? row.personId;
  const events = [];
  if (outcome.status === 'PROVISIONED' && ['CREATE', 'ADOPT', 'UPDATE'].includes(outcome.lastAction)) {
    const r = outcome.lastResult;
    const detail = { CREATE: `created${r.roles?.length ? ` with roles ${r.roles.join(', ')}` : ''}`, ADOPT: `adopted existing account (matched by ${String(r.via ?? '').toLowerCase().replace(/_/g, ' ')})`, UPDATE: `updated (${[...(r.changed ?? []), ...(r.addRoles ?? []).map((x) => `+${x}`), ...(r.removeRoles ?? []).map((x) => `-${x}`)].join(', ')})` }[outcome.lastAction];
    events.push({ action: { CREATE: 'identity.account_created', ADOPT: 'identity.account_adopted', UPDATE: 'identity.account_updated' }[outcome.lastAction], summary: `University account for ${who} ${detail}`, after: { keycloakUserId: outcome.keycloakUserId, ...r } });
  }
  if (outcome.status === 'NEEDS_REVIEW' && !(row.lastAction === 'CONFLICT' && row.reason === outcome.reason)) {
    events.push({ action: 'identity.provisioning_needs_review', outcome: 'REJECTED', summary: `University account for ${who} needs review: ${outcome.reason}`, after: { reason: outcome.reason } });
  }
  if (outcome.status === 'FAILED' || (outcome.retry && outcome.attempts === 1)) {
    events.push({ action: 'identity.provisioning_failed', outcome: 'FAILURE', summary: `University account for ${who} could not be provisioned (${outcome.error.code})${outcome.retry ? '; retrying automatically' : `; gave up after ${outcome.attempts} attempt(s)`}`, after: { code: outcome.error.code, attempts: outcome.attempts } });
  }
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.identityProvisioning.updateMany({ where: { personId: row.personId, requestedVersion: row.requestedVersion }, data });
    // A change arrived while this person was being processed: keep what was learned, run them again now.
    if (!count) await tx.identityProvisioning.update({ where: { personId: row.personId }, data: { ...data, status: 'PENDING', attempts: 0, nextAttemptAt: now } });
    for (const e of events) await audit(systemActor(row.institutionId), { entityType: 'Person', entityId: row.personId, ...e }, tx);
  });
  return { personId: row.personId, personNumber: outcome.personNumber ?? null, status: outcome.status, action: outcome.lastAction ?? null, reason: outcome.reason ?? null, errorCode: outcome.error?.code ?? null };
}

/** One pass: claim due rows and process them. `personIds` limits the pass to those people (operations, tests). */
export async function runOnce({ keycloak, limit = 20, personIds, sendSetupEmail = config.identitySync.sendSetupEmail, maxAttempts = config.identitySync.maxAttempts } = {}) {
  const rows = await claim({ limit, personIds: personIds?.length ? personIds : null });
  const results = [];
  for (const row of rows) results.push(await record(row, await reconcile(row, { keycloak, sendSetupEmail, maxAttempts })));
  return results;
}

export function keycloakFromConfig(c = config.identitySync.keycloak) {
  return new KeycloakAdminClient({ baseUrl: c.baseUrl, realm: c.realm, clientId: c.clientId, clientSecret: c.clientSecret, timeoutMs: c.timeoutMs });
}

/** The background worker (in the API process): polls for due rows, drains them in batches, then waits. */
export function startIdentityProvisioningWorker({ keycloak = keycloakFromConfig(), intervalMs = config.identitySync.pollIntervalMs, log = console } = {}) {
  let stopped = false;
  let timer = null;
  let running = null;
  const tick = async () => {
    try {
      for (let batch = await runOnce({ keycloak }); batch.length && !stopped; batch = await runOnce({ keycloak })) {
        for (const r of batch) log.log(`identity provisioning: ${r.personNumber ?? r.personId} ${r.status}${r.action ? ` (${r.action})` : ''}${r.reason ? ` ${r.reason}` : ''}${r.errorCode ? ` error ${r.errorCode}` : ''}`);
      }
    } catch (error) {
      log.error(`identity provisioning: pass failed (${error?.code ?? error?.name ?? 'error'})`);
    }
    if (!stopped) timer = setTimeout(() => { running = tick(); }, intervalMs);
  };
  timer = setTimeout(() => { running = tick(); }, 1000);
  log.log(`identity provisioning: worker started (every ${Math.round(intervalMs / 1000)}s)`);
  return { stop: async () => { stopped = true; clearTimeout(timer); await running; } };
}

// ── Administration ──

const AWAITING = ['PENDING', 'PROCESSING'];

export function provisioningDto(row) {
  if (!row) return { status: null };
  return {
    status: row.status,
    keycloakUserId: row.keycloakUserId,
    lastAction: row.lastAction,
    reason: row.reason,
    lastResult: row.lastResult,
    lastErrorCode: row.lastErrorCode,
    lastError: row.lastError,
    attempts: row.attempts,
    nextAttemptAt: AWAITING.includes(row.status) ? row.nextAttemptAt : null,
    provisionedAt: row.provisionedAt,
    setupEmailSentAt: row.setupEmailSentAt,
    adoptionPending: Boolean(row.adoptAccountId),
    updatedAt: row.updatedAt,
  };
}

async function personFor(institutionId, personId) {
  const person = await prisma.person.findFirst({ where: { id: personId, institutionId }, select: { id: true, personNumber: true, student: { select: { id: true } }, faculty: { select: { id: true } } } });
  if (!person) throw notFound('Person');
  return person;
}

export async function getProvisioning(institutionId, personId) {
  await personFor(institutionId, personId);
  return provisioningDto(await prisma.identityProvisioning.findUnique({ where: { personId } }));
}

/** Queue for administrators: people by provisioning status (default: those needing a person's attention). */
export async function listProvisioning(institutionId, { status, page = 1, pageSize = 25 }) {
  const where = { institutionId, status: status ? status : { in: ['NEEDS_REVIEW', 'FAILED'] } };
  const [rows, total] = await Promise.all([
    prisma.identityProvisioning.findMany({ where, include: { person: { include: personInclude } }, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.identityProvisioning.count({ where }),
  ]);
  return { rows: rows.map((r) => { const p = personDto(r.person); return { personId: p.id, personNumber: p.personNumber, firstName: p.firstName, lastName: p.lastName, relationships: p.relationships.map(({ type, sisId, number, status }) => ({ type, sisId, number, status })), ...provisioningDto(r) }; }), total };
}

/**
 * An administrator asks for the person to be processed again now (after fixing configuration or data, or after
 * disabling a merged person's leftover account). People never in the flow (no records, no row) are refused.
 */
export async function requestRetry(actor, personId) {
  const person = await personFor(actor.institutionId, personId);
  return prisma.$transaction(async (tx) => {
    const before = await tx.identityProvisioning.findUnique({ where: { personId } });
    if (!before && !person.student && !person.faculty) throw conflict('This person has no student or faculty record, so there is no university account to provision.', 'no_records');
    if (before?.status === 'PROCESSING') throw conflict('This person is being processed right now.', 'provisioning_in_progress');
    const row = await tx.identityProvisioning.upsert({
      where: { personId },
      create: { personId, institutionId: actor.institutionId },
      update: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), requestedVersion: { increment: 1 } },
    });
    await audit(actor, { action: 'identity.provisioning_retried', entityType: 'Person', entityId: personId, summary: `Requested university account provisioning again for ${person.personNumber}${before ? ` (was ${before.status}${before.reason ? `: ${before.reason}` : ''})` : ''}`, before: before ? { status: before.status, reason: before.reason, lastErrorCode: before.lastErrorCode } : undefined, after: { status: 'PENDING' } }, tx);
    return provisioningDto(row);
  });
}

/**
 * An administrator confirms that an existing account in the identity provider is this person's (after checking
 * it in Keycloak): the worker adopts it once, still refusing an account that carries another person's number.
 */
export async function confirmAdoption(actor, personId, { accountId, reason }) {
  const person = await personFor(actor.institutionId, personId);
  if (!person.student && !person.faculty) throw conflict('This person has no student or faculty record, so there is no university account to provision.', 'no_records');
  return prisma.$transaction(async (tx) => {
    const before = await tx.identityProvisioning.findUnique({ where: { personId } });
    if (before?.status === 'PROCESSING') throw conflict('This person is being processed right now.', 'provisioning_in_progress');
    const row = await tx.identityProvisioning.upsert({
      where: { personId },
      create: { personId, institutionId: actor.institutionId, adoptAccountId: accountId },
      update: { adoptAccountId: accountId, status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), requestedVersion: { increment: 1 } },
    });
    await audit(actor, { action: 'identity.account_adoption_confirmed', entityType: 'Person', entityId: personId, summary: `Confirmed university account ${accountId} belongs to ${person.personNumber}: ${reason}`, before: before ? { status: before.status, reason: before.reason } : undefined, after: { adoptAccountId: accountId, reason } }, tx);
    return provisioningDto(row);
  });
}
