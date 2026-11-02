import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { parse, id, isoDate } from '../../../lib/validate.js';
import { notFound, ruleViolation } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requirePermission } from '../../../lib/permissions.js';
import { getGradebook, approveGrades, returnGrades, publishGrades, requestGradeChange, reviewGradeChange } from '../../../services/gradeService.js';
import { notifyStudent } from '../../../services/notificationService.js';
import { calendarDto, announcementDto } from '../../v1/dto.js';

const router = Router();
const inst = (req) => req.user.institutionId;
const grades = requirePermission('grades.approve');

// ── Grade approval queue ──
router.get('/grades/queue', grades, async (req, res) => {
  const q = parse(z.object({ termId: id.optional() }), req.query);
  const rows = await prisma.grade.groupBy({ by: ['status'], where: { registration: { institutionId: inst(req), ...(q.termId ? { section: { termId: q.termId } } : {}) } }, _count: true });
  const sections = await prisma.section.findMany({
    where: { institutionId: inst(req), ...(q.termId ? { termId: q.termId } : {}), status: { not: 'CANCELLED' }, registrations: { some: { status: { in: ['REGISTERED', 'COMPLETED'] } } } },
    include: { course: true, term: true, instructors: { include: { faculty: true } }, registrations: { where: { status: { in: ['REGISTERED', 'COMPLETED'] } }, include: { grade: { select: { status: true } } } } },
    orderBy: [{ term: { startDate: 'desc' } }, { course: { code: 'asc' } }],
  });
  const data = sections.map((s) => {
    const counts = { MISSING: 0, DRAFT: 0, SUBMITTED: 0, APPROVED: 0, PUBLISHED: 0, RETURNED: 0 };
    for (const r of s.registrations) counts[r.grade?.status ?? 'MISSING'] += 1;
    const stage = counts.SUBMITTED ? 'AWAITING_APPROVAL' : counts.APPROVED ? 'AWAITING_PUBLICATION' : counts.PUBLISHED === s.registrations.length ? 'PUBLISHED' : counts.RETURNED ? 'RETURNED' : 'IN_PROGRESS';
    return { sectionId: s.id, label: `${s.course.code}-${s.sectionNumber}`, title: s.course.title, term: s.term.code, gradesDueDate: s.term.gradesDueDate, instructors: s.instructors.map((i) => `${i.faculty.firstName} ${i.faculty.lastName}`), enrolled: s.registrations.length, counts, stage };
  });
  res.json({ data, totals: Object.fromEntries(rows.map((r) => [r.status, r._count])) });
});

router.get('/sections/:id/gradebook', grades, async (req, res) => res.json({ data: await getGradebook(req.params.id, inst(req)) }));
router.post('/sections/:id/grades/approve', grades, async (req, res) => res.json({ data: await approveGrades(req.actor, { sectionId: req.params.id }) }));
router.post('/sections/:id/grades/publish', grades, async (req, res) => res.json({ data: await publishGrades(req.actor, { sectionId: req.params.id }) }));
router.post('/sections/:id/grades/return', grades, async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
  res.json({ data: await returnGrades(req.actor, { sectionId: req.params.id, reason }) });
});

router.get('/grade-changes', grades, async (req, res) => {
  const q = parse(z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }), req.query);
  const rows = await prisma.gradeChangeRequest.findMany({ where: { grade: { registration: { institutionId: inst(req) } }, ...(q.status ? { status: q.status } : {}) }, include: { grade: { include: { registration: { include: { student: true, section: { include: { course: true, term: true } } } } } } }, orderBy: { createdAt: 'desc' }, take: 200 });
  const userIds = [...new Set(rows.flatMap((r) => [r.requestedById, r.reviewedById]).filter(Boolean))];
  const users = Object.fromEntries((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } })).map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  res.json({ data: rows.map((r) => ({ id: r.id, status: r.status, fromLetter: r.fromLetter, toLetter: r.toLetter, reason: r.reason, reviewNote: r.reviewNote, createdAt: r.createdAt, reviewedAt: r.reviewedAt, requestedBy: users[r.requestedById] ?? r.requestedByType, requestedById: r.requestedById, reviewedBy: users[r.reviewedById] ?? null, student: { id: r.grade.registration.student.id, studentNumber: r.grade.registration.student.studentNumber, name: `${r.grade.registration.student.firstName} ${r.grade.registration.student.lastName}` }, course: `${r.grade.registration.section.course.code}-${r.grade.registration.section.sectionNumber}`, term: r.grade.registration.section.term.code })) });
});

router.post('/grade-changes', grades, async (req, res) => {
  const body = parse(z.object({ gradeId: id, toLetter: z.string().trim().min(1).max(3), reason: z.string().trim().min(10).max(1000) }), req.body);
  res.status(201).json({ data: await requestGradeChange(req.actor, body) });
});

router.post('/grade-changes/:id/review', grades, async (req, res) => {
  const body = parse(z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }), req.body);
  res.json({ data: await reviewGradeChange(req.actor, { requestId: req.params.id, ...body }) });
});

router.get('/grades/:id/history', grades, async (req, res) => {
  const g = await prisma.grade.findFirst({ where: { id: req.params.id, registration: { institutionId: inst(req) } }, include: { history: { orderBy: { createdAt: 'asc' } } } });
  if (!g) throw notFound('Grade');
  res.json({ data: g.history });
});

// ── Document requests ──
router.get('/document-requests', requirePermission('documents.manage'), async (req, res) => {
  const q = parse(z.object({ status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED']).optional() }), req.query);
  const rows = await prisma.documentRequest.findMany({ where: { institutionId: inst(req), ...(q.status ? { status: q.status } : {}) }, include: { student: { select: { id: true, studentNumber: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ data: rows });
});

const DOC_FLOW = { PENDING: ['PROCESSING', 'REJECTED'], PROCESSING: ['COMPLETED', 'REJECTED'], COMPLETED: [], REJECTED: [] };
router.post('/document-requests/:id/status', requirePermission('documents.manage'), async (req, res) => {
  const body = parse(z.object({ status: z.enum(['PROCESSING', 'COMPLETED', 'REJECTED']), notes: z.string().trim().max(500).optional() }), req.body);
  const d = await prisma.documentRequest.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!d) throw notFound('Document request');
  if (!DOC_FLOW[d.status].includes(body.status)) throw ruleViolation('invalid_transition', `Cannot move a ${d.status.toLowerCase()} request to ${body.status.toLowerCase()}.`);
  await prisma.documentRequest.update({ where: { id: d.id }, data: { status: body.status, notes: body.notes ?? d.notes, processedById: req.user.id, processedAt: new Date() } });
  await audit(req.actor, { action: 'document_request.updated', entityType: 'DocumentRequest', entityId: d.id, summary: `Document request ${d.type.replace(/_/g, ' ').toLowerCase()} → ${body.status.toLowerCase()}` });
  await notifyStudent(d.studentId, { title: `Document request ${body.status.toLowerCase()}`, body: `Your ${d.type.replace(/_/g, ' ').toLowerCase()} request is now ${body.status.toLowerCase()}.${body.notes ? ` ${body.notes}` : ''}`, link: '/student/documents' });
  res.json({ ok: true });
});

// ── Calendar ──
const comms = requirePermission('communications.manage');
const eventBody = z.object({ title: z.string().trim().min(3).max(150), description: z.string().max(1000).nullable().optional(), category: z.enum(['ACADEMIC', 'DEADLINE', 'HOLIDAY', 'EXAM', 'EVENT']), startDate: isoDate, endDate: isoDate.nullable().optional(), termId: id.nullable().optional() });

router.post('/calendar', comms, async (req, res) => {
  const body = parse(eventBody.strict(), req.body);
  if (body.termId && !(await prisma.term.findFirst({ where: { id: body.termId, institutionId: inst(req) } }))) throw notFound('Term');
  const e = await prisma.calendarEvent.create({ data: { ...body, startDate: new Date(body.startDate), endDate: body.endDate ? new Date(body.endDate) : null, institutionId: inst(req) } });
  await audit(req.actor, { action: 'calendar.created', entityType: 'CalendarEvent', entityId: e.id, summary: `Added calendar event "${e.title}"` });
  res.status(201).json({ data: calendarDto(e) });
});
router.patch('/calendar/:id', comms, async (req, res) => {
  const body = parse(eventBody.partial().strict(), req.body);
  const e = await prisma.calendarEvent.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!e) throw notFound('Calendar event');
  await prisma.calendarEvent.update({ where: { id: e.id }, data: { ...body, ...(body.startDate ? { startDate: new Date(body.startDate) } : {}), ...(body.endDate !== undefined ? { endDate: body.endDate ? new Date(body.endDate) : null } : {}) } });
  await audit(req.actor, { action: 'calendar.updated', entityType: 'CalendarEvent', entityId: e.id, summary: `Updated calendar event "${e.title}"` });
  res.json({ ok: true });
});
router.delete('/calendar/:id', comms, async (req, res) => {
  const e = await prisma.calendarEvent.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!e) throw notFound('Calendar event');
  await prisma.calendarEvent.delete({ where: { id: e.id } });
  await audit(req.actor, { action: 'calendar.deleted', entityType: 'CalendarEvent', entityId: e.id, summary: `Deleted calendar event "${e.title}"`, before: calendarDto(e) });
  res.status(204).end();
});

// ── Announcements ──
router.get('/announcements', comms, async (req, res) => {
  const rows = await prisma.announcement.findMany({ where: { institutionId: inst(req) }, include: { section: { include: { course: true } } }, orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }], take: 100 });
  res.json({ data: rows.map((a) => ({ ...announcementDto(a), section: a.section ? `${a.section.course.code}-${a.section.sectionNumber}` : null })) });
});
const annBody = z.object({ title: z.string().trim().min(3).max(150), body: z.string().trim().min(3).max(5000), audience: z.enum(['ALL', 'STUDENTS', 'FACULTY', 'STAFF']), pinned: z.boolean().default(false), expiresAt: isoDate.nullable().optional() });
router.post('/announcements', comms, async (req, res) => {
  const body = parse(annBody.strict(), req.body);
  const a = await prisma.announcement.create({ data: { ...body, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, institutionId: inst(req), authorUserId: req.user.id, authorName: `${req.user.firstName} ${req.user.lastName}` } });
  await audit(req.actor, { action: 'announcement.created', entityType: 'Announcement', entityId: a.id, summary: `Published announcement "${a.title}" to ${a.audience.toLowerCase()}` });
  res.status(201).json({ data: announcementDto(a) });
});
router.patch('/announcements/:id', comms, async (req, res) => {
  const body = parse(annBody.partial().strict(), req.body);
  const a = await prisma.announcement.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!a) throw notFound('Announcement');
  await prisma.announcement.update({ where: { id: a.id }, data: { ...body, ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null } : {}) } });
  await audit(req.actor, { action: 'announcement.updated', entityType: 'Announcement', entityId: a.id, summary: `Updated announcement "${a.title}"` });
  res.json({ ok: true });
});
router.delete('/announcements/:id', comms, async (req, res) => {
  const a = await prisma.announcement.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!a) throw notFound('Announcement');
  await prisma.announcement.delete({ where: { id: a.id } });
  await audit(req.actor, { action: 'announcement.deleted', entityType: 'Announcement', entityId: a.id, summary: `Deleted announcement "${a.title}"` });
  res.status(204).end();
});

export default router;
