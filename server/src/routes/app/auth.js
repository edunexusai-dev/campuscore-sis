import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse } from '../../lib/validate.js';
import { verifyPassword, hashPassword } from '../../lib/crypto.js';
import { unauthorized, AppError } from '../../lib/errors.js';
import { audit, actorFromUser } from '../../lib/audit.js';
import { createSession, destroySession, requireAuth } from '../../middleware/session.js';
import { permissionsFor } from '../../lib/permissions.js';
import { effectiveRoles, homeFor, roleInclude } from '../../lib/roles.js';
import oidcRoutes from './oidc.js';

const router = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'rate_limited', message: 'Too many sign-in attempts. Try again in a few minutes.' } } });

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
// Pre-computed hash so unknown emails take the same time as wrong passwords (no account enumeration).
const DUMMY_HASH = await hashPassword('timing-equaliser');

// Public branding for the sign-in page (no records). Which institution is shown is configuration
// (DEFAULT_INSTITUTION_SLUG), not code; falls back to the oldest institution.
router.get('/branding', async (_req, res) => {
  const slug = process.env.DEFAULT_INSTITUTION_SLUG;
  const i = (slug && await prisma.institution.findUnique({ where: { slug } })) || await prisma.institution.findFirst({ orderBy: { createdAt: 'asc' } });
  res.json({ data: i ? { name: i.name, shortName: i.shortName, emailDomain: i.emailDomain, studentEmailDomain: i.studentEmailDomain } : null });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) }), req.body);
  const user = await prisma.user.findUnique({ where: { email }, include: { institution: true, ...roleInclude } });
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || user.status !== 'ACTIVE') throw unauthorized('Invalid email or password.', 'invalid_credentials');
  if (user.lockedUntil && user.lockedUntil > new Date()) throw new AppError(423, 'account_locked', `Account temporarily locked after repeated failed sign-ins. Try again after ${user.lockedUntil.toLocaleTimeString()}.`);
  if (!ok) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({ where: { id: user.id }, data: { failedLogins: failed, ...(failed >= LOCK_AFTER ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000), failedLogins: 0 } : {}) } });
    if (failed >= LOCK_AFTER) await audit(actorFromUser(user, req.ip), { action: 'auth.locked', entityType: 'User', entityId: user.id, summary: `Account locked after ${LOCK_AFTER} failed sign-in attempts` });
    throw unauthorized('Invalid email or password.', 'invalid_credentials');
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null } });
  const csrfToken = await createSession(res, user, req);
  await audit(actorFromUser(user, req.ip), { action: 'auth.login', entityType: 'User', entityId: user.id, summary: 'Signed in' });
  res.json({ csrfToken, user: meDto(user, user.institution) });
});

// University sign-in (OpenID Connect): /api/app/auth/oidc/*
router.use('/oidc', oidcRoutes);

// Signs out of CampusCore only. A university (SSO) session stays open at the provider; signing out of
// every university app is POST /auth/oidc/logout-everywhere.
router.post('/logout', async (req, res) => {
  if (req.session && req.get('x-csrf-token') !== req.session.csrfToken) throw new AppError(403, 'csrf_failed', 'Missing or invalid CSRF token.');
  await destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const institution = await prisma.institution.findUnique({ where: { id: req.user.institutionId } });
  // signInMethod lets the app offer "sign out of all university apps" only for a university sign-in.
  res.json({ csrfToken: req.session.csrfToken, user: { ...meDto(req.user, institution), signInMethod: req.session.authMethod === 'OIDC' ? 'SSO' : 'PASSWORD' } });
});

router.post('/change-password', requireAuth, async (req, res) => {
  if (req.get('x-csrf-token') !== req.session.csrfToken) throw new AppError(403, 'csrf_failed', 'Missing or invalid CSRF token.');
  const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10, 'Use at least 10 characters').max(200) }), req.body);
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.passwordHash) throw new AppError(409, 'sso_only_account', 'This account signs in with the university sign-in only, so it has no CampusCore password to change.');
  if (!(await verifyPassword(body.currentPassword, user.passwordHash))) throw unauthorized('Current password is incorrect.', 'invalid_credentials');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
  // Invalidate every other session for this user.
  await prisma.session.deleteMany({ where: { userId: user.id, id: { not: req.session.id } } });
  await audit(req.actor, { action: 'auth.password_changed', entityType: 'User', entityId: user.id, summary: 'Changed password' });
  res.json({ ok: true });
});

// `roles`: everything this account may act as; `role`: the first of them (kept for older clients); `home`: where to
// land (the persona chooser "/" when there are several); `hasPassword`: false for a university-sign-in-only account.
function meDto(user, institution) {
  const roles = user.roles ?? effectiveRoles(user);
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: roles[0] ?? user.role,
    roles,
    home: homeFor(roles),
    hasPassword: Boolean(user.passwordHash),
    studentId: user.student?.id ?? null,
    facultyId: user.faculty?.id ?? null,
    permissions: permissionsFor(roles),
    institution: { id: institution.id, slug: institution.slug, name: institution.name, shortName: institution.shortName, emailDomain: institution.emailDomain, studentEmailDomain: institution.studentEmailDomain },
  };
}

export default router;
