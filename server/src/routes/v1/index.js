// External integration API (/api/v1). Authenticated with OAuth 2.0 client-credentials bearer tokens only.
import express, { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse, id, isoDate, paginationQuery, sortQuery, paged } from '../../lib/validate.js';
import { notFound } from '../../lib/errors.js';
import { requireBearer, requireScope } from '../../middleware/integrationAuth.js';
import { apiRequestLog } from '../../middleware/apiLog.js';
import { issueToken, revokeTokenByClient } from '../../services/integrationService.js';
import { assertOperation, evaluateCapabilities } from '../../services/capabilityService.js';
import { registerStudentWriteRoutes } from './studentWrites.js';
import { registerIdentityRoutes } from './identity.js';
import { findStudents, getStudent, findFaculty, findSections, getSection, findCourses, studentSchedule, sectionInclude } from '../../services/queryService.js';
import { registerStudent, dropRegistration } from '../../services/registrationService.js';
import { getAcademicRecord } from '../../services/academicService.js';
import { saveDraftGrades, getGradebook } from '../../services/gradeService.js';
import { recordAttendance, getStudentAttendance, getSectionAttendance } from '../../services/attendanceService.js';
import * as dto from './dto.js';
import { findPeople, getPerson, personDto } from '../../services/personService.js';
import { idempotent } from '../../middleware/idempotency.js';
import { getPolicies } from '../../services/policyService.js';
import { currentStudentAccount } from '../../services/financeService.js';

const router = Router();
router.use(apiRequestLog);

// ── OAuth endpoints ──
const tokenLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', error_description: 'Too many token requests. Try again shortly.' } });

function clientCredentials(req) {
  // HTTP Basic (RFC 6749 §2.3.1 preferred) or client_id/client_secret in the body.
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('basic ')) {
    const [cid, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    return { clientId: decodeURIComponent(cid), clientSecret: decodeURIComponent(rest.join(':')) };
  }
  return { clientId: req.body?.client_id, clientSecret: req.body?.client_secret };
}

router.post('/oauth/token', tokenLimiter, express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
  const { clientId, clientSecret } = clientCredentials(req);
  const { client, ...result } = await issueToken({ grantType: req.body?.grant_type, clientId, clientSecret, scope: req.body?.scope, ip: req.ip });
  res.locals.logClient = client;
  res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache').json(result);
});

router.post('/oauth/revoke', tokenLimiter, express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
  const { clientId, clientSecret } = clientCredentials(req);
  await revokeTokenByClient({ token: String(req.body?.token ?? ''), clientId, clientSecret });
  res.status(200).json({ revoked: true });
});

// ── Everything below requires a valid bearer token ──
router.use(requireBearer);
const listLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => req.integration?.client.id ?? ipKeyGenerator(req.ip), message: { error: { code: 'rate_limited', message: 'Rate limit exceeded (600 requests/minute per client).' } } });
router.use(listLimiter);

const inst = (req) => req.integration.client.institutionId;

router.get('/me', async (req, res) => {
  const { client, scopes, expiresAt } = req.integration;
  const institution = await prisma.institution.findUnique({ where: { id: client.institutionId }, select: { id: true, slug: true, name: true, shortName: true } });
  res.json({ clientId: client.clientId, name: client.name, institutionId: client.institutionId, institution, scopes, tokenExpiresAt: expiresAt });
});

// Effective write capabilities for this client: scope × institutional policy × client write preferences.
router.get('/capabilities', async (req, res) => {
  const { client, scopes } = req.integration;
  const institution = await prisma.institution.findUnique({ where: { id: client.institutionId }, select: { id: true, slug: true, name: true } });
  res.json({ data: { institution, client: { clientId: client.clientId, name: client.name }, scopes, operations: await evaluateCapabilities(client, scopes) } });
});

router.get('/institution', requireScope('institution:read'), async (req, res) => {
  const i = await prisma.institution.findUnique({ where: { id: inst(req) } });
  res.json({ data: dto.institutionDto(i) });
});

// Terms
router.get('/terms', requireScope('terms:read'), async (req, res) => {
  const q = parse(z.object({ status: z.enum(['PLANNED', 'REGISTRATION_OPEN', 'IN_PROGRESS', 'COMPLETED']).optional(), current: z.enum(['true', 'false']).optional() }), req.query);
  const terms = await prisma.term.findMany({ where: { institutionId: inst(req), ...(q.status ? { status: q.status } : {}), ...(q.current ? { isCurrent: q.current === 'true' } : {}) }, include: { academicYear: true }, orderBy: { startDate: 'asc' } });
  res.json({ data: terms.map(dto.termDto) });
});
router.get('/terms/:id', requireScope('terms:read'), async (req, res) => {
  const t = await prisma.term.findFirst({ where: { id: req.params.id, institutionId: inst(req) }, include: { academicYear: true } });
  if (!t) throw notFound('Term');
  res.json({ data: dto.termDto(t) });
});

router.get('/calendar', requireScope('calendar:read'), async (req, res) => {
  const q = parse(z.object({ termId: id.optional(), from: isoDate.optional(), to: isoDate.optional(), category: z.enum(['ACADEMIC', 'DEADLINE', 'HOLIDAY', 'EXAM', 'EVENT']).optional() }), req.query);
  const events = await prisma.calendarEvent.findMany({
    where: { institutionId: inst(req), ...(q.termId ? { termId: q.termId } : {}), ...(q.category ? { category: q.category } : {}), startDate: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } },
    orderBy: { startDate: 'asc' },
  });
  res.json({ data: events.map(dto.calendarDto) });
});

// Departments and programs
router.get('/departments', requireScope('programs:read'), async (req, res) => {
  const rows = await prisma.department.findMany({ where: { institutionId: inst(req) }, include: { college: true }, orderBy: { code: 'asc' } });
  res.json({ data: rows.map(dto.departmentDto) });
});
router.get('/programs', requireScope('programs:read'), async (req, res) => {
  const q = parse(z.object({ departmentId: id.optional(), level: z.enum(['UNDERGRADUATE', 'GRADUATE']).optional() }), req.query);
  const rows = await prisma.program.findMany({ where: { institutionId: inst(req), ...(q.departmentId ? { departmentId: q.departmentId } : {}), ...(q.level ? { level: q.level } : {}) }, include: { department: true }, orderBy: { code: 'asc' } });
  res.json({ data: rows.map(dto.programDto) });
});

// Courses
router.get('/courses', requireScope('courses:read'), async (req, res) => {
  const q = parse(paginationQuery.extend({ search: z.string().max(100).optional(), departmentId: id.optional(), sort: sortQuery(['code', 'title', 'credits', 'level'], 'code') }), req.query);
  const { rows, total } = await findCourses(inst(req), q);
  res.json(paged(rows.map(dto.courseDto), total, q));
});
router.get('/courses/:id', requireScope('courses:read'), async (req, res) => {
  const c = await prisma.course.findFirst({ where: { id: req.params.id, institutionId: inst(req) }, include: { department: true, prerequisites: { include: { prerequisite: true } } } });
  if (!c) throw notFound('Course');
  res.json({ data: dto.courseDto(c) });
});

// Sections
router.get('/sections', requireScope('sections:read'), async (req, res) => {
  const q = parse(paginationQuery.extend({ termId: id.optional(), courseId: id.optional(), facultyId: id.optional(), search: z.string().max(100).optional(), status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).optional() }), req.query);
  const { rows, total } = await findSections(inst(req), q);
  res.json(paged(rows.map(dto.sectionDto), total, q));
});
router.get('/sections/:id', requireScope('sections:read'), async (req, res) => {
  res.json({ data: dto.sectionDto(await getSection(inst(req), req.params.id)) });
});
router.get('/sections/:id/roster', requireScope('registrations:read'), async (req, res) => {
  await getSection(inst(req), req.params.id);
  const regs = await prisma.registration.findMany({ where: { sectionId: req.params.id, status: { in: ['REGISTERED', 'WAITLISTED', 'COMPLETED'] } }, include: { student: true }, orderBy: [{ status: 'asc' }, { student: { lastName: 'asc' } }] });
  res.json({ data: regs.map(dto.registrationDto) });
});
router.get('/sections/:id/grades', requireScope('grades:read'), async (req, res) => {
  const gb = await getGradebook(req.params.id, inst(req));
  // Integrations see only the official (published) grade plus the workflow state of the section.
  res.json({ data: { section: gb.section, counts: gb.counts, grades: gb.rows.map((r) => ({ registrationId: r.registrationId, studentId: r.student.id, studentNumber: r.student.studentNumber, status: r.grade?.status ?? null, letter: r.grade?.status === 'PUBLISHED' ? r.grade.letter : null })) } });
});
router.get('/sections/:id/attendance', requireScope('attendance:read'), async (req, res) => {
  const q = parse(z.object({ date: isoDate.optional() }), req.query);
  const data = await getSectionAttendance(req.params.id, inst(req), q.date);
  res.json({ data });
});

// Students
const studentListQuery = paginationQuery.extend({
  search: z.string().max(100).optional(),
  status: z.enum(['APPLICANT', 'ADMITTED', 'ACTIVE', 'LEAVE_OF_ABSENCE', 'SUSPENDED', 'WITHDRAWN', 'GRADUATED']).optional(),
  programId: id.optional(),
  classLevel: z.enum(['FRESHMAN', 'SOPHOMORE', 'JUNIOR', 'SENIOR', 'GRADUATE']).optional(),
  email: z.string().trim().email().max(200).optional(),
  studentNumber: z.string().trim().max(30).optional(),
  sort: sortQuery(['lastName', 'firstName', 'studentNumber', 'updatedAt', 'createdAt'], 'lastName'),
});
router.get('/students', requireScope('students:read'), async (req, res) => {
  const q = parse(studentListQuery, req.query);
  const { rows, total } = await findStudents(inst(req), q);
  res.json(paged(rows.map(dto.studentDto), total, q));
});
router.get('/students/:id', requireScope('students:read'), async (req, res) => {
  const s = await getStudent(inst(req), req.params.id);
  res.set('ETag', `W/"${s.updatedAt.getTime()}"`).json({ data: dto.studentDto(s) });
});

registerStudentWriteRoutes(router);

router.get('/students/:id/registrations', requireScope('registrations:read'), async (req, res) => {
  const q = parse(z.object({ termId: id.optional(), status: z.enum(['REGISTERED', 'WAITLISTED', 'DROPPED', 'WITHDRAWN', 'COMPLETED']).optional() }), req.query);
  await getStudent(inst(req), req.params.id);
  const regs = await prisma.registration.findMany({ where: { studentId: req.params.id, ...(q.status ? { status: q.status } : {}), ...(q.termId ? { section: { termId: q.termId } } : {}) }, include: { section: { include: { course: true, term: true } } }, orderBy: { registeredAt: 'desc' } });
  res.json({ data: regs.map(dto.registrationDto) });
});

router.get('/students/:id/schedule', requireScope('schedules:read'), async (req, res) => {
  const q = parse(z.object({ termId: id.optional() }), req.query);
  await getStudent(inst(req), req.params.id);
  const term = q.termId ? await prisma.term.findFirst({ where: { id: q.termId, institutionId: inst(req) } }) : await prisma.term.findFirst({ where: { institutionId: inst(req), isCurrent: true } });
  if (!term) throw notFound('Term');
  const items = await studentSchedule(req.params.id, term.id);
  res.json({ data: { term: { id: term.id, code: term.code, name: term.name }, classes: items.map((i) => ({ ...dto.sectionDto(i.section), registrationId: i.registrationId, registrationStatus: i.registrationStatus, waitlistPosition: i.waitlistPosition })) } });
});

router.get('/students/:id/grades', requireScope('grades:read'), async (req, res) => {
  await getStudent(inst(req), req.params.id);
  const record = await getAcademicRecord(req.params.id, inst(req));
  res.json({ data: record.terms.map((t) => ({ term: t.term.code, termName: t.term.name, termGpa: t.termGpa, courses: t.courses.map((c) => ({ sectionId: c.sectionId, courseCode: c.courseCode, courseTitle: c.courseTitle, credits: c.credits, grade: c.grade, state: c.state })) })) });
});

router.get('/students/:id/academic-record', requireScope('grades:read'), async (req, res) => {
  const s = await getStudent(inst(req), req.params.id);
  const record = await getAcademicRecord(s.id, inst(req));
  res.json({ data: { studentId: s.id, studentNumber: s.studentNumber, program: s.program?.name ?? null, classLevel: s.classLevel, academicStanding: s.academicStanding, cumulativeGpa: record.cumulativeGpa, creditsAttempted: record.creditsAttempted, creditsEarned: record.creditsEarned, creditsInProgress: record.creditsInProgress, terms: record.terms.map((t) => ({ term: t.term.code, termGpa: t.termGpa, cumulativeGpa: t.cumulativeGpa, creditsEarned: t.creditsEarned })) } });
});

// The student's account for a term (default: the current term, else the most recent). data is null when the student
// has no account: an empty state, not an error.
router.get('/students/:id/account', requireScope('finance:read'), async (req, res) => {
  const q = parse(z.object({ termId: id.optional() }), req.query);
  await getStudent(inst(req), req.params.id);
  res.json({ data: await currentStudentAccount(inst(req), req.params.id, q.termId) });
});

router.get('/students/:id/attendance', requireScope('attendance:read'), async (req, res) => {
  const q = parse(z.object({ termId: id.optional() }), req.query);
  await getStudent(inst(req), req.params.id);
  res.json({ data: await getStudentAttendance(req.params.id, q.termId) });
});

// People (person registry). One entry per human being, with every student/faculty relationship. Used by identity
// provisioning (e.g. the university identity provider sync) and by portals that create accounts at first sign-in.
const peopleQuery = paginationQuery.extend({
  personNumber: z.string().trim().max(30).optional(),
  studentNumber: z.string().trim().max(30).optional(),
  employeeNumber: z.string().trim().max(30).optional(),
  email: z.string().trim().email().max(200).optional(),
  updatedSince: z.coerce.date().optional(),
});
router.get('/people', requireScope('people:read'), async (req, res) => {
  const q = parse(peopleQuery, req.query);
  // Integrations only ever see people who may be provisioned (see personService.findPeople).
  const { rows, total } = await findPeople(inst(req), { ...q, provisionableOnly: true });
  res.json(paged(rows.map(personDto), total, q));
});
router.get('/people/:id', requireScope('people:read'), async (req, res) => {
  res.json({ data: personDto(await getPerson(inst(req), req.params.id, { provisionableOnly: true })) });
});

// Faculty
router.get('/faculty', requireScope('faculty:read'), async (req, res) => {
  const q = parse(paginationQuery.extend({ search: z.string().max(100).optional(), departmentId: id.optional(), sort: sortQuery(['lastName', 'firstName', 'employeeNumber'], 'lastName') }), req.query);
  const { rows, total } = await findFaculty(inst(req), q);
  res.json(paged(rows.map(dto.facultyDto), total, q));
});
router.get('/faculty/:id', requireScope('faculty:read'), async (req, res) => {
  const f = await prisma.faculty.findFirst({ where: { id: req.params.id, institutionId: inst(req) }, include: { department: true } });
  if (!f) throw notFound('Faculty member');
  res.json({ data: dto.facultyDto(f) });
});
router.get('/faculty/:id/sections', requireScope('faculty:read', 'sections:read'), async (req, res) => {
  const q = parse(z.object({ termId: id.optional() }), req.query);
  const f = await prisma.faculty.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!f) throw notFound('Faculty member');
  const { rows } = await findSections(inst(req), { facultyId: f.id, termId: q.termId, sort: 'term' });
  res.json({ data: rows.map(dto.sectionDto) });
});
router.get('/faculty/:id/schedule', requireScope('schedules:read'), async (req, res) => {
  const q = parse(z.object({ termId: id.optional() }), req.query);
  const f = await prisma.faculty.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!f) throw notFound('Faculty member');
  const term = q.termId ? await prisma.term.findFirst({ where: { id: q.termId, institutionId: inst(req) } }) : await prisma.term.findFirst({ where: { institutionId: inst(req), isCurrent: true } });
  if (!term) throw notFound('Term');
  const sections = await prisma.section.findMany({ where: { termId: term.id, instructors: { some: { facultyId: f.id } }, status: { not: 'CANCELLED' } }, include: sectionInclude });
  res.json({ data: { term: { id: term.id, code: term.code, name: term.name }, classes: sections.map(dto.sectionDto) } });
});

// Registrations
router.get('/registrations', requireScope('registrations:read'), async (req, res) => {
  const q = parse(paginationQuery.extend({ termId: id.optional(), studentId: id.optional(), sectionId: id.optional(), status: z.enum(['REGISTERED', 'WAITLISTED', 'DROPPED', 'WITHDRAWN', 'COMPLETED']).optional() }), req.query);
  const where = { institutionId: inst(req), ...(q.studentId ? { studentId: q.studentId } : {}), ...(q.sectionId ? { sectionId: q.sectionId } : {}), ...(q.status ? { status: q.status } : {}), ...(q.termId ? { section: { termId: q.termId } } : {}) };
  const [rows, total] = await Promise.all([
    prisma.registration.findMany({ where, include: { student: true, section: { include: { course: true, term: true } } }, orderBy: [{ registeredAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.registration.count({ where }),
  ]);
  res.json(paged(rows.map(dto.registrationDto), total, q));
});

router.get('/registrations/:id', requireScope('registrations:read'), async (req, res) => {
  const r = await prisma.registration.findFirst({ where: { id: req.params.id, institutionId: inst(req) }, include: { student: true, section: { include: { course: true, term: true } }, events: { orderBy: { createdAt: 'asc' } } } });
  if (!r) throw notFound('Registration');
  res.json({ data: { ...dto.registrationDto(r), history: r.events.map((e) => ({ action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus, actorType: e.actorType, reason: e.reason, at: e.createdAt })) } });
});

router.post('/registrations', requireScope('registrations:write'), idempotent(), async (req, res) => {
  await assertOperation(req, 'registration.write');
  const body = parse(z.object({ studentId: id, sectionId: id }).strict(), req.body);
  const reg = await registerStudent(req.actor, { ...body, source: 'API' });
  const full = await prisma.registration.findUnique({ where: { id: reg.id }, include: { student: true, section: { include: { course: true, term: true } } } });
  res.status(201).location(`/api/v1/registrations/${reg.id}`).json({ data: dto.registrationDto(full) });
});

router.post('/registrations/:id/drop', requireScope('registrations:write'), idempotent(), async (req, res) => {
  await assertOperation(req, 'registration.write');
  const body = parse(z.object({ reason: z.string().trim().max(500).optional() }).strict(), req.body);
  const reg = await dropRegistration(req.actor, { registrationId: req.params.id, reason: body.reason });
  res.json({ data: dto.registrationDto(reg) });
});

// Grades (write): draft grades only, on behalf of an assigned instructor.
router.put('/sections/:id/grades', requireScope('grades:write'), async (req, res) => {
  await assertOperation(req, 'grade.write');
  const policies = await getPolicies(inst(req));
  const body = parse(z.object({
    actingFacultyId: id,
    grades: z.array(z.object({ studentId: id, letter: z.string().trim().min(1).max(3), comment: z.string().max(500).optional() }).strict()).min(1).max(500),
  }).strict(), req.body);
  const gb = await saveDraftGrades(req.actor, { sectionId: req.params.id, facultyId: body.actingFacultyId, entries: body.grades, submit: policies['api.gradeWritesAutoSubmit'] });
  res.json({ data: { section: gb.section, counts: gb.counts, grades: gb.rows.map((r) => ({ studentId: r.student.id, status: r.grade?.status ?? null, letter: r.grade?.letter ?? null })) } });
});

// Attendance (write)
router.post('/sections/:id/attendance', requireScope('attendance:write'), idempotent(), async (req, res) => {
  await assertOperation(req, 'attendance.write');
  const body = parse(z.object({
    actingFacultyId: id,
    date: isoDate,
    records: z.array(z.object({ studentId: id, status: z.enum(['PRESENT', 'ABSENT', 'LATE', 'EXCUSED']), note: z.string().max(300).optional() }).strict()).min(1).max(500),
  }).strict(), req.body);
  const result = await recordAttendance(req.actor, { sectionId: req.params.id, facultyId: body.actingFacultyId, date: body.date, records: body.records });
  res.json({ data: result });
});

// Announcements
router.get('/announcements', requireScope('announcements:read'), async (req, res) => {
  const q = parse(z.object({ audience: z.enum(['ALL', 'STUDENTS', 'FACULTY', 'STAFF']).optional() }), req.query);
  const now = new Date();
  const rows = await prisma.announcement.findMany({ where: { institutionId: inst(req), sectionId: null, publishedAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], ...(q.audience ? { audience: { in: ['ALL', q.audience] } } : {}) }, orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }], take: 50 });
  res.json({ data: rows.map(dto.announcementDto) });
});

// Class announcements for the sections a student is registered in (posted by their instructors), newest first.
router.get('/students/:id/announcements', requireScope('announcements:read'), async (req, res) => {
  await getStudent(inst(req), req.params.id);
  const now = new Date();
  const sectionIds = (await prisma.registration.findMany({ where: { studentId: req.params.id, status: 'REGISTERED' }, select: { sectionId: true } })).map((r) => r.sectionId);
  const rows = await prisma.announcement.findMany({
    where: { institutionId: inst(req), sectionId: { in: sectionIds }, publishedAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    include: { section: { include: { course: true, term: true } } },
    orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }],
    take: 50,
  });
  res.json({ data: rows.map((a) => ({ ...dto.announcementDto(a), section: { id: a.section.id, label: `${a.section.course.code}-${a.section.sectionNumber}`, courseCode: a.section.course.code, courseTitle: a.section.course.title, term: a.section.term.code } })) });
});

registerIdentityRoutes(router);

export default router;
