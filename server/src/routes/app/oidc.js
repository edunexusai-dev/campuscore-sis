// University sign-in for the CampusCore web app (mounted at /api/app/auth/oidc).
//
//   GET  /config                  is university sign-in available, and under what name
//   GET  /start?returnTo=/path    sealed transaction cookie, then 302 to the identity provider
//   GET  /callback                verify, resolve the CampusCore account, create the CampusCore session
//   POST /logout-everywhere       end this session AND the provider session (all university apps)
//   POST /backchannel-logout      the provider ends sessions (OIDC Back-Channel Logout, signed token)
//
// Who signed in is proven by the provider; what the account may do is CampusCore's own decision: its
// roles (staff role, plus Student/Faculty from its records), its permission matrix and record ownership. Nothing in the provider's token (groups, realm
// roles) grants a CampusCore role, and ADMIN/REGISTRAR accounts are never linked automatically.
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { audit, actorFromUser } from '../../lib/audit.js';
import { createSession, destroySession } from '../../middleware/session.js';
import { AppError } from '../../lib/errors.js';
import { homeFor, roleInclude, effectiveRoles } from '../../lib/roles.js';
import { LOGIN_ACCESS, primaryEmailOf } from '../../services/personService.js';
import { OidcError, TRANSACTION_TTL_MS, beginLogin, completeLogin, logoutUrl, oidcSettings, seal, unseal, verifyLogoutToken } from '../../lib/oidc.js';

const router = Router();
const COOKIE = 'cc_oidc_tx';
const COOKIE_PATH = '/api/app/auth/oidc';
const TX_PURPOSE = 'campuscore-oidc-transaction-v1';
const HINT_PURPOSE = 'campuscore-oidc-id-token-v1';
const PRIVILEGED = ['ADMIN', 'REGISTRAR'];
const limiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 10_000 : 30, standardHeaders: 'draft-7', legacyHeaders: false });

const txCookie = { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: COOKIE_PATH };
const failTo = (res, s, reason) => res.redirect(302, `${s.appUrl}/login?sso_error=${encodeURIComponent(reason)}`);

class Refusal extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

/** System-level audit entry (no identity detail in refusals beyond the reason code). */
async function systemAudit(action, summary, outcome = 'SUCCESS') {
  const slug = oidcSettings()?.institutionSlug;
  const institution = await prisma.institution.findFirst({ where: slug ? { slug } : {}, orderBy: { createdAt: 'asc' } });
  if (!institution) return;
  await audit({ type: 'SYSTEM', id: null, label: 'University sign-in', institutionId: institution.id }, { action, entityType: 'User', entityId: null, summary, outcome }).catch(() => {});
}

const claimValues = (claims, name) => {
  const v = claims?.[name];
  return (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);
};

/**
 * The CampusCore account for a verified sign-in:
 *  1. an existing link (issuer + subject), or
 *  2. at the first sign-in, the ONE person who owns the student/faculty records named by the token's verified
 *     institutional numbers (all numbers must belong to that same person), with the provider's verified email
 *     being one of that person's addresses. Never email alone; ambiguity refuses; staff accounts are never
 *     auto-linked. The person's login is used, or (OIDC_JIT_ACCOUNTS) created now without a password.
 */
async function resolveAccount(s, identity) {
  const existing = await prisma.userIdentityLink.findUnique({ where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } }, include: { user: true } });
  if (existing) {
    if (existing.user.status !== 'ACTIVE') throw new Refusal('ACCOUNT_DISABLED');
    return { user: existing.user, link: existing, linked: false, created: false };
  }
  const institution = s.institutionSlug ? await prisma.institution.findUnique({ where: { slug: s.institutionSlug } }) : null;
  if (!institution) throw new Refusal('NOT_CONFIGURED');
  const studentNumbers = claimValues(identity.claims, s.studentNumberClaim);
  const employeeNumbers = claimValues(identity.claims, s.employeeNumberClaim);
  if (!studentNumbers.length && !employeeNumbers.length) throw new Refusal('NO_INSTITUTIONAL_ID');
  const records = [
    ...(studentNumbers.length ? await prisma.student.findMany({ where: { institutionId: institution.id, studentNumber: { in: studentNumbers } }, select: { personId: true } }) : []),
    ...(employeeNumbers.length ? await prisma.faculty.findMany({ where: { institutionId: institution.id, employeeNumber: { in: employeeNumbers } }, select: { personId: true } }) : []),
  ];
  if (!records.length) throw new Refusal('NO_MATCHING_RECORD');
  const personIds = [...new Set(records.map((r) => r.personId))];
  if (personIds.length > 1) throw new Refusal('AMBIGUOUS_RECORDS');
  const person = await prisma.person.findUnique({ where: { id: personIds[0] }, include: { student: true, faculty: true, user: true } });
  let user = person.user;
  if (user && user.status !== 'ACTIVE') throw new Refusal('ACCOUNT_DISABLED');
  if (user && PRIVILEGED.includes(user.role)) throw new Refusal('STAFF_ACCOUNT_NEEDS_ADMIN_LINK');
  if (identity.claims.email_verified !== true) throw new Refusal('EMAIL_NOT_VERIFIED');
  const email = String(identity.claims.email ?? '').toLowerCase();
  const known = new Set([user?.email, person.student?.email, person.faculty?.email].filter(Boolean).map((e) => e.toLowerCase()));
  if (!known.has(email)) throw new Refusal('EVIDENCE_MISMATCH');
  if (!user) {
    if (!s.jitAccounts) throw new Refusal('NO_CAMPUSCORE_LOGIN');
    if (person.identityExcluded) throw new Refusal('IDENTITY_EXCLUDED');
    const hasAccess = (person.student && LOGIN_ACCESS.STUDENT(person.student)) || (person.faculty && LOGIN_ACCESS.FACULTY(person.faculty));
    if (!hasAccess) throw new Refusal('NO_CURRENT_RELATIONSHIP');
    if (await prisma.user.findUnique({ where: { email: primaryEmailOf(person) }, select: { id: true } })) throw new Refusal('EMAIL_IN_USE');
  } else if (await prisma.userIdentityLink.findUnique({ where: { userId_issuer: { userId: user.id, issuer: identity.issuer } } })) {
    throw new Refusal('ACCOUNT_LINKED_TO_ANOTHER_IDENTITY');
  }
  const created = !user;
  try {
    return await prisma.$transaction(async (tx) => {
      if (!user) {
        const named = person.faculty ?? person.student;
        user = await tx.user.create({ data: { institutionId: institution.id, personId: person.id, email: primaryEmailOf(person), passwordHash: null, firstName: named.firstName, lastName: named.lastName, role: person.faculty ? 'FACULTY' : 'STUDENT' } });
      }
      // Every record of the person belongs to the person's one login (also repairs a record added without one).
      if (person.student && !person.student.userId) await tx.student.update({ where: { id: person.student.id }, data: { userId: user.id } });
      if (person.faculty && !person.faculty.userId) await tx.faculty.update({ where: { id: person.faculty.id }, data: { userId: user.id } });
      const link = await tx.userIdentityLink.create({ data: { userId: user.id, issuer: identity.issuer, subject: identity.subject, linkMethod: 'INSTITUTIONAL_ID' } });
      return { user, link, linked: true, created };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new Refusal(created ? 'EMAIL_IN_USE' : 'ACCOUNT_LINKED_TO_ANOTHER_IDENTITY');
    throw error;
  }
}

router.get('/config', (_req, res) => {
  const s = oidcSettings();
  res.json({ data: s ? { enabled: true, displayName: s.displayName } : { enabled: false } });
});

router.get('/start', limiter, async (req, res) => {
  const s = oidcSettings();
  if (!s) return res.redirect(302, '/login');
  try {
    const { url, transaction } = await beginLogin(s, { returnTo: req.query.returnTo });
    res.cookie(COOKIE, seal(transaction, config.jwtSecret, TX_PURPOSE), { ...txCookie, maxAge: TRANSACTION_TTL_MS });
    return res.redirect(302, url);
  } catch (error) {
    return failTo(res, s, error instanceof OidcError ? 'PROVIDER_UNAVAILABLE' : 'SIGN_IN_FAILED');
  }
});

router.get('/callback', limiter, async (req, res) => {
  const s = oidcSettings();
  if (!s) return res.redirect(302, '/login');
  const sealed = req.cookies?.[COOKIE];
  res.clearCookie(COOKIE, txCookie);
  if (req.query.error) return failTo(res, s, req.query.error === 'access_denied' ? 'CANCELLED' : 'PROVIDER_ERROR');
  let transaction;
  try {
    transaction = JSON.parse(unseal(sealed, config.jwtSecret, TX_PURPOSE) ?? 'null');
  } catch { transaction = null; }
  if (!transaction) return failTo(res, s, 'INVALID_REQUEST');
  try {
    const identity = await completeLogin(s, { callbackUrl: `${s.appUrl}${req.originalUrl}`, transaction });
    const { user, link, linked, created } = await resolveAccount(s, identity);
    await prisma.$transaction([
      prisma.userIdentityLink.update({ where: { id: link.id }, data: { lastLoginAt: new Date() } }),
      prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    ]);
    // A previous CampusCore session in this browser is replaced, never merged.
    await destroySession(req, res);
    await createSession(res, user, req, { issuer: identity.issuer, subject: identity.subject, sid: identity.claims.sid ? String(identity.claims.sid) : null, idTokenSealed: identity.idToken ? seal(identity.idToken, config.jwtSecret, HINT_PURPOSE) : null });
    const actor = actorFromUser(user, req.ip);
    if (created) await audit(actor, { action: 'auth.sso_account_created', entityType: 'User', entityId: user.id, summary: 'Created a CampusCore login (university sign-in only, no password) at first sign-in (verified institutional ID)' });
    if (linked) await audit(actor, { action: 'auth.sso_linked', entityType: 'User', entityId: user.id, summary: 'Linked a university sign-in at first sign-in (verified institutional ID)' });
    await audit(actor, { action: 'auth.login', entityType: 'User', entityId: user.id, summary: 'Signed in with the university sign-in' });
    const roles = effectiveRoles(await prisma.user.findUnique({ where: { id: user.id }, include: roleInclude }));
    return res.redirect(302, `${s.appUrl}${transaction.returnTo ?? homeFor(roles)}`);
  } catch (error) {
    if (error instanceof Refusal) {
      await systemAudit('auth.sso_refused', `University sign-in refused: ${error.reason}`, 'DENIED');
      return failTo(res, s, error.reason);
    }
    if (error instanceof OidcError) return failTo(res, s, 'VERIFICATION_FAILED');
    console.error('University sign-in failed:', error.message);
    return failTo(res, s, 'SIGN_IN_FAILED');
  }
});

// Ends this CampusCore session and returns the provider's end-session address (with the ID token as
// hint, so there is no confirmation page). The provider then signs the person out of every app that
// registered back-channel logout, EdunexusAI included.
router.post('/logout-everywhere', async (req, res) => {
  if (!req.session) return res.json({ url: null });
  if (req.get('x-csrf-token') !== req.session.csrfToken) throw new AppError(403, 'csrf_failed', 'Missing or invalid CSRF token.');
  const s = oidcSettings();
  const hint = req.session.authMethod === 'OIDC' && req.session.idTokenSealed ? unseal(req.session.idTokenSealed, config.jwtSecret, HINT_PURPOSE) : null;
  const wasSso = req.session.authMethod === 'OIDC';
  await destroySession(req, res);
  const url = s && wasSso ? await logoutUrl(s, { idTokenHint: hint }).catch(() => null) : null;
  res.json({ url });
});

router.post('/backchannel-logout', limiter, express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const s = oidcSettings();
  if (!s || typeof req.body?.logout_token !== 'string') return res.status(400).json({ error: 'invalid_request' });
  let claims;
  try {
    claims = await verifyLogoutToken(s, req.body.logout_token);
  } catch {
    return res.status(400).json({ error: 'invalid_request' });
  }
  const where = { oidcIssuer: claims.issuer, ...(claims.sid ? { oidcSid: claims.sid } : {}), ...(claims.subject ? { oidcSubject: claims.subject } : {}) };
  const ended = await prisma.session.deleteMany({ where });
  if (ended.count) await systemAudit('auth.sso_logout', `The identity provider ended ${ended.count} CampusCore session(s)`);
  return res.status(200).end();
});

export default router;
