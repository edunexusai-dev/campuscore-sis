// University sign-in (OpenID Connect relying party) for CampusCore: authorization code flow with PKCE
// (S256), state and nonce, using the certified openid-client library. The ID token is verified by
// signature (provider JWKS), issuer, audience (this client), expiry and nonce. This module only proves
// WHO signed in; which CampusCore account that is, and what it may do, is decided by CampusCore's own
// identity links, roles and record ownership (routes/app/oidc.js).
import * as oidc from 'openid-client';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export class OidcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
  }
}

export const TRANSACTION_TTL_MS = 10 * 60_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
let cached = null;

/** Sign-in settings from the environment; null when university sign-in is not configured. */
export function oidcSettings(env = process.env) {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET || !env.OIDC_APP_URL) return null;
  return {
    issuer: env.OIDC_ISSUER.replace(/\/$/, ''),
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    appUrl: env.OIDC_APP_URL.replace(/\/$/, ''),
    allowHttp: env.OIDC_ALLOW_HTTP === 'true' && env.NODE_ENV !== 'production',
    displayName: env.OIDC_DISPLAY_NAME || 'University ID',
    studentNumberClaim: env.OIDC_STUDENT_NUMBER_CLAIM || 'student_number',
    employeeNumberClaim: env.OIDC_EMPLOYEE_NUMBER_CLAIM || 'employee_number',
    institutionSlug: env.OIDC_INSTITUTION_SLUG || env.DEFAULT_INSTITUTION_SLUG || null,
    // SSO-first: create a CampusCore login (no password) at the first university sign-in of a person who has
    // records but no login yet. Off unless explicitly enabled.
    jitAccounts: env.OIDC_JIT_ACCOUNTS === 'true',
  };
}

export const callbackPath = '/api/app/auth/oidc/callback';

async function configuration(s) {
  if (cached && cached.key === `${s.issuer}|${s.clientId}` && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.config;
  const issuer = new URL(s.issuer);
  if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && s.allowHttp)) throw new OidcError('INSECURE_ISSUER', 'The identity provider must use https.');
  try {
    const config = await oidc.discovery(issuer, s.clientId, s.clientSecret, oidc.ClientSecretPost(s.clientSecret), {
      // Signatures are always checked against the provider's keys (essential over plain-http development).
      execute: [oidc.enableNonRepudiationChecks, ...(issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : [])],
      timeout: 8,
    });
    cached = { key: `${s.issuer}|${s.clientId}`, at: Date.now(), config };
    return config;
  } catch (error) {
    throw new OidcError('DISCOVERY_FAILED', `The identity provider could not be reached (${error.code ?? error.name}).`);
  }
}

export const clearOidcCache = () => { cached = null; jwks.clear(); };

/** Only same-site paths are accepted as return targets (no open redirects). */
export const safeReturnPath = (value) =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !value.startsWith('/api/') && value.length <= 300 ? value : null;

/**
 * Start a sign-in. No `prompt` is sent: when the person already has a session at the provider (for
 * example from signing in to EdunexusAI), the provider answers without asking for credentials.
 */
export async function beginLogin(s, { returnTo } = {}) {
  const config = await configuration(s);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const transaction = { state: oidc.randomState(), nonce: oidc.randomNonce(), codeVerifier, redirectUri: `${s.appUrl}${callbackPath}`, returnTo: safeReturnPath(returnTo), expiresAt: Date.now() + TRANSACTION_TTL_MS };
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: transaction.redirectUri,
    scope: 'openid email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state: transaction.state,
    nonce: transaction.nonce,
  });
  return { url: url.href, transaction };
}

/** Finish a sign-in from the provider's redirect: { issuer, subject, claims, idToken } or OidcError. */
export async function completeLogin(s, { callbackUrl, transaction }) {
  if (!transaction || !(transaction.expiresAt > Date.now())) throw new OidcError('EXPIRED_TRANSACTION', 'This sign-in took too long.');
  const callback = new URL(callbackUrl);
  if (`${callback.origin}${callback.pathname}` !== transaction.redirectUri) throw new OidcError('INVALID_CALLBACK', 'The sign-in response arrived at an unexpected address.');
  const config = await configuration(s);
  let tokens;
  try {
    tokens = await oidc.authorizationCodeGrant(config, callback, { pkceCodeVerifier: transaction.codeVerifier, expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true });
  } catch (error) {
    throw new OidcError('TOKEN_REJECTED', `The identity provider's response could not be verified (${error.code ?? error.error ?? error.name}).`);
  }
  const claims = tokens.claims();
  if (!claims?.sub) throw new OidcError('TOKEN_REJECTED', 'The identity provider did not identify the user.');
  return { issuer: claims.iss, subject: String(claims.sub), claims, idToken: tokens.id_token };
}

/** The provider's end-session address; with the ID token as hint no confirmation page is shown. */
export async function logoutUrl(s, { idTokenHint = null } = {}) {
  const config = await configuration(s);
  if (!config.serverMetadata().end_session_endpoint) return null;
  return oidc.buildEndSessionUrl(config, { client_id: s.clientId, post_logout_redirect_uri: `${s.appUrl}/login`, ...(idTokenHint ? { id_token_hint: idTokenHint } : {}) }).href;
}

const jwks = new Map();
const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** OIDC Back-Channel Logout token: signature (JWKS), issuer, audience, recent iat, event, no nonce, sub or sid. */
export async function verifyLogoutToken(s, token, { maxAgeSeconds = 300 } = {}) {
  const config = await configuration(s);
  const { issuer, jwks_uri: uri } = config.serverMetadata();
  if (!jwks.has(uri)) jwks.set(uri, createRemoteJWKSet(new URL(uri), { timeoutDuration: 5000 }));
  let payload;
  try {
    ({ payload } = await jwtVerify(String(token ?? ''), jwks.get(uri), { issuer, audience: s.clientId, maxTokenAge: `${maxAgeSeconds}s`, clockTolerance: 30 }));
  } catch (error) {
    throw new OidcError('LOGOUT_TOKEN_REJECTED', `The logout token could not be verified (${error.code ?? error.name}).`);
  }
  if (!payload.events || typeof payload.events !== 'object' || !(BACKCHANNEL_EVENT in payload.events)) throw new OidcError('LOGOUT_TOKEN_REJECTED', 'Not a logout token.');
  if ('nonce' in payload) throw new OidcError('LOGOUT_TOKEN_REJECTED', 'A logout token must not carry a nonce.');
  if (!payload.sub && !payload.sid) throw new OidcError('LOGOUT_TOKEN_REJECTED', 'The logout token names no subject or session.');
  return { issuer, subject: payload.sub ? String(payload.sub) : null, sid: payload.sid ? String(payload.sid) : null };
}

/* Sealed values (AES-256-GCM): the sign-in transaction cookie and the stored logout hint. */
const keyFor = (secret, purpose) => Buffer.from(hkdfSync('sha256', Buffer.from(String(secret)), Buffer.alloc(0), Buffer.from(purpose), 32));

export function seal(value, secret, purpose) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, purpose), iv);
  const body = Buffer.concat([cipher.update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((p) => p.toString('base64url')).join('.');
}

export function unseal(sealed, secret, purpose) {
  try {
    const [iv, tag, body] = String(sealed ?? '').split('.').map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, purpose), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
