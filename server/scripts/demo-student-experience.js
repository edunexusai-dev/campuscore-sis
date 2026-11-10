// Illustrative "student experience" data for ONE existing student and ONE existing instructor, through the normal
// services (registration rules, the finance ledger, audit). Nothing else is touched; no person, login or course is
// created.
//
//   node scripts/demo-student-experience.js --slug feddrick                 (dry run: what would happen)
//   node scripts/demo-student-experience.js --slug feddrick --apply         (writes; safe to re-run)
//   node scripts/demo-student-experience.js --slug feddrick --cleanup       (removes only what this seed created)
//
// What it does (defaults: student S2400017, instructor F01002, the current term):
//   1. Timetable: the student's own registrations are never changed. To give the week classes on every weekday, ONE
//      section that only this student attends (MATH 251-01, Mon/Wed) moves to an unused standard Tue/Thu block in its
//      own room. The move is refused if anyone else is registered or waitlisted there, if it would clash with the
//      student's other classes, or if the room is taken; the previous meetings are recorded so --cleanup restores them.
//      The instructor is assigned to CS 101-01 if it has no instructor and posts a class announcement there (as the
//      faculty portal does).
//   2. Finance: if the institution has no active fee catalogue of its own, adds an ILLUSTRATIVE one (isDemo); opens an
//      illustrative account for the term, assesses the fees, records one simulated payment and one illustrative
//      scholarship credit (both isDemo, never real money), and issues the term invoice.
// Everything created is recorded as an audit event "demo_seed.*", which is how --cleanup finds it. A run also removes
// records an EARLIER version of this seed created that the definition below no longer contains (an earlier version
// registered the student in CS 120-01), and rebuilds the illustrative account if its tuition no longer matches the
// student's registered credits.
import { parseArgs } from 'node:util';
import { prisma } from '../src/lib/prisma.js';
import { audit } from '../src/lib/audit.js';
import { dropRegistration } from '../src/services/registrationService.js';
import * as finance from '../src/services/financeService.js';

const { values: a } = parseArgs({ options: { slug: { type: 'string' }, student: { type: 'string', default: 'S2400017' }, instructor: { type: 'string', default: 'F01002' }, apply: { type: 'boolean', default: false }, cleanup: { type: 'boolean', default: false } } });
const fail = (m) => { console.error(m); process.exit(1); };
if (!a.slug) fail('Usage: demo-student-experience.js --slug <institution> [--student S…] [--instructor F…] [--apply | --cleanup]');

// The institution's standard 75-minute Tue/Thu block; the room is kept.
const RESCHEDULE = { course: 'MATH 251', section: '01', meetings: [{ dayOfWeek: 2, startTime: '11:00', endTime: '12:15' }, { dayOfWeek: 4, startTime: '11:00', endTime: '12:15' }] };
const TEACH = [{ course: 'CS 101', section: '01' }];
// Illustrative USD amounts for a demonstration, not an official tuition schedule.
const DEMO_FEES = [
  { code: 'DEMO-TUITION', name: 'Tuition (illustrative)', category: 'TUITION', basis: 'PER_CREDIT', amount: '350.00' },
  { code: 'DEMO-TECH', name: 'Technology fee (illustrative)', category: 'TECHNOLOGY', basis: 'FLAT', amount: '175.00' },
  { code: 'DEMO-SERVICES', name: 'Student services fee (illustrative)', category: 'STUDENT_SERVICES', basis: 'FLAT', amount: '240.00' },
  { code: 'DEMO-REG', name: 'Registration fee (illustrative)', category: 'REGISTRATION', basis: 'FLAT', amount: '60.00' },
];
const DUE = '2026-12-01';
const ANNOUNCEMENTS = [
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
const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const fmt = (ms) => ms.map((m) => `${DAY[m.dayOfWeek]} ${m.startTime}–${m.endTime}${m.room ? ` ${m.room}` : ''}`).join(', ') || 'no meetings';
const slots = (ms) => ms.map((m) => `${m.dayOfWeek} ${m.startTime} ${m.endTime} ${m.room ?? ''}`).sort().join('|');
const overlaps = (x, y) => x.dayOfWeek === y.dayOfWeek && x.startTime < y.endTime && y.startTime < x.endTime;
const mode = a.cleanup ? 'cleanup' : a.apply ? 'apply' : 'dry-run';
say(`${inst.name} · ${term.code} · student ${student.studentNumber} (${student.firstName} ${student.lastName}) · instructor ${faculty.employeeNumber} (${faculty.firstName} ${faculty.lastName}) · ${mode}`);

// A registration the seed created is deleted outright (with its own events, such as a recorded override) when nothing
// hangs off it; otherwise it is dropped so its history stays.
async function removeRegistration(id) {
  const reg = await prisma.registration.findUnique({ where: { id }, include: { grade: true, _count: { select: { attendance: true } }, section: { include: { course: true } } } });
  if (!reg || reg.studentId !== student.id) return;
  const label = `${reg.section.course.code}-${reg.section.sectionNumber}`;
  if (!reg.grade && !reg._count.attendance) {
    await prisma.$transaction(async (tx) => {
      await tx.registration.delete({ where: { id } });
      await audit(actor, { action: 'demo_seed.cleanup', entityType: 'Registration', entityId: id, summary: `Removed demo registration of ${student.studentNumber} in ${label}` }, tx);
    });
    say(`  registration ${label}: removed`);
  } else if (['REGISTERED', 'WAITLISTED'].includes(reg.status)) {
    await dropRegistration(actor, { registrationId: id, reason: 'Demo seed cleanup' });
    say(`  registration ${label}: dropped (it has grades or attendance, so its history is kept)`);
  }
}

async function removeDemoAccount(id) {
  const acc = await prisma.studentAccount.findUnique({ where: { id }, include: { entries: true } });
  if (!acc) return false;
  if (!acc.isDemo || acc.entries.some((e) => !e.isDemo)) { say(`  account ${acc.accountNumber}: holds non-demo entries; left in place`); return false; }
  await prisma.$transaction(async (tx) => {
    await tx.invoice.deleteMany({ where: { accountId: id } });
    // Reversals first (they reference what they reverse), then the rest; the trigger allows deleting demo entries only.
    await tx.ledgerEntry.deleteMany({ where: { accountId: id, reversesId: { not: null } } });
    await tx.ledgerEntry.deleteMany({ where: { accountId: id } });
    await tx.studentAccount.delete({ where: { id } });
    await audit(actor, { action: 'demo_seed.cleanup', entityType: 'StudentAccount', entityId: id, summary: `Removed demo account ${acc.accountNumber}` }, tx);
  });
  say(`  account ${acc.accountNumber}: removed`);
  return true;
}

// Records an earlier version of this seed created that the current definition no longer contains.
async function retire(write) {
  const wanted = (row, list) => list.some((t) => row.section.course.code === t.course && row.section.sectionNumber === t.section);
  for (const id of await created('demo_seed.registration')) {
    const reg = await prisma.registration.findUnique({ where: { id }, include: { section: { include: { course: true } } } });
    if (!reg) continue;
    if (write) await removeRegistration(id);
    else say(`  registration ${reg.section.course.code}-${reg.section.sectionNumber}: would remove (created by an earlier version of this seed)`);
  }
  for (const id of await created('demo_seed.instructor')) {
    const row = await prisma.sectionInstructor.findUnique({ where: { id }, include: { section: { include: { course: true } } } });
    if (!row || wanted(row, TEACH)) continue;
    if (write) await prisma.sectionInstructor.delete({ where: { id } });
    say(`  instructor assignment ${row.section.course.code}-${row.section.sectionNumber}: ${write ? 'removed' : 'would remove'} (no longer part of the demo)`);
  }
  for (const id of await created('demo_seed.announcement')) {
    const row = await prisma.announcement.findUnique({ where: { id }, include: { section: { include: { course: true } } } });
    if (!row || ANNOUNCEMENTS.some((n) => n.title === row.title && row.section && wanted(row, [n.section]))) continue;
    if (write) await prisma.announcement.delete({ where: { id } });
    say(`  announcement "${row.title}": ${write ? 'removed' : 'would remove'} (no longer part of the demo)`);
  }
}

async function reschedule(write) {
  const s = await section(RESCHEDULE);
  if (!s) { say(`  ${RESCHEDULE.course}-${RESCHEDULE.section}: not in ${term.code}; timetable left unchanged`); return; }
  const label = `${s.course.code}-${s.sectionNumber}`;
  const room = s.meetings.find((m) => m.room)?.room ?? s.location ?? null;
  const target = RESCHEDULE.meetings.map((m) => ({ ...m, room }));
  if (slots(s.meetings) === slots(target)) { say(`  ${label}: already ${fmt(target)}`); return; }
  const regs = await prisma.registration.findMany({ where: { sectionId: s.id, status: { in: ['REGISTERED', 'WAITLISTED'] } }, include: { student: true } });
  const refuse = (why) => say(`  ${label}: NOT moved, ${why}. It stays ${fmt(s.meetings)}.`);
  if (!regs.some((r) => r.studentId === student.id)) return refuse(`${student.studentNumber} is not registered in it`);
  const others = regs.filter((r) => r.studentId !== student.id);
  if (others.length) return refuse(`${others.length} other student(s) attend it (${others.map((r) => r.student.studentNumber).join(', ')}) and their timetable would change`);
  const mine = await prisma.meetingTime.findMany({ where: { sectionId: { not: s.id }, section: { termId: term.id, registrations: { some: { studentId: student.id, status: { in: ['REGISTERED', 'WAITLISTED'] } } } } }, include: { section: { include: { course: true } } } });
  const clash = mine.find((m) => target.some((t) => overlaps(m, t)));
  if (clash) return refuse(`it would clash with ${clash.section.course.code}-${clash.section.sectionNumber} (${fmt([clash])})`);
  if (room) {
    const busy = (await prisma.meetingTime.findMany({ where: { room, sectionId: { not: s.id }, section: { termId: term.id, status: { not: 'CANCELLED' } } }, include: { section: { include: { course: true } } } })).find((m) => target.some((t) => overlaps(m, t)));
    if (busy) return refuse(`${room} is used by ${busy.section.course.code}-${busy.section.sectionNumber} then`);
  }
  if (!write) { say(`  ${label}: would move ${fmt(s.meetings)} → ${fmt(target)} (only ${student.studentNumber} attends it)`); return; }
  const before = s.meetings.map(({ dayOfWeek, startTime, endTime, room: r }) => ({ dayOfWeek, startTime, endTime, room: r }));
  await prisma.$transaction(async (tx) => {
    await tx.meetingTime.deleteMany({ where: { sectionId: s.id } });
    await tx.meetingTime.createMany({ data: target.map((m) => ({ ...m, sectionId: s.id })) });
    await audit(actor, { action: 'section.updated', entityType: 'Section', entityId: s.id, summary: `Updated section ${label}: meetings`, before: { meetings: before }, after: { meetings: target } }, tx);
    await audit(actor, { action: 'demo_seed.meetings', entityType: 'Section', entityId: s.id, summary: `Demo seed moved ${label} from ${fmt(before)} to ${fmt(target)}`, before: { meetings: before }, after: { meetings: target } }, tx);
  });
  say(`  ${label}: moved ${fmt(before)} → ${fmt(target)}`);
}

async function seed(write) {
  // 1. Timetable
  say('\nTimetable:');
  await retire(write);
  await reschedule(write);
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
  let existing = await prisma.studentAccount.findUnique({ where: { studentId_termId: { studentId: student.id, termId: term.id } }, include: { entries: { include: { reversedBy: true } } } });
  if (existing?.isDemo) {
    const regs = await prisma.registration.findMany({ where: { studentId: student.id, status: { in: ['REGISTERED', 'COMPLETED'] }, section: { termId: term.id } }, select: { creditsAttempted: true } });
    const credits = regs.reduce((n, r) => n + Number(r.creditsAttempted ?? 0), 0);
    const stale = existing.entries.find((e) => e.type === 'CHARGE' && e.quantity != null && !e.reversedBy && Number(e.quantity) !== credits);
    if (stale) {
      say(`  account ${existing.accountNumber}: tuition was assessed on ${Number(stale.quantity)} credits, the student now has ${credits}; ${write ? 'rebuilding' : 'would rebuild'} the illustrative account`);
      if (!write) return;
      if (await removeDemoAccount(existing.id)) existing = null;
    }
  }
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
  for (const id of await created('demo_seed.account')) await removeDemoAccount(id);
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
  for (const id of await created('demo_seed.registration')) await removeRegistration(id);
  // Restore moved sections, latest move first, only while they still have the meetings the seed gave them.
  const moves = await prisma.auditEvent.findMany({ where: { institutionId: inst.id, action: 'demo_seed.meetings' }, orderBy: { createdAt: 'desc' } });
  for (const sectionId of new Set(moves.map((e) => e.entityId))) {
    const move = moves.find((e) => e.entityId === sectionId);
    const s = await prisma.section.findUnique({ where: { id: sectionId }, include: { course: true, meetings: true } });
    if (!s) continue;
    const label = `${s.course.code}-${s.sectionNumber}`;
    if (slots(s.meetings) !== slots(move.after.meetings)) { say(`  ${label}: meetings changed since the seed moved it; left as ${fmt(s.meetings)}`); continue; }
    await prisma.$transaction(async (tx) => {
      await tx.meetingTime.deleteMany({ where: { sectionId } });
      await tx.meetingTime.createMany({ data: move.before.meetings.map((m) => ({ ...m, sectionId })) });
      await audit(actor, { action: 'section.updated', entityType: 'Section', entityId: sectionId, summary: `Updated section ${label}: meetings (demo seed cleanup)`, before: { meetings: move.after.meetings }, after: { meetings: move.before.meetings } }, tx);
      await audit(actor, { action: 'demo_seed.cleanup', entityType: 'Section', entityId: sectionId, summary: `Restored ${label} to ${fmt(move.before.meetings)}` }, tx);
    });
    say(`  ${label}: restored to ${fmt(move.before.meetings)}`);
  }
}

try {
  if (a.cleanup) await cleanup();
  else await seed(a.apply);
  if (!a.apply && !a.cleanup) say('\nDry run: nothing was written. Re-run with --apply.');
} finally {
  await prisma.$disconnect();
}
