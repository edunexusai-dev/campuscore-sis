// Human sessions: opaque random token in an HttpOnly, SameSite=Lax cookie; only its SHA-256 hash is stored.
// CSRF: every state-changing request must echo the per-session CSRF token in the X-CSRF-Token header.
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { sha256, randomToken } from '../lib/crypto.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { actorFromUser } from '../lib/audit.js';
import { effectiveRoles, roleInclude } from '../lib/roles.js';

export const cookieOptions = () => ({ httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: config.sessionTtlMs });

// `sso` (optional): { issuer, subject, sid, idTokenSealed } for a session that began with university sign-in.
export async function createSession(res, user, req, sso = null) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  await prisma.session.create({
    data: {
      tokenHash: sha256(token), csrfToken, userId: user.id, expiresAt: new Date(Date.now() + config.sessionTtlMs), ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 255),
      ...(sso ? { authMethod: 'OIDC', oidcIssuer: sso.issuer, oidcSubject: sso.subject, oidcSid: sso.sid ?? null, idTokenSealed: sso.idTokenSealed ?? null } : {}),
    },
  });
  res.cookie(config.sessionCookie, token, cookieOptions());
  return csrfToken;
}

export async function destroySession(req, res) {
  const token = req.cookies?.[config.sessionCookie];
  if (token) await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  res.clearCookie(config.sessionCookie, { ...cookieOptions(), maxAge: undefined });
}

// Loads the session (if any) and attaches req.user / req.actor / req.session.
export async function loadSession(req, _res, next) {
  try {
    const token = req.cookies?.[config.sessionCookie];
    if (!token) return next();
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: roleInclude } },
    });
    if (!session || session.expiresAt < new Date() || session.user.status !== 'ACTIVE') return next();
    req.session = session;
    req.user = { ...session.user, roles: effectiveRoles(session.user) };
    req.actor = actorFromUser(session.user, req.ip);
    // Throttle last-seen writes to once a minute.
    if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
      prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
    }
    next();
  } catch (e) { next(e); }
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export function csrfProtection(req, _res, next) {
  if (SAFE.has(req.method) || !req.session) return next();
  if (req.get('x-csrf-token') !== req.session.csrfToken) return next(forbidden('Missing or invalid CSRF token.', 'csrf_failed'));
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  // Any role the account holds (a lecturer who also studies may use both the faculty and the student areas).
  if (!roles.some((r) => req.user.roles.includes(r))) return next(forbidden());
  next();
};
