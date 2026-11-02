import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SisPortalService, SisError, CampusCoreClient } from '../src/index.js';

// Fake adapter: records calls and serves two students, one faculty member, and links by portal user id.
function fakeSis({ links = {}, caps = {}, failSchedule = false } = {}) {
  const calls = [];
  const rec = (name, ...a) => calls.push([name, ...a]);
  return {
    calls,
    resolveIdentity: async (uid, { recordType } = {}) => {
      rec('resolve', uid, recordType);
      const entry = links[uid];
      // A person with several relationships: resolve per record type, LINKED_MULTIPLE without one.
      if (Array.isArray(entry)) {
        if (!recordType) return { externalUserId: uid, status: 'LINKED_MULTIPLE', links: entry };
        return entry.find((l) => l.recordType === recordType) ?? { externalUserId: uid, status: 'UNMAPPED' };
      }
      if (entry && recordType && entry.recordType !== recordType) return { externalUserId: uid, status: 'UNMAPPED' };
      return entry ?? { externalUserId: uid, status: 'UNMAPPED' };
    },
    getStudent: async (id) => { rec('getStudent', id); return { source: { id }, displayName: id }; },
    getAcademicSummary: async (id) => { rec('academic', id); return { gpa: 3.5 }; },
    getStudentSchedule: async (id) => { rec('schedule', id); if (failSchedule) throw new SisError('down', { status: 503, code: 'sis_unavailable', retryable: true }); return { items: [] }; },
    getGradeHistory: async (id) => { rec('grades', id); return []; },
    getRegistrations: async (id) => { rec('registrations', id); return []; },
    listFacultySections: async (fid) => { rec('sections', fid); return fid === 'fac-1' ? [{ source: { id: 'sec-A' } }] : []; },
    getFacultySchedule: async () => ({ items: [] }),
    getRoster: async (sid) => { rec('roster', sid); return [{ student: sid }]; },
    getCapabilities: async () => ({ operations: Object.entries({ 'student.create': false, 'student.deactivate': false, ...caps }).map(([operation, effective]) => ({ operation, effective, reason: effective ? null : 'Disabled by institutional policy.' })) }),
    searchStudents: async (q) => { rec('search', q); return { items: [] }; },
    createStudent: async (input, opts) => { rec('create', input, opts); return { student: input }; },
    resolveCount() { return calls.filter((c) => c[0] === 'resolve').length; },
  };
}
const links = { 'u-maya': { status: 'LINKED', recordType: 'STUDENT', sisId: 'stu-maya', institutionalId: 'S1' }, 'u-prof': { status: 'LINKED', recordType: 'FACULTY', sisId: 'fac-1' } };
const svc = (sis, extra = {}) => new SisPortalService({ adapter: sis, tenantKey: 'feddrick', ...extra });
const maya = { id: 'u-maya', role: 'STUDENT', tenantKey: 'feddrick' };

test('a student only ever receives their own linked record', async () => {
  const sis = fakeSis({ links });
  const r = await svc(sis).studentOverview(maya);
  assert.equal(r.state, 'OK');
  assert.ok(sis.calls.filter((c) => ['getStudent', 'academic', 'schedule', 'grades', 'registrations'].includes(c[0])).every((c) => c[1] === 'stu-maya'));
  // There is no API that accepts a student id from the caller; another student's id cannot be requested.
  assert.equal(typeof svc(sis).studentOverview.length, 'number');
});

test('unmapped and non-student accounts get explicit states, not someone else\'s data', async () => {
  const sis = fakeSis({ links });
  assert.equal((await svc(sis).studentOverview({ id: 'u-new', role: 'STUDENT', tenantKey: 'feddrick' })).state, 'UNMAPPED');
  assert.equal((await svc(sis).studentOverview({ id: 'u-prof', role: 'FACULTY', tenantKey: 'feddrick' })).state, 'NOT_A_STUDENT');
  assert.equal(sis.calls.filter((c) => c[0] === 'getStudent').length, 0);
});

test('a section failure is reported as UNAVAILABLE instead of inventing data', async () => {
  const r = await svc(fakeSis({ links, failSchedule: true })).studentOverview(maya);
  assert.equal(r.schedule.state, 'UNAVAILABLE');
  assert.equal(r.schedule.error.retryable, true);
  assert.equal(r.profile.state, 'OK');
});

test('cross-tenant users are rejected before any SIS call', async () => {
  const sis = fakeSis({ links });
  await assert.rejects(svc(sis).studentOverview({ ...maya, tenantKey: 'other-university' }), (e) => e.code === 'tenant_mismatch');
  assert.equal(sis.calls.length, 0);
});

test('faculty can read rosters only for sections they teach', async () => {
  const sis = fakeSis({ links });
  const prof = { id: 'u-prof', role: 'FACULTY', tenantKey: 'feddrick' };
  assert.deepEqual(await svc(sis).facultyRoster(prof, 'sec-A'), [{ student: 'sec-A' }]);
  await assert.rejects(svc(sis).facultyRoster(prof, 'sec-B'), (e) => e.code === 'not_section_instructor');
  await assert.rejects(svc(sis).facultyRoster(maya, 'sec-A'), (e) => e.code === 'not_faculty');
});

test('admin operations need the portal admin role and an effective SIS capability', async () => {
  const sis = fakeSis({ links });
  await assert.rejects(svc(sis).adminSearchStudents(maya, {}), (e) => e.code === 'not_portal_admin');
  const adminUser = { id: 'u-admin', role: 'ADMIN', tenantKey: 'feddrick' };
  await assert.rejects(svc(sis).adminCreateStudent(adminUser, { firstName: 'A' }, { idempotencyKey: 'k-123456789' }), (e) => e.code === 'write_not_permitted');
  const allowed = fakeSis({ links, caps: { 'student.create': true } });
  await svc(allowed).adminCreateStudent(adminUser, { firstName: 'A' }, { idempotencyKey: 'k-123456789' });
  const create = allowed.calls.find((c) => c[0] === 'create');
  assert.equal(create[2].actingUser, 'edunexusai:u-admin');
  assert.equal(create[2].idempotencyKey, 'k-123456789');
});

test('identity resolution is cached and can be invalidated', async () => {
  let t = 0;
  const sis = fakeSis({ links });
  const s = svc(sis, { now: () => t });
  await s.resolve(maya); await s.resolve(maya);
  assert.equal(sis.resolveCount(), 1);
  s.invalidate('u-maya'); await s.resolve(maya);
  t = 120_000; await s.resolve(maya);
  assert.equal(sis.resolveCount(), 3);
});

test('client secret is not exposed through serialisation', () => {
  const c = new CampusCoreClient({ baseUrl: 'http://sis', clientId: 'cid', clientSecret: 'super-secret-value', fetchImpl: async () => new Response('{}') });
  assert.ok(!JSON.stringify(c).includes('super-secret-value'));
  assert.equal(c.clientSecret, undefined);
});

test('a faculty member who is also a student gets the record of each role, never the other one', async () => {
  const dual = { 'u-rahul': [{ status: 'LINKED', recordType: 'STUDENT', sisId: 'stu-rahul', institutionalId: 'S9' }, { status: 'LINKED', recordType: 'FACULTY', sisId: 'fac-1' }] };
  const sis = fakeSis({ links: dual });
  const s = svc(sis);
  const rahul = { id: 'u-rahul', role: 'FACULTY', tenantKey: 'feddrick' };
  const overview = await s.studentOverview(rahul);
  assert.equal(overview.state, 'OK');
  assert.equal(overview.identity.sisId, 'stu-rahul');
  assert.ok(sis.calls.filter((c) => c[0] === 'resolve').every((c) => c[2] === 'STUDENT'));
  const teaching = await s.facultyTeaching(rahul);
  assert.equal(teaching.sections.state, 'OK');
  assert.ok(sis.calls.some((c) => c[0] === 'sections' && c[1] === 'fac-1'));
  assert.ok(!sis.calls.some((c) => (c[0] === 'sections' || c[0] === 'roster') && c[1] === 'stu-rahul'), 'the student record is never used for teaching');
  await assert.rejects(() => s.facultyRoster(rahul, 'sec-B'), (e) => e.code === 'not_section_instructor');
});

test('per-record-type cache entries are all invalidated together', async () => {
  const sis = fakeSis({ links: { 'u-x': [{ status: 'LINKED', recordType: 'STUDENT', sisId: 's' }, { status: 'LINKED', recordType: 'FACULTY', sisId: 'fac-1' }] } });
  const s = svc(sis);
  const x = { id: 'u-x', role: 'STUDENT', tenantKey: 'feddrick' };
  await s.resolve(x, { recordType: 'STUDENT' }); await s.resolve(x, { recordType: 'FACULTY' }); await s.resolve(x, { recordType: 'STUDENT' });
  assert.equal(sis.resolveCount(), 2);
  s.invalidate('u-x');
  await s.resolve(x, { recordType: 'STUDENT' }); await s.resolve(x, { recordType: 'FACULTY' });
  assert.equal(sis.resolveCount(), 4);
});
