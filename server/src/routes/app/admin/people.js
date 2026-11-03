import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { parse, id, isoDate, paginationQuery, sortQuery, paged } from '../../../lib/validate.js';
import { notFound, ruleViolation, forbidden } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { hashPassword, randomToken } from '../../../lib/crypto.js';
import { requirePermission } from '../../../lib/permissions.js';
import { findStudents, getStudent, findFaculty } from '../../../services/queryService.js';
import { getAcademicRecord, getDegreeAudit, getTranscript } from '../../../services/academicService.js';
import { notifyStudent } from '../../../services/notificationService.js';
import { nextStudentNumber } from '../../../services/studentService.js';
import { createPerson, nextEmployeeNumber, syncLogin, getPerson, personDto, mergeRecordIntoPerson, setIdentityExclusion } from '../../../services/personService.js';
import { effectiveRoles, roleInclude } from '../../../lib/roles.js';
import { getProvisioning, listProvisioning, requestRetry, confirmAdoption } from '../../../services/identityProvisioningService.js';
import { sectionDto } from '../../v1/dto.js';

const router = Router();
const inst = (req) => req.user.institutionId;

const STUDENT_STATUS = ['APPLICANT', 'ADMITTED', 'ACTIVE', 'LEAVE_OF_ABSENCE', 'SUSPENDED', 'WITHDRAWN', 'GRADUATED'];
const CLASS_LEVEL = ['FRESHMAN', 'SOPHOMORE', 'JUNIOR', 'SENIOR', 'GRADUATE'];
const STANDING = ['GOOD', 'DEANS_LIST', 'PROBATION', 'SUSPENSION'];

// Valid lifecycle transitions; prevents e.g. GRADUATED → APPLICANT.
const TRANSITIONS = {
  APPLICANT: ['ADMITTED', 'WITHDRAWN'],
  ADMITTED: ['ACTIVE', 'WITHDRAWN'],
  ACTIVE: ['LEAVE_OF_ABSENCE', 'SUSPENDED', 'WITHDRAWN', 'GRADUATED'],
  LEAVE_OF_ABSENCE: ['ACTIVE', 'WITHDRAWN'],
  SUSPENDED: ['ACTIVE', 'WITHDRAWN'],
  WITHDRAWN: ['ACTIVE'],
  GRADUATED: [],
};

const tempPassword = () => `Cc-${randomToken(9)}`;


const studentListRow = (s) => ({
  id: s.id, studentNumber: s.studentNumber, firstName: s.firstName, lastName: s.lastName, preferredName: s.preferredName, email: s.email,
  status: s.status, classLevel: s.classLevel, academicStanding: s.academicStanding,
  program: s.program ? { id: s.program.id, code: s.program.code, name: s.program.name } : null,
  activeHolds: s.holds.length, updatedAt: s.updatedAt,
});

const studentQuery = paginationQuery.extend({
  search: z.string().max(100).optional(),
  status: z.enum(STUDENT_STATUS).optional(),
  programId: id.optional(),
  classLevel: z.enum(CLASS_LEVEL).optional(),
  standing: z.enum(STANDING).optional(),
  hasHold: z.enum(['true']).optional(),
  sort: sortQuery(['lastName', 'firstName', 'studentNumber', 'updatedAt', 'createdAt', 'status'], 'lastName'),
});

// ── Students ──
router.get('/students', requirePermission('students.manage'), async (req, res) => {
  const q = parse(studentQuery, req.query);
  const { rows, total } = await findStudents(inst(req), q);
  res.json(paged(rows.map(studentListRow), total, q));
});

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/students/export', requirePermission('students.export'), async (req, res) => {
  const q = parse(studentQuery.omit({ page: true, pageSize: true }), req.query);
  const { rows } = await findStudents(inst(req), q);
  const header = ['Student Number', 'Last Name', 'First Name', 'Preferred Name', 'Email', 'Program', 'Status', 'Class Level', 'Academic Standing', 'Active Holds'];
  const lines = rows.map((s) => [s.studentNumber, s.lastName, s.firstName, s.preferredName, s.email, s.program?.name, s.status, s.classLevel, s.academicStanding, s.holds.length].map(csvCell).join(','));
  await audit(req.actor, { action: 'students.exported', entityType: 'Student', summary: `Exported ${rows.length} student record(s) to CSV`, after: { filters: q } });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="students-${new Date().toISOString().slice(0, 10)}.csv"`).set('Cache-Control', 'no-store');
  res.send([header.join(','), ...lines].join('\n'));
});

const studentBody = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  preferredName: z.string().trim().max(80).nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(120),
  personalEmail: z.string().trim().email().max(120).nullable().optional().or(z.literal('').transform(() => null)),
  phone: z.string().trim().max(30).nullable().optional(),
  dateOfBirth: isoDate.nullable().optional(),
  addressLine: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  region: z.string().trim().max(80).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  country: z.string().trim().max(60).nullable().optional(),
  emergencyContactName: z.string().trim().max(120).nullable().optional(),
  emergencyContactPhone: z.string().trim().max(30).nullable().optional(),
  emergencyContactRelation: z.string().trim().max(60).nullable().optional(),
  programId: id.nullable().optional(),
  classLevel: z.enum(CLASS_LEVEL).optional(),
  admitTermId: id.nullable().optional(),
  expectedGraduation: z.string().trim().max(20).nullable().optional(),
  financialAccountRef: z.string().trim().max(60).nullable().optional(),
  financialAidStatus: z.string().trim().max(60).nullable().optional(),
});

async function assertRefs(institutionId, { programId, admitTermId }) {
  if (programId && !(await prisma.program.findFirst({ where: { id: programId, institutionId } }))) throw notFound('Program');
  if (admitTermId && !(await prisma.term.findFirst({ where: { id: admitTermId, institutionId } }))) throw notFound('Term');
}

router.post('/students', requirePermission('students.manage'), async (req, res) => {
  // `personOfFacultyId`: enrol an existing faculty member as a student. The new student record joins that faculty
  // member's Person (and their CampusCore login, if they have one) instead of creating a new person, so every
  // system can tell that the two records are one human being.
  const body = parse(studentBody.extend({ status: z.enum(['ADMITTED', 'ACTIVE']).default('ACTIVE'), createLogin: z.boolean().default(true), personOfFacultyId: z.string().trim().min(1).max(64).optional() }).strict(), req.body);
  await assertRefs(inst(req), body);
  const { createLogin: wantsLogin, personOfFacultyId, dateOfBirth, ...data } = body;
  let existingPerson = null;
  if (personOfFacultyId) {
    const faculty = await prisma.faculty.findFirst({ where: { id: personOfFacultyId, institutionId: inst(req) }, include: { person: { include: { student: { select: { id: true } } } } } });
    if (!faculty) throw notFound('Faculty member');
    if (faculty.person.student) throw ruleViolation('person_already_student', 'This person already has a student record.');
    existingPerson = { id: faculty.personId, userId: faculty.userId };
  }
  const createLogin = wantsLogin && !existingPerson;
  const password = createLogin ? tempPassword() : null;
  const student = await prisma.$transaction(async (tx) => {
    const personId = existingPerson?.id ?? (await createPerson(tx, inst(req))).id;
    let userId = existingPerson?.userId ?? null;
    if (createLogin) {
      const user = await tx.user.create({ data: { institutionId: inst(req), personId, email: data.email, passwordHash: await hashPassword(password), firstName: data.firstName, lastName: data.lastName, role: 'STUDENT' } });
      userId = user.id;
    }
    const s = await tx.student.create({ data: { ...data, dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null, institutionId: inst(req), personId, userId, studentNumber: await nextStudentNumber(inst(req), tx) } });
    await audit(req.actor, { action: 'student.created', entityType: 'Student', entityId: s.id, summary: `Created student ${s.firstName} ${s.lastName} (${s.studentNumber})${createLogin ? ' with portal login' : ''}${existingPerson ? ` for existing faculty member ${personOfFacultyId} (same person)` : ''}` }, tx);
    return s;
  });
  res.status(201).json({ data: { id: student.id, studentNumber: student.studentNumber }, temporaryPassword: password });
});

router.get('/students/:id', requirePermission('students.manage'), async (req, res) => {
  const s = await getStudent(inst(req), req.params.id);
  const [record, registrations, documents, application] = await Promise.all([
    getAcademicRecord(s.id, inst(req)),
    prisma.registration.findMany({ where: { studentId: s.id }, include: { grade: true, section: { include: { course: true, term: true, meetings: true, instructors: { include: { faculty: true } } } } }, orderBy: [{ section: { term: { startDate: 'desc' } } }, { section: { course: { code: 'asc' } } }] }),
    prisma.documentRequest.findMany({ where: { studentId: s.id }, orderBy: { createdAt: 'desc' } }),
    prisma.application.findFirst({ where: { studentId: s.id } }),
  ]);
  const { user, ...rest } = s;
  res.json({ data: {
    ...rest,
    login: user ? { email: user.email, status: user.status, lastLoginAt: user.lastLoginAt, userId: user.id } : null,
    record: { cumulativeGpa: record.cumulativeGpa, creditsEarned: record.creditsEarned, creditsAttempted: record.creditsAttempted, creditsInProgress: record.creditsInProgress, terms: record.terms.map((t) => ({ term: t.term, termGpa: t.termGpa, cumulativeGpa: t.cumulativeGpa, creditsEarned: t.creditsEarned })) },
    registrations: registrations.map((r) => ({ id: r.id, status: r.status, waitlistPosition: r.waitlistPosition, source: r.source, registeredAt: r.registeredAt, credits: r.creditsAttempted, grade: r.grade ? { letter: r.grade.letter, status: r.grade.status } : null, term: { id: r.section.term.id, code: r.section.term.code, name: r.section.term.name }, section: sectionDto(r.section) })),
    documents,
    application: application ? { id: application.id, applicationNumber: application.applicationNumber, submittedAt: application.submittedAt, decisionAt: application.decisionAt } : null,
    allowedTransitions: TRANSITIONS[s.status],
  } });
});

router.patch('/students/:id', requirePermission('students.manage'), async (req, res) => {
  const body = parse(studentBody.partial().extend({ academicStanding: z.enum(STANDING).optional() }).strict(), req.body);
  const before = await getStudent(inst(req), req.params.id);
  await assertRefs(inst(req), body);
  const data = { ...body, ...(body.dateOfBirth !== undefined ? { dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null } : {}) };
  const s = await prisma.$transaction(async (tx) => {
    const updated = await tx.student.update({ where: { id: before.id }, data });
    if (body.email) await syncLogin(tx, before.personId);
    const changed = Object.keys(body).filter((k) => String(before[k] ?? '') !== String(body[k] ?? ''));
    await audit(req.actor, { action: 'student.updated', entityType: 'Student', entityId: before.id, summary: `Updated ${before.studentNumber}: ${changed.join(', ') || 'no changes'}`, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, body[k]])) }, tx);
    return updated;
  });
  res.json({ data: { id: s.id } });
});

router.post('/students/:id/status', requirePermission('students.manage'), async (req, res) => {
  const body = parse(z.object({ status: z.enum(STUDENT_STATUS), reason: z.string().trim().min(3).max(500) }), req.body);
  const s = await getStudent(inst(req), req.params.id);
  if (!TRANSITIONS[s.status].includes(body.status)) throw ruleViolation('invalid_transition', `Cannot change status from ${s.status} to ${body.status}. Allowed: ${TRANSITIONS[s.status].join(', ') || 'none'}.`);
  if (body.status === 'GRADUATED') {
    const audit_ = await getDegreeAudit(s.id, inst(req));
    if (!audit_.eligibleToGraduate) throw ruleViolation('not_eligible_to_graduate', 'Student does not meet graduation requirements.', audit_.checks.filter((c) => !c.met));
  }
  await prisma.$transaction(async (tx) => {
    await tx.student.update({ where: { id: s.id }, data: { status: body.status } });
    await audit(req.actor, { action: 'student.status_changed', entityType: 'Student', entityId: s.id, summary: `Changed status of ${s.studentNumber} from ${s.status} to ${body.status}: ${body.reason}`, before: { status: s.status }, after: { status: body.status, reason: body.reason } }, tx);
  });
  res.json({ ok: true });
});

router.get('/students/:id/transcript', requirePermission('students.manage'), async (req, res) => {
  const t = await getTranscript(req.params.id, inst(req));
  await audit(req.actor, { action: 'transcript.viewed', entityType: 'Student', entityId: req.params.id, summary: `Viewed unofficial transcript for ${t.student.studentNumber}` });
  res.json({ data: t });
});

router.get('/students/:id/degree-audit', requirePermission('students.manage'), async (req, res) => {
  res.json({ data: await getDegreeAudit(req.params.id, inst(req)) });
});

router.post('/students/:id/login', requirePermission('users.manage'), async (req, res) => {
  const s = await getStudent(inst(req), req.params.id);
  if (s.userId) throw ruleViolation('login_exists', 'This student already has a portal login.');
  // A person who already signs in (e.g. as faculty) keeps that one login; the student record joins it.
  const personLogin = await prisma.user.findUnique({ where: { personId: s.personId }, select: { id: true, email: true } });
  if (personLogin) {
    await prisma.$transaction(async (tx) => {
      await tx.student.update({ where: { id: s.id }, data: { userId: personLogin.id } });
      await audit(req.actor, { action: 'user.record_attached', entityType: 'User', entityId: personLogin.id, summary: `Attached student ${s.studentNumber} to the person's existing login ${personLogin.email}` }, tx);
    });
    return res.status(200).json({ attachedTo: personLogin.email, temporaryPassword: null });
  }
  const password = tempPassword();
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { institutionId: inst(req), personId: s.personId, email: s.email, passwordHash: await hashPassword(password), firstName: s.firstName, lastName: s.lastName, role: 'STUDENT' } });
    await tx.student.update({ where: { id: s.id }, data: { userId: user.id } });
    await audit(req.actor, { action: 'user.created', entityType: 'User', entityId: user.id, summary: `Created portal login for student ${s.studentNumber}` }, tx);
  });
  res.status(201).json({ temporaryPassword: password });
});

// ── Holds ──
router.post('/students/:id/holds', requirePermission('students.manage'), async (req, res) => {
  const body = parse(z.object({ type: z.enum(['FINANCIAL', 'ACADEMIC', 'ADVISING', 'ADMINISTRATIVE', 'IMMUNIZATION']), reason: z.string().trim().min(3).max(300), blocksRegistration: z.boolean().default(true) }), req.body);
  const s = await getStudent(inst(req), req.params.id);
  const hold = await prisma.hold.create({ data: { ...body, studentId: s.id, placedById: req.user.id } });
  await audit(req.actor, { action: 'hold.placed', entityType: 'Hold', entityId: hold.id, summary: `Placed ${body.type.toLowerCase()} hold on ${s.studentNumber}: ${body.reason}` });
  await notifyStudent(s.id, { title: 'A hold was placed on your account', body: `${body.type.toLowerCase()} hold: ${body.reason}`, link: '/student/profile' });
  res.status(201).json({ data: hold });
});

router.post('/holds/:id/release', requirePermission('students.manage'), async (req, res) => {
  const hold = await prisma.hold.findFirst({ where: { id: req.params.id, student: { institutionId: inst(req) } }, include: { student: true } });
  if (!hold) throw notFound('Hold');
  if (hold.releasedAt) throw ruleViolation('already_released', 'This hold has already been released.');
  await prisma.hold.update({ where: { id: hold.id }, data: { releasedAt: new Date(), releasedById: req.user.id } });
  await audit(req.actor, { action: 'hold.released', entityType: 'Hold', entityId: hold.id, summary: `Released ${hold.type.toLowerCase()} hold on ${hold.student.studentNumber}` });
  await notifyStudent(hold.studentId, { title: 'Hold released', body: `Your ${hold.type.toLowerCase()} hold has been released.`, link: '/student/profile' });
  res.json({ ok: true });
});

// ── Faculty ──
const facultyRow = (f) => ({ id: f.id, personId: f.personId, employeeNumber: f.employeeNumber, firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone, title: f.title, status: f.status, department: { id: f.department.id, code: f.department.code, name: f.department.name }, officeLocation: f.officeLocation, officeHours: f.officeHours, hasLogin: !!f.user, lastLoginAt: f.user?.lastLoginAt ?? null });

router.get('/faculty', requirePermission('academics.manage'), async (req, res) => {
  const q = parse(paginationQuery.extend({ search: z.string().max(100).optional(), departmentId: id.optional(), sort: sortQuery(['lastName', 'firstName', 'employeeNumber'], 'lastName') }), req.query);
  const { rows, total } = await findFaculty(inst(req), q);
  res.json(paged(rows.map(facultyRow), total, q));
});

router.get('/faculty/:id', requirePermission('academics.manage'), async (req, res) => {
  const f = await prisma.faculty.findFirst({ where: { id: req.params.id, institutionId: inst(req) }, include: { department: true, user: true, sections: { include: { section: { include: { course: true, term: true, meetings: true, instructors: { include: { faculty: true } } } } } } } });
  if (!f) throw notFound('Faculty member');
  res.json({ data: { ...facultyRow(f), sections: f.sections.map((si) => sectionDto(si.section)).sort((a, b) => (b.termCode ?? '').localeCompare(a.termCode ?? '')) } });
});

const facultyBody = z.object({
  firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(120), phone: z.string().trim().max(30).nullable().optional(),
  title: z.string().trim().min(2).max(80), departmentId: id,
  officeLocation: z.string().trim().max(80).nullable().optional(), officeHours: z.string().trim().max(120).nullable().optional(),
});

router.post('/faculty', requirePermission('faculty.manage'), async (req, res) => {
  // `personOfStudentId`: appoint an existing student (e.g. a teaching assistant) as faculty. The faculty record
  // joins that student's Person and login instead of creating a second person.
  const body = parse(facultyBody.extend({ createLogin: z.boolean().default(true), personOfStudentId: z.string().trim().min(1).max(64).optional() }).strict(), req.body);
  if (!(await prisma.department.findFirst({ where: { id: body.departmentId, institutionId: inst(req) } }))) throw notFound('Department');
  const { createLogin: wantsLogin, personOfStudentId, ...data } = body;
  let existingPerson = null;
  if (personOfStudentId) {
    const student = await prisma.student.findFirst({ where: { id: personOfStudentId, institutionId: inst(req) }, include: { person: { include: { faculty: { select: { id: true } } } } } });
    if (!student) throw notFound('Student');
    if (student.person.faculty) throw ruleViolation('person_already_faculty', 'This person already has a faculty record.');
    existingPerson = { id: student.personId, userId: student.userId };
  }
  const createLogin = wantsLogin && !existingPerson;
  const password = createLogin ? tempPassword() : null;
  const f = await prisma.$transaction(async (tx) => {
    const personId = existingPerson?.id ?? (await createPerson(tx, inst(req))).id;
    const user = createLogin ? await tx.user.create({ data: { institutionId: inst(req), personId, email: data.email, passwordHash: await hashPassword(password), firstName: data.firstName, lastName: data.lastName, role: 'FACULTY' } }) : null;
    const created = await tx.faculty.create({ data: { ...data, institutionId: inst(req), personId, userId: user?.id ?? existingPerson?.userId ?? null, employeeNumber: await nextEmployeeNumber(inst(req), tx) } });
    await audit(req.actor, { action: 'faculty.created', entityType: 'Faculty', entityId: created.id, summary: `Created faculty member ${data.firstName} ${data.lastName}${existingPerson ? ` for existing student ${personOfStudentId} (same person)` : ''}` }, tx);
    return created;
  });
  res.status(201).json({ data: { id: f.id, employeeNumber: f.employeeNumber }, temporaryPassword: password });
});

router.patch('/faculty/:id', requirePermission('faculty.manage'), async (req, res) => {
  const body = parse(facultyBody.partial().extend({ status: z.enum(['ACTIVE', 'DISABLED']).optional() }).strict(), req.body);
  const before = await prisma.faculty.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!before) throw notFound('Faculty member');
  if (body.departmentId && !(await prisma.department.findFirst({ where: { id: body.departmentId, institutionId: inst(req) } }))) throw notFound('Department');
  await prisma.$transaction(async (tx) => {
    await tx.faculty.update({ where: { id: before.id }, data: body });
    if (body.email || body.status) await syncLogin(tx, before.personId, { access: Boolean(body.status) });
    await audit(req.actor, { action: 'faculty.updated', entityType: 'Faculty', entityId: before.id, summary: `Updated faculty ${before.firstName} ${before.lastName}: ${Object.keys(body).join(', ')}`, after: body }, tx);
  });
  res.json({ ok: true });
});

// ── Person registry ──
// The person a record belongs to, with all of their relationships (shown on student and faculty detail pages).
router.get('/persons/:id', requirePermission('identity.manage'), async (req, res) => {
  res.json({ data: personDto(await getPerson(inst(req), req.params.id)) });
});

// Include or exclude a person from identity provisioning (university account, portal accounts). Records stay.
router.put('/persons/:id/identity-exclusion', requirePermission('identity.manage'), async (req, res) => {
  const body = parse(z.object({ excluded: z.boolean(), reason: z.string().trim().min(10, 'Give a reason (at least 10 characters).').max(500) }).strict(), req.body);
  await setIdentityExclusion(req.actor, [req.params.id], body, audit);
  res.json({ data: personDto(await getPerson(inst(req), req.params.id)) });
});

// "Same person": an administrator confirms that a student or faculty record belongs to another person (the same
// human being registered twice). Audited; never automatic and never decided on name or email.
router.post('/persons/:id/records', requirePermission('identity.manage'), async (req, res) => {
  const body = parse(z.object({ recordType: z.enum(['STUDENT', 'FACULTY']), recordId: id, reason: z.string().trim().min(10, 'Say how you verified it is the same person (at least 10 characters).').max(500) }).strict(), req.body);
  const result = await mergeRecordIntoPerson(req.actor, { ...body, intoPersonId: req.params.id }, audit);
  res.json({ data: result });
});

// ── University accounts (identity provider) ──
// Provisioning is automatic (services/identityProvisioningService.js); these show where a person's account stands
// and let an administrator act when the worker could not decide or gave up.
router.get('/identity-provisioning', requirePermission('identity.manage'), async (req, res) => {
  const q = parse(paginationQuery.extend({ status: z.enum(['PENDING', 'PROCESSING', 'PROVISIONED', 'FAILED', 'NEEDS_REVIEW', 'SKIPPED']).optional() }), req.query);
  const { rows, total } = await listProvisioning(inst(req), q);
  res.json(paged(rows, total, q));
});

router.get('/persons/:id/identity-provisioning', requirePermission('identity.manage'), async (req, res) => {
  res.json({ data: await getProvisioning(inst(req), req.params.id) });
});

router.post('/persons/:id/identity-provisioning/retry', requirePermission('identity.manage'), async (req, res) => {
  parse(z.object({}).strict(), req.body ?? {});
  res.json({ data: await requestRetry(req.actor, req.params.id) });
});

// Adopting an existing account decides who can sign in as this person, so it is an administrator's decision only.
router.post('/persons/:id/identity-provisioning/adopt', requirePermission('users.manage'), async (req, res) => {
  const body = parse(z.object({ accountId: z.string().trim().uuid('Paste the account\'s ID from Keycloak (Users → the account → ID).'), reason: z.string().trim().min(10, 'Say how you verified the account is this person\'s (at least 10 characters).').max(500) }).strict(), req.body);
  res.json({ data: await confirmAdoption(req.actor, req.params.id, body) });
});

// ── Users & roles ──
router.get('/users', requirePermission('users.manage'), async (req, res) => {
  const q = parse(paginationQuery.extend({ search: z.string().max(100).optional(), role: z.enum(['ADMIN', 'REGISTRAR', 'FACULTY', 'STUDENT']).optional() }), req.query);
  // Staff roles are granted to the account; Student/Faculty come from its records (an account may hold both).
  const roleWhere = { ADMIN: { role: 'ADMIN' }, REGISTRAR: { role: 'REGISTRAR' }, FACULTY: { faculty: { isNot: null } }, STUDENT: { student: { isNot: null } } }[q.role] ?? {};
  const where = { institutionId: inst(req), ...roleWhere, ...(q.search ? { OR: [{ email: { contains: q.search, mode: 'insensitive' } }, { firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }] } : {}) };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: [{ role: 'asc' }, { lastName: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, email: true, firstName: true, lastName: true, role: true, status: true, lastLoginAt: true, createdAt: true, lockedUntil: true, passwordHash: true, person: { select: { personNumber: true } }, ...roleInclude } }),
    prisma.user.count({ where }),
  ]);
  res.json(paged(rows.map(({ passwordHash, student, faculty, person, ...u }) => ({ ...u, roles: effectiveRoles({ role: u.role, student, faculty }), personNumber: person?.personNumber ?? null, hasPassword: Boolean(passwordHash) })), total, q));
});

router.post('/users', requirePermission('users.manage'), async (req, res) => {
  // Staff accounts only; student and faculty logins are created with their records.
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80), role: z.enum(['ADMIN', 'REGISTRAR']) }).strict(), req.body);
  const password = tempPassword();
  const user = await prisma.user.create({ data: { ...body, institutionId: inst(req), passwordHash: await hashPassword(password) } });
  await audit(req.actor, { action: 'user.created', entityType: 'User', entityId: user.id, summary: `Created ${body.role.toLowerCase()} account ${body.email}` });
  res.status(201).json({ data: { id: user.id }, temporaryPassword: password });
});

router.patch('/users/:id', requirePermission('users.manage'), async (req, res) => {
  const body = parse(z.object({ role: z.enum(['ADMIN', 'REGISTRAR']).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), unlock: z.boolean().optional() }).strict(), req.body);
  const user = await prisma.user.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!user) throw notFound('User');
  if (user.id === req.user.id && (body.status === 'DISABLED' || (body.role && body.role !== user.role))) throw forbidden('You cannot disable or change the role of your own account.');
  // Students and faculty are tied to their records; only staff roles are interchangeable.
  if (body.role && !['ADMIN', 'REGISTRAR'].includes(user.role)) throw ruleViolation('role_locked', 'Student and faculty account roles are determined by their records.');
  const data = { ...(body.role ? { role: body.role } : {}), ...(body.status ? { status: body.status } : {}), ...(body.unlock ? { lockedUntil: null, failedLogins: 0 } : {}) };
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data });
    if (body.status === 'DISABLED' || body.role) await tx.session.deleteMany({ where: { userId: user.id } });
    await audit(req.actor, { action: 'user.updated', entityType: 'User', entityId: user.id, summary: `Updated account ${user.email}: ${JSON.stringify(body)}`, before: { role: user.role, status: user.status }, after: data }, tx);
  });
  res.json({ ok: true });
});

router.post('/users/:id/reset-password', requirePermission('users.manage'), async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!user) throw notFound('User');
  const password = tempPassword();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await audit(req.actor, { action: 'user.password_reset', entityType: 'User', entityId: user.id, summary: `Reset password for ${user.email}; all sessions signed out` }, tx);
  });
  res.json({ temporaryPassword: password });
});

// ── University sign-in links (OpenID Connect) ──
// A link proves which university sign-in belongs to this account; it never changes the account's role.
// Staff (ADMIN/REGISTRAR) accounts can use university sign-in only through a link made here by another
// administrator; student and faculty accounts are also linked automatically from verified IDs.
router.get('/users/:id/identity-links', requirePermission('users.manage'), async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, institutionId: inst(req) }, select: { id: true } });
  if (!user) throw notFound('User');
  const rows = await prisma.userIdentityLink.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' }, select: { id: true, issuer: true, subject: true, linkMethod: true, note: true, createdAt: true, lastLoginAt: true } });
  res.json({ data: rows });
});

router.post('/users/:id/identity-links', requirePermission('users.manage'), async (req, res) => {
  const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, '');
  if (!issuer) throw ruleViolation('sso_not_configured', 'University sign-in is not configured.');
  const body = parse(z.object({ subject: z.string().trim().min(1).max(255).regex(/^[\x21-\x7e]+$/), note: z.string().trim().min(10, 'Say how you verified that this sign-in belongs to this person.').max(300) }).strict(), req.body);
  const user = await prisma.user.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!user) throw notFound('User');
  if (user.id === req.user.id) throw forbidden('Another administrator must link your own account.');
  if (await prisma.userIdentityLink.findUnique({ where: { userId_issuer: { userId: user.id, issuer } } })) throw ruleViolation('already_linked', 'This account already has a university sign-in. Remove it first.');
  if (await prisma.userIdentityLink.findUnique({ where: { issuer_subject: { issuer, subject: body.subject } } })) throw ruleViolation('identity_in_use', 'This university sign-in is already linked to an account.');
  const link = await prisma.$transaction(async (tx) => {
    const created = await tx.userIdentityLink.create({ data: { userId: user.id, issuer, subject: body.subject, linkMethod: 'ADMIN_VERIFIED', note: body.note, createdById: req.user.id } });
    await audit(req.actor, { action: 'user.sso_linked', entityType: 'User', entityId: user.id, summary: `Linked a university sign-in to ${user.email} (administrator verified: ${body.note})` }, tx);
    return created;
  });
  res.status(201).json({ data: { id: link.id } });
});

router.delete('/users/:id/identity-links/:linkId', requirePermission('users.manage'), async (req, res) => {
  const link = await prisma.userIdentityLink.findFirst({ where: { id: req.params.linkId, userId: req.params.id, user: { institutionId: inst(req) } }, include: { user: true } });
  if (!link) throw notFound('Identity link');
  await prisma.$transaction(async (tx) => {
    await tx.userIdentityLink.delete({ where: { id: link.id } });
    // Sessions that began with this sign-in end now.
    await tx.session.deleteMany({ where: { userId: link.userId, oidcIssuer: link.issuer, oidcSubject: link.subject } });
    await audit(req.actor, { action: 'user.sso_unlinked', entityType: 'User', entityId: link.userId, summary: `Removed the university sign-in of ${link.user.email}; its sessions were signed out` }, tx);
  });
  res.json({ ok: true });
});

// ── Admissions ──
router.get('/applications', requirePermission('admissions.manage'), async (req, res) => {
  const q = parse(paginationQuery.extend({ status: z.enum(['SUBMITTED', 'UNDER_REVIEW', 'ADMITTED', 'WAITLISTED', 'REJECTED', 'MATRICULATED', 'WITHDRAWN']).optional(), termId: id.optional(), search: z.string().max(100).optional() }), req.query);
  const where = { institutionId: inst(req), ...(q.status ? { status: q.status } : {}), ...(q.termId ? { termId: q.termId } : {}), ...(q.search ? { OR: [{ firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }, { applicationNumber: { contains: q.search, mode: 'insensitive' } }] } : {}) };
  const [rows, total, counts] = await Promise.all([
    prisma.application.findMany({ where, include: { program: true, term: true, student: { select: { id: true, studentNumber: true } } }, orderBy: { submittedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.application.count({ where }),
    prisma.application.groupBy({ by: ['status'], where: { institutionId: inst(req) }, _count: true }),
  ]);
  res.json({ ...paged(rows.map((a) => ({ ...a, priorGpa: a.priorGpa ? Number(a.priorGpa) : null })), total, q), counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) });
});

router.post('/applications', requirePermission('admissions.manage'), async (req, res) => {
  const body = parse(z.object({ firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80), email: z.string().trim().toLowerCase().email(), phone: z.string().trim().max(30).optional(), programId: id, termId: id, priorGpa: z.number().min(0).max(4).optional(), notes: z.string().max(1000).optional() }).strict(), req.body);
  await assertRefs(inst(req), { programId: body.programId, admitTermId: body.termId });
  const count = await prisma.application.count({ where: { institutionId: inst(req) } });
  const a = await prisma.application.create({ data: { ...body, institutionId: inst(req), applicationNumber: `APP-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}` } });
  await audit(req.actor, { action: 'application.created', entityType: 'Application', entityId: a.id, summary: `Recorded application ${a.applicationNumber} for ${a.firstName} ${a.lastName}` });
  res.status(201).json({ data: a });
});

const DECISIONS = { SUBMITTED: ['UNDER_REVIEW', 'WITHDRAWN'], UNDER_REVIEW: ['ADMITTED', 'WAITLISTED', 'REJECTED', 'WITHDRAWN'], WAITLISTED: ['ADMITTED', 'REJECTED', 'WITHDRAWN'], ADMITTED: ['WITHDRAWN'], REJECTED: [], MATRICULATED: [], WITHDRAWN: [] };

router.post('/applications/:id/decision', requirePermission('admissions.manage'), async (req, res) => {
  const body = parse(z.object({ status: z.enum(['UNDER_REVIEW', 'ADMITTED', 'WAITLISTED', 'REJECTED', 'WITHDRAWN']), notes: z.string().max(1000).optional() }), req.body);
  const a = await prisma.application.findFirst({ where: { id: req.params.id, institutionId: inst(req) } });
  if (!a) throw notFound('Application');
  if (!DECISIONS[a.status].includes(body.status)) throw ruleViolation('invalid_transition', `Cannot move an application from ${a.status} to ${body.status}.`);
  await prisma.application.update({ where: { id: a.id }, data: { status: body.status, notes: body.notes ?? a.notes, ...(['ADMITTED', 'REJECTED', 'WAITLISTED'].includes(body.status) ? { decisionAt: new Date(), decisionById: req.user.id } : {}) } });
  await audit(req.actor, { action: 'application.decision', entityType: 'Application', entityId: a.id, summary: `Application ${a.applicationNumber}: ${a.status} → ${body.status}`, before: { status: a.status }, after: { status: body.status } });
  res.json({ ok: true });
});

// Matriculation converts an admitted applicant into a student record (status ADMITTED) with a portal login.
router.post('/applications/:id/matriculate', requirePermission('admissions.manage'), async (req, res) => {
  const a = await prisma.application.findFirst({ where: { id: req.params.id, institutionId: inst(req) }, include: { program: true, term: true } });
  if (!a) throw notFound('Application');
  if (a.status !== 'ADMITTED') throw ruleViolation('not_admitted', 'Only admitted applicants can be matriculated.');
  const password = tempPassword();
  const result = await prisma.$transaction(async (tx) => {
    const studentNumber = await nextStudentNumber(inst(req), tx);
    const institution = await tx.institution.findUnique({ where: { id: inst(req) } });
    if (!institution.studentEmailDomain) throw ruleViolation('email_domain_not_configured', 'Set the institution\'s student email domain before matriculating students.');
    const email = `${a.firstName}.${a.lastName}.${studentNumber.slice(-3)}@${institution.studentEmailDomain}`.toLowerCase().replace(/[^a-z0-9.@-]/g, '');
    const person = await createPerson(tx, inst(req));
    const user = await tx.user.create({ data: { institutionId: inst(req), personId: person.id, email, passwordHash: await hashPassword(password), firstName: a.firstName, lastName: a.lastName, role: 'STUDENT' } });
    const s = await tx.student.create({ data: { institutionId: inst(req), personId: person.id, userId: user.id, studentNumber, firstName: a.firstName, lastName: a.lastName, email, personalEmail: a.email, phone: a.phone, programId: a.programId, admitTermId: a.termId, status: 'ADMITTED', classLevel: a.program.level === 'GRADUATE' ? 'GRADUATE' : 'FRESHMAN' } });
    await tx.application.update({ where: { id: a.id }, data: { status: 'MATRICULATED', studentId: s.id } });
    await audit(req.actor, { action: 'application.matriculated', entityType: 'Application', entityId: a.id, summary: `Matriculated ${a.applicationNumber} as student ${studentNumber}` }, tx);
    return { student: s, email };
  });
  res.status(201).json({ data: { studentId: result.student.id, studentNumber: result.student.studentNumber, email: result.email }, temporaryPassword: password });
});

export default router;
