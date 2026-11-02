import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { parse, id, isoDate, hhmm, paginationQuery, sortQuery, paged } from '../../../lib/validate.js';
import { notFound, ruleViolation, badRequest } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requirePermission } from '../../../lib/permissions.js';
import { findCourses, findSections, getSection } from '../../../services/queryService.js';
import { registerStudent, dropRegistration, evaluateRegistration, promoteFromWaitlist } from '../../../services/registrationService.js';
import { sectionDto, termDto, courseDto, programDto } from '../../v1/dto.js';

const router = Router();
const inst = (req) => req.user.institutionId;
const manage = requirePermission('academics.manage');
const dateTime = z.string().datetime({ offset: true }).or(isoDate).transform((v) => new Date(v));

// ── Terms ──
router.get('/terms', manage, async (req, res) => {
  const terms = await prisma.term.findMany({ where: { institutionId: inst(req) }, include: { academicYear: true, _count: { select: { sections: true } } }, orderBy: { startDate: 'desc' } });
  const years = await prisma.academicYear.findMany({ where: { institutionId: inst(req) }, orderBy: { startDate: 'desc' } });
  res.json({ data: terms.map((t) => ({ ...termDto(t), academicYearId: t.academicYearId, sectionCount: t._count.sections })), academicYears: years });
});

const termBody = z.object({
  academicYearId: id, code: z.string().trim().min(2).max(20), name: z.string().trim().min(2).max(80),
  startDate: isoDate, endDate: isoDate, registrationOpens: dateTime, registrationCloses: dateTime,
  addDropDeadline: dateTime, withdrawDeadline: dateTime, gradesDueDate: dateTime,
  status: z.enum(['PLANNED', 'REGISTRATION_OPEN', 'IN_PROGRESS', 'COMPLETED']).optional(),
});

function checkTermDates(t) {
  const errs = [];
  if (new Date(t.endDate) <= new Date(t.startDate)) errs.push({ field: 'endDate', message: 'End date must be after start date' });
  if (t.registrationCloses <= t.registrationOpens) errs.push({ field: 'registrationCloses', message: 'Registration must close after it opens' });
  if (t.withdrawDeadline < t.addDropDeadline) errs.push({ field: 'withdrawDeadline', message: 'Withdrawal deadline must be on or after the add/drop deadline' });
  if (errs.length) throw badRequest('Invalid term dates.', errs);
}

router.post('/terms', manage, async (req, res) => {
  const body = parse(termBody.strict(), req.body);
  checkTermDates(body);
  if (!(await prisma.academicYear.findFirst({ where: { id: body.academicYearId, institutionId: inst(req) } }))) throw notFound('Academic year');
  const t = await prisma.term.create({ data: { ...body, startDate: new Date(body.startDate), endDate: new Date(body.endDate), institutionId: inst(req) } });
  await audit(req.actor, { action: 'term.created', entityType: 'Term', entityId: t.id, summary: `Created term ${t.code} (${t.name})` });
  res.status(201).json({ data: termDto(t) });
});

router.patch('/terms/:id', manage, async (req, res) => {
  const body = parse(termBody.partial().strict(), req.body);
  const before = await prisma.term.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!before) throw notFound('Term');
  const merged = { ...before, ...body, startDate: body.startDate ?? before.startDate, endDate: body.endDate ?? before.endDate };
  checkTermDates(merged);
  const data = { ...body, ...(body.startDate ? { startDate: new Date(body.startDate) } : {}), ...(body.endDate ? { endDate: new Date(body.endDate) } : {}) };
  const t = await prisma.term.update({ where: { id: before.id }, data });
  await audit(req.actor, { action: 'term.updated', entityType: 'Term', entityId: t.id, summary: `Updated term ${t.code}: ${Object.keys(body).join(', ')}`, after: body });
  res.json({ data: termDto(t) });
});

router.post('/terms/:id/set-current', manage, async (req, res) => {
  const t = await prisma.term.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!t) throw notFound('Term');
  await prisma.$transaction([
    prisma.term.updateMany({ where: { institutionId: inst(req) }, data: { isCurrent: false } }),
    prisma.term.update({ where: { id: t.id }, data: { isCurrent: true } }),
  ]);
  await audit(req.actor, { action: 'term.set_current', entityType: 'Term', entityId: t.id, summary: `Set ${t.code} as the current term` });
  res.json({ ok: true });
});

router.post('/academic-years', manage, async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(4).max(20), startDate: isoDate, endDate: isoDate }).strict(), req.body);
  const y = await prisma.academicYear.create({ data: { name: body.name, startDate: new Date(body.startDate), endDate: new Date(body.endDate), institutionId: inst(req) } });
  await audit(req.actor, { action: 'academic_year.created', entityType: 'AcademicYear', entityId: y.id, summary: `Created academic year ${y.name}` });
  res.status(201).json({ data: y });
});

// ── Colleges, departments, programs ──
router.get('/structure', manage, async (req, res) => {
  const colleges = await prisma.college.findMany({
    where: { institutionId: inst(req) },
    include: { departments: { include: { programs: { include: { _count: { select: { students: true, requirements: true } } } }, _count: { select: { courses: true, faculty: true } } }, orderBy: { code: 'asc' } } },
    orderBy: { code: 'asc' },
  });
  res.json({ data: colleges });
});

router.post('/colleges', manage, async (req, res) => {
  const body = parse(z.object({ code: z.string().trim().min(2).max(10).toUpperCase(), name: z.string().trim().min(3).max(120) }).strict(), req.body);
  const c = await prisma.college.create({ data: { ...body, institutionId: inst(req) } });
  await audit(req.actor, { action: 'college.created', entityType: 'College', entityId: c.id, summary: `Created college ${c.name}` });
  res.status(201).json({ data: c });
});

const deptBody = z.object({ collegeId: id, code: z.string().trim().min(2).max(10).toUpperCase(), name: z.string().trim().min(3).max(120), officeLocation: z.string().trim().max(80).nullable().optional(), email: z.string().trim().email().nullable().optional() });
router.post('/departments', manage, async (req, res) => {
  const body = parse(deptBody.strict(), req.body);
  if (!(await prisma.college.findFirst({ where: { id: body.collegeId, institutionId: inst(req) } }))) throw notFound('College');
  const d = await prisma.department.create({ data: { ...body, institutionId: inst(req) } });
  await audit(req.actor, { action: 'department.created', entityType: 'Department', entityId: d.id, summary: `Created department ${d.code} ${d.name}` });
  res.status(201).json({ data: d });
});
router.patch('/departments/:id', manage, async (req, res) => {
  const body = parse(deptBody.partial().strict(), req.body);
  const d = await prisma.department.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!d) throw notFound('Department');
  await prisma.department.update({ where: { id: d.id }, data: body });
  await audit(req.actor, { action: 'department.updated', entityType: 'Department', entityId: d.id, summary: `Updated department ${d.code}`, after: body });
  res.json({ ok: true });
});

const programBody = z.object({ departmentId: id, code: z.string().trim().min(2).max(20).toUpperCase(), name: z.string().trim().min(3).max(120), degreeType: z.string().trim().min(2).max(10), level: z.enum(['UNDERGRADUATE', 'GRADUATE']), requiredCredits: z.number().int().min(1).max(300), minGpa: z.number().min(0).max(4).default(2), description: z.string().max(2000).nullable().optional(), active: z.boolean().optional() });

router.get('/programs/:id', manage, async (req, res) => {
  const p = await prisma.program.findFirst({ where: { id: req.params.id, institutionId: inst(req) }, include: { department: true, requirements: { include: { course: true }, orderBy: { course: { code: 'asc' } } }, _count: { select: { students: true } } } });
  if (!p) throw notFound('Program');
  res.json({ data: { ...programDto(p), minGpa: Number(p.minGpa), studentCount: p._count.students, requirements: p.requirements.map((r) => ({ id: r.id, category: r.category, course: { id: r.course.id, code: r.course.code, title: r.course.title, credits: r.course.credits } })) } });
});
router.post('/programs', manage, async (req, res) => {
  const body = parse(programBody.strict(), req.body);
  if (!(await prisma.department.findFirst({ where: { id: body.departmentId, institutionId: inst(req) } }))) throw notFound('Department');
  const p = await prisma.program.create({ data: { ...body, institutionId: inst(req) } });
  await audit(req.actor, { action: 'program.created', entityType: 'Program', entityId: p.id, summary: `Created program ${p.code} ${p.name}` });
  res.status(201).json({ data: programDto(p) });
});
router.patch('/programs/:id', manage, async (req, res) => {
  const body = parse(programBody.partial().strict(), req.body);
  const p = await prisma.program.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!p) throw notFound('Program');
  await prisma.program.update({ where: { id: p.id }, data: body });
  await audit(req.actor, { action: 'program.updated', entityType: 'Program', entityId: p.id, summary: `Updated program ${p.code}`, after: body });
  res.json({ ok: true });
});
router.put('/programs/:id/requirements', manage, async (req, res) => {
  const body = parse(z.object({ requirements: z.array(z.object({ courseId: id, category: z.enum(['CORE', 'MAJOR', 'ELECTIVE', 'GENERAL_EDUCATION']) })).max(100) }).strict(), req.body);
  const p = await prisma.program.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!p) throw notFound('Program');
  const ids = [...new Set(body.requirements.map((r) => r.courseId))];
  if ((await prisma.course.count({ where: { id: { in: ids }, institutionId: inst(req) } })) !== ids.length) throw notFound('Course');
  await prisma.$transaction([
    prisma.programRequirement.deleteMany({ where: { programId: p.id } }),
    prisma.programRequirement.createMany({ data: body.requirements.map((r) => ({ programId: p.id, ...r })) }),
  ]);
  await audit(req.actor, { action: 'program.requirements_updated', entityType: 'Program', entityId: p.id, summary: `Set ${body.requirements.length} degree requirement(s) for ${p.code}` });
  res.json({ ok: true });
});

// ── Courses ──
router.get('/courses', manage, async (req, res) => {
  const q = parse(paginationQuery.extend({ search: z.string().max(100).optional(), departmentId: id.optional(), sort: sortQuery(['code', 'title', 'credits', 'level'], 'code') }), req.query);
  const { rows, total } = await findCourses(inst(req), q);
  res.json(paged(rows.map(courseDto), total, q));
});

const courseBody = z.object({ departmentId: id, code: z.string().trim().min(3).max(15).toUpperCase().regex(/^[A-Z]{2,5} \d{3,4}[A-Z]?$/, 'Use the format "DEPT 101"'), title: z.string().trim().min(3).max(150), description: z.string().max(3000).nullable().optional(), credits: z.number().int().min(0).max(12), level: z.number().int().min(100).max(900), active: z.boolean().optional() });

router.get('/courses/:id', manage, async (req, res) => {
  const c = await prisma.course.findFirst({ where: { id: req.params.id, institutionId: inst(req) }, include: { department: true, prerequisites: { include: { prerequisite: true } }, prerequisiteOf: { include: { course: true } } } });
  if (!c) throw notFound('Course');
  const { rows } = await findSections(inst(req), { courseId: c.id, sort: 'term' });
  res.json({ data: { ...courseDto(c), requiredBy: c.prerequisiteOf.map((p) => ({ id: p.course.id, code: p.course.code })), sections: rows.map(sectionDto) } });
});
router.post('/courses', manage, async (req, res) => {
  const body = parse(courseBody.strict(), req.body);
  if (!(await prisma.department.findFirst({ where: { id: body.departmentId, institutionId: inst(req) } }))) throw notFound('Department');
  const c = await prisma.course.create({ data: { ...body, institutionId: inst(req) } });
  await audit(req.actor, { action: 'course.created', entityType: 'Course', entityId: c.id, summary: `Created course ${c.code} ${c.title}` });
  res.status(201).json({ data: courseDto(c) });
});
router.patch('/courses/:id', manage, async (req, res) => {
  const body = parse(courseBody.partial().strict(), req.body);
  const c = await prisma.course.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!c) throw notFound('Course');
  // Credits are copied onto registrations at registration time, so changing them never rewrites history.
  await prisma.course.update({ where: { id: c.id }, data: body });
  await audit(req.actor, { action: 'course.updated', entityType: 'Course', entityId: c.id, summary: `Updated course ${c.code}: ${Object.keys(body).join(', ')}`, before: Object.fromEntries(Object.keys(body).map((k) => [k, c[k]])), after: body });
  res.json({ ok: true });
});
router.put('/courses/:id/prerequisites', manage, async (req, res) => {
  const body = parse(z.object({ prerequisites: z.array(z.object({ courseId: id, minGrade: z.string().trim().min(1).max(3).default('D') })).max(10) }).strict(), req.body);
  const c = await prisma.course.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!c) throw notFound('Course');
  if (body.prerequisites.some((p) => p.courseId === c.id)) throw badRequest('A course cannot be its own prerequisite.');
  const ids = body.prerequisites.map((p) => p.courseId);
  if ((await prisma.course.count({ where: { id: { in: ids }, institutionId: inst(req) } })) !== new Set(ids).size) throw notFound('Prerequisite course');
  // Reject direct cycles (A requires B while B requires A).
  const cyc = await prisma.coursePrerequisite.findFirst({ where: { courseId: { in: ids }, prerequisiteId: c.id }, include: { course: true } });
  if (cyc) throw ruleViolation('prerequisite_cycle', `${cyc.course.code} already requires ${c.code}; this would create a cycle.`);
  await prisma.$transaction([
    prisma.coursePrerequisite.deleteMany({ where: { courseId: c.id } }),
    prisma.coursePrerequisite.createMany({ data: body.prerequisites.map((p) => ({ courseId: c.id, prerequisiteId: p.courseId, minGrade: p.minGrade })) }),
  ]);
  await audit(req.actor, { action: 'course.prerequisites_updated', entityType: 'Course', entityId: c.id, summary: `Set ${ids.length} prerequisite(s) for ${c.code}` });
  res.json({ ok: true });
});

// ── Sections ──
router.get('/sections', manage, async (req, res) => {
  const q = parse(paginationQuery.extend({ termId: id.optional(), courseId: id.optional(), departmentId: id.optional(), search: z.string().max(100).optional(), status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).optional(), scheduled: z.enum(['true', 'false']).optional() }), req.query);
  const { rows, total } = await findSections(inst(req), q);
  res.json(paged(rows.map(sectionDto), total, q));
});

router.get('/sections/:id', manage, async (req, res) => {
  const s = await getSection(inst(req), req.params.id);
  const regs = await prisma.registration.findMany({ where: { sectionId: s.id }, include: { student: true, grade: { select: { letter: true, status: true } } }, orderBy: [{ status: 'asc' }, { waitlistPosition: 'asc' }, { student: { lastName: 'asc' } }] });
  res.json({ data: { ...sectionDto(s), term: termDto(s.term), course: { ...sectionDto(s).course, description: s.course.description, prerequisites: s.course.prerequisites.map((p) => ({ code: p.prerequisite.code, minGrade: p.minGrade })) }, registrations: regs.map((r) => ({ id: r.id, status: r.status, waitlistPosition: r.waitlistPosition, source: r.source, registeredAt: r.registeredAt, grade: r.grade, student: { id: r.student.id, studentNumber: r.student.studentNumber, name: `${r.student.lastName}, ${r.student.firstName}`, status: r.student.status } })) } });
});

const meetingSchema = z.object({ dayOfWeek: z.number().int().min(1).max(7), startTime: hhmm, endTime: hhmm, room: z.string().trim().max(60).nullable().optional() }).refine((m) => m.startTime < m.endTime, { message: 'Meeting must end after it starts' });
const sectionBody = z.object({
  termId: id, courseId: id, sectionNumber: z.string().trim().min(1).max(5),
  capacity: z.number().int().min(1).max(1000), waitlistCapacity: z.number().int().min(0).max(200).default(0),
  location: z.string().trim().max(80).nullable().optional(), deliveryMode: z.enum(['IN_PERSON', 'ONLINE', 'HYBRID']).default('IN_PERSON'),
  status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).optional(),
  meetings: z.array(meetingSchema).max(7).default([]),
  instructorIds: z.array(id).max(5).default([]),
});

async function assertSectionRefs(institutionId, { termId, courseId, instructorIds }) {
  if (termId && !(await prisma.term.findFirst({ where: { id: termId, institutionId } }))) throw notFound('Term');
  if (courseId && !(await prisma.course.findFirst({ where: { id: courseId, institutionId } }))) throw notFound('Course');
  if (instructorIds?.length && (await prisma.faculty.count({ where: { id: { in: instructorIds }, institutionId } })) !== new Set(instructorIds).size) throw notFound('Instructor');
}

router.post('/sections', manage, async (req, res) => {
  const body = parse(sectionBody.strict(), req.body);
  await assertSectionRefs(inst(req), body);
  const { meetings, instructorIds, ...data } = body;
  const s = await prisma.$transaction(async (tx) => {
    const created = await tx.section.create({ data: { ...data, institutionId: inst(req), meetings: { create: meetings }, instructors: { create: instructorIds.map((fid, i) => ({ facultyId: fid, isPrimary: i === 0 })) } }, include: { course: true, term: true } });
    await audit(req.actor, { action: 'section.created', entityType: 'Section', entityId: created.id, summary: `Created section ${created.course.code}-${created.sectionNumber} for ${created.term.code}` }, tx);
    return created;
  });
  res.status(201).json({ data: { id: s.id } });
});

router.patch('/sections/:id', manage, async (req, res) => {
  const body = parse(sectionBody.omit({ termId: true, courseId: true }).partial().strict(), req.body);
  const before = await getSection(inst(req), req.params.id);
  await assertSectionRefs(inst(req), body);
  if (body.capacity !== undefined && body.capacity < before.seats.registered) throw ruleViolation('capacity_below_enrollment', `Capacity cannot be lower than current enrollment (${before.seats.registered}).`);
  if (body.status === 'CANCELLED' && before.seats.registered + before.seats.waitlisted > 0) throw ruleViolation('section_has_students', 'Drop or move all registered and waitlisted students before cancelling this section.');
  const { meetings, instructorIds, ...data } = body;
  await prisma.$transaction(async (tx) => {
    await tx.section.update({ where: { id: before.id }, data });
    if (meetings) { await tx.meetingTime.deleteMany({ where: { sectionId: before.id } }); await tx.meetingTime.createMany({ data: meetings.map((m) => ({ ...m, sectionId: before.id })) }); }
    if (instructorIds) { await tx.sectionInstructor.deleteMany({ where: { sectionId: before.id } }); await tx.sectionInstructor.createMany({ data: instructorIds.map((fid, i) => ({ sectionId: before.id, facultyId: fid, isPrimary: i === 0 })) }); }
    // A capacity increase opens seats: promote from the waitlist under normal rules.
    if (body.capacity > before.capacity) await promoteFromWaitlist(tx, before.id, req.actor);
    await audit(req.actor, { action: 'section.updated', entityType: 'Section', entityId: before.id, summary: `Updated section ${before.course.code}-${before.sectionNumber}: ${Object.keys(body).join(', ')}`, before: { capacity: before.capacity, status: before.status }, after: body }, tx);
  });
  res.json({ ok: true });
});

// ── Registrations (staff) ──
router.get('/registrations', requirePermission('registrations.manage'), async (req, res) => {
  const q = parse(paginationQuery.extend({ termId: id.optional(), status: z.enum(['REGISTERED', 'WAITLISTED', 'DROPPED', 'WITHDRAWN', 'COMPLETED']).optional(), source: z.enum(['STUDENT_PORTAL', 'ADMIN', 'API', 'SYSTEM']).optional(), search: z.string().max(100).optional() }), req.query);
  const where = { institutionId: inst(req), ...(q.status ? { status: q.status } : {}), ...(q.source ? { source: q.source } : {}), ...(q.termId ? { section: { termId: q.termId } } : {}), ...(q.search ? { OR: [{ student: { lastName: { contains: q.search, mode: 'insensitive' } } }, { student: { studentNumber: { contains: q.search, mode: 'insensitive' } } }, { section: { course: { code: { contains: q.search, mode: 'insensitive' } } } }] } : {}) };
  const [rows, total] = await Promise.all([
    prisma.registration.findMany({ where, include: { student: true, section: { include: { course: true, term: true } } }, orderBy: { statusChangedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.registration.count({ where }),
  ]);
  res.json(paged(rows.map((r) => ({ id: r.id, status: r.status, waitlistPosition: r.waitlistPosition, source: r.source, registeredAt: r.registeredAt, statusChangedAt: r.statusChangedAt, credits: r.creditsAttempted, student: { id: r.student.id, studentNumber: r.student.studentNumber, name: `${r.student.lastName}, ${r.student.firstName}` }, section: { id: r.section.id, label: `${r.section.course.code}-${r.section.sectionNumber}`, title: r.section.course.title, term: r.section.term.code } })), total, q));
});

router.get('/registrations/check', requirePermission('registrations.manage'), async (req, res) => {
  const q = parse(z.object({ studentId: id, sectionId: id }), req.query);
  const ev = await evaluateRegistration({ institutionId: inst(req), ...q });
  res.json({ data: { outcome: ev.outcome, violations: ev.violations } });
});

router.post('/registrations', requirePermission('registrations.manage'), async (req, res) => {
  const body = parse(z.object({ studentId: id, sectionId: id, override: z.boolean().default(false), reason: z.string().trim().max(500).optional() }).strict().refine((b) => !b.override || (b.reason && b.reason.length >= 5), { message: 'A reason (5+ characters) is required when overriding rules', path: ['reason'] }), req.body);
  const reg = await registerStudent(req.actor, { ...body, source: 'ADMIN' });
  res.status(201).json({ data: { id: reg.id, status: reg.status, waitlistPosition: reg.waitlistPosition } });
});

router.post('/registrations/:id/drop', requirePermission('registrations.manage'), async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().min(3).max(500) }).strict(), req.body);
  const reg = await dropRegistration(req.actor, { registrationId: req.params.id, reason: body.reason });
  res.json({ data: { id: reg.id, status: reg.status } });
});

router.get('/registrations/:id/history', requirePermission('registrations.manage'), async (req, res) => {
  const r = await prisma.registration.findFirst({ where: { id: req.params.id, institutionId: inst(req) }, include: { events: { orderBy: { createdAt: 'asc' } } } });
  if (!r) throw notFound('Registration');
  res.json({ data: r.events });
});

export default router;
