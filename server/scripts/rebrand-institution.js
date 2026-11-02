// Re-identifies an existing institution (name, slug, contact details, email domains) WITHOUT changing any IDs
// or relationships. Only rows belonging to that institution are touched. Dry run by default.
//
//   node --env-file=.env scripts/rebrand-institution.js --from northbridge --slug feddrick \
//     --name "Feddrick University" --short FU --domain feddrick.edu --student-domain students.feddrick.edu \
//     --website https://www.feddrick.example.edu [--apply]
//
// Take a database backup (pg_dump) before running with --apply.
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';

const { values: a } = parseArgs({ options: {
  from: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' }, short: { type: 'string' },
  domain: { type: 'string' }, 'student-domain': { type: 'string' }, website: { type: 'string' }, apply: { type: 'boolean', default: false },
} });
for (const k of ['from', 'slug', 'name', 'short', 'domain', 'student-domain']) if (!a[k]) { console.error(`Missing --${k}`); process.exit(1); }
const domainRe = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
if (!domainRe.test(a.domain) || !domainRe.test(a['student-domain'])) { console.error('Domains must look like example.edu'); process.exit(1); }

const prisma = new PrismaClient();
const inst = await prisma.institution.findUnique({ where: { slug: a.from } });
if (!inst) {
  const already = await prisma.institution.findUnique({ where: { slug: a.slug } });
  console.log(already ? `Nothing to do: institution "${a.slug}" already exists (${already.name}).` : `No institution with slug "${a.from}".`);
  process.exit(already ? 0 : 1);
}
if (a.slug !== a.from && (await prisma.institution.findUnique({ where: { slug: a.slug } }))) { console.error(`Slug "${a.slug}" is already used by another institution.`); process.exit(1); }

// Derive the old domains from the institution's existing addresses.
const oldDomain = inst.emailDomain ?? (inst.email?.split('@')[1]) ?? `${a.from}.edu`;
const oldStudentDomain = inst.studentEmailDomain ?? `students.${oldDomain}`;
const swap = (email) => {
  if (!email) return email;
  const [local, dom] = email.split('@');
  if (dom === oldStudentDomain) return `${local}@${a['student-domain']}`;
  if (dom === oldDomain) return `${local}@${a.domain}`;
  return email; // personal/external addresses are left alone
};

const [users, students, faculty, departments] = await Promise.all([
  prisma.user.findMany({ where: { institutionId: inst.id }, select: { id: true, email: true } }),
  prisma.student.findMany({ where: { institutionId: inst.id }, select: { id: true, email: true } }),
  prisma.faculty.findMany({ where: { institutionId: inst.id }, select: { id: true, email: true } }),
  prisma.department.findMany({ where: { institutionId: inst.id }, select: { id: true, email: true } }),
]);
const changes = (rows) => rows.map((r) => ({ id: r.id, from: r.email, to: swap(r.email) })).filter((c) => c.to !== c.from);
const plan = { users: changes(users), students: changes(students), faculty: changes(faculty), departments: changes(departments) };

// User emails are globally unique: refuse if any new address already belongs to someone else.
const collisions = await prisma.user.findMany({ where: { email: { in: plan.users.map((c) => c.to) }, id: { notIn: plan.users.map((c) => c.id) } }, select: { email: true } });
if (collisions.length) { console.error('Aborting: these addresses already exist:', collisions.map((c) => c.email)); process.exit(1); }

const instChange = {
  slug: a.slug, name: a.name, shortName: a.short, emailDomain: a.domain, studentEmailDomain: a['student-domain'],
  email: inst.email ? swap(inst.email) : `registrar@${a.domain}`, ...(a.website ? { website: a.website } : {}),
};
console.log(`Institution ${inst.id}: "${inst.name}" (${inst.slug}) → "${a.name}" (${a.slug})`);
console.log(`Email domains: ${oldDomain} → ${a.domain}, ${oldStudentDomain} → ${a['student-domain']}`);
console.log(`Rows to update: users ${plan.users.length}, students ${plan.students.length}, faculty ${plan.faculty.length}, departments ${plan.departments.length}`);
console.log('Sample:', plan.users.slice(0, 3).map((c) => `${c.from} → ${c.to}`));

if (!a.apply) { console.log('\nDry run only. Re-run with --apply to make these changes.'); await prisma.$disconnect(); process.exit(0); }

await prisma.$transaction(async (tx) => {
  await tx.institution.update({ where: { id: inst.id }, data: instChange });
  for (const c of plan.users) await tx.user.update({ where: { id: c.id }, data: { email: c.to } });
  for (const c of plan.students) await tx.student.update({ where: { id: c.id }, data: { email: c.to } });
  for (const c of plan.faculty) await tx.faculty.update({ where: { id: c.id }, data: { email: c.to } });
  for (const c of plan.departments) await tx.department.update({ where: { id: c.id }, data: { email: c.to } });
  await tx.auditEvent.create({ data: {
    institutionId: inst.id, actorType: 'SYSTEM', actorLabel: 'System (rebrand script)', action: 'institution.rebranded', entityType: 'Institution', entityId: inst.id,
    summary: `Institution re-identified as ${a.name} (${a.slug}); ${plan.users.length} login and ${plan.students.length + plan.faculty.length} record email addresses moved to ${a.domain}. IDs unchanged.`,
    before: { slug: inst.slug, name: inst.name, shortName: inst.shortName, email: inst.email, website: inst.website, emailDomain: oldDomain, studentEmailDomain: oldStudentDomain },
    after: instChange,
  } });
}, { timeout: 60_000 });
console.log('\nApplied.');
await prisma.$disconnect();
