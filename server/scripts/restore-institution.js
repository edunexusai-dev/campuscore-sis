// Restores one institution's academic dataset from another CampusCore database (e.g. a reviewed local dataset into a
// freshly bootstrapped production database), keeping record ids so every relationship stays intact.
//
//   export (source):  node scripts/restore-institution.js export --slug feddrick --out restore.json \
//                       --external-users <id>,<id>   (portal user ids whose ACTIVE identity links are restored)
//   import (target):  node scripts/restore-institution.js import --slug feddrick --file restore.json           (dry run)
//                     node scripts/restore-institution.js import --slug feddrick --file restore.json --apply   (writes)
//
// Copied: colleges, departments, programs and requirements, academic years, terms, courses and prerequisites, people
// with their student/faculty records (and their identity-provisioning exclusion), sections, meeting times,
// instructors, registrations and their history, grades and grade history and change requests, attendance, holds,
// applications, document requests, announcements, calendar events, the institution's email domains, and the ACTIVE
// external identity links of the listed portal users.
// Never copied: logins (User) and passwords, sessions, university sign-in links, notifications, integration clients
// and tokens, API logs, idempotency records, policies, the audit log, grade scales (the target's own is used; the
// export records the source scale and the import refuses a different one), and the institution's address profile.
// References to source logins (who entered a grade, placed a hold, ...) are cleared; the actor TYPE is kept.
//
// Import rules: the target institution must already exist (scripts/bootstrap.js). Rows keep their ids; a row whose id
// already exists is left alone (so the import can be re-run). A row refused for another reason (a different record
// already holds the same code or number) is a conflict and nothing is written. A person whose number is already used
// by someone else in the target (e.g. a person created there by hand) gets the next free person number; this is
// reported. Everything happens in one transaction; a dry run rolls it back after inserting, so it proves every key.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';

const FORMAT = 'campuscore-restore/1';
const I = '"institutionId" = $1';
const inInst = (table, col = 'id') => `IN (SELECT "${col}" FROM "${table}" WHERE ${I})`;
// Parents first. `where` selects the institution's rows ($1 = source institution id).
const TABLES = [
  ['College', I], ['Department', I], ['Program', I], ['AcademicYear', I], ['Term', I], ['Course', I],
  ['CoursePrerequisite', `"courseId" ${inInst('Course')}`], ['ProgramRequirement', `"programId" ${inInst('Program')}`],
  ['Person', `${I} AND "mergedIntoId" IS NULL`], ['Student', I], ['Faculty', I],
  ['Section', I], ['MeetingTime', `"sectionId" ${inInst('Section')}`], ['SectionInstructor', `"sectionId" ${inInst('Section')}`],
  ['Registration', I], ['RegistrationEvent', `"registrationId" ${inInst('Registration')}`],
  ['Grade', `"registrationId" ${inInst('Registration')}`], ['GradeHistory', `"gradeId" IN (SELECT g."id" FROM "Grade" g JOIN "Registration" r ON r."id" = g."registrationId" WHERE r.${I})`],
  ['GradeChangeRequest', `"gradeId" IN (SELECT g."id" FROM "Grade" g JOIN "Registration" r ON r."id" = g."registrationId" WHERE r.${I})`],
  ['AttendanceRecord', `"sectionId" ${inInst('Section')}`], ['Hold', `"studentId" ${inInst('Student')}`],
  ['Application', I], ['DocumentRequest', I], ['Announcement', I], ['CalendarEvent', I],
  ['ExternalIdentityLink', `${I} AND "status" = 'ACTIVE' AND "externalUserId" = ANY($2)`],
];
// Columns naming a source login: cleared (the logins are not copied).
const CLEAR = {
  Student: ['userId'], Faculty: ['userId'], Announcement: ['authorUserId'], Application: ['decisionById'],
  AttendanceRecord: ['recordedById'], DocumentRequest: ['processedById'], Grade: ['enteredById', 'approvedById'],
  GradeChangeRequest: ['requestedById', 'reviewedById'], GradeHistory: ['actorId'], Hold: ['placedById', 'releasedById'],
  RegistrationEvent: ['actorId'], ExternalIdentityLink: ['createdById', 'clientId'],
};

const { positionals: [mode], values: a } = parseArgs({ allowPositionals: true, options: { slug: { type: 'string' }, out: { type: 'string' }, file: { type: 'string' }, 'external-users': { type: 'string', default: '' }, apply: { type: 'boolean', default: false } } });
const fail = (m) => { console.error(m); process.exit(1); };
if (!['export', 'import'].includes(mode) || !a.slug) fail('Usage: restore-institution.js export|import --slug <institution> (see the header of this file).');
const prisma = new PrismaClient();
const scaleOf = async (db, institutionId) => (await db.gradeScaleEntry.findMany({ where: { scale: { institutionId, isDefault: true } }, orderBy: { sortOrder: 'asc' } })).map((e) => `${e.letter}:${Number(e.points)}:${e.countsInGpa}:${e.earnsCredit}`).join(' ');

async function exportRestore() {
  if (!a.out) fail('Missing --out');
  const inst = await prisma.institution.findUnique({ where: { slug: a.slug } });
  if (!inst) fail(`No institution "${a.slug}".`);
  const externalUsers = a['external-users'].split(',').map((s) => s.trim()).filter(Boolean);
  const tables = {};
  for (const [table, where] of TABLES) {
    const rows = (await prisma.$queryRawUnsafe(`SELECT row_to_json(x) AS r FROM "${table}" x WHERE ${where}`, inst.id, ...(where.includes('$2') ? [externalUsers] : []))).map((r) => r.r);
    tables[table] = rows.map((row) => {
      for (const c of CLEAR[table] ?? []) if (c in row) row[c] = null;
      if (table === 'ExternalIdentityLink') row.evidence = { ...(row.evidence ?? {}), importedFrom: `${a.slug} (restore)` };
      return row;
    });
  }
  const restore = { format: FORMAT, source: { slug: a.slug, institutionId: inst.id, exportedAt: new Date().toISOString(), gradeScale: await scaleOf(prisma, inst.id) }, institution: { emailDomain: inst.emailDomain, studentEmailDomain: inst.studentEmailDomain }, tables };
  const text = JSON.stringify(restore);
  if (/"passwordHash"|"tokenHash"|"secretHash"/.test(text)) fail('Refusing to write: credential material present.');
  fs.writeFileSync(a.out, text);
  console.log(`Exported ${a.slug} → ${a.out} (${(text.length / 1048576).toFixed(1)} MB)`);
  for (const [t, rows] of Object.entries(tables)) console.log(`  ${t.padEnd(22)} ${rows.length}`);
}

class DryRun extends Error {}

async function importRestore() {
  if (!a.file) fail('Missing --file');
  const r = JSON.parse(fs.readFileSync(a.file, 'utf8'));
  if (r.format !== FORMAT) fail(`Not a ${FORMAT} file.`);
  const inst = await prisma.institution.findUnique({ where: { slug: a.slug } });
  if (!inst) fail(`No institution "${a.slug}" here (create it with scripts/bootstrap.js first).`);
  const targetScale = await scaleOf(prisma, inst.id);
  if (targetScale !== r.source.gradeScale) fail('The default grade scale here differs from the source; grades would be interpreted differently. Nothing written.');
  const report = [];
  const notes = [];
  const conflicts = [];
  try {
    await prisma.$transaction(async (tx) => {
      // Institution email domains: filled when empty, a different value is a conflict.
      const domains = {};
      for (const [k, v] of Object.entries(r.institution)) {
        if (!v) continue;
        if (!inst[k]) domains[k] = v;
        else if (inst[k] !== v) conflicts.push(`institution ${k} is "${inst[k]}" here, "${v}" in the source`);
      }
      if (Object.keys(domains).length) { await tx.institution.update({ where: { id: inst.id }, data: domains }); notes.push(`institution: set ${Object.keys(domains).join(', ')}`); }
      // Person numbers already used here by someone else: the incoming person gets the next free number.
      const taken = new Map((await tx.person.findMany({ where: { institutionId: inst.id }, select: { id: true, personNumber: true } })).map((p) => [p.personNumber, p.id]));
      const incoming = new Set(r.tables.Person.map((p) => p.personNumber));
      let next = Math.max(0, ...[...taken.keys(), ...incoming].map((n) => Number(n.slice(1))).filter(Number.isFinite)) + 1;
      const present = new Set((await tx.person.findMany({ where: { id: { in: r.tables.Person.map((p) => p.id) } }, select: { id: true } })).map((p) => p.id));
      for (const p of r.tables.Person) {
        if (present.has(p.id)) continue; // already imported (re-run): left as it is
        const holder = taken.get(p.personNumber);
        if (holder && holder !== p.id) { const n = `P${String(next++).padStart(7, '0')}`; notes.push(`person ${p.personNumber} renumbered ${n} (the number is used here by another person)`); p.personNumber = n; }
      }
      for (const [table] of TABLES) {
        const rows = (r.tables[table] ?? []).map((row) => ('institutionId' in row ? { ...row, institutionId: inst.id } : row));
        let inserted = 0;
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          const cols = [...new Set(chunk.flatMap(Object.keys))].map((c) => `"${c.replace(/"/g, '')}"`).join(', ');
          const ids = (await tx.$queryRawUnsafe(`INSERT INTO "${table}" (${cols}) SELECT ${cols} FROM json_populate_recordset(NULL::"${table}", $1::json) ON CONFLICT DO NOTHING RETURNING "id"`, JSON.stringify(chunk))).map((x) => x.id);
          inserted += ids.length;
          if (ids.length < chunk.length) {
            const got = new Set(ids);
            const skipped = chunk.filter((x) => !got.has(x.id)).map((x) => x.id);
            const present = new Set((await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = ANY($1)`, skipped)).map((x) => x.id));
            for (const id of skipped.filter((x) => !present.has(x))) conflicts.push(`${table} ${id}: another record here already holds the same unique key`);
          }
        }
        report.push([table, rows.length, inserted]);
      }
      if (conflicts.length) throw new Error('conflicts');
      const imported = report.reduce((n, [, , x]) => n + x, 0);
      await tx.auditEvent.create({ data: { institutionId: inst.id, actorType: 'SYSTEM', actorLabel: 'System (institution restore)', action: 'institution.restored', entityType: 'Institution', entityId: inst.id, summary: `Restored ${imported} academic records from ${r.source.slug} export ${r.source.exportedAt} (ids kept; logins, credentials and policies not copied)` } });
      const queued = await tx.identityProvisioning.groupBy({ by: ['status'], _count: true }).catch(() => []);
      notes.push(`identity-provisioning queue after import: ${queued.map((q) => `${q.status}=${q._count}`).join(', ') || 'n/a'} (worker state unchanged)`);
      if (!a.apply) throw new DryRun();
    }, { timeout: 900_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof DryRun)) {
      console.log(conflicts.length ? `${conflicts.length} conflict(s); nothing written:\n  ${conflicts.slice(0, 40).join('\n  ')}` : `Import failed; nothing written: ${error.meta?.message ?? error.message}`);
      process.exitCode = 2;
      return;
    }
  }
  console.log(`${a.apply ? 'APPLIED' : 'DRY RUN (rolled back; add --apply)'} · ${r.source.slug} export ${r.source.exportedAt} → ${inst.slug}`);
  for (const [t, total, inserted] of report) console.log(`  ${t.padEnd(22)} ${String(inserted).padStart(6)} new · ${total - inserted} already present`);
  for (const n of notes) console.log(`  note: ${n}`);
}

try {
  await (mode === 'export' ? exportRestore() : importRestore());
} finally {
  await prisma.$disconnect();
}
