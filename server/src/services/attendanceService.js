import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { notFound, ruleViolation, forbidden } from '../lib/errors.js';
import { getPolicies } from './policyService.js';
import { assertInstructor } from './gradeService.js';

const isStaff = (actor) => actor.type === 'USER' && ['ADMIN', 'REGISTRAR'].includes(actor.role);
const dayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export async function getSectionAttendance(sectionId, institutionId, date) {
  const section = await prisma.section.findFirst({ where: { id: sectionId, institutionId }, include: { course: true, term: true, meetings: true } });
  if (!section) throw notFound('Section');
  const regs = await prisma.registration.findMany({
    where: { sectionId, status: { in: ['REGISTERED', 'COMPLETED'] } },
    include: { student: true, attendance: true },
    orderBy: { student: { lastName: 'asc' } },
  });
  const dates = [...new Set(regs.flatMap((r) => r.attendance.map((a) => a.date.toISOString().slice(0, 10))))].sort();
  return {
    section: { id: section.id, courseCode: section.course.code, courseTitle: section.course.title, sectionNumber: section.sectionNumber, termStart: section.term.startDate, termEnd: section.term.endDate, meetingDays: section.meetings.map((m) => m.dayOfWeek) },
    recordedDates: dates,
    rows: regs.map((r) => {
      const byDate = Object.fromEntries(r.attendance.map((a) => [a.date.toISOString().slice(0, 10), a.status]));
      const total = r.attendance.length;
      const attended = r.attendance.filter((a) => a.status === 'PRESENT' || a.status === 'LATE').length;
      return {
        registrationId: r.id,
        student: { id: r.student.id, studentNumber: r.student.studentNumber, name: `${r.student.lastName}, ${r.student.preferredName || r.student.firstName}` },
        status: date ? byDate[date] ?? null : undefined,
        note: date ? r.attendance.find((a) => a.date.toISOString().slice(0, 10) === date)?.note ?? null : undefined,
        summary: { total, attended, rate: total ? Math.round((attended / total) * 100) : null },
      };
    }),
  };
}

// Record (upsert) attendance for one class date. Faculty may only record for their own sections,
// within the term and within the institution's edit window.
export async function recordAttendance(actor, { sectionId, facultyId, date, records }) {
  const section = await prisma.section.findFirst({ where: { id: sectionId, institutionId: actor.institutionId }, include: { term: true, course: true } });
  if (!section) throw notFound('Section');
  if (!isStaff(actor)) {
    if (!facultyId) throw forbidden('An acting instructor is required.', 'not_section_instructor');
    await assertInstructor(sectionId, facultyId, actor.institutionId);
  }
  const d = new Date(`${date}T00:00:00Z`);
  const today = dayStart(new Date());
  if (d < section.term.startDate || d > section.term.endDate) throw ruleViolation('date_outside_term', `Date must fall within ${section.term.name}.`);
  if (d > today) throw ruleViolation('future_date', 'Attendance cannot be recorded for a future date.');
  const policies = await getPolicies(actor.institutionId);
  const windowDays = policies['attendance.facultyEditWindowDays'];
  if (!isStaff(actor) && (today - d) / 86400000 > windowDays) throw ruleViolation('edit_window_closed', `Attendance can only be recorded or corrected within ${windowDays} days of the class date.`);

  return prisma.$transaction(async (tx) => {
    let changed = 0;
    for (const rec of records) {
      const reg = await tx.registration.findFirst({ where: { sectionId, studentId: rec.studentId, status: { in: ['REGISTERED', 'COMPLETED'] } } });
      if (!reg) throw ruleViolation('student_not_on_roster', `Student ${rec.studentId} is not on this section's roster.`);
      await tx.attendanceRecord.upsert({
        where: { registrationId_date: { registrationId: reg.id, date: d } },
        create: { sectionId, studentId: rec.studentId, registrationId: reg.id, date: d, status: rec.status, note: rec.note, recordedByType: actor.type, recordedById: actor.id },
        update: { status: rec.status, note: rec.note, recordedByType: actor.type, recordedById: actor.id },
      });
      changed += 1;
    }
    await audit(actor, { action: 'attendance.recorded', entityType: 'Section', entityId: sectionId, summary: `Recorded attendance for ${changed} student(s) in ${section.course.code}-${section.sectionNumber} on ${date}` }, tx);
    return { sectionId, date, recorded: changed };
  });
}

export async function getStudentAttendance(studentId, termId) {
  const regs = await prisma.registration.findMany({
    where: { studentId, status: { in: ['REGISTERED', 'COMPLETED'] }, ...(termId ? { section: { termId } } : {}) },
    include: { attendance: { orderBy: { date: 'asc' } }, section: { include: { course: true, term: true } } },
  });
  return regs.map((r) => {
    const attended = r.attendance.filter((a) => a.status === 'PRESENT' || a.status === 'LATE').length;
    return {
      sectionId: r.sectionId,
      courseCode: r.section.course.code,
      courseTitle: r.section.course.title,
      sectionNumber: r.section.sectionNumber,
      term: r.section.term.code,
      summary: { total: r.attendance.length, attended, absent: r.attendance.filter((a) => a.status === 'ABSENT').length, late: r.attendance.filter((a) => a.status === 'LATE').length, excused: r.attendance.filter((a) => a.status === 'EXCUSED').length, rate: r.attendance.length ? Math.round((attended / r.attendance.length) * 100) : null },
      records: r.attendance.map((a) => ({ date: a.date.toISOString().slice(0, 10), status: a.status, note: a.note })),
    };
  });
}
