import fs from 'node:fs';
import { defineConfig } from 'vitest/config';

// Tests run against a dedicated database (DATABASE_URL in .env.test), which is reset and re-seeded per run.
const envFile = new URL('./.env.test', import.meta.url).pathname;
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    globalSetup: './tests/global-setup.js',
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
