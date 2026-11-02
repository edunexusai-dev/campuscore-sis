import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { login, prisma, seedData, setPolicy } from './helpers.js';

let maya, nextTermId, currentTermId, freshman;

async function sectionOf(code, termId, number = '01') {
  return prisma.section.findFirst({ where: { termId, sectionNumber: number, course: { code } } });
}

beforeAll(async () => {
  const { terms } = seedData();
  nextTermId = terms.next.id;
  currentTermId = terms.current.id;
  maya = await login('student');
  // An active first-term student with no holds and no prior CS coursework.
  const s = await prisma.student.findFirst({
    where: { status: 'ACTIVE', classLevel: 'FRESHMAN', holds: { none: { releasedAt: null } }, registrations: { none: { section: { course: { code: 'CS 201' } } } }, user: { status: 'ACTIVE' }, program: { level: 'UNDERGRADUATE' } },
    include: { user: true },
  });
  freshman = await login(s.user.email);
});

afterAll(async () => {
  await setPolicy('registration.maxCreditsPerTerm', 18);
  await setPolicy('registration.allowStudentSelfService', true);
});

describe('enrollment business rules', () => {
  it('registers an eligible student during the registration window', async () => {
    const sec = await sectionOf('HIST 210', nextTermId);
    const res = await maya.post('/api/app/student/registrations', { sectionId: sec.id });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('REGISTERED');
    const audit = await prisma.auditEvent.findFirst({ where: { entityId: res.body.data.id, action: 'registration.created' } });
    expect(audit).toBeTruthy();
  });

  it('rejects a duplicate registration', async () => {
    const sec = await sectionOf('HIST 210', nextTermId);
    const res = await maya.post('/api/app/student/registrations', { sectionId: sec.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('already_registered');
  });

  it('enforces prerequisites', async () => {
    const sec = await sectionOf('CS 301', nextTermId);
    const res = await freshman.post('/api/app/student/registrations', { sectionId: sec.id });
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d) => d.code)).toContain('prerequisite_not_met');
  });

  it('blocks students with a registration hold', async () => {
    const jordan = await login('heldStudent');
    const sec = await sectionOf('ENGL 210', nextTermId);
    const res = await jordan.post('/api/app/student/registrations', { sectionId: sec.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('registration_hold');
  });

  it('enforces the registration window', async () => {
    const sec = await sectionOf('ENGL 220', currentTermId);
    const res = await maya.post('/api/app/student/registrations', { sectionId: sec.id });
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d) => d.code)).toContain('registration_window_closed');
  });

  it('enforces the credit limit policy', async () => {
    await setPolicy('registration.maxCreditsPerTerm', 4);
    const sec = await sectionOf('CHEM 110', nextTermId);
    const res = await maya.post('/api/app/student/registrations', { sectionId: sec.id });
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d) => d.code)).toContain('credit_limit_exceeded');
    await setPolicy('registration.maxCreditsPerTerm', 18);
  });

  it('honours the self-service policy switch', async () => {
    await setPolicy('registration.allowStudentSelfService', false);
    const sec = await sectionOf('ENGL 210', nextTermId);
    const res = await maya.post('/api/app/student/registrations', { sectionId: sec.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('policy_disabled');
    await setPolicy('registration.allowStudentSelfService', true);
  });

  it('lets registrar staff override overridable rules with a reason, but students cannot', async () => {
    const registrar = await login('registrar');
    // A current-term section (registration window closed) in a course the student is not already taking.
    const taking = await prisma.registration.findMany({ where: { studentId: freshman.user.studentId, section: { termId: currentTermId } }, select: { section: { select: { courseId: true } } } });
    const sec = await prisma.section.findFirst({ where: { termId: currentTermId, course: { prerequisites: { none: {} }, level: { lt: 300 } }, courseId: { notIn: taking.map((t) => t.section.courseId) } } });
    const asStudent = await freshman.post('/api/app/student/registrations', { sectionId: sec.id });
    expect(asStudent.status).toBe(422);
    const noReason = await registrar.post('/api/app/admin/registrations', { studentId: freshman.user.studentId, sectionId: sec.id, override: true });
    expect(noReason.status).toBe(400);
    const res = await registrar.post('/api/app/admin/registrations', { studentId: freshman.user.studentId, sectionId: sec.id, override: true, reason: 'Late add approved by department chair' });
    expect(res.status).toBe(201);
    const ev = await prisma.registrationEvent.findFirst({ where: { registrationId: res.body.data.id } });
    expect(ev.reason).toMatch(/Override/);
  });

  it('waitlists when full and promotes the next student when a seat opens', async () => {
    const admin = await login('admin');
    const course = await prisma.course.findFirst({ where: { code: 'ENGL 220' } });
    const created = await admin.post('/api/app/admin/sections', { termId: nextTermId, courseId: course.id, sectionNumber: '09', capacity: 1, waitlistCapacity: 2, meetings: [] });
    expect(created.status).toBe(201);
    const sectionId = created.body.data.id;

    const first = await maya.post('/api/app/student/registrations', { sectionId });
    expect(first.body.data.status).toBe('REGISTERED');
    const second = await freshman.post('/api/app/student/registrations', { sectionId });
    expect(second.status).toBe(201);
    expect(second.body.data.status).toBe('WAITLISTED');
    expect(second.body.data.waitlistPosition).toBe(1);

    const drop = await maya.post(`/api/app/student/registrations/${first.body.data.id}/drop`, { reason: 'Schedule change' });
    expect(drop.status).toBe(200);
    expect(drop.body.data.status).toBe('DROPPED');

    const promoted = await prisma.registration.findUnique({ where: { id: second.body.data.id } });
    expect(promoted.status).toBe('REGISTERED');
    expect(promoted.waitlistPosition).toBeNull();
  });

  it("prevents a student from dropping someone else's registration", async () => {
    const other = await prisma.registration.findFirst({ where: { status: 'REGISTERED', studentId: { not: maya.user.studentId }, section: { termId: nextTermId } } });
    const res = await maya.post(`/api/app/student/registrations/${other.id}/drop`, {});
    expect(res.status).toBe(404);
  });

  it('rejects malformed input with field-level validation errors', async () => {
    const res = await maya.post('/api/app/student/registrations', { sectionId: 123, studentId: 'someone-else' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});
