import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { login, getToken, api, prisma, setPolicy } from './helpers.js';

// Class announcements reach an integration per faculty member: only those on sections that member teaches.
let reader, noScope, faculty, mine, other, institutionWide;

beforeAll(async () => {
  const admin = await login('admin');
  const c = await admin.post('/api/app/admin/integrations', { name: 'Faculty announcements reader', scopes: ['announcements:read'] });
  reader = api((await getToken(c.body.client.clientId, c.body.clientSecret)).body.access_token);
  const n = await admin.post('/api/app/admin/integrations', { name: 'No announcements scope', scopes: ['faculty:read'] });
  noScope = api((await getToken(n.body.client.clientId, n.body.clientSecret)).body.access_token);

  const taught = await prisma.sectionInstructor.findFirst({ include: { faculty: true } });
  faculty = taught.faculty;
  const otherSection = await prisma.section.findFirst({ where: { institutionId: faculty.institutionId, instructors: { none: { facultyId: faculty.id } } } });
  mine = await prisma.announcement.create({ data: { institutionId: faculty.institutionId, sectionId: taught.sectionId, title: 'Lab moved to room 204', body: 'Same time.', audience: 'STUDENTS', authorName: 'Instructor' } });
  other = await prisma.announcement.create({ data: { institutionId: faculty.institutionId, sectionId: otherSection.id, title: 'Someone else\'s class', body: 'Other section.', audience: 'STUDENTS', authorName: 'Instructor' } });
  institutionWide = await prisma.announcement.create({ data: { institutionId: faculty.institutionId, sectionId: null, title: 'Campus closed Monday', body: 'Holiday.', audience: 'ALL', authorName: 'Registrar' } });
});

describe('class announcements for a faculty member', () => {
  it('returns announcements of sections the faculty member teaches only, with the section named', async () => {
    const res = await reader.get(`/api/v1/faculty/${faculty.id}/announcements`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((a) => a.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
    expect(ids).not.toContain(institutionWide.id);
    expect(res.body.data.find((a) => a.id === mine.id).section.label).toMatch(/^[A-Z]+ \d+-\w+$/);
  });

  it('narrows to a term when asked', async () => {
    const section = await prisma.section.findUnique({ where: { id: mine.sectionId } });
    const otherTerm = await prisma.term.findFirst({ where: { institutionId: faculty.institutionId, id: { not: section.termId } } });
    expect((await reader.get(`/api/v1/faculty/${faculty.id}/announcements?termId=${section.termId}`)).body.data.map((a) => a.id)).toContain(mine.id);
    expect((await reader.get(`/api/v1/faculty/${faculty.id}/announcements?termId=${otherTerm.id}`)).body.data.map((a) => a.id)).not.toContain(mine.id);
  });

  it('is 404 for an unknown faculty member and refused without the announcements:read scope', async () => {
    expect((await reader.get('/api/v1/faculty/nonexistent-id/announcements')).status).toBe(404);
    expect((await noScope.get(`/api/v1/faculty/${faculty.id}/announcements`)).status).toBe(403);
  });
});

// Publishing through the integration API: announcements:write × policy api.allowAnnouncementWrites × client
// preference, on behalf of an active instructor assigned to the section, idempotent, audited.
describe('publishing a class announcement on behalf of an instructor', () => {
  let writer, section, instructor, student, otherFaculty;
  const key = () => `ann-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const post = (sectionId, body, idemKey = key()) => writer.post(`/api/v1/sections/${sectionId}/announcements`, body).set('Idempotency-Key', idemKey).set('X-Acting-User', 'edunexusai:user-1');

  beforeAll(async () => {
    const admin = await login('admin');
    const c = await admin.post('/api/app/admin/integrations', { name: 'Announcements writer', scopes: ['announcements:write', 'announcements:read', 'integration:configure'] });
    writer = api((await getToken(c.body.client.clientId, c.body.clientSecret)).body.access_token);
    const reg = await prisma.registration.findFirst({ where: { status: 'REGISTERED', section: { status: { not: 'CANCELLED' }, instructors: { some: { faculty: { status: 'ACTIVE', userId: { not: null } } } } } }, include: { section: { include: { instructors: { include: { faculty: true } }, course: true } } } });
    section = reg.section;
    instructor = section.instructors.find((i) => i.faculty.status === 'ACTIVE' && i.faculty.userId).faculty;
    student = reg.studentId;
    otherFaculty = await prisma.faculty.findFirst({ where: { institutionId: section.institutionId, sections: { none: { sectionId: section.id } } } });
  });
  afterAll(() => setPolicy('api.allowAnnouncementWrites', false));

  const valid = () => ({ actingFacultyId: instructor.id, title: 'Room change for Thursday', body: 'We meet in Turing 210 this week.' });

  it('is off until the institution enables the policy (default off), and requires the write scope', async () => {
    const off = await post(section.id, valid());
    expect(off.status).toBe(422);
    expect(off.body.error.code).toBe('policy_disabled');
    await setPolicy('api.allowAnnouncementWrites', true);
    const readOnly = await reader.post(`/api/v1/sections/${section.id}/announcements`, valid()).set('Idempotency-Key', key());
    expect(readOnly.status).toBe(403);
    expect(readOnly.body.error.code).toBe('insufficient_scope');
    const caps = (await writer.get('/api/v1/capabilities')).body.data.operations;
    expect(caps.find((o) => o.operation === 'announcement.write')).toMatchObject({ scopeGranted: true, policyEnabled: true, effective: true });
  });

  it('publishes as the assigned instructor, audited, and the registered student sees it', async () => {
    await setPolicy('api.allowAnnouncementWrites', true);
    const res = await post(section.id, { ...valid(), pinned: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ title: 'Room change for Thursday', pinned: true, author: `${instructor.firstName} ${instructor.lastName}`, section: { id: section.id, label: `${section.course.code}-${section.sectionNumber}` } });
    const row = await prisma.announcement.findUnique({ where: { id: res.body.data.id } });
    expect(row).toMatchObject({ sectionId: section.id, audience: 'STUDENTS', authorUserId: instructor.userId, institutionId: section.institutionId });
    const event = await prisma.auditEvent.findFirst({ where: { entityType: 'Announcement', entityId: row.id, action: 'announcement.created' } });
    expect(event).toMatchObject({ actorType: 'INTEGRATION', onBehalfOf: 'edunexusai:user-1' });
    expect(event.summary).toContain(instructor.employeeNumber);
    expect((await reader.get(`/api/v1/students/${student}/announcements`)).body.data.map((a) => a.id)).toContain(row.id);
    expect((await reader.get(`/api/v1/faculty/${instructor.id}/announcements`)).body.data.map((a) => a.id)).toContain(row.id);
  });

  it('refuses an instructor who is not assigned to the section, an unknown section, and leaves nothing behind', async () => {
    await setPolicy('api.allowAnnouncementWrites', true);
    const before = await prisma.announcement.count();
    const denied = await post(section.id, { ...valid(), actingFacultyId: otherFaculty.id });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('not_section_instructor');
    expect((await post('nonexistent-section', valid())).status).toBe(404);
    expect(await prisma.announcement.count()).toBe(before);
  });

  it('refuses an inactive instructor and a cancelled section', async () => {
    await setPolicy('api.allowAnnouncementWrites', true);
    await prisma.faculty.update({ where: { id: instructor.id }, data: { status: 'DISABLED' } });
    try {
      const inactive = await post(section.id, valid());
      expect(inactive.status).toBe(403);
      expect(inactive.body.error.code).toBe('faculty_inactive');
    } finally {
      await prisma.faculty.update({ where: { id: instructor.id }, data: { status: 'ACTIVE' } });
    }
    const original = section.status;
    await prisma.section.update({ where: { id: section.id }, data: { status: 'CANCELLED' } });
    try {
      const cancelled = await post(section.id, valid());
      expect(cancelled.status).toBe(422);
      expect(cancelled.body.error.code).toBe('section_cancelled');
    } finally {
      await prisma.section.update({ where: { id: section.id }, data: { status: original } });
    }
  });

  it('needs an Idempotency-Key; a retry replays instead of posting twice; a reused key with another body is refused', async () => {
    await setPolicy('api.allowAnnouncementWrites', true);
    const missing = await writer.post(`/api/v1/sections/${section.id}/announcements`, valid());
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('idempotency_key_required');
    const k = key();
    const first = await post(section.id, { ...valid(), title: 'Retried once' }, k);
    const again = await post(section.id, { ...valid(), title: 'Retried once' }, k);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await prisma.announcement.count({ where: { title: 'Retried once' } })).toBe(1);
    expect((await post(section.id, { ...valid(), title: 'Different' }, k)).status).toBe(422);
  });

  it('validates the body strictly: no audience, author or institution-wide fields can be smuggled in', async () => {
    await setPolicy('api.allowAnnouncementWrites', true);
    for (const body of [{ ...valid(), audience: 'ALL' }, { ...valid(), authorName: 'Registrar' }, { ...valid(), title: 'x' }, { title: 'No acting faculty', body: 'Missing.' }]) {
      const res = await post(section.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('honours the client’s own write preference', async () => {
    await setPolicy('api.allowAnnouncementWrites', true);
    await writer.put('/api/v1/integration/write-preferences', { disabledOperations: ['announcement.write'] });
    try {
      const res = await post(section.id, valid());
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('disabled_by_client_preference');
    } finally {
      await writer.put('/api/v1/integration/write-preferences', { disabledOperations: [] });
    }
  });
});
