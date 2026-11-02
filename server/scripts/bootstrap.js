// Creates an institution (if it doesn't exist), its default grade scale and a first administrator.
// Intended for a fresh production database where the demo seed must NOT be used.
//   node --env-file=.env scripts/bootstrap.js --slug feddrick --name "Feddrick University" --short FU \
//        --email registrar.admin@feddrick.edu --first Avery --last Collins
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { hashPassword, randomToken } from '../src/lib/crypto.js';

const { values: a } = parseArgs({ options: { slug: { type: 'string' }, name: { type: 'string' }, short: { type: 'string' }, timezone: { type: 'string', default: 'America/New_York' }, email: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' } } });
for (const k of ['slug', 'name', 'short', 'email', 'first', 'last']) if (!a[k]) { console.error(`Missing --${k}`); process.exit(1); }

const SCALE = [['A', 4.0, true, true], ['A-', 3.7, true, true], ['B+', 3.3, true, true], ['B', 3.0, true, true], ['B-', 2.7, true, true], ['C+', 2.3, true, true], ['C', 2.0, true, true], ['C-', 1.7, true, true], ['D+', 1.3, true, true], ['D', 1.0, true, true], ['F', 0, true, false], ['P', 0, false, true], ['NP', 0, false, false], ['I', 0, false, false], ['W', 0, false, false]];
const prisma = new PrismaClient();
const inst = await prisma.institution.upsert({ where: { slug: a.slug }, update: {}, create: { slug: a.slug, name: a.name, shortName: a.short, timezone: a.timezone } });
if (!(await prisma.gradeScale.findFirst({ where: { institutionId: inst.id } }))) {
  await prisma.gradeScale.create({ data: { institutionId: inst.id, name: 'Standard 4.0', isDefault: true, entries: { create: SCALE.map(([letter, points, countsInGpa, earnsCredit], i) => ({ letter, points, countsInGpa, earnsCredit, sortOrder: i })) } } });
}
if (await prisma.user.findUnique({ where: { email: a.email.toLowerCase() } })) { console.error('A user with that email already exists.'); process.exit(1); }
const password = `Cc-${randomToken(12)}`;
const user = await prisma.user.create({ data: { institutionId: inst.id, email: a.email.toLowerCase(), passwordHash: await hashPassword(password), firstName: a.first, lastName: a.last, role: 'ADMIN' } });
await prisma.auditEvent.create({ data: { institutionId: inst.id, actorType: 'SYSTEM', actorLabel: 'System (bootstrap)', action: 'user.created', entityType: 'User', entityId: user.id, summary: `Bootstrapped administrator ${user.email}` } });
await prisma.$disconnect();
console.log(`Institution: ${inst.name} (${inst.slug})\nAdministrator: ${user.email}\nTemporary password (shown once): ${password}\nSign in and change it under your account immediately.`);
