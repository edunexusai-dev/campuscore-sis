export { CampusCoreClient } from './CampusCoreClient.js';
export { CampusCoreAdapter } from './adapters/CampusCoreAdapter.js';
export { SisAdapter } from './adapters/SisAdapter.js';
export { SisError } from './errors.js';
export * from './canonical.js';
export { SisPortalService } from './portal/SisPortalService.js';

import { CampusCoreAdapter } from './adapters/CampusCoreAdapter.js';

// Factory used by EdunexusAI: choose the adapter by configuration, read credentials from the server environment.
export function createSisAdapter(env = process.env) {
  const kind = env.SIS_PROVIDER ?? 'campuscore';
  if (kind === 'campuscore') {
    const missing = ['CAMPUSCORE_BASE_URL', 'CAMPUSCORE_CLIENT_ID', 'CAMPUSCORE_CLIENT_SECRET'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`Missing server-side configuration: ${missing.join(', ')}`);
    if (env.NODE_ENV === 'production' && !env.CAMPUSCORE_BASE_URL.startsWith('https://')) throw new Error('CAMPUSCORE_BASE_URL must use https:// in production.');
    const adapter = new CampusCoreAdapter({ baseUrl: env.CAMPUSCORE_BASE_URL, clientId: env.CAMPUSCORE_CLIENT_ID, clientSecret: env.CAMPUSCORE_CLIENT_SECRET, timeoutMs: Number(env.CAMPUSCORE_TIMEOUT_MS ?? 10_000), logger: console });
    adapter.expectedInstitution = env.CAMPUSCORE_EXPECTED_INSTITUTION || null;
    return adapter;
  }
  throw new Error(`Unsupported SIS_PROVIDER "${kind}". Implement a new SisAdapter for it.`);
}
