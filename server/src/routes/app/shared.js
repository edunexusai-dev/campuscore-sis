// Endpoints available to every signed-in user (scoped by role where relevant).
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse, id } from '../../lib/validate.js';
import { notFound } from '../../lib/errors.js';
import { termDto, calendarDto, announcementDto } from '../v1/dto.js';

const router = Router();

const AUDIENCE = { STUDENT: ['ALL', 'STUDENTS'], FACULTY: ['ALL', 'FACULTY'], ADMIN: ['ALL', 'STAFF', 'FACULTY', 'STUDENTS'], REGISTRAR: ['ALL', 'STAFF', 'FACULTY', 'STUDENTS'] };

router.get('/terms', async (req, res) => {
  const terms = await prisma.term.findMany({ where: { institutionId: req.user.institutionId }, include: { academicYear: true }, orderBy: { startDate: 'desc' } });
  res.json({ data: terms.map(termDto) });
});

router.get('/lookups', async (req, res) => {
  const institutionId = req.user.institutionId;
  const [departments, programs, colleges, terms] = await Promise.all([
    prisma.department.findMany({ where: { institutionId }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, collegeId: true } }),
    prisma.program.findMany({ where: { institutionId }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, degreeType: true, level: true, active: true } }),
    prisma.college.findMany({ where: { institutionId }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
    prisma.term.findMany({ where: { institutionId }, orderBy: { startDate: 'desc' }, select: { id: true, code: true, name: true, isCurrent: true, status: true } }),
  ]);
  res.json({ data: { departments, programs, colleges, terms } });
});

router.get('/calendar', async (req, res) => {
  const q = parse(z.object({ termId: id.optional() }), req.query);
  const events = await prisma.calendarEvent.findMany({ where: { institutionId: req.user.institutionId, ...(q.termId ? { termId: q.termId } : {}) }, orderBy: { startDate: 'asc' } });
  res.json({ data: events.map(calendarDto) });
});

router.get('/announcements', async (req, res) => {
  const now = new Date();
  const { roles } = req.user;
  // Section announcements: only for sections the user teaches or is registered in (both, for someone who does both).
  let sectionIds = [];
  if (roles.includes('STUDENT') && req.user.student) {
    sectionIds.push(...(await prisma.registration.findMany({ where: { studentId: req.user.student.id, status: 'REGISTERED' }, select: { sectionId: true } })).map((r) => r.sectionId));
  }
  if (roles.includes('FACULTY') && req.user.faculty) {
    sectionIds.push(...(await prisma.sectionInstructor.findMany({ where: { facultyId: req.user.faculty.id }, select: { sectionId: true } })).map((r) => r.sectionId));
  }
  const audiences = [...new Set(roles.flatMap((r) => AUDIENCE[r] ?? []))];
  const rows = await prisma.announcement.findMany({
    where: {
      institutionId: req.user.institutionId,
      publishedAt: { lte: now },
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: [{ sectionId: null, audience: { in: audiences } }, { sectionId: { in: sectionIds } }] },
      ],
    },
    include: { section: { include: { course: true } } },
    orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }],
    take: 50,
  });
  res.json({ data: rows.map((a) => ({ ...announcementDto(a), section: a.section ? `${a.section.course.code}-${a.section.sectionNumber}` : null })) });
});

router.get('/notifications', async (req, res) => {
  const rows = await prisma.notification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 });
  const unread = await prisma.notification.count({ where: { userId: req.user.id, readAt: null } });
  res.json({ data: rows, unread });
});

router.post('/notifications/:id/read', async (req, res) => {
  const n = await prisma.notification.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!n) throw notFound('Notification');
  await prisma.notification.update({ where: { id: n.id }, data: { readAt: n.readAt ?? new Date() } });
  res.json({ ok: true });
});

router.post('/notifications/read-all', async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
});

// Campus directory: faculty and departments only (students are not listed in the public directory).
router.get('/directory', async (req, res) => {
  const q = parse(z.object({ search: z.string().max(100).optional(), departmentId: id.optional() }), req.query);
  const faculty = await prisma.faculty.findMany({
    where: {
      institutionId: req.user.institutionId,
      status: 'ACTIVE',
      ...(q.departmentId ? { departmentId: q.departmentId } : {}),
      ...(q.search ? { OR: [{ firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }, { department: { name: { contains: q.search, mode: 'insensitive' } } }] } : {}),
    },
    include: { department: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  const departments = await prisma.department.findMany({ where: { institutionId: req.user.institutionId }, include: { college: true }, orderBy: { name: 'asc' } });
  res.json({
    data: {
      people: faculty.map((f) => ({ id: f.id, name: `${f.firstName} ${f.lastName}`, title: f.title, department: f.department.name, email: f.email, phone: f.phone, office: f.officeLocation, officeHours: f.officeHours })),
      departments: departments.map((d) => ({ id: d.id, code: d.code, name: d.name, college: d.college.name, email: d.email, office: d.officeLocation })),
    },
  });
});

export default router;
