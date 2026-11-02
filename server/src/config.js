// Centralised, validated configuration. The process refuses to start with unsafe settings.
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SIGNING_SECRET: z.string().min(32, 'JWT_SIGNING_SECRET must be at least 32 characters'),
  CLIENT_SECRET_PEPPER: z.string().min(8),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:5180'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY: z.string().default('false'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const env = parsed.data;

if (env.NODE_ENV === 'production' && env.COOKIE_SECURE !== 'true') {
  console.error('COOKIE_SECURE must be true in production.');
  process.exit(1);
}

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  jwtSecret: env.JWT_SIGNING_SECRET,
  secretPepper: env.CLIENT_SECRET_PEPPER,
  publicApiUrl: env.PUBLIC_API_URL.replace(/\/$/, ''),
  corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  sessionTtlMs: env.SESSION_TTL_HOURS * 3600 * 1000,
  cookieSecure: env.COOKIE_SECURE === 'true',
  trustProxy: env.TRUST_PROXY === 'false' ? false : env.TRUST_PROXY === 'true' ? true : Number(env.TRUST_PROXY) || env.TRUST_PROXY,
  sessionCookie: 'cc_session',
};
