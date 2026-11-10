// Illustrative "student experience" data for ONE existing student and ONE existing instructor, through the normal
// services (registration rules, the finance ledger, audit). Nothing else is touched; no person, login or course is
// created.
//
//   node scripts/demo-student-experience.js --slug feddrick                 (dry run: what would happen)
//   node scripts/demo-student-experience.js --slug feddrick --apply         (writes; safe to re-run)
//   node scripts/demo-student-experience.js --slug feddrick --cleanup       (removes only what this seed created)
//
// What it does (defaults: student S2400017, instructor F01002, the current term):
//   1. Timetable: registers the student in an existing Tue/Thu section (CS 120-01) and assigns the instructor to it and
//      to CS 101-01 where those sections have no instructor. Registration rules apply; a rule a registrar may override
//      (e.g. the closed add window) is overridden with the reason recorded, any other rule stops the seed.
//      The instructor posts three class announcements to those sections (as the faculty portal does).
//   2. Finance: if the institution has no active fee catalogue of its own, adds an ILLUSTRATIVE one (isDemo); opens an
//      illustrative account for the term, assesses the fees, records one simulated payment and one illustrative
//      scholarship credit (both isDemo, never real money), and issues the term invoice.
// Everything created is recorded as an audit event "demo_seed.*", which is how --cleanup finds it.
import { parseArgs } from 'node:util';
import { prisma } from '../src/lib/prisma.js';
import { audit } from '../src/lib/audit.js';
import { registerStudent, dropRegistration } from '../src/services/registrationService.js';
import * as finance from '../src/services/financeService.js';

const { values: a } = parseArgs({ options: { slug: { type: 'string' }, student: { type: 'string', default: 'S2400017' }, instructor: { type: 'string', default: 'F01002' }, apply: { type: 'boolean', default: false }, cleanup: { type: 'boolean', default: false } } });
const fail = (m) => { console.error(m); process.exit(1); };
if (!a.slug) fail('Usage: demo-student-experience.js --slug <institution> [--student S…] [--instructor F…] [--apply | --cleanup]');

const TTH_SECTION = { course: 'CS 120', section: '01' };
const TEACH = [{ course: 'CS 120', section: '01' }, { course: 'CS 101', section: '01' }];
// Illustrative USD amounts for a demonstration, not an official tuition schedule.
const DEMO_FEES = [
  { code: 'DEMO-TUITION', name: 'Tuition (illustrative)', category: 'TUITION', basis: 'PER_CREDIT', amount: '350.00' },
  { code: 'DEMO-TECH', name: 'Technology fee (illustrative)', category: 'TECHNOLOGY', basis: 'FLAT', amount: '175.00' },
  { code: 'DEMO-SERVICES', name: 'Student services fee (illustrative)', category: 'STUDENT_SERVICES', basis: 'FLAT', amount: '240.00' },
  { code: 'DEMO-REG', name: 'Registration fee (illustrative)', category: 'REGISTRATION', basis: 'FLAT', amount: '60.00' },
];
const DUE = '2026-12-01';
const ANNOUNCEMENTS = [
  { section: { course: 'CS 120', section: '01' }, hoursAgo: 20, pinned: true, title: 'Problem Set 4 due Thursday', body: 'Problem Set 4 (proof techniques and induction) is due at the start of Thursday\'s class. Office hours are Wednesday 15:00–16:00 in Turing Hall 210.' },
  { section: { course: 'CS 120', section: '01' }, hoursAgo: 70, title: 'Midterm review on Tuesday', body: 'Tuesday\'s session will be a midterm review covering sets, relations and logic. Bring your questions; practice problems are posted on Moodle.' },
  { section: { course: 'CS 101', section: '01' }, hoursAgo: 30, title: 'Lab this week: Python control flow', body: 'This week\'s lab covers loops and conditionals. Please bring a laptop with Python 3 installed; the exercise sheet is on Moodle under Week 11.' },
];

const inst = await prisma.institution.findFirst({ where: { slug: a.slug } });
if (!inst) fail(`No institution "${a.slug}".`);
const admin = await prisma.user.findFirst({ where: { institutionId: inst.id, role: 'ADMIN', status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
if (!admin) fail('No active administrator to attribute the changes to.');
const actor = { type: 'USER', id: admin.id, role: 'ADMIN', label: `Demo seed (as ${admin.firstName} ${admin.lastName})`, institutionId: inst.id };
const student = await prisma.student.findFirst({ where: { institutionId: inst.id, studentNumber: a.student } });
const faculty = await prisma.faculty.findFirst({ where: { institutionId: inst.id, employeeNumber: a.instructor } });
const term = await prisma.term.findFirst({ where: { institutionId: inst.id, isCurrent: true } });
if (!student || !faculty || !term) fail(`Missing: ${!student ? `student ${a.student} ` : ''}${!faculty ? `instructor ${a.instructor} ` : ''}${!term ? 'current term' : ''}`);
const section = (s) => prisma.section.findFirst({ where: { institutionId: inst.id, termId: term.id, sectionNumber: s.section, course: { code: s.course } }, include: { course: true, meetings: true, instructors: true } });
const created = async (action) => (await prisma.auditEvent.findMany({ where: { institutionId: inst.id, action }, select: { entityId: true } })).map((e) => e.entityId);
const mark = (action, entityType, entityId, summary) => audit(actor, { action, entityType, entityId, summary });
const say = (m) => console.log(m);
const mode = a.cleanup ? 'cleanup' : a.apply ? 'apply' : 'dry-run';
say(`${inst.name} · ${term.code} · student ${student.studentNumber} (${student.firstName} ${student.lastName}) · instructor ${faculty.employeeNumber} (${faculty.firstName} ${faculty.lastName}) · ${mode}`);

async function seed(write) {
  // 1. Timetable
  const tth = await section(TTH_SECTION);
  if (!tth) fail(`No ${TTH_SECTION.course}-${TTH_SECTION.section} in ${term.code}.`);
  say(`\nTimetable: ${tth.course.code}-${tth.sectionNumber} ${tth.course.title} · ${tth.meetings.map((m) => `${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][m.dayOfWeek]} ${m.startTime}–${m.endTime} ${m.room ?? ''}`).join(', ')}`);
  const reg = await prisma.registration.findUnique({ where: { studentId_sectionId: { studentId: student.id, sectionId: tth.id } } });
  if (reg && ['REGISTERED', 'COMPLETED'].includes(reg.status)) say(`  registration: already ${reg.status}`);
  else if (write) {
    let r;
    try {
      r = await registerStudent(actor, { studentId: student.id, sectionId: tth.id, source: 'ADMIN', reason: 'Demo seed' });
    } catch (e) {
      if (e.status !== 422) throw e;
      // A registrar override passes only overridable rules (late add, prerequisite in progress); others still block.
      say(`  registration rules: ${e.details?.map((d) => d.code).join(', ') ?? e.code}; using a recorded staff override`);
      r = await registerStudent(actor, { studentId: student.id, sectionId: tth.id, source: 'ADMIN', override: true, reason: `Demo seed late add (${e.details?.map((d) => d.code).join(', ') ?? e.code})` });
    }
    const id = r.id ?? r.registration?.id ?? (await prisma.registration.findUnique({ where: { studentId_sectionId: { studentId: student.id, sectionId: tth.id } } })).id;
    await mark('demo_seed.registration', 'Registration', id, `Demo seed registered ${student.studentNumber} in ${tth.course.code}-${tth.sectionNumber}`);
    say('  registration: REGISTERED');
  } else say('  registration: would register (registration rules apply)');
  for (const t of TEACH) {
    const s = await section(t);
    if (!s) { say(`  instructor: no ${t.course}-${t.section} in ${term.code}; skipped`); continue; }
    if (s.instructors.some((i) => i.facultyId === faculty.id)) { say(`  instructor: already teaches ${t.course}-${t.section}`); continue; }
    if (s.instructors.length) { say(`  instructor: ${t.course}-${t.section} already has an instructor; left unchanged`); continue; }
    if (write) {
      const row = await prisma.sectionInstructor.create({ data: { sectionId: s.id, facultyId: faculty.id, isPrimary: true } });
      await mark('demo_seed.instructor', 'SectionInstructor', row.id, `Demo seed assigned ${faculty.employeeNumber} to ${t.course}-${t.section}`);
      say(`  instructor: assigned to ${t.course}-${t.section}`);
    } else say(`  instructor: would assign to ${t.course}-${t.section}`);
  }

  // Class announcements from the instructor, exactly as the faculty portal posts them (section, STUDENTS audience).
  const facultyUser = await prisma.user.findFirst({ where: { institutionId: inst.id, faculty: { id: faculty.id } } });
  for (const n of ANNOUNCEMENTS) {
    const s = await section(n.section);
    if (!s) continue;
    const exists = await prisma.announcement.findFirst({ where: { sectionId: s.id, title: n.title } });
    if (exists) { say(`  announcement "${n.title}": exists`); continue; }
    if (write) {
      const row = await prisma.announcement.create({ data: { institutionId: inst.id, sectionId: s.id, title: n.title, body: n.body, audience: 'STUDENTS', authorUserId: facultyUser?.id ?? null, authorName: `${faculty.firstName} ${faculty.lastName}`, publishedAt: new Date(Date.now() - n.hoursAgo * 3600_000), pinned: Boolean(n.pinned) } });
      await mark('demo_seed.announcement', 'Announcement', row.id, `Demo seed class announcement "${n.title}" on ${n.section.course}-${n.section.section}`);
    }
    say(`  announcement "${n.title}" (${n.section.course}-${n.section.section}): ${write ? 'posted' : 'would post'}`);
  }

  // 2. Finance
  const ownFees = await prisma.feeDefinition.count({ where: { institutionId: inst.id, active: true, isDemo: false } });
  say(`\nFinance: ${ownFees ? `${ownFees} configured fee(s) of the institution are used` : 'no fee catalogue configured: illustrative (demo) fees are used'}`);
  if (!ownFees) {
    for (const f of DEMO_FEES) {
      const exists = await prisma.feeDefinition.findUnique({ where: { institutionId_code: { institutionId: inst.id, code: f.code } } });
      if (exists) { say(`  fee ${f.code}: exists`); continue; }
      if (write) {
        const fee = await finance.createFee(actor, { ...f, termId: term.id, isDemo: true, description: 'Illustrative fee for demonstration; not an official charge.' });
        await mark('demo_seed.fee', 'FeeDefinition', fee.id, `Demo seed fee ${f.code}`);
      }
      say(`  fee ${f.code}: ${write ? 'created' : 'would create'} ${f.amount} ${f.basis === 'PER_CREDIT' ? 'per credit' : 'flat'}`);
    }
  }
  const existing = await prisma.studentAccount.findUnique({ where: { studentId_termId: { studentId: student.id, termId: term.id } } });
  if (existing && !existing.isDemo) { say(`  account ${existing.accountNumber} is a real account; the seed will not touch it.`); return; }
  if (!write) { say(`  account: would ${existing ? 'reuse' : 'open'} an illustrative ${term.code} account due ${DUE}, assess fees, record a simulated payment and an illustrative scholarship, issue the invoice`); return; }
  const { account, created: opened } = await finance.openAccount(actor, { studentId: student.id, termId: term.id, dueDate: DUE, isDemo: true });
  if (opened) await mark('demo_seed.account', 'StudentAccount', account.id, `Demo seed account ${account.accountNumber}`);
  const assessed = await finance.assessFees(actor, account.id);
  say(`  account ${account.accountNumber}: assessed ${assessed.posted.length} new fee(s) on ${assessed.credits} credits`);
  await finance.postEntry(actor, account.id, { type: 'PAYMENT', amount: '2000.00', description: 'Simulated payment (demo data, no money moved)', method: 'Simulated (demo)', effectiveDate: '2026-09-15', idempotencyKey: 'demo-seed:payment-1', isDemo: true });
  await finance.postEntry(actor, account.id, { type: 'CREDIT', amount: '1000.00', description: 'Nursing merit scholarship (illustrative)', effectiveDate: '2026-09-01', idempotencyKey: 'demo-seed:credit-1', isDemo: true });
  const now = await finance.getAccount(inst.id, account.id);
  if (now.entries.some((e) => e.type === 'CHARGE' && !e.invoiced)) await finance.issueInvoice(actor, account.id, { dueDate: DUE });
  const final = await finance.getAccount(inst.id, account.id);
  say(`  totals: charges ${final.totals.charges} · payments ${final.totals.payments} · credits ${final.totals.credits} · balance ${final.totals.balance} · due ${final.dueDate} · ${final.invoices.length} invoice(s)`);
}

async function cleanup() {
  for (const id of await created('demo_seed.announcement')) {
    const row = await prisma.announcement.findUnique({ where: { id } });
    if (row) { await prisma.announcement.delete({ where: { id } }); say(`  announcement "${row.title}": removed`); }
  }
  for (const id of await created('demo_seed.account')) {
    const acc = await prisma.studentAccount.findUnique({ where: { id }, include: { entries: true } });
    if (!acc) continue;
    if (!acc.isDemo || acc.entries.some((e) => !e.isDemo)) { say(`  account ${acc.accountNumber}: holds non-demo entries; left in place`); continue; }
    await prisma.$transaction(async (tx) => {
      await tx.invoice.deleteMany({ where: { accountId: id } });
      // Reversals first (they reference what they reverse), then the rest; the trigger allows deleting demo entries only.
      await tx.ledgerEntry.deleteMany({ where: { accountId: id, reversesId: { not: null } } });
      await tx.ledgerEntry.deleteMany({ where: { accountId: id } });
      await tx.studentAccount.delete({ where: { id } });
      await audit(actor, { action: 'demo_seed.cleanup', entityType: 'StudentAccount', entityId: id, summary: `Removed demo account ${acc.accountNumber}` }, tx);
    });
    say(`  account ${acc.accountNumber}: removed`);
  }
  for (const id of await created('demo_seed.fee')) {
    const fee = await prisma.feeDefinition.findUnique({ where: { id }, include: { _count: { select: { entries: true } } } });
    if (!fee) continue;
    if (fee._count.entries) { say(`  fee ${fee.code}: still referenced; left in place`); continue; }
    await prisma.feeDefinition.delete({ where: { id } });
    say(`  fee ${fee.code}: removed`);
  }
  for (const id of await created('demo_seed.instructor')) {
    const row = await prisma.sectionInstructor.findUnique({ where: { id } });
    if (row) { await prisma.sectionInstructor.delete({ where: { id } }); say(`  instructor assignment ${id}: removed`); }
  }
  for (const id of await created('demo_seed.registration')) {
    const reg = await prisma.registration.findUnique({ where: { id } });
    if (reg && ['REGISTERED', 'WAITLISTED'].includes(reg.status)) { await dropRegistration(actor, { registrationId: id, reason: 'Demo seed cleanup' }); say(`  registration ${id}: dropped (history kept)`); }
  }
}

try {
  if (a.cleanup) await cleanup();
  else await seed(a.apply);
  if (!a.apply && !a.cleanup) say('\nDry run: nothing was written. Re-run with --apply.');
} finally {
  await prisma.$disconnect();
}
