// Integration API: student record writes. Registered directly on the v1 router.
//   POST  /students                    students:create      + api.allowStudentCreation      (Idempotency-Key required)
//   PATCH /students/:id                field-level: students:write (contact, legacy) | students:update | students:academic
//   POST  /students/:id/deactivate     students:deactivate  + api.allowStudentDeactivation  (Idempotency-Key optional)
//   GET   /students/:id/audit          audit:read
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse, id, isoDate, paginationQuery, paged } from '../../lib/validate.js';
import { requireScope } from '../../middleware/integrationAuth.js';
import { AppError, ruleViolation } from '../../lib/errors.js';
import { idempotent } from '../../middleware/idempotency.js';
import { assertOperation, authorizeStudentFields } from '../../services/capabilityService.js';
import { createStudent, updateStudent, deactivateStudent, etagFor } from '../../services/studentService.js';
import { getStudent } from '../../services/queryService.js';
import { studentDto } from './dto.js';

const str = (max) => z.string().trim().max(max);
const nullableStr = (max) => str(max).nullable().optional();

const contactShape = {
  preferredName: nullableStr(80), phone: nullableStr(30), personalEmail: z.string().trim().email().max(120).nullable().optional(),
  addressLine: nullableStr(200), city: nullableStr(80), region: nullableStr(80), postalCode: nullableStr(20), country: nullableStr(60),
  emergencyContactName: nullableStr(120), emergencyContactPhone: nullableStr(30), emergencyContactRelation: nullableStr(60),
};
// Every field that can ever be written through the API. Anything else (studentNumber, status, standing, class level,
// email, financial references…) is rejected with 400 by the strict schema.
const patchSchema = z.object({
  ...contactShape,
  firstName: str(80).min(1).optional(), lastName: str(80).min(1).optional(), dateOfBirth: isoDate.nullable().optional(),
  programId: id.nullable().optional(), admitTermId: id.nullable().optional(), expectedGraduation: z.string().trim().regex(/^(Spring|Summer|Fall|Winter) \d{4}$/, 'Use "Spring 2028"').nullable().optional(),
}).strict('Only profile, contact and approved academic fields can be written through the API. Identity numbers, status, standing, class level and institutional email are managed by the registrar.');

const createSchema = z.object({
  firstName: str(80).min(1), lastName: str(80).min(1), email: z.string().trim().toLowerCase().email().max(120),
  studentNumber: z.string().trim().regex(/^[A-Z0-9-]{4,20}$/, 'Use 4–20 uppercase letters, digits or hyphens').optional(),
  programId: id, admitTermId: id.optional(), status: z.enum(['ADMITTED', 'ACTIVE']).default('ADMITTED'),
  dateOfBirth: isoDate.optional(), expectedGraduation: z.string().trim().regex(/^(Spring|Summer|Fall|Winter) \d{4}$/).optional(),
  ...contactShape,
}).strict();

const full = (s) => ({ ...studentDto(s), program: s.program ? { id: s.program.id, code: s.program.code, name: s.program.name, degreeType: s.program.degreeType } : null });

export function registerStudentWriteRoutes(router) {
  router.post('/students', requireScope('students:create'), idempotent({ required: true }), async (req, res) => {
    await assertOperation(req, 'student.create');
    const body = parse(createSchema, req.body);
    const s = await createStudent(req.actor, body);
    res.status(201).location(`/api/v1/students/${s.id}`).set('ETag', etagFor(s)).json({ data: full(s) });
  });

  router.patch('/students/:id', async (req, res) => {
    const writeScopes = ['students:write', 'students:update', 'students:academic'];
    if (!writeScopes.some((sc) => req.integration.scopes.includes(sc))) {
      throw Object.assign(new AppError(403, 'insufficient_scope', `Updating students requires one of the scopes: ${writeScopes.join(', ')}.`, { required: writeScopes, granted: req.integration.scopes }), { oauth: true });
    }
    const changes = parse(patchSchema, req.body);
    const fields = Object.keys(changes);
    if (!fields.length) throw ruleViolation('no_changes', 'No updatable fields were provided.');
    await authorizeStudentFields(req, fields);
    const { student, changed } = await updateStudent(req.actor, req.params.id, changes, { ifMatch: req.get('if-match') });
    res.set('ETag', etagFor(student)).json({ data: full(student), meta: { changedFields: changed } });
  });

  router.post('/students/:id/deactivate', requireScope('students:deactivate'), idempotent(), async (req, res) => {
    await assertOperation(req, 'student.deactivate');
    const body = parse(z.object({ reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500), dropFutureRegistrations: z.boolean().default(false) }).strict(), req.body);
    const r = await deactivateStudent(req.actor, req.params.id, body);
    const s = await getStudent(req.integration.client.institutionId, req.params.id);
    res.json({ data: full(s), meta: { changed: r.changed, droppedRegistrations: r.droppedRegistrations, retained: 'Registrations, grades, transcript and audit history are retained.' } });
  });

  router.get('/students/:id/audit', requireScope('audit:read'), async (req, res) => {
    const q = parse(paginationQuery, req.query);
    const s = await getStudent(req.integration.client.institutionId, req.params.id);
    const regIds = (await prisma.registration.findMany({ where: { studentId: s.id }, select: { id: true } })).map((r) => r.id);
    const where = { institutionId: s.institutionId, OR: [{ entityType: 'Student', entityId: s.id }, { entityType: 'Registration', entityId: { in: regIds } }] };
    const [rows, total] = await Promise.all([
      prisma.auditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.auditEvent.count({ where }),
    ]);
    res.json(paged(rows.map((e) => ({ id: e.id, at: e.createdAt, action: e.action, outcome: e.outcome, actorType: e.actorType, actor: e.actorLabel, onBehalfOf: e.onBehalfOf, entityType: e.entityType, entityId: e.entityId, summary: e.summary, before: e.before, after: e.after })), total, q));
  });
}
