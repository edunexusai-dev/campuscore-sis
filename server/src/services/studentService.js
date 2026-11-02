// Student record writes shared by the integration API. Business rules live here, not in the routes.
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { notFound, conflict, ruleViolation, AppError } from '../lib/errors.js';
import { refreshStudentStanding } from './academicService.js';
import { promoteFromWaitlist } from './registrationService.js';
import { createPerson, syncLogin } from './personService.js';

const INACTIVE = ['WITHDRAWN', 'GRADUATED'];
export const etagFor = (s) => `W/"${s.updatedAt.getTime()}"`;

export async function nextStudentNumber(institutionId, tx = prisma) {
  const year = new Date().getFullYear().toString().slice(2);
  const last = await tx.student.findFirst({ where: { institutionId, studentNumber: { startsWith: `S${year}` } }, orderBy: { studentNumber: 'desc' } });
  const seq = last ? Number(last.studentNumber.slice(3)) + 1 : 1;
  return `S${year}${String(seq).padStart(5, '0')}`;
}

async function assertProgram(tx, institutionId, programId) {
  const p = await tx.program.findFirst({ where: { id: programId, institutionId } });
  if (!p) throw ruleViolation('invalid_program', 'Program does not exist at this institution.');
  if (!p.active) throw ruleViolation('program_inactive', `Program ${p.code} is not accepting students.`);
  return p;
}
async function assertTerm(tx, institutionId, termId) {
  const t = await tx.term.findFirst({ where: { id: termId, institutionId } });
  if (!t) throw ruleViolation('invalid_term', 'Term does not exist at this institution.');
  return t;
}

export async function createStudent(actor, input) {
  return prisma.$transaction(async (tx) => {
    const program = await assertProgram(tx, actor.institutionId, input.programId);
    if (input.admitTermId) await assertTerm(tx, actor.institutionId, input.admitTermId);
    const dupEmail = await tx.student.findFirst({ where: { institutionId: actor.institutionId, email: { equals: input.email, mode: 'insensitive' } } });
    if (dupEmail) throw conflict('A student with this institutional email already exists.', 'duplicate_student', { existingId: dupEmail.id, studentNumber: dupEmail.studentNumber });
    let studentNumber = input.studentNumber;
    if (studentNumber) {
      if (await tx.student.findFirst({ where: { institutionId: actor.institutionId, studentNumber } })) throw conflict(`Student number ${studentNumber} is already assigned.`, 'duplicate_student_number');
    } else {
      studentNumber = await nextStudentNumber(actor.institutionId, tx);
    }
    const { dateOfBirth, ...rest } = input;
    const person = await createPerson(tx, actor.institutionId);
    const s = await tx.student.create({
      data: { ...rest, personId: person.id, studentNumber, dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null, institutionId: actor.institutionId, classLevel: program.level === 'GRADUATE' ? 'GRADUATE' : 'FRESHMAN' },
      include: { program: true, admitTerm: true, holds: true },
    });
    await audit(actor, { action: 'student.created', entityType: 'Student', entityId: s.id, summary: `Created student ${s.firstName} ${s.lastName} (${s.studentNumber}) in ${program.code} via API`, after: { studentNumber, email: s.email, programId: s.programId, status: s.status } }, tx);
    return s;
  });
}

export async function updateStudent(actor, id, changes, { ifMatch } = {}) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.student.findFirst({ where: { id, institutionId: actor.institutionId } });
    if (!before) throw notFound('Student');
    if (ifMatch && ifMatch !== etagFor(before)) throw new AppError(412, 'precondition_failed', 'The student record changed since you read it. Fetch it again and retry.', { currentEtag: etagFor(before) });
    if ('programId' in changes || 'admitTermId' in changes || 'expectedGraduation' in changes) {
      if (INACTIVE.includes(before.status)) throw ruleViolation('student_inactive', `Academic attributes cannot be changed for a ${before.status.toLowerCase()} student.`);
    }
    if (changes.programId) await assertProgram(tx, actor.institutionId, changes.programId);
    if (changes.programId === null) throw ruleViolation('program_required', 'A program cannot be removed through the API.');
    if (changes.admitTermId) await assertTerm(tx, actor.institutionId, changes.admitTermId);
    const data = { ...changes, ...(changes.dateOfBirth !== undefined ? { dateOfBirth: changes.dateOfBirth ? new Date(changes.dateOfBirth) : null } : {}) };
    const changed = Object.keys(changes).filter((k) => String(before[k] instanceof Date ? before[k].toISOString().slice(0, 10) : before[k] ?? '') !== String(changes[k] ?? ''));
    if (!changed.length) return { student: await tx.student.findUnique({ where: { id }, include: { program: true, admitTerm: true, holds: { where: { releasedAt: null } } } }), changed };
    await tx.student.update({ where: { id }, data });
    if (changes.programId && changes.programId !== before.programId) await refreshStudentStanding(id, tx);
    if (changed.includes('email')) await syncLogin(tx, before.personId);
    await audit(actor, { action: 'student.updated', entityType: 'Student', entityId: id, summary: `Updated ${before.studentNumber} via API: ${changed.join(', ')}`, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, changes[k]])) }, tx);
    const student = await tx.student.findUnique({ where: { id }, include: { program: true, admitTerm: true, holds: { where: { releasedAt: null } } } });
    return { student, changed };
  });
}

// Deactivation = lifecycle status WITHDRAWN. Nothing is deleted: registrations, grades, transcripts, holds and
// audit history stay. Registrations in terms that have not started are dropped only if explicitly requested;
// a student with registrations in a term in progress must be handled by the registrar (withdrawals affect the record).
export async function deactivateStudent(actor, id, { reason, dropFutureRegistrations = false }) {
  return prisma.$transaction(async (tx) => {
    const s = await tx.student.findFirst({ where: { id, institutionId: actor.institutionId } });
    if (!s) throw notFound('Student');
    if (s.status === 'WITHDRAWN') return { student: s, changed: false, droppedRegistrations: 0 };
    if (s.status === 'GRADUATED') throw ruleViolation('student_graduated', 'Graduated students cannot be deactivated; their record is already closed.');
    const now = new Date();
    const active = await tx.registration.findMany({ where: { studentId: id, status: { in: ['REGISTERED', 'WAITLISTED'] } }, include: { section: { include: { term: true, course: true } } } });
    const inProgress = active.filter((r) => r.section.term.startDate <= now && r.section.term.status !== 'COMPLETED' && r.status === 'REGISTERED');
    if (inProgress.length) throw ruleViolation('active_term_registrations', `The student is registered in ${inProgress.length} class(es) in a term in progress. The registrar must process withdrawals first.`, inProgress.map((r) => ({ registrationId: r.id, section: `${r.section.course.code}-${r.section.sectionNumber}`, term: r.section.term.code })));
    const future = active.filter((r) => !inProgress.includes(r));
    if (future.length && !dropFutureRegistrations) throw ruleViolation('future_registrations', `The student has ${future.length} registration(s) in upcoming terms. Resend with dropFutureRegistrations=true to drop them as part of deactivation.`, future.map((r) => ({ registrationId: r.id, section: `${r.section.course.code}-${r.section.sectionNumber}`, term: r.section.term.code })));
    for (const r of future) {
      await tx.registration.update({ where: { id: r.id }, data: { status: 'DROPPED', waitlistPosition: null, statusChangedAt: now } });
      await tx.registrationEvent.create({ data: { registrationId: r.id, action: 'DROP', fromStatus: r.status, toStatus: 'DROPPED', actorType: actor.type, actorId: actor.id, reason: `Student deactivated: ${reason}` } });
    }
    // Seats freed by dropped registrations go to the next eligible waitlisted students.
    for (const sectionId of new Set(future.filter((r) => r.status === 'REGISTERED').map((r) => r.sectionId))) await promoteFromWaitlist(tx, sectionId, actor);
    const updated = await tx.student.update({ where: { id }, data: { status: 'WITHDRAWN' } });
    // The login is disabled only if none of the person's other records (e.g. faculty) still uses it.
    await syncLogin(tx, s.personId, { access: true });
    await audit(actor, { action: 'student.deactivated', entityType: 'Student', entityId: id, summary: `Deactivated ${s.studentNumber} (${s.status} → WITHDRAWN)${future.length ? `; dropped ${future.length} upcoming registration(s)` : ''}: ${reason}`, before: { status: s.status }, after: { status: 'WITHDRAWN', reason, droppedRegistrations: future.map((r) => r.id) } }, tx);
    return { student: updated, changed: true, droppedRegistrations: future.length, affectedSections: future.map((r) => r.sectionId) };
  }, { timeout: 30_000 });
}
