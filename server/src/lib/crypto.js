import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

// Human passwords: salted scrypt (memory-hard). Format: scrypt$N$r$p$salt$hash
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT_PARAMS);
  return ['scrypt', SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, actual);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// Session tokens are stored as SHA-256 hashes so a DB leak doesn't yield usable sessions.
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Client secrets are 256-bit random values, so a keyed HMAC (with a server-side pepper) is sufficient
// and keeps the token endpoint fast. The pepper lives only in the environment, never in the database.
export const hashClientSecret = (secret) => crypto.createHmac('sha256', config.secretPepper).update(secret).digest('hex');

export function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}
