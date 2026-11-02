import { verifyToken } from '../services/integrationService.js';
import { actorFromClient } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';

// Authenticates /api/v1 requests with an OAuth bearer token. Human session cookies are NOT accepted here.
export async function requireBearer(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      res.set('WWW-Authenticate', 'Bearer realm="campuscore"');
      throw Object.assign(new AppError(401, 'invalid_request', 'Missing bearer access token. Obtain one from POST /api/v1/oauth/token.'), { oauth: true });
    }
    const auth = await verifyToken(token);
    const acting = req.get('x-acting-user');
    if (acting !== undefined && !/^[\w.@+\-:| ]{1,120}$/.test(acting)) throw new AppError(400, 'validation_error', 'X-Acting-User must be 1–120 characters of letters, digits and . @ + - : | or space.');
    req.integration = auth;
    req.actor = actorFromClient(auth.client, req.ip, acting);
    next();
  } catch (e) {
    if (e.status === 401) res.set('WWW-Authenticate', `Bearer realm="campuscore", error="${e.code}", error_description="${e.message}"`);
    next(e);
  }
}

// Every scope listed must be present on the token.
export const requireScope = (...scopes) => (req, res, next) => {
  const missing = scopes.filter((s) => !req.integration?.scopes.includes(s));
  if (missing.length) {
    res.set('WWW-Authenticate', `Bearer realm="campuscore", error="insufficient_scope", scope="${scopes.join(' ')}"`);
    return next(Object.assign(new AppError(403, 'insufficient_scope', `This operation requires the scope(s): ${missing.join(', ')}.`, { required: scopes, granted: req.integration?.scopes ?? [] }), { oauth: true }));
  }
  next();
};
