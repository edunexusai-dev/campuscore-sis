// In-process OpenID provider for tests (copied from EdunexusAI tests/helpers/oidcProvider.js; no network).
import http from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * In-process OpenID provider for tests (no network, no real identity provider). It publishes a
 * discovery document and JWKS, and its token endpoint behaves like a real one: it checks the
 * client, the redirect URI and the PKCE verifier, issues each code once, and returns an RS256 ID
 * token. Tests obtain a code with `issueCode()` (standing in for the user signing in at the
 * provider) and can bend any ID-token field to exercise the relying party's validation.
 */
export async function startOidcProvider({ clientId = 'edunexusai', clientSecret = 'test-secret' } = {}) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const codes = new Map();
  const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const jwt = (payload, key = keys.privateKey) => {
    const head = b64({ alg: 'RS256', typ: 'JWT', kid });
    const body = b64(payload);
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
  };
  let issuer;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    }
    if (url.pathname === '/jwks') return send(200, { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) return send(401, { error: 'invalid_client' });
      const entry = codes.get(form.get('code'));
      if (!entry || entry.used) return send(400, { error: 'invalid_grant', error_description: 'unknown or used code' });
      entry.used = true;
      if (form.get('redirect_uri') !== entry.redirectUri) return send(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== entry.codeChallenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const now = Math.floor(Date.now() / 1000);
      const payload = { iss: issuer, aud: clientId, iat: now, exp: now + 300, nonce: entry.nonce, ...entry.claims, ...entry.override };
      return send(200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: jwt(payload, entry.signWithRogueKey ? rogue.privateKey : keys.privateKey) });
    }
    return send(404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    /**
     * Stand-in for the person signing in at the provider: registers a one-time code for the given
     * authorisation URL (its PKCE challenge, nonce and redirect URI) and returns the callback URL.
     */
    issueCode(authorizationUrl, { claims = {}, override = {}, signWithRogueKey = false, state } = {}) {
      const auth = new URL(authorizationUrl);
      const code = randomBytes(12).toString('hex');
      codes.set(code, {
        redirectUri: auth.searchParams.get('redirect_uri'),
        codeChallenge: auth.searchParams.get('code_challenge'),
        nonce: auth.searchParams.get('nonce'),
        claims, override, signWithRogueKey, used: false,
      });
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state ?? auth.searchParams.get('state'));
      return callback.href;
    },
    /** A Back-Channel Logout token as the provider would POST it; `override` bends any field. */
    logoutToken(claims = {}, { override = {}, signWithRogueKey = false } = {}) {
      const now = Math.floor(Date.now() / 1000);
      return jwt({ iss: issuer, aud: clientId, iat: now, jti: randomBytes(8).toString('hex'), events: { 'http://schemas.openid.net/event/backchannel-logout': {} }, ...claims, ...override }, signWithRogueKey ? rogue.privateKey : keys.privateKey);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
