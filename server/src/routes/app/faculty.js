// Faculty portal. Every section-level endpoint verifies the signed-in instructor is assigned to the section.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse, id, isoDate } from '../../lib/validate.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requireRole } from '../../middleware/session.js';
import { findSections, currentTerm, sectionInclude } from '../../services/queryService.js';
import { getGradebook, saveDraftGrades, submitGrades, requestGradeChange } from '../../services/gradeService.js';
import { getSectionAttendance, recordAttendance } from '../../services/attendanceService.js';
import { sectionDto } from '../v1/dto.js';

const router = Router();
router.use(requireRole('FACULTY'), (req, _res, next) => {
  if (!req.user.faculty) return next(forbidden('No faculty record is linked to this account.'));
  req.facultyId = req.user.faculty.id;
  next();
});

// Resource-level guard: 404 (not 403) for sections the instructor doesn't teach, to avoid confirming existence.
async function assignedSection(req) {
  const s = await prisma.section.findFirst({ where: { id: req.params.id, institutionId: req.user.institutionId, instructors: { some: { facultyId: req.facultyId } } }, include: sectionInclude });
  if (!s) throw notFound('Section');
  return s;
}

router.get('/dashboard', async (req, res) => {
  const term = await currentTerm(req.user.institutionId);
  const { rows } = await findSections(req.user.institutionId, { facultyId: req.facultyId, termId: term?.id });
  const sectionIds = rows.map((r) => r.id);
  const [gradeCounts, pendingChanges, recentAttendance, profile] = await Promise.all([
    prisma.grade.groupBy({ by: ['status'], where: { registration: { sectionId: { in: sectionIds }, status: 'REGISTERED' } }, _count: true }),
    prisma.gradeChangeRequest.count({ where: { requestedById: req.user.id, status: 'PENDING' } }),
    prisma.attendanceRecord.groupBy({ by: ['sectionId'], where: { sectionId: { in: sectionIds } }, _max: { date: true } }),
    prisma.faculty.findUnique({ where: { id: req.facultyId }, include: { department: true } }),
  ]);
  const lastTaken = Object.fromEntries(recentAttendance.map((r) => [r.sectionId, r._max.date]));
  const totalStudents = rows.reduce((s, r) => s + r.seats.registered, 0);
  res.json({ data: {
    profile: { name: `${profile.firstName} ${profile.lastName}`, title: profile.title, department: profile.department.name, office: profile.officeLocation, officeHours: profile.officeHours, email: profile.email },
    term: term ? { id: term.id, name: term.name, code: term.code, gradesDueDate: term.gradesDueDate, endDate: term.endDate } : null,
    sections: rows.map((s) => ({ ...sectionDto(s), lastAttendance: lastTaken[s.id] ?? null })),
    stats: { sections: rows.length, students: totalStudents, pendingChangeRequests: pendingChanges, grades: Object.fromEntries(gradeCounts.map((g) => [g.status, g._count])) },
  } });
});

router.get('/sections', async (req, res) => {
  const q = parse(z.object({ termId: id.optional() }), req.query);
  const { rows } = await findSections(req.user.institutionId, { facultyId: req.facultyId, termId: q.termId, sort: 'term' });
  res.json({ data: rows.map(sectionDto) });
});

router.get('/schedule', async (req, res) => {
  const term = await currentTerm(req.user.institutionId);
  const { rows } = await findSections(req.user.institutionId, { facultyId: req.facultyId, termId: term?.id });
  res.json({ data: { term: term ? { id: term.id, name: term.name } : null, classes: rows.filter((s) => s.status !== 'CANCELLED').map(sectionDto) } });
});

router.get('/sections/:id', async (req, res) => {
  const s = await assignedSection(req);
  const regs = await prisma.registration.findMany({ where: { sectionId: s.id, status: { in: ['REGISTERED', 'WAITLISTED', 'COMPLETED', 'WITHDRAWN'] } }, include: { student: { include: { program: true } } }, orderBy: [{ status: 'asc' }, { waitlistPosition: 'asc' }, { student: { lastName: 'asc' } }] });
  const seats = { registered: regs.filter((r) => r.status === 'REGISTERED' || r.status === 'COMPLETED').length, waitlisted: regs.filter((r) => r.status === 'WAITLISTED').length };
  res.json({ data: {
    section: { ...sectionDto({ ...s, seats }), description: s.course.description, term: { id: s.term.id, name: s.term.name, startDate: s.term.startDate, endDate: s.term.endDate, gradesDueDate: s.term.gradesDueDate } },
    roster: regs.map((r) => ({ registrationId: r.id, status: r.status, waitlistPosition: r.waitlistPosition, registeredAt: r.registeredAt, student: { id: r.student.id, studentNumber: r.student.studentNumber, name: `${r.student.lastName}, ${r.student.preferredName || r.student.firstName}`, email: r.student.email, program: r.student.program?.name ?? null, classLevel: r.student.classLevel } })),
  } });
});

router.get('/sections/:id/attendance', async (req, res) => {
  await assignedSection(req);
  const q = parse(z.object({ date: isoDate.optional() }), req.query);
  res.json({ data: await getSectionAttendance(req.params.id, req.user.institutionId, q.date) });
});

router.put('/sections/:id/attendance', async (req, res) => {
  await assignedSection(req);
  const body = parse(z.object({ date: isoDate, records: z.array(z.object({ studentId: id, status: z.enum(['PRESENT', 'ABSENT', 'LATE', 'EXCUSED']), note: z.string().max(300).optional() })).min(1).max(500) }), req.body);
  res.json({ data: await recordAttendance(req.actor, { sectionId: req.params.id, facultyId: req.facultyId, ...body }) });
});

router.get('/sections/:id/grades', async (req, res) => {
  await assignedSection(req);
  res.json({ data: await getGradebook(req.params.id, req.user.institutionId) });
});

router.put('/sections/:id/grades', async (req, res) => {
  await assignedSection(req);
  const body = parse(z.object({ grades: z.array(z.object({ registrationId: id, letter: z.string().trim().min(1).max(3), comment: z.string().max(500).optional() })).min(1).max(500) }), req.body);
  res.json({ data: await saveDraftGrades(req.actor, { sectionId: req.params.id, facultyId: req.facultyId, entries: body.grades }) });
});

router.post('/sections/:id/grades/submit', async (req, res) => {
  await assignedSection(req);
  res.json({ data: await submitGrades(req.actor, { sectionId: req.params.id, facultyId: req.facultyId }) });
});

router.get('/grade-changes', async (req, res) => {
  const rows = await prisma.gradeChangeRequest.findMany({ where: { requestedByType: 'USER', requestedById: req.user.id }, include: { grade: { include: { registration: { include: { student: true, section: { include: { course: true, term: true } } } } } } }, orderBy: { createdAt: 'desc' } });
  res.json({ data: rows.map((r) => ({ id: r.id, fromLetter: r.fromLetter, toLetter: r.toLetter, reason: r.reason, status: r.status, reviewNote: r.reviewNote, createdAt: r.createdAt, reviewedAt: r.reviewedAt, student: `${r.grade.registration.student.firstName} ${r.grade.registration.student.lastName}`, course: `${r.grade.registration.section.course.code}-${r.grade.registration.section.sectionNumber}`, term: r.grade.registration.section.term.code })) });
});

router.post('/grade-changes', async (req, res) => {
  const body = parse(z.object({ gradeId: id, toLetter: z.string().trim().min(1).max(3), reason: z.string().trim().min(10, 'Please give a reason of at least 10 characters').max(1000) }), req.body);
  res.status(201).json({ data: await requestGradeChange(req.actor, { ...body, facultyId: req.facultyId }) });
});

router.post('/sections/:id/announcements', async (req, res) => {
  const s = await assignedSection(req);
  const body = parse(z.object({ title: z.string().trim().min(3).max(150), body: z.string().trim().min(3).max(5000) }), req.body);
  const a = await prisma.announcement.create({ data: { ...body, institutionId: req.user.institutionId, sectionId: s.id, audience: 'STUDENTS', authorUserId: req.user.id, authorName: `${req.user.firstName} ${req.user.lastName}` } });
  await audit(req.actor, { action: 'announcement.created', entityType: 'Announcement', entityId: a.id, summary: `Posted class announcement "${a.title}" to ${s.course.code}-${s.sectionNumber}` });
  res.status(201).json({ data: a });
});

// Limited student profile — only for students currently or previously on one of this instructor's rosters.
router.get('/students/:id', async (req, res) => {
  const link = await prisma.registration.findFirst({ where: { studentId: req.params.id, section: { instructors: { some: { facultyId: req.facultyId } } } } });
  if (!link) throw notFound('Student');
  const s = await prisma.student.findUnique({ where: { id: req.params.id }, include: { program: true } });
  res.json({ data: { id: s.id, studentNumber: s.studentNumber, name: `${s.preferredName || s.firstName} ${s.lastName}`, email: s.email, program: s.program?.name ?? null, classLevel: s.classLevel, status: s.status } });
});

export default router;
