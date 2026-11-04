// Reduces an institution's people to a named set of pilot people, keeping the catalog and the pilots' own academic
// records. Everything owned exclusively by other people is removed, in explicit steps (no hidden cascades):
//
//   node scripts/cleanup-to-pilots.js --slug feddrick --keep P0000024,P0000107,P0000210,P0000002          (dry run)
//   node scripts/cleanup-to-pilots.js --slug feddrick --keep P0000024,P0000107,P0000210,P0000002 --apply  (writes)
//
// Kept: the institution and its catalog (colleges, departments, programs and requirements, academic years, terms,
// courses and prerequisites, grade scales, policies, calendar events, institution-wide announcements); staff logins
// without a person (administrators); the pilots, their student/faculty records, logins, sign-in links, external
// identity links and provisioning rows; sections a pilot teaches or is registered in, with their meeting times, and
// the pilots' registrations, registration history, grades, grade history and attendance.
// Removed: every other person with their student/faculty records; their registrations (with history, grades, grade
// history, change requests) and attendance; their holds, applications and document requests; applications without a
// student; sections no pilot teaches or attends (with meeting times, instructor assignments, section announcements);
// other people's instructor assignments on kept sections; their provisioning rows.
// One transaction. A dry run performs every step and rolls back, so the counts are exact. Re-running after an apply
// removes nothing.
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';

const { values: a } = parseArgs({ options: { slug: { type: 'string' }, keep: { type: 'string' }, apply: { type: 'boolean', default: false } } });
const fail = (m) => { console.error(m); process.exit(1); };
if (!a.slug || !a.keep) fail('Usage: cleanup-to-pilots.js --slug <institution> --keep P0000001,P0000002 [--apply]');
const keep = a.keep.split(',').map((s) => s.trim()).filter(Boolean);
const prisma = new PrismaClient();
class DryRun extends Error {}

const TABLES = ['Person', 'Student', 'Faculty', 'User', 'Section', 'MeetingTime', 'SectionInstructor', 'Registration', 'RegistrationEvent', 'Grade', 'GradeHistory', 'GradeChangeRequest', 'AttendanceRecord', 'Hold', 'Application', 'DocumentRequest', 'Announcement', 'ExternalIdentityLink', 'IdentityProvisioning', 'UserIdentityLink', 'Session', 'Notification', 'College', 'Department', 'Program', 'AcademicYear', 'Term', 'Course', 'CoursePrerequisite', 'ProgramRequirement', 'GradeScale', 'CalendarEvent', 'Policy'];
const countAll = async (tx) => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await tx.$queryRawUnsafe(`SELECT count(*)::int n FROM "${t}"`))[0].n])));

try {
  const inst = await prisma.institution.findUnique({ where: { slug: a.slug } });
  if (!inst) fail(`No institution "${a.slug}".`);
  const pilots = await prisma.person.findMany({ where: { institutionId: inst.id, personNumber: { in: keep } }, include: { student: true, faculty: true } });
  if (pilots.length !== keep.length) fail(`Pilot people not found: ${keep.filter((n) => !pilots.some((p) => p.personNumber === n)).join(', ')}`);
  const P = pilots.map((p) => p.id);
  const PS = pilots.flatMap((p) => (p.student ? [p.student.id] : []));
  const PF = pilots.flatMap((p) => (p.faculty ? [p.faculty.id] : []));
  const before = await countAll(prisma);
  const steps = [];
  try {
    await prisma.$transaction(async (tx) => {
      const run = async (label, sql, ...params) => { const n = await tx.$executeRawUnsafe(sql, ...params); steps.push([label, n]); };
      const I = inst.id;
      // Sections kept: taught by a pilot, or attended by a pilot student.
      const keptSections = (await tx.$queryRawUnsafe(`SELECT DISTINCT "sectionId" AS id FROM "SectionInstructor" WHERE "facultyId" = ANY($1) UNION SELECT DISTINCT "sectionId" FROM "Registration" WHERE "studentId" = ANY($2)`, PF, PS)).map((r) => r.id);
      const otherStudents = `SELECT "id" FROM "Student" WHERE "institutionId" = $1 AND NOT ("id" = ANY($2))`;
      const dropRegs = `SELECT "id" FROM "Registration" WHERE "institutionId" = $1 AND NOT ("studentId" = ANY($2))`;
      const dropSections = `SELECT "id" FROM "Section" WHERE "institutionId" = $1 AND NOT ("id" = ANY($2))`;
      // 1. Other people's academic history (children before parents; restrictive keys first).
      await run('AttendanceRecord (other students, or in removed sections)', `DELETE FROM "AttendanceRecord" WHERE "studentId" IN (${otherStudents}) OR "sectionId" IN (${dropSections.replace('$2', '$3')})`, I, PS, keptSections);
      await run('GradeChangeRequest (other students)', `DELETE FROM "GradeChangeRequest" WHERE "gradeId" IN (SELECT "id" FROM "Grade" WHERE "registrationId" IN (${dropRegs}))`, I, PS);
      await run('GradeHistory (other students)', `DELETE FROM "GradeHistory" WHERE "gradeId" IN (SELECT "id" FROM "Grade" WHERE "registrationId" IN (${dropRegs}))`, I, PS);
      await run('Grade (other students)', `DELETE FROM "Grade" WHERE "registrationId" IN (${dropRegs})`, I, PS);
      await run('RegistrationEvent (other students)', `DELETE FROM "RegistrationEvent" WHERE "registrationId" IN (${dropRegs})`, I, PS);
      await run('Registration (other students)', `DELETE FROM "Registration" WHERE "id" IN (${dropRegs})`, I, PS);
      await run('Hold (other students)', `DELETE FROM "Hold" WHERE "studentId" IN (${otherStudents})`, I, PS);
      await run('DocumentRequest (other students)', `DELETE FROM "DocumentRequest" WHERE "institutionId" = $1 AND NOT ("studentId" = ANY($2))`, I, PS);
      await run('Application (other students or none)', `DELETE FROM "Application" WHERE "institutionId" = $1 AND ("studentId" IS NULL OR NOT ("studentId" = ANY($2)))`, I, PS);
      // 2. Sections no pilot teaches or attends, and other people's teaching assignments.
      await run('Announcement (in removed sections)', `DELETE FROM "Announcement" WHERE "sectionId" IN (${dropSections})`, I, keptSections);
      await run('MeetingTime (removed sections)', `DELETE FROM "MeetingTime" WHERE "sectionId" IN (${dropSections})`, I, keptSections);
      await run('SectionInstructor (removed sections or other faculty)', `DELETE FROM "SectionInstructor" WHERE "sectionId" IN (${dropSections}) OR "facultyId" IN (SELECT "id" FROM "Faculty" WHERE "institutionId" = $1 AND NOT ("id" = ANY($3)))`, I, keptSections, PF);
      await run('Section (no pilot teaches or attends)', `DELETE FROM "Section" WHERE "id" IN (${dropSections})`, I, keptSections);
      // 3. Other people and everything still attached to them.
      const otherPeople = `SELECT "id" FROM "Person" WHERE "institutionId" = $1 AND NOT ("id" = ANY($2))`;
      await run('ExternalIdentityLink (other people)', `DELETE FROM "ExternalIdentityLink" WHERE "institutionId" = $1 AND ("studentId" IN (SELECT "id" FROM "Student" WHERE "personId" IN (${otherPeople})) OR "facultyId" IN (SELECT "id" FROM "Faculty" WHERE "personId" IN (${otherPeople})))`, I, P);
      await run('UserIdentityLink (logins of other people)', `DELETE FROM "UserIdentityLink" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "personId" IN (${otherPeople}))`, I, P);
      await run('Session (logins of other people)', `DELETE FROM "Session" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "personId" IN (${otherPeople}))`, I, P);
      await run('Notification (logins of other people)', `DELETE FROM "Notification" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "personId" IN (${otherPeople}))`, I, P);
      await run('Student (other people)', `DELETE FROM "Student" WHERE "personId" IN (${otherPeople})`, I, P);
      await run('Faculty (other people)', `DELETE FROM "Faculty" WHERE "personId" IN (${otherPeople})`, I, P);
      await run('User (logins of other people)', `DELETE FROM "User" WHERE "personId" IN (${otherPeople})`, I, P);
      await run('IdentityProvisioning (other people)', `DELETE FROM "IdentityProvisioning" WHERE "personId" IN (${otherPeople})`, I, P);
      await run('Person (other people)', `DELETE FROM "Person" WHERE "id" IN (${otherPeople})`, I, P);
      const removed = steps.reduce((n, [, x]) => n + x, 0);
      if (removed) await tx.auditEvent.create({ data: { institutionId: I, actorType: 'SYSTEM', actorLabel: 'System (approved pilot cleanup)', action: 'institution.cleaned_to_pilots', entityType: 'Institution', entityId: I, summary: `Kept people ${keep.join(', ')} and the catalog; removed ${removed} records owned by other people (approved by the institution owner)` } });
      // Integrity: nothing may point at a removed record.
      const orphans = (await tx.$queryRawUnsafe(`SELECT
        (SELECT count(*) FROM "Registration" r LEFT JOIN "Student" s ON s.id = r."studentId" WHERE s.id IS NULL)::int reg_student,
        (SELECT count(*) FROM "Registration" r LEFT JOIN "Section" s ON s.id = r."sectionId" WHERE s.id IS NULL)::int reg_section,
        (SELECT count(*) FROM "SectionInstructor" i LEFT JOIN "Faculty" f ON f.id = i."facultyId" WHERE f.id IS NULL)::int instr_faculty,
        (SELECT count(*) FROM "AttendanceRecord" x LEFT JOIN "Student" s ON s.id = x."studentId" WHERE s.id IS NULL)::int att_student,
        (SELECT count(*) FROM "Grade" g LEFT JOIN "Registration" r ON r.id = g."registrationId" WHERE r.id IS NULL)::int grade_reg,
        (SELECT count(*) FROM "Student" s LEFT JOIN "Person" p ON p.id = s."personId" WHERE p.id IS NULL)::int student_person,
        (SELECT count(*) FROM "Faculty" f LEFT JOIN "Person" p ON p.id = f."personId" WHERE p.id IS NULL)::int faculty_person`))[0];
      if (Object.values(orphans).some((n) => n > 0)) throw new Error(`orphaned references remain: ${JSON.stringify(orphans)}`);
      steps.push(['(integrity check: orphaned references)', 0]);
      const after = await countAll(tx);
      console.log(`${a.apply ? 'APPLIED' : 'DRY RUN (rolled back; add --apply)'} · ${a.slug} · keeping ${keep.join(', ')}`);
      for (const [label, n] of steps) console.log(`  ${String(n).padStart(6)}  ${label}`);
      console.log('  table                   before   after');
      for (const t of TABLES) console.log(`  ${t.padEnd(22)} ${String(before[t]).padStart(7)} ${String(after[t]).padStart(7)}${before[t] !== after[t] ? '' : '   (unchanged)'}`);
      if (!a.apply) throw new DryRun();
    }, { timeout: 300_000 });
  } catch (error) {
    if (!(error instanceof DryRun)) { console.log(`Cleanup failed; nothing written: ${error.meta?.message ?? error.message}`); process.exitCode = 2; }
  }
} finally {
  await prisma.$disconnect();
}
