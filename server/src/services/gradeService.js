// Grade workflow: DRAFT → SUBMITTED → APPROVED → PUBLISHED (RETURNED sends a submission back to faculty).
// Only PUBLISHED grades are official. Published grades change only through an approved GradeChangeRequest.
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { notFound, forbidden, ruleViolation, badRequest } from '../lib/errors.js';
import { getPolicies } from './policyService.js';
import { getGradeScale, refreshStudentStanding } from './academicService.js';
import { notifyStudent, notifyUser } from './notificationService.js';

const EDITABLE = ['DRAFT', 'RETURNED'];
const isStaff = (actor) => actor.type === 'USER' && ['ADMIN', 'REGISTRAR'].includes(actor.role);

export async function assertInstructor(sectionId, facultyId, institutionId, tx = prisma) {
  const link = await tx.sectionInstructor.findFirst({ where: { sectionId, facultyId, section: { institutionId } } });
  if (!link) throw forbidden('The acting faculty member is not assigned to this section.', 'not_section_instructor');
}

async function loadSection(sectionId, institutionId, tx = prisma) {
  const section = await tx.section.findFirst({ where: { id: sectionId, institutionId }, include: { term: true, course: true, instructors: { include: { faculty: true } } } });
  if (!section) throw notFound('Section');
  return section;
}

export async function getGradebook(sectionId, institutionId) {
  const section = await loadSection(sectionId, institutionId);
  const regs = await prisma.registration.findMany({
    where: { sectionId, status: { in: ['REGISTERED', 'COMPLETED', 'WITHDRAWN'] } },
    include: { student: true, grade: { include: { changeRequests: { where: { status: 'PENDING' } } } } },
    orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
  });
  const scale = await getGradeScale(institutionId);
  const counts = { DRAFT: 0, SUBMITTED: 0, APPROVED: 0, PUBLISHED: 0, RETURNED: 0, MISSING: 0 };
  const rows = regs.map((r) => {
    if (r.status !== 'WITHDRAWN') counts[r.grade?.status ?? 'MISSING'] += 1;
    return {
      registrationId: r.id,
      registrationStatus: r.status,
      student: { id: r.student.id, studentNumber: r.student.studentNumber, name: `${r.student.lastName}, ${r.student.preferredName || r.student.firstName}`, email: r.student.email },
      grade: r.grade ? { id: r.grade.id, letter: r.grade.letter, status: r.grade.status, comment: r.grade.comment, submittedAt: r.grade.submittedAt, publishedAt: r.grade.publishedAt, pendingChange: r.grade.changeRequests[0] ?? null } : null,
    };
  });
  return {
    section: { id: section.id, courseCode: section.course.code, courseTitle: section.course.title, sectionNumber: section.sectionNumber, term: section.term.name, termId: section.termId, gradesDueDate: section.term.gradesDueDate },
    letters: scale.entries.map((e) => ({ letter: e.letter, points: e.points, description: e.description })),
    counts,
    rows,
  };
}

// Save draft grades. `facultyId` is the acting instructor (portal user or integration on-behalf-of);
// staff may edit without one. Locked grades (submitted/approved/published) are rejected.
export async function saveDraftGrades(actor, { sectionId, facultyId, entries, submit = false }) {
  const section = await loadSection(sectionId, actor.institutionId);
  if (!isStaff(actor)) {
    if (!facultyId) throw forbidden('An acting instructor is required.', 'not_section_instructor');
    await assertInstructor(sectionId, facultyId, actor.institutionId);
  }
  const policies = await getPolicies(actor.institutionId);
  if (!policies['grades.facultyCanEnterGradesBeforeTermEnd'] && new Date() < section.term.endDate && !isStaff(actor)) {
    throw ruleViolation('grading_not_open', `Grade entry opens at the end of ${section.term.name}.`);
  }
  const scale = await getGradeScale(actor.institutionId);
  const errors = [];
  for (const e of entries) if (!scale.byLetter[e.letter]) errors.push({ field: e.studentId ?? e.registrationId, message: `"${e.letter}" is not a valid grade. Allowed: ${scale.entries.map((x) => x.letter).join(', ')}` });
  if (errors.length) throw badRequest('Invalid grade letters.', errors);

  await prisma.$transaction(async (tx) => {
    for (const e of entries) {
      const reg = await tx.registration.findFirst({
        where: { sectionId, status: 'REGISTERED', ...(e.registrationId ? { id: e.registrationId } : { studentId: e.studentId }) },
        include: { grade: true, student: true },
      });
      if (!reg) throw ruleViolation('student_not_on_roster', `Student ${e.studentId ?? e.registrationId} is not actively registered in this section.`);
      if (reg.grade && !EDITABLE.includes(reg.grade.status)) {
        throw ruleViolation('grade_locked', `The grade for ${reg.student.firstName} ${reg.student.lastName} is ${reg.grade.status.toLowerCase()} and can no longer be edited${reg.grade.status === 'PUBLISHED' ? '; submit a grade change request instead' : ''}.`);
      }
      if (reg.grade && reg.grade.letter === e.letter && reg.grade.comment === (e.comment ?? reg.grade.comment)) continue;
      const grade = reg.grade
        ? await tx.grade.update({ where: { id: reg.grade.id }, data: { letter: e.letter, comment: e.comment ?? reg.grade.comment, status: 'DRAFT', enteredByType: actor.type, enteredById: actor.id } })
        : await tx.grade.create({ data: { registrationId: reg.id, letter: e.letter, comment: e.comment, status: 'DRAFT', enteredByType: actor.type, enteredById: actor.id } });
      await tx.gradeHistory.create({ data: { gradeId: grade.id, fromLetter: reg.grade?.letter ?? null, toLetter: e.letter, fromStatus: reg.grade?.status ?? null, toStatus: 'DRAFT', actorType: actor.type, actorId: actor.id } });
      await audit(actor, { action: 'grade.draft_saved', entityType: 'Grade', entityId: grade.id, summary: `Draft grade ${reg.grade?.letter ? `${reg.grade.letter} → ` : ''}${e.letter} for ${reg.student.studentNumber} in ${section.course.code}-${section.sectionNumber}`, before: reg.grade ? { letter: reg.grade.letter, status: reg.grade.status } : null, after: { letter: e.letter, status: 'DRAFT' } }, tx);
    }
  });
  if (submit) return submitGrades(actor, { sectionId, facultyId, requireComplete: false });
  return getGradebook(sectionId, actor.institutionId);
}

// Submit all editable grades for a section. Faculty submissions must cover the whole active roster.
export async function submitGrades(actor, { sectionId, facultyId, requireComplete = true }) {
  const section = await loadSection(sectionId, actor.institutionId);
  if (!isStaff(actor)) await assertInstructor(sectionId, facultyId, actor.institutionId);
  const policies = await getPolicies(actor.institutionId);
  const regs = await prisma.registration.findMany({ where: { sectionId, status: 'REGISTERED' }, include: { grade: true, student: true } });
  const missing = regs.filter((r) => !r.grade);
  if (requireComplete && missing.length) {
    throw ruleViolation('grades_incomplete', `${missing.length} student(s) do not have a grade yet.`, missing.map((r) => ({ studentId: r.studentId, studentNumber: r.student.studentNumber })));
  }
  const toSubmit = regs.filter((r) => r.grade && EDITABLE.includes(r.grade.status));
  if (!toSubmit.length) throw ruleViolation('nothing_to_submit', 'There are no draft grades to submit.');

  const autoApprove = !policies['grades.requireApproval'];
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const r of toSubmit) {
      await tx.grade.update({ where: { id: r.grade.id }, data: { status: autoApprove ? 'APPROVED' : 'SUBMITTED', submittedAt: now, ...(autoApprove ? { approvedAt: now } : {}) } });
      await tx.gradeHistory.create({ data: { gradeId: r.grade.id, fromLetter: r.grade.letter, toLetter: r.grade.letter, fromStatus: r.grade.status, toStatus: 'SUBMITTED', actorType: actor.type, actorId: actor.id } });
    }
    await audit(actor, { action: 'grade.submitted', entityType: 'Section', entityId: sectionId, summary: `Submitted ${toSubmit.length} grade(s) for ${section.course.code}-${section.sectionNumber} (${section.term.code})${autoApprove ? ' — auto-approved by policy' : ''}` }, tx);
  });
  if (autoApprove && policies['grades.autoPublishOnApproval']) await publishGrades({ ...actor, type: 'SYSTEM', label: 'System (auto-publish policy)' }, { sectionId });
  return getGradebook(sectionId, actor.institutionId);
}

export async function approveGrades(actor, { sectionId }) {
  if (!isStaff(actor)) throw forbidden('Only registrar staff can approve grades.');
  const section = await loadSection(sectionId, actor.institutionId);
  const policies = await getPolicies(actor.institutionId);
  const grades = await prisma.grade.findMany({ where: { status: 'SUBMITTED', registration: { sectionId } } });
  if (!grades.length) throw ruleViolation('nothing_to_approve', 'There are no submitted grades awaiting approval.');
  await prisma.$transaction(async (tx) => {
    await tx.grade.updateMany({ where: { id: { in: grades.map((g) => g.id) } }, data: { status: 'APPROVED', approvedAt: new Date(), approvedById: actor.id } });
    await tx.gradeHistory.createMany({ data: grades.map((g) => ({ gradeId: g.id, fromLetter: g.letter, toLetter: g.letter, fromStatus: 'SUBMITTED', toStatus: 'APPROVED', actorType: actor.type, actorId: actor.id })) });
    await audit(actor, { action: 'grade.approved', entityType: 'Section', entityId: sectionId, summary: `Approved ${grades.length} grade(s) for ${section.course.code}-${section.sectionNumber}` }, tx);
  });
  if (policies['grades.autoPublishOnApproval']) await publishGrades(actor, { sectionId });
  return getGradebook(sectionId, actor.institutionId);
}

export async function returnGrades(actor, { sectionId, reason }) {
  if (!isStaff(actor)) throw forbidden('Only registrar staff can return grades.');
  const section = await loadSection(sectionId, actor.institutionId);
  const grades = await prisma.grade.findMany({ where: { status: { in: ['SUBMITTED', 'APPROVED'] }, registration: { sectionId } } });
  if (!grades.length) throw ruleViolation('nothing_to_return', 'There are no submitted or approved grades to return.');
  await prisma.$transaction(async (tx) => {
    await tx.grade.updateMany({ where: { id: { in: grades.map((g) => g.id) } }, data: { status: 'RETURNED', approvedAt: null, approvedById: null } });
    await tx.gradeHistory.createMany({ data: grades.map((g) => ({ gradeId: g.id, fromLetter: g.letter, toLetter: g.letter, fromStatus: g.status, toStatus: 'RETURNED', actorType: actor.type, actorId: actor.id, reason })) });
    await audit(actor, { action: 'grade.returned', entityType: 'Section', entityId: sectionId, summary: `Returned ${grades.length} grade(s) for ${section.course.code}-${section.sectionNumber} to faculty: ${reason}` }, tx);
    for (const i of section.instructors) {
      await notifyUser(i.faculty.userId, { title: `Grades returned: ${section.course.code}-${section.sectionNumber}`, body: reason, link: `/faculty/sections/${sectionId}/grades` }, tx);
    }
  });
  return getGradebook(sectionId, actor.institutionId);
}

export async function publishGrades(actor, { sectionId }) {
  if (actor.type === 'USER' && !isStaff(actor)) throw forbidden('Only registrar staff can publish grades.');
  const section = await loadSection(sectionId, actor.institutionId);
  const grades = await prisma.grade.findMany({ where: { status: 'APPROVED', registration: { sectionId } }, include: { registration: true } });
  if (!grades.length) throw ruleViolation('nothing_to_publish', 'There are no approved grades to publish.');
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.grade.updateMany({ where: { id: { in: grades.map((g) => g.id) } }, data: { status: 'PUBLISHED', publishedAt: now } });
    await tx.gradeHistory.createMany({ data: grades.map((g) => ({ gradeId: g.id, fromLetter: g.letter, toLetter: g.letter, fromStatus: 'APPROVED', toStatus: 'PUBLISHED', actorType: actor.type, actorId: actor.id })) });
    await tx.registration.updateMany({ where: { id: { in: grades.map((g) => g.registrationId) } }, data: { status: 'COMPLETED', statusChangedAt: now } });
    await audit(actor, { action: 'grade.published', entityType: 'Section', entityId: sectionId, summary: `Published ${grades.length} grade(s) for ${section.course.code}-${section.sectionNumber} (${section.term.code})` }, tx);
    for (const g of grades) {
      await refreshStudentStanding(g.registration.studentId, tx);
      await notifyStudent(g.registration.studentId, { title: `Final grade posted: ${section.course.code}`, body: `Your final grade for ${section.course.title} is now available.`, link: '/student/grades' }, tx);
    }
  }, { timeout: 30000 });
  return getGradebook(sectionId, actor.institutionId);
}

export async function requestGradeChange(actor, { gradeId, toLetter, reason, facultyId }) {
  const grade = await prisma.grade.findFirst({ where: { id: gradeId, registration: { institutionId: actor.institutionId } }, include: { registration: { include: { section: { include: { course: true } }, student: true } }, changeRequests: { where: { status: 'PENDING' } } } });
  if (!grade) throw notFound('Grade');
  const policies = await getPolicies(actor.institutionId);
  if (!isStaff(actor)) {
    if (!policies['grades.allowFacultyChangeRequests']) throw ruleViolation('policy_disabled', 'Grade change requests are disabled by institutional policy.');
    await assertInstructor(grade.registration.sectionId, facultyId, actor.institutionId);
  }
  if (grade.status !== 'PUBLISHED') throw ruleViolation('grade_not_published', 'Only published grades require a change request. Edit draft grades directly.');
  if (grade.changeRequests.length) throw ruleViolation('change_pending', 'A change request for this grade is already pending.');
  const scale = await getGradeScale(actor.institutionId);
  if (!scale.byLetter[toLetter]) throw badRequest(`"${toLetter}" is not a valid grade.`);
  if (toLetter === grade.letter) throw badRequest('The new grade must differ from the current grade.');
  const req = await prisma.gradeChangeRequest.create({ data: { gradeId, fromLetter: grade.letter, toLetter, reason, requestedByType: actor.type, requestedById: actor.id } });
  await audit(actor, { action: 'grade_change.requested', entityType: 'GradeChangeRequest', entityId: req.id, summary: `Requested grade change ${grade.letter} → ${toLetter} for ${grade.registration.student.studentNumber} in ${grade.registration.section.course.code}: ${reason}` });
  return req;
}

export async function reviewGradeChange(actor, { requestId, approve, note }) {
  if (!isStaff(actor)) throw forbidden('Only registrar staff can review grade changes.');
  const req = await prisma.gradeChangeRequest.findFirst({ where: { id: requestId, grade: { registration: { institutionId: actor.institutionId } } }, include: { grade: { include: { registration: { include: { student: true, section: { include: { course: true } } } } } } } });
  if (!req) throw notFound('Grade change request');
  if (req.status !== 'PENDING') throw ruleViolation('already_reviewed', `This request was already ${req.status.toLowerCase()}.`);
  if (approve && req.requestedByType === 'USER' && req.requestedById === actor.id && actor.role !== 'ADMIN') {
    throw forbidden('A registrar cannot approve their own grade change request.', 'separation_of_duties');
  }
  const { grade } = req;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.gradeChangeRequest.update({ where: { id: requestId }, data: { status: approve ? 'APPROVED' : 'REJECTED', reviewedById: actor.id, reviewedAt: new Date(), reviewNote: note } });
    if (approve) {
      await tx.grade.update({ where: { id: grade.id }, data: { letter: req.toLetter } });
      await tx.gradeHistory.create({ data: { gradeId: grade.id, fromLetter: grade.letter, toLetter: req.toLetter, fromStatus: 'PUBLISHED', toStatus: 'PUBLISHED', actorType: actor.type, actorId: actor.id, reason: `Change request approved: ${req.reason}` } });
      await refreshStudentStanding(grade.registration.studentId, tx);
      await notifyStudent(grade.registration.studentId, { title: `Grade updated: ${grade.registration.section.course.code}`, body: 'A correction to your final grade has been posted.', link: '/student/grades' }, tx);
    }
    await audit(actor, { action: approve ? 'grade_change.approved' : 'grade_change.rejected', entityType: 'Grade', entityId: grade.id, summary: `${approve ? 'Approved' : 'Rejected'} grade change ${req.fromLetter} → ${req.toLetter} for ${grade.registration.student.studentNumber} in ${grade.registration.section.course.code}`, before: { letter: grade.letter }, after: { letter: approve ? req.toLetter : grade.letter, note } }, tx);
    return updated;
  });
}
