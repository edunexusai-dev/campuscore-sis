// Student self-service. Every query is pinned to the signed-in student's own record (req.studentId);
// there are no student-ID parameters, so other students' records cannot be addressed at all.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse, id } from '../../lib/validate.js';
import { forbidden, ruleViolation } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requireRole } from '../../middleware/session.js';
import { getPolicies } from '../../services/policyService.js';
import { getAcademicRecord, getDegreeAudit, getTranscript } from '../../services/academicService.js';
import { registerStudent, dropRegistration, evaluateRegistration } from '../../services/registrationService.js';
import { getStudentAttendance } from '../../services/attendanceService.js';
import { findSections, studentSchedule, currentTerm } from '../../services/queryService.js';
import { sectionDto } from '../v1/dto.js';

const router = Router();
router.use(requireRole('STUDENT'), (req, _res, next) => {
  if (!req.user.student) return next(forbidden('No student record is linked to this account.'));
  req.studentId = req.user.student.id;
  next();
});

const myStudent = (req) => prisma.student.findUnique({ where: { id: req.studentId }, include: { program: { include: { department: true } }, admitTerm: true, holds: { where: { releasedAt: null }, orderBy: { placedAt: 'desc' } } } });

function profileDto(s) {
  return {
    id: s.id, studentNumber: s.studentNumber, firstName: s.firstName, lastName: s.lastName, preferredName: s.preferredName,
    email: s.email, personalEmail: s.personalEmail, phone: s.phone, dateOfBirth: s.dateOfBirth,
    addressLine: s.addressLine, city: s.city, region: s.region, postalCode: s.postalCode, country: s.country,
    emergencyContactName: s.emergencyContactName, emergencyContactPhone: s.emergencyContactPhone, emergencyContactRelation: s.emergencyContactRelation,
    status: s.status, classLevel: s.classLevel, academicStanding: s.academicStanding, expectedGraduation: s.expectedGraduation,
    program: s.program ? { name: s.program.name, code: s.program.code, degreeType: s.program.degreeType, department: s.program.department.name } : null,
    admitTerm: s.admitTerm?.name ?? null,
    financialAccountRef: s.financialAccountRef, financialAidStatus: s.financialAidStatus,
    holds: s.holds.map((h) => ({ id: h.id, type: h.type, reason: h.reason, blocksRegistration: h.blocksRegistration, placedAt: h.placedAt })),
  };
}

router.get('/dashboard', async (req, res) => {
  const [student, term, policies] = await Promise.all([myStudent(req), currentTerm(req.user.institutionId), getPolicies(req.user.institutionId)]);
  const [record, schedule, upcoming, unread] = await Promise.all([
    getAcademicRecord(req.studentId, req.user.institutionId),
    term ? studentSchedule(req.studentId, term.id) : [],
    prisma.calendarEvent.findMany({ where: { institutionId: req.user.institutionId, startDate: { gte: new Date(new Date().toDateString()) } }, orderBy: { startDate: 'asc' }, take: 5 }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
  ]);
  const registered = schedule.filter((s) => s.registrationStatus === 'REGISTERED');
  res.json({ data: {
    profile: profileDto(student),
    term: term ? { id: term.id, name: term.name, code: term.code, addDropDeadline: term.addDropDeadline, withdrawDeadline: term.withdrawDeadline, registrationOpens: term.registrationOpens, registrationCloses: term.registrationCloses } : null,
    record: { cumulativeGpa: record.cumulativeGpa, creditsEarned: record.creditsEarned, creditsInProgress: record.creditsInProgress, gpaTrend: record.terms.filter((t) => t.termGpa != null).map((t) => ({ term: t.term.code, termGpa: t.termGpa, cumulativeGpa: t.cumulativeGpa })) },
    currentClasses: registered.map((s) => sectionDto(s.section)),
    waitlisted: schedule.filter((s) => s.registrationStatus === 'WAITLISTED').map((s) => ({ ...sectionDto(s.section), waitlistPosition: s.waitlistPosition })),
    upcoming: upcoming.map((e) => ({ id: e.id, title: e.title, category: e.category, startDate: e.startDate })),
    unreadNotifications: unread,
    selfServiceRegistration: policies['registration.allowStudentSelfService'],
  } });
});

router.get('/profile', async (req, res) => res.json({ data: profileDto(await myStudent(req)) }));

// Students may update contact details only. Identity, status and academic fields are not accepted.
const contactSchema = z.object({
  preferredName: z.string().trim().max(80).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  personalEmail: z.string().trim().email().max(120).nullable().optional().or(z.literal('')),
  addressLine: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  region: z.string().trim().max(80).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  country: z.string().trim().max(60).nullable().optional(),
  emergencyContactName: z.string().trim().max(120).nullable().optional(),
  emergencyContactPhone: z.string().trim().max(30).nullable().optional(),
  emergencyContactRelation: z.string().trim().max(60).nullable().optional(),
}).strict('Only contact information can be changed here. Contact the registrar to change other details.');

router.patch('/profile', async (req, res) => {
  const changes = parse(contactSchema, req.body);
  if (changes.personalEmail === '') changes.personalEmail = null;
  const before = await prisma.student.findUnique({ where: { id: req.studentId } });
  await prisma.student.update({ where: { id: req.studentId }, data: changes });
  await audit(req.actor, { action: 'student.contact_updated', entityType: 'Student', entityId: req.studentId, summary: `Student updated own contact details (${Object.keys(changes).join(', ')})`, before: Object.fromEntries(Object.keys(changes).map((k) => [k, before[k]])), after: changes });
  res.json({ data: profileDto(await myStudent(req)) });
});

router.get('/schedule', async (req, res) => {
  const q = parse(z.object({ termId: id.optional() }), req.query);
  const term = q.termId ? await prisma.term.findFirst({ where: { id: q.termId, institutionId: req.user.institutionId } }) : await currentTerm(req.user.institutionId);
  const items = term ? await studentSchedule(req.studentId, term.id) : [];
  res.json({ data: { term: term ? { id: term.id, name: term.name, code: term.code } : null, classes: items.map((i) => ({ ...sectionDto(i.section), registrationId: i.registrationId, registrationStatus: i.registrationStatus, waitlistPosition: i.waitlistPosition })) } });
});

router.get('/registrations', async (req, res) => {
  const regs = await prisma.registration.findMany({
    where: { studentId: req.studentId },
    include: { section: { include: { course: true, term: true, meetings: true, instructors: { include: { faculty: true } } } }, grade: { select: { status: true } }, events: { orderBy: { createdAt: 'asc' } } },
    orderBy: [{ section: { term: { startDate: 'desc' } } }, { section: { course: { code: 'asc' } } }],
  });
  const now = new Date();
  res.json({ data: regs.map((r) => ({
    id: r.id, status: r.status, waitlistPosition: r.waitlistPosition, credits: r.creditsAttempted, registeredAt: r.registeredAt, statusChangedAt: r.statusChangedAt, source: r.source,
    section: sectionDto(r.section),
    term: { id: r.section.term.id, name: r.section.term.name, code: r.section.term.code },
    canDrop: ['REGISTERED', 'WAITLISTED'].includes(r.status) && (!r.grade || r.grade.status === 'DRAFT') && (r.status === 'WAITLISTED' || now <= r.section.term.withdrawDeadline),
    dropWillWithdraw: r.status === 'REGISTERED' && now > r.section.term.addDropDeadline,
    history: r.events.map((e) => ({ action: e.action, toStatus: e.toStatus, at: e.createdAt, reason: e.reason, actorType: e.actorType })),
  })) });
});

// Class search with per-section eligibility, so students see why they can or can't register before trying.
router.get('/class-search', async (req, res) => {
  const q = parse(z.object({ termId: id.optional(), search: z.string().max(100).optional(), departmentId: id.optional() }), req.query);
  const term = q.termId ? await prisma.term.findFirst({ where: { id: q.termId, institutionId: req.user.institutionId } }) : await prisma.term.findFirst({ where: { institutionId: req.user.institutionId, status: 'REGISTRATION_OPEN' }, orderBy: { startDate: 'asc' } }) ?? await currentTerm(req.user.institutionId);
  if (!term) return res.json({ data: { term: null, sections: [] } });
  const { rows } = await findSections(req.user.institutionId, { termId: term.id, search: q.search, departmentId: q.departmentId });
  const visible = rows.filter((s) => s.status !== 'CANCELLED').slice(0, 60);
  const results = [];
  for (const s of visible) {
    const ev = await evaluateRegistration({ institutionId: req.user.institutionId, studentId: req.studentId, sectionId: s.id });
    results.push({ ...sectionDto(s), description: s.course.description, eligibility: { outcome: ev.outcome, violations: ev.violations.map(({ code, message }) => ({ code, message })) } });
  }
  res.json({ data: { term: { id: term.id, name: term.name, code: term.code, status: term.status, registrationOpens: term.registrationOpens, registrationCloses: term.registrationCloses }, sections: results } });
});

async function assertSelfService(req) {
  const policies = await getPolicies(req.user.institutionId);
  if (!policies['registration.allowStudentSelfService']) throw ruleViolation('policy_disabled', 'Online self-registration is currently disabled. Contact the registrar.');
}

router.post('/registrations', async (req, res) => {
  await assertSelfService(req);
  // studentId is never taken from the request body.
  const { sectionId } = parse(z.object({ sectionId: id }).strict(), req.body);
  const reg = await registerStudent(req.actor, { studentId: req.studentId, sectionId, source: 'STUDENT_PORTAL' });
  res.status(201).json({ data: { id: reg.id, status: reg.status, waitlistPosition: reg.waitlistPosition } });
});

router.post('/registrations/:id/drop', async (req, res) => {
  await assertSelfService(req);
  const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }).strict(), req.body);
  const reg = await dropRegistration(req.actor, { registrationId: req.params.id, reason, studentScope: req.studentId });
  res.json({ data: { id: reg.id, status: reg.status } });
});

router.get('/grades', async (req, res) => {
  const record = await getAcademicRecord(req.studentId, req.user.institutionId);
  res.json({ data: record });
});

router.get('/transcript', async (req, res) => {
  const t = await getTranscript(req.studentId, req.user.institutionId);
  await audit(req.actor, { action: 'transcript.viewed', entityType: 'Student', entityId: req.studentId, summary: 'Viewed own unofficial transcript' });
  res.json({ data: t });
});

router.get('/degree-audit', async (req, res) => res.json({ data: await getDegreeAudit(req.studentId, req.user.institutionId) }));

router.get('/attendance', async (req, res) => {
  const policies = await getPolicies(req.user.institutionId);
  if (!policies['attendance.visibleToStudents']) return res.json({ data: [], hidden: true });
  const q = parse(z.object({ termId: id.optional() }), req.query);
  const term = q.termId ? { id: q.termId } : await currentTerm(req.user.institutionId);
  res.json({ data: await getStudentAttendance(req.studentId, term?.id) });
});

router.get('/document-requests', async (req, res) => {
  const rows = await prisma.documentRequest.findMany({ where: { studentId: req.studentId }, orderBy: { createdAt: 'desc' } });
  res.json({ data: rows });
});

router.post('/document-requests', async (req, res) => {
  const body = parse(z.object({
    type: z.enum(['OFFICIAL_TRANSCRIPT', 'ENROLLMENT_VERIFICATION', 'DEGREE_VERIFICATION']),
    recipient: z.string().trim().min(2).max(200),
    deliveryMethod: z.enum(['ELECTRONIC', 'MAIL', 'PICKUP']).default('ELECTRONIC'),
    copies: z.number().int().min(1).max(5).default(1),
    notes: z.string().trim().max(500).optional(),
  }).strict(), req.body);
  const student = await prisma.student.findUnique({ where: { id: req.studentId }, include: { holds: { where: { releasedAt: null, type: 'FINANCIAL' } } } });
  if (body.type === 'OFFICIAL_TRANSCRIPT' && student.holds.length) throw ruleViolation('financial_hold', 'Official transcripts cannot be requested while a financial hold is active.');
  const pending = await prisma.documentRequest.count({ where: { studentId: req.studentId, status: { in: ['PENDING', 'PROCESSING'] } } });
  if (pending >= 5) throw ruleViolation('too_many_requests', 'You already have 5 open requests.');
  const doc = await prisma.documentRequest.create({ data: { ...body, institutionId: req.user.institutionId, studentId: req.studentId } });
  await audit(req.actor, { action: 'document_request.created', entityType: 'DocumentRequest', entityId: doc.id, summary: `Requested ${body.type.replace(/_/g, ' ').toLowerCase()} for ${body.recipient}` });
  res.status(201).json({ data: doc });
});

export default router;
