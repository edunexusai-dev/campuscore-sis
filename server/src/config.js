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
  // Automatic university-account provisioning (services/identityProvisioningService.js). Off unless enabled.
  IDENTITY_SYNC_ENABLED: z.enum(['true', 'false']).default('false'),
  IDENTITY_SYNC_KEYCLOAK_URL: z.string().url().optional(),
  IDENTITY_SYNC_KEYCLOAK_REALM: z.string().min(1).optional(),
  IDENTITY_SYNC_CLIENT_ID: z.string().min(1).optional(),
  IDENTITY_SYNC_CLIENT_SECRET: z.string().min(1).optional(),
  IDENTITY_SYNC_SEND_SETUP_EMAIL: z.enum(['true', 'false']).default('false'),
  IDENTITY_SYNC_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  IDENTITY_SYNC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(12),
  IDENTITY_SYNC_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
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

// Provisioning uses its own service-account client (Keycloak realm-management user roles only), never the
// browser sign-in client: a leaked sign-in secret must not be able to manage accounts, and the reverse.
if (env.IDENTITY_SYNC_ENABLED === 'true') {
  const missing = ['IDENTITY_SYNC_KEYCLOAK_URL', 'IDENTITY_SYNC_KEYCLOAK_REALM', 'IDENTITY_SYNC_CLIENT_ID', 'IDENTITY_SYNC_CLIENT_SECRET'].filter((k) => !env[k]);
  const problem = missing.length ? `set ${missing.join(', ')}`
    : env.IDENTITY_SYNC_CLIENT_ID === process.env.OIDC_CLIENT_ID || env.IDENTITY_SYNC_CLIENT_SECRET === process.env.OIDC_CLIENT_SECRET ? 'IDENTITY_SYNC_CLIENT_ID/SECRET must be the dedicated sync client, not the sign-in client (OIDC_CLIENT_ID)'
    : env.NODE_ENV === 'production' && !env.IDENTITY_SYNC_KEYCLOAK_URL.startsWith('https://') ? 'IDENTITY_SYNC_KEYCLOAK_URL must use https in production'
    : null;
  if (problem) {
    console.error(`Identity provisioning is enabled but misconfigured: ${problem}.`);
    process.exit(1);
  }
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
  identitySync: {
    enabled: env.IDENTITY_SYNC_ENABLED === 'true',
    keycloak: { baseUrl: env.IDENTITY_SYNC_KEYCLOAK_URL, realm: env.IDENTITY_SYNC_KEYCLOAK_REALM, clientId: env.IDENTITY_SYNC_CLIENT_ID, clientSecret: env.IDENTITY_SYNC_CLIENT_SECRET, timeoutMs: env.IDENTITY_SYNC_TIMEOUT_MS },
    sendSetupEmail: env.IDENTITY_SYNC_SEND_SETUP_EMAIL === 'true',
    pollIntervalMs: env.IDENTITY_SYNC_POLL_INTERVAL_MS,
    maxAttempts: env.IDENTITY_SYNC_MAX_ATTEMPTS,
  },
};
