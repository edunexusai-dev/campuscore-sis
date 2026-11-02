// Registration engine. Every add/drop — from the student portal, the admin portal or the integration API —
// runs through these functions, so business rules are enforced identically for every channel.
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { notFound, ruleViolation, forbidden, conflict } from '../lib/errors.js';
import { getPolicies } from './policyService.js';
import { getGradeScale, meetsMinimum } from './academicService.js';
import { notifyStudent } from './notificationService.js';

const ACTIVE = ['REGISTERED', 'WAITLISTED'];
const REGISTERABLE_STUDENT_STATUSES = ['ACTIVE', 'ADMITTED'];
const isStaff = (actor) => actor.type === 'USER' && ['ADMIN', 'REGISTRAR'].includes(actor.role);

const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export function meetingsOverlap(a, b) {
  return a.some((x) => b.some((y) => x.dayOfWeek === y.dayOfWeek && toMinutes(x.startTime) < toMinutes(y.endTime) && toMinutes(y.startTime) < toMinutes(x.endTime)));
}

// Evaluates every rule and returns a list of violations (code + message). Used both to enforce
// registration and to show students "why can't I register" before they try.
export async function evaluateRegistration({ institutionId, studentId, sectionId, now = new Date() }, tx = prisma) {
  const [student, section, policies] = await Promise.all([
    tx.student.findFirst({ where: { id: studentId, institutionId }, include: { holds: { where: { releasedAt: null, blocksRegistration: true } } } }),
    tx.section.findFirst({ where: { id: sectionId, institutionId }, include: { term: true, meetings: true, course: { include: { prerequisites: { include: { prerequisite: true } } } } } }),
    getPolicies(institutionId, tx),
  ]);
  if (!student) throw notFound('Student');
  if (!section) throw notFound('Section');

  const violations = []; // { code, message, overridable }
  const add = (code, message, overridable = true) => violations.push({ code, message, overridable });

  if (!REGISTERABLE_STUDENT_STATUSES.includes(student.status)) add('student_not_eligible', `Students with status ${student.status} cannot register.`, false);
  for (const hold of student.holds) add('registration_hold', `${hold.type.toLowerCase()} hold: ${hold.reason}`, false);

  if (section.status === 'CANCELLED') add('section_cancelled', 'This section has been cancelled.', false);
  else if (section.status === 'CLOSED') add('section_closed', 'This section is closed to registration.');

  if (section.term.status === 'COMPLETED') add('term_completed', 'Registration is not possible for a completed term.', false);
  if (policies['registration.enforceRegistrationWindow'] && (now < section.term.registrationOpens || now > section.term.registrationCloses)) {
    add('registration_window_closed', `Registration for ${section.term.name} is open ${section.term.registrationOpens.toDateString()} – ${section.term.registrationCloses.toDateString()}.`);
  }

  const termRegs = await tx.registration.findMany({
    where: { studentId, status: { in: ACTIVE }, section: { termId: section.termId } },
    include: { section: { include: { meetings: true, course: true } } },
  });
  const existing = termRegs.find((r) => r.sectionId === sectionId);
  if (existing) add(existing.status === 'WAITLISTED' ? 'already_waitlisted' : 'already_registered', `Already ${existing.status.toLowerCase()} in this section.`, false);
  const sameCourse = termRegs.find((r) => r.sectionId !== sectionId && r.section.courseId === section.courseId);
  if (sameCourse) add('duplicate_course', `Already enrolled in ${section.course.code} section ${sameCourse.section.sectionNumber} this term.`, false);

  if (policies['registration.enforcePrerequisites'] && section.course.prerequisites.length) {
    const scale = await getGradeScale(institutionId, tx);
    const history = await tx.registration.findMany({
      where: { studentId, status: { in: ['REGISTERED', 'COMPLETED'] }, section: { courseId: { in: section.course.prerequisites.map((p) => p.prerequisiteId) } } },
      include: { grade: true, section: { include: { term: true } } },
    });
    for (const pre of section.course.prerequisites) {
      const attempts = history.filter((h) => h.section.courseId === pre.prerequisiteId);
      const satisfied = attempts.some((h) =>
        (h.grade?.status === 'PUBLISHED' && meetsMinimum(scale, h.grade.letter, pre.minGrade)) ||
        // In progress in an earlier term counts (provisional), mirroring common SIS practice.
        (h.status === 'REGISTERED' && h.section.term.startDate < section.term.startDate && h.grade?.status !== 'PUBLISHED'));
      if (!satisfied) add('prerequisite_not_met', `Requires ${pre.prerequisite.code} with a minimum grade of ${pre.minGrade}.`);
    }
  }

  const registeredCredits = termRegs.filter((r) => r.status === 'REGISTERED').reduce((s, r) => s + r.creditsAttempted, 0);
  const max = policies['registration.maxCreditsPerTerm'];
  if (registeredCredits + section.course.credits > max) add('credit_limit_exceeded', `Adding ${section.course.credits} credits would exceed the ${max}-credit term limit (currently ${registeredCredits}).`);

  const conflictWith = termRegs.find((r) => r.status === 'REGISTERED' && r.sectionId !== sectionId && meetingsOverlap(r.section.meetings, section.meetings));
  if (conflictWith) add('time_conflict', `Meeting times conflict with ${conflictWith.section.course.code}-${conflictWith.section.sectionNumber}.`);

  const registeredCount = await tx.registration.count({ where: { sectionId, status: 'REGISTERED' } });
  const waitlistCount = await tx.registration.count({ where: { sectionId, status: 'WAITLISTED' } });
  const seatsAvailable = Math.max(0, section.capacity - registeredCount);
  const waitlistAvailable = policies['registration.allowWaitlist'] ? Math.max(0, section.waitlistCapacity - waitlistCount) : 0;
  let outcome = 'REGISTERED';
  if (seatsAvailable === 0) {
    if (waitlistAvailable > 0) outcome = 'WAITLISTED';
    else add('section_full', 'This section is full and has no waitlist space.');
  }

  return { student, section, policies, violations, outcome, seatsAvailable, waitlistCount, registeredCredits };
}

// Adds a registration. `override` (staff only) bypasses overridable rules such as the registration window,
// prerequisites, credit limit, time conflicts and capacity. Holds and student status are never overridable.
export async function registerStudent(actor, { studentId, sectionId, source, override = false, reason }) {
  if (override && !isStaff(actor)) throw forbidden('Only registrar staff can override registration rules.');

  const result = await prisma.$transaction(async (tx) => {
    // Lock the section row so concurrent registrations cannot oversubscribe capacity.
    await tx.$queryRaw`SELECT id FROM "Section" WHERE id = ${sectionId} AND "institutionId" = ${actor.institutionId} FOR UPDATE`;
    const ev = await evaluateRegistration({ institutionId: actor.institutionId, studentId, sectionId }, tx);
    const blocking = ev.violations.filter((v) => !(override && v.overridable));
    if (blocking.length) {
      throw ruleViolation(blocking[0].code, blocking[0].message, blocking.map(({ code, message }) => ({ code, message })));
    }
    // A staff override on a full section is a capacity override: the student is seated, not waitlisted.
    const status = override ? 'REGISTERED' : ev.outcome;

    const waitlistPosition = status === 'WAITLISTED' ? ev.waitlistCount + 1 : null;
    const data = { status, waitlistPosition, source, statusChangedAt: new Date(), creditsAttempted: ev.section.course.credits };
    const prior = await tx.registration.findUnique({ where: { studentId_sectionId: { studentId, sectionId } } });
    if (prior && ACTIVE.includes(prior.status)) throw conflict('Registration already exists.', 'already_registered');
    if (prior && prior.status !== 'DROPPED') throw conflict(`A ${prior.status.toLowerCase()} registration already exists for this section.`, 'registration_exists');
    const reg = prior
      ? await tx.registration.update({ where: { id: prior.id }, data: { ...data, registeredAt: new Date() } })
      : await tx.registration.create({ data: { ...data, institutionId: actor.institutionId, studentId, sectionId } });

    const label = `${ev.section.course.code}-${ev.section.sectionNumber}`;
    await tx.registrationEvent.create({ data: { registrationId: reg.id, action: status === 'WAITLISTED' ? 'WAITLIST' : 'ADD', fromStatus: prior?.status ?? null, toStatus: status, actorType: actor.type, actorId: actor.id, reason: override ? `Override: ${reason || 'no reason given'}` : reason } });
    await audit(actor, {
      action: status === 'WAITLISTED' ? 'registration.waitlisted' : 'registration.created',
      entityType: 'Registration', entityId: reg.id,
      summary: `${status === 'WAITLISTED' ? 'Waitlisted' : 'Registered'} ${ev.student.firstName} ${ev.student.lastName} (${ev.student.studentNumber}) in ${label}${override ? ' with override' : ''}`,
      after: { status, sectionId, studentId, override, overriddenRules: override ? ev.violations.map((v) => v.code) : undefined },
    }, tx);
    await notifyStudent(studentId, {
      title: status === 'WAITLISTED' ? `Waitlisted for ${label}` : `Registered for ${label}`,
      body: status === 'WAITLISTED' ? `You are #${waitlistPosition} on the waitlist for ${ev.section.course.title}.` : `You are registered in ${ev.section.course.title}.`,
      link: '/student/registration',
    }, tx);
    return reg;
  });
  return result;
}

// Drops (before add/drop deadline) or withdraws (before withdrawal deadline) a registration.
export async function dropRegistration(actor, { registrationId, reason, studentScope }) {
  return prisma.$transaction(async (tx) => {
    const reg = await tx.registration.findFirst({
      where: { id: registrationId, institutionId: actor.institutionId, ...(studentScope ? { studentId: studentScope } : {}) },
      include: { grade: true, student: true, section: { include: { term: true, course: true } } },
    });
    if (!reg) throw notFound('Registration');
    await tx.$queryRaw`SELECT id FROM "Section" WHERE id = ${reg.sectionId} FOR UPDATE`;
    if (!ACTIVE.includes(reg.status)) throw ruleViolation('registration_not_active', `Registration is already ${reg.status.toLowerCase()}.`);
    if (reg.grade && reg.grade.status !== 'DRAFT') throw ruleViolation('grade_on_record', 'A grade has been submitted for this registration; it can no longer be dropped.');

    const now = new Date();
    const { term } = reg.section;
    let toStatus;
    if (reg.status === 'WAITLISTED' || now <= term.addDropDeadline) toStatus = 'DROPPED';
    else if (now <= term.withdrawDeadline || isStaff(actor)) toStatus = 'WITHDRAWN';
    else throw ruleViolation('withdraw_deadline_passed', `The withdrawal deadline for ${term.name} (${term.withdrawDeadline.toDateString()}) has passed. Contact the registrar.`);

    const wasRegistered = reg.status === 'REGISTERED';
    const updated = await tx.registration.update({ where: { id: reg.id }, data: { status: toStatus, waitlistPosition: null, statusChangedAt: now } });
    if (reg.grade) await tx.grade.delete({ where: { id: reg.grade.id } }); // only DRAFT can reach here
    await tx.registrationEvent.create({ data: { registrationId: reg.id, action: toStatus === 'DROPPED' ? 'DROP' : 'WITHDRAW', fromStatus: reg.status, toStatus, actorType: actor.type, actorId: actor.id, reason } });
    const label = `${reg.section.course.code}-${reg.section.sectionNumber}`;
    await audit(actor, { action: toStatus === 'DROPPED' ? 'registration.dropped' : 'registration.withdrawn', entityType: 'Registration', entityId: reg.id, summary: `${toStatus === 'DROPPED' ? 'Dropped' : 'Withdrew'} ${reg.student.firstName} ${reg.student.lastName} (${reg.student.studentNumber}) from ${label}`, before: { status: reg.status }, after: { status: toStatus, reason } }, tx);

    if (reg.status === 'WAITLISTED') await renumberWaitlist(tx, reg.sectionId);
    if (wasRegistered) await promoteFromWaitlist(tx, reg.sectionId, actor);
    return updated;
  });
}

async function renumberWaitlist(tx, sectionId) {
  const waiting = await tx.registration.findMany({ where: { sectionId, status: 'WAITLISTED' }, orderBy: [{ waitlistPosition: 'asc' }, { registeredAt: 'asc' }] });
  for (const [i, w] of waiting.entries()) {
    if (w.waitlistPosition !== i + 1) await tx.registration.update({ where: { id: w.id }, data: { waitlistPosition: i + 1 } });
  }
}

// Fills open seats from the waitlist in order. Students who would now exceed the credit limit or have a
// time conflict are skipped (they stay on the waitlist) so promotion never bypasses registration rules.
export async function promoteFromWaitlist(tx, sectionId, actor) {
  const section = await tx.section.findUnique({ where: { id: sectionId }, include: { course: true, meetings: true } });
  const registered = await tx.registration.count({ where: { sectionId, status: 'REGISTERED' } });
  let open = section.capacity - registered;
  if (open <= 0) return [];
  const policies = await getPolicies(section.institutionId, tx);
  const waiting = await tx.registration.findMany({ where: { sectionId, status: 'WAITLISTED' }, orderBy: { waitlistPosition: 'asc' }, include: { student: true } });
  const promoted = [];
  for (const w of waiting) {
    if (open <= 0) break;
    const others = await tx.registration.findMany({ where: { studentId: w.studentId, status: 'REGISTERED', section: { termId: section.termId } }, include: { section: { include: { meetings: true } } } });
    const credits = others.reduce((s, r) => s + r.creditsAttempted, 0);
    if (credits + section.course.credits > policies['registration.maxCreditsPerTerm']) continue;
    if (others.some((o) => meetingsOverlap(o.section.meetings, section.meetings))) continue;
    await tx.registration.update({ where: { id: w.id }, data: { status: 'REGISTERED', waitlistPosition: null, statusChangedAt: new Date() } });
    await tx.registrationEvent.create({ data: { registrationId: w.id, action: 'WAITLIST_PROMOTE', fromStatus: 'WAITLISTED', toStatus: 'REGISTERED', actorType: 'SYSTEM', reason: 'Seat became available' } });
    await audit({ ...actor, type: 'SYSTEM', id: null, label: 'System (waitlist)' }, { action: 'registration.promoted', entityType: 'Registration', entityId: w.id, summary: `Promoted ${w.student.firstName} ${w.student.lastName} from waitlist into ${section.course.code}-${section.sectionNumber}` }, tx);
    await notifyStudent(w.studentId, { title: `Seat available: ${section.course.code}`, body: `You have been moved from the waitlist into ${section.course.title}.`, link: '/student/registration' }, tx);
    promoted.push(w.id);
    open -= 1;
  }
  await renumberWaitlist(tx, sectionId);
  return promoted;
}

export async function sectionSeatSummary(sectionIds, tx = prisma) {
  if (!sectionIds.length) return {};
  const rows = await tx.registration.groupBy({ by: ['sectionId', 'status'], where: { sectionId: { in: sectionIds }, status: { in: ACTIVE } }, _count: true });
  const out = {};
  for (const id of sectionIds) out[id] = { registered: 0, waitlisted: 0 };
  for (const r of rows) out[r.sectionId][r.status === 'REGISTERED' ? 'registered' : 'waitlisted'] = r._count;
  return out;
}
