import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { parse, id, paginationQuery, paged } from '../../../lib/validate.js';
import { notFound } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requirePermission, PERMISSIONS } from '../../../lib/permissions.js';
import { listPolicyDefinitions, updatePolicies } from '../../../services/policyService.js';
import { getGradeScale } from '../../../services/academicService.js';
import { currentTerm } from '../../../services/queryService.js';
import * as integrations from '../../../services/integrationService.js';
import * as identity from '../../../services/identityService.js';
import { evaluateCapabilities, validatePreferences, OPERATIONS } from '../../../services/capabilityService.js';
import { institutionDto } from '../../v1/dto.js';

const router = Router();
const inst = (req) => req.user.institutionId;
const startedAt = new Date();

// ── Dashboard & reports (all figures computed live from the database) ──
router.get('/dashboard', requirePermission('reports.view'), async (req, res) => {
  const institutionId = inst(req);
  const term = await currentTerm(institutionId);
  const [studentsByStatus, activeHolds, pendingApps, gradeQueue, pendingChanges, pendingDocs, termRegs, sections, recentAudit, integrationsCount, apiCalls24h] = await Promise.all([
    prisma.student.groupBy({ by: ['status'], where: { institutionId }, _count: true }),
    prisma.hold.count({ where: { releasedAt: null, student: { institutionId } } }),
    prisma.application.count({ where: { institutionId, status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } }),
    prisma.grade.groupBy({ by: ['status'], where: { registration: { institutionId }, status: { in: ['SUBMITTED', 'APPROVED'] } }, _count: true }),
    prisma.gradeChangeRequest.count({ where: { status: 'PENDING', grade: { registration: { institutionId } } } }),
    prisma.documentRequest.count({ where: { institutionId, status: { in: ['PENDING', 'PROCESSING'] } } }),
    term ? prisma.registration.groupBy({ by: ['status'], where: { institutionId, section: { termId: term.id } }, _count: true }) : [],
    term ? prisma.section.findMany({ where: { institutionId, termId: term.id, status: { not: 'CANCELLED' } }, include: { course: { include: { department: true } }, _count: { select: { registrations: { where: { status: 'REGISTERED' } } } } } }) : [],
    prisma.auditEvent.findMany({ where: { institutionId }, orderBy: { createdAt: 'desc' }, take: 8 }),
    prisma.integrationClient.count({ where: { institutionId, enabled: true, revokedAt: null } }),
    prisma.apiRequestLog.count({ where: { institutionId, createdAt: { gte: new Date(Date.now() - 86400000) } } }),
  ]);
  const byDept = {};
  let seats = 0, filled = 0;
  for (const s of sections) {
    const d = s.course.department.code;
    byDept[d] ??= { department: d, name: s.course.department.name, enrolled: 0, capacity: 0 };
    byDept[d].enrolled += s._count.registrations; byDept[d].capacity += s.capacity;
    seats += s.capacity; filled += s._count.registrations;
  }
  const count = (rows, k) => rows.find((r) => r.status === k)?._count ?? 0;
  res.json({ data: {
    term: term ? { id: term.id, name: term.name, code: term.code, status: term.status } : null,
    kpis: {
      activeStudents: count(studentsByStatus, 'ACTIVE'),
      totalStudents: studentsByStatus.reduce((s, r) => s + r._count, 0),
      termRegistrations: count(termRegs, 'REGISTERED'),
      termWaitlisted: count(termRegs, 'WAITLISTED'),
      sections: sections.length,
      fillRate: seats ? Math.round((filled / seats) * 100) : 0,
      activeHolds,
      integrations: integrationsCount,
      apiCalls24h,
    },
    worklist: [
      { key: 'grades_submitted', label: 'Grades awaiting approval', count: count(gradeQueue, 'SUBMITTED'), link: '/admin/grades' },
      { key: 'grades_approved', label: 'Approved grades to publish', count: count(gradeQueue, 'APPROVED'), link: '/admin/grades' },
      { key: 'grade_changes', label: 'Grade change requests', count: pendingChanges, link: '/admin/grades?tab=changes' },
      { key: 'applications', label: 'Applications to review', count: pendingApps, link: '/admin/admissions' },
      { key: 'documents', label: 'Document requests', count: pendingDocs, link: '/admin/documents' },
    ],
    studentsByStatus: studentsByStatus.map((r) => ({ status: r.status, count: r._count })),
    enrollmentByDepartment: Object.values(byDept).sort((a, b) => b.enrolled - a.enrolled),
    recentActivity: recentAudit.map((a) => ({ id: a.id, actor: a.actorLabel, action: a.action, summary: a.summary, createdAt: a.createdAt })),
  } });
});

router.get('/reports', requirePermission('reports.view'), async (req, res) => {
  const institutionId = inst(req);
  const q = parse(z.object({ termId: id.optional() }), req.query);
  const term = q.termId ? await prisma.term.findFirst({ where: { id: q.termId, institutionId } }) : await currentTerm(institutionId);
  if (!term) throw notFound('Term');
  const [terms, gradeDist, standing, levels, programs, sections, sources] = await Promise.all([
    prisma.term.findMany({ where: { institutionId }, orderBy: { startDate: 'asc' }, include: { sections: { include: { _count: { select: { registrations: { where: { status: { in: ['REGISTERED', 'COMPLETED'] } } } } } } } } }),
    prisma.grade.groupBy({ by: ['letter'], where: { status: 'PUBLISHED', registration: { institutionId, section: { termId: term.id } } }, _count: true }),
    prisma.student.groupBy({ by: ['academicStanding'], where: { institutionId, status: 'ACTIVE' }, _count: true }),
    prisma.student.groupBy({ by: ['classLevel'], where: { institutionId, status: 'ACTIVE' }, _count: true }),
    prisma.student.groupBy({ by: ['programId'], where: { institutionId, status: 'ACTIVE' }, _count: true }),
    prisma.section.findMany({ where: { institutionId, termId: term.id, status: { not: 'CANCELLED' } }, include: { course: true, _count: { select: { registrations: { where: { status: { in: ['REGISTERED', 'COMPLETED'] } } } } } } }),
    prisma.registration.groupBy({ by: ['source'], where: { institutionId, section: { termId: term.id } }, _count: true }),
  ]);
  const programNames = Object.fromEntries((await prisma.program.findMany({ where: { institutionId } })).map((p) => [p.id, p.name]));
  const scale = await getGradeScale(institutionId);
  res.json({ data: {
    term: { id: term.id, name: term.name, code: term.code },
    enrollmentTrend: terms.map((t) => ({ term: t.code, enrollments: t.sections.reduce((s, x) => s + x._count.registrations, 0), sections: t.sections.length })),
    gradeDistribution: scale.entries.map((e) => ({ letter: e.letter, count: gradeDist.find((g) => g.letter === e.letter)?._count ?? 0 })).filter((g) => g.count > 0 || ['A', 'B', 'C', 'D', 'F'].includes(g.letter)),
    standing: standing.map((s) => ({ standing: s.academicStanding, count: s._count })),
    classLevels: levels.map((l) => ({ level: l.classLevel, count: l._count })),
    programs: programs.map((p) => ({ program: programNames[p.programId] ?? 'Undeclared', count: p._count })).sort((a, b) => b.count - a.count),
    sectionFill: sections.map((s) => ({ label: `${s.course.code}-${s.sectionNumber}`, enrolled: s._count.registrations, capacity: s.capacity, fill: Math.round((s._count.registrations / s.capacity) * 100) })).sort((a, b) => b.fill - a.fill),
    registrationSources: sources.map((s) => ({ source: s.source, count: s._count })),
  } });
});

// ── Roles & permissions (read-only matrix; roles are assigned per user) ──
router.get('/roles', requirePermission('users.manage'), async (req, res) => {
  const counts = await prisma.user.groupBy({ by: ['role'], where: { institutionId: inst(req) }, _count: true });
  res.json({ data: {
    roles: ['ADMIN', 'REGISTRAR', 'FACULTY', 'STUDENT'].map((r) => ({ role: r, users: counts.find((c) => c.role === r)?._count ?? 0 })),
    permissions: Object.entries(PERMISSIONS).map(([key, p]) => ({ key, label: p.label, roles: p.roles })),
  } });
});

// ── Policies ──
router.get('/policies', requirePermission('policies.manage'), async (req, res) => res.json({ data: await listPolicyDefinitions(inst(req)) }));
router.put('/policies', requirePermission('policies.manage'), async (req, res) => {
  const body = parse(z.object({ changes: z.record(z.string(), z.union([z.boolean(), z.number(), z.array(z.string()).max(50)])) }), req.body);
  await updatePolicies(req.actor, body.changes);
  res.json({ data: await listPolicyDefinitions(inst(req)) });
});

// ── Institution & grade scale ──
router.get('/institution', requirePermission('institution.manage'), async (req, res) => {
  const i = await prisma.institution.findUnique({ where: { id: inst(req) } });
  const scale = await getGradeScale(inst(req));
  res.json({ data: { ...institutionDto(i), gradeScale: { id: scale.id, name: scale.name, entries: scale.entries.map(({ id: eid, letter, points, minPercent, countsInGpa, earnsCredit, description }) => ({ id: eid, letter, points, minPercent, countsInGpa, earnsCredit, description })) } } });
});
router.patch('/institution', requirePermission('institution.manage'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(3).max(150), shortName: z.string().trim().min(2).max(20), timezone: z.string().max(60), website: z.string().url().nullable(), email: z.string().email().nullable(), phone: z.string().max(30).nullable(), addressLine: z.string().max(200).nullable(), city: z.string().max(80).nullable(), region: z.string().max(80).nullable(), postalCode: z.string().max(20).nullable(), emailDomain: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/).nullable(), studentEmailDomain: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/).nullable() }).partial().strict(), req.body);
  const before = await prisma.institution.findUnique({ where: { id: inst(req) } });
  await prisma.institution.update({ where: { id: inst(req) }, data: body });
  await audit(req.actor, { action: 'institution.updated', entityType: 'Institution', entityId: inst(req), summary: `Updated institution profile: ${Object.keys(body).join(', ')}`, before: Object.fromEntries(Object.keys(body).map((k) => [k, before[k]])), after: body });
  res.json({ ok: true });
});
router.patch('/grade-scale/:entryId', requirePermission('institution.manage'), async (req, res) => {
  const body = parse(z.object({ points: z.number().min(0).max(5), minPercent: z.number().int().min(0).max(100).nullable(), countsInGpa: z.boolean(), earnsCredit: z.boolean(), description: z.string().max(100).nullable() }).partial().strict(), req.body);
  const entry = await prisma.gradeScaleEntry.findFirst({ where: { id: req.params.entryId, scale: { institutionId: inst(req) } } });
  if (!entry) throw notFound('Grade scale entry');
  await prisma.gradeScaleEntry.update({ where: { id: entry.id }, data: body });
  await audit(req.actor, { action: 'grade_scale.updated', entityType: 'GradeScaleEntry', entityId: entry.id, summary: `Updated grade ${entry.letter}: ${JSON.stringify(body)} (GPA calculations use the new values immediately)`, before: { points: Number(entry.points), countsInGpa: entry.countsInGpa, earnsCredit: entry.earnsCredit }, after: body });
  res.json({ ok: true });
});

// ── Integrations ──
const manageInt = requirePermission('integrations.manage');
const scopeList = z.array(z.enum(integrations.SCOPE_NAMES)).max(integrations.SCOPE_NAMES.length);

router.get('/integrations/scopes', manageInt, (_req, res) => res.json({ data: Object.entries(integrations.SCOPES).map(([scope, description]) => ({ scope, description, write: scope.endsWith(':write') })) }));
router.get('/integrations', manageInt, async (req, res) => res.json({ data: await integrations.listClients(inst(req)) }));
router.post('/integrations', manageInt, async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(3).max(80), description: z.string().trim().max(500).optional(), scopes: scopeList.min(1, 'Select at least one scope'), tokenTtlSeconds: z.number().int().min(60).max(3600).default(900) }).strict(), req.body);
  res.status(201).set('Cache-Control', 'no-store').json(await integrations.createClient(req.actor, body));
});
router.get('/integrations/activity', manageInt, async (req, res) => {
  const q = parse(paginationQuery.extend({ clientId: id.optional() }), req.query);
  res.json(await integrations.apiActivity(inst(req), q));
});
router.get('/integrations/:id', manageInt, async (req, res) => {
  const client = await integrations.getClient(inst(req), req.params.id);
  const events = await prisma.auditEvent.findMany({ where: { institutionId: inst(req), OR: [{ entityType: 'IntegrationClient', entityId: req.params.id }, { actorType: 'INTEGRATION', actorId: req.params.id }] }, orderBy: { createdAt: 'desc' }, take: 50 });
  const raw = await prisma.integrationClient.findUnique({ where: { id: req.params.id } });
  res.json({ data: { ...client, tokens: await integrations.listTokens(inst(req), req.params.id), auditEvents: events, capabilities: await evaluateCapabilities(raw, raw.scopes), operationLabels: Object.fromEntries(Object.entries(OPERATIONS).map(([k, v]) => [k, v.label])) } });
});
router.patch('/integrations/:id', manageInt, async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(3).max(80), description: z.string().trim().max(500).nullable(), scopes: scopeList, enabled: z.boolean(), tokenTtlSeconds: z.number().int().min(60).max(3600), writePreferences: z.unknown() }).partial().strict(), req.body);
  if (body.writePreferences !== undefined) body.writePreferences = validatePreferences(body.writePreferences);
  res.json({ data: await integrations.updateClient(req.actor, req.params.id, body) });
});
router.post('/integrations/:id/rotate', manageInt, async (req, res) => res.set('Cache-Control', 'no-store').json(await integrations.rotateSecret(req.actor, req.params.id)));
router.post('/integrations/:id/revoke', manageInt, async (req, res) => res.json({ data: await integrations.revokeClient(req.actor, req.params.id) }));
router.post('/integrations/:id/revoke-tokens', manageInt, async (req, res) => res.json({ data: await integrations.revokeAllTokens(req.actor, req.params.id) }));

// ── Audit log ──
router.get('/audit', requirePermission('audit.view'), async (req, res) => {
  const q = parse(paginationQuery.extend({ search: z.string().max(100).optional(), actorType: z.enum(['USER', 'INTEGRATION', 'SYSTEM']).optional(), entityType: z.string().max(50).optional(), action: z.string().max(80).optional() }), req.query);
  const where = { institutionId: inst(req), ...(q.actorType ? { actorType: q.actorType } : {}), ...(q.entityType ? { entityType: q.entityType } : {}), ...(q.action ? { action: { startsWith: q.action } } : {}), ...(q.search ? { OR: [{ summary: { contains: q.search, mode: 'insensitive' } }, { actorLabel: { contains: q.search, mode: 'insensitive' } }] } : {}) };
  const [rows, total, entityTypes] = await Promise.all([
    prisma.auditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.groupBy({ by: ['entityType'], where: { institutionId: inst(req) } }),
  ]);
  res.json({ ...paged(rows, total, q), entityTypes: entityTypes.map((e) => e.entityType).sort() });
});

// ── System health ──
router.get('/system/health', requirePermission('audit.view'), async (req, res) => {
  const t0 = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  const dbLatencyMs = Date.now() - t0;
  const [[{ version }], migrations, sessions, tokens, errors24h] = await Promise.all([
    prisma.$queryRaw`SELECT version()`,
    prisma.$queryRaw`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 5`.catch(() => []),
    prisma.session.count({ where: { expiresAt: { gt: new Date() } } }),
    prisma.accessToken.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.apiRequestLog.count({ where: { institutionId: inst(req), status: { gte: 500 }, createdAt: { gte: new Date(Date.now() - 86400000) } } }),
  ]);
  res.json({ data: {
    status: 'ok', startedAt, uptimeSeconds: Math.round(process.uptime()), node: process.version, environment: process.env.NODE_ENV,
    database: { status: 'ok', latencyMs: dbLatencyMs, version: version.split(' ').slice(0, 2).join(' '), recentMigrations: migrations },
    activeSessions: sessions, activeApiTokens: tokens, serverErrors24h: errors24h,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  } });
});

router.post('/system/cleanup', requirePermission('audit.view'), async (req, res) => {
  // Housekeeping: purge expired sessions and access-token records older than 7 days.
  const cutoff = new Date(Date.now() - 7 * 86400000);
  const [s, t] = await Promise.all([
    prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    prisma.accessToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
  ]);
  await audit(req.actor, { action: 'system.cleanup', entityType: 'System', summary: `Purged ${s.count} expired session(s) and ${t.count} old token record(s)` });
  res.json({ data: { sessions: s.count, tokens: t.count } });
});

export default router;

// ── Identity links (cross-system account ↔ SIS record) ──
const manageIdentity = requirePermission('identity.manage');
const extSystem = z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{1,39}$/).default('edunexusai');
router.get('/identity-links', manageIdentity, async (req, res) => {
  const q = parse(paginationQuery.extend({ externalSystem: extSystem.optional(), externalUserId: z.string().max(128).optional(), recordType: z.enum(['STUDENT', 'FACULTY']).optional(), status: z.enum(['ACTIVE', 'REVOKED']).optional(), sisRecordId: id.optional() }), req.query);
  const { rows, total } = await identity.listLinks(inst(req), q);
  res.json(paged(rows, total, q));
});
router.post('/identity-links/reconcile', manageIdentity, async (req, res) => {
  const body = parse(z.object({ externalSystem: extSystem, candidates: z.array(z.object({ externalUserId: z.string().trim().min(1).max(128), recordType: z.enum(['STUDENT', 'FACULTY']), email: z.string().trim().email().optional(), institutionalId: z.string().trim().max(30).optional(), firstName: z.string().max(80).optional(), lastName: z.string().max(80).optional() }).strict()).min(1).max(200) }).strict(), req.body);
  res.json({ data: await identity.reconcile(inst(req), body.externalSystem, body.candidates) });
});
router.post('/identity-links', manageIdentity, async (req, res) => {
  const body = parse(z.object({ externalSystem: extSystem, externalUserId: z.string().trim().min(1).max(128), externalEmail: z.string().trim().email().optional(), externalLabel: z.string().trim().max(160).optional(), recordType: z.enum(['STUDENT', 'FACULTY']), sisRecordId: id, evidenceMismatchReason: z.string().trim().min(10).max(500).optional() }).strict(), req.body);
  res.status(201).json({ data: await identity.link(req.actor, { ...body, method: 'MANUAL_ADMIN' }) });
});
router.post('/identity-links/:id/revoke', manageIdentity, async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().min(5).max(500) }).strict(), req.body);
  res.json({ data: await identity.revoke(req.actor, { linkId: req.params.id, reason: body.reason }) });
});
