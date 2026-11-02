// Prepares the dedicated test database: create it if missing, apply migrations (non-destructive
// `migrate deploy`), then load the fictional seed (which clears only this test database's tables).
import { execSync } from 'node:child_process';

export default async function setup({ provide }) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to run tests against a database whose name does not end in "_test": ${dbName}`);

  const { PrismaClient } = await import('@prisma/client');
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  const exists = await admin.$queryRaw`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
  if (!exists.length) await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  await admin.$disconnect();

  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });

  const { seed } = await import('../prisma/seed-lib.js');
  const prisma = new PrismaClient();
  const result = await seed(prisma, { log: () => {} });
  await prisma.$disconnect();
  provide('seed', result);
}
