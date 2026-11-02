import { describe, it, expect } from 'vitest';
import { login, prisma, seedData } from './helpers.js';

describe('role-based and resource-level authorization', () => {
  it('students and faculty cannot reach administrator endpoints', async () => {
    for (const who of ['student', 'faculty']) {
      const s = await login(who);
      expect((await s.get('/api/app/admin/students')).status).toBe(403);
      expect((await s.get('/api/app/admin/integrations')).status).toBe(403);
      expect((await s.put('/api/app/admin/policies', { changes: { 'registration.maxCreditsPerTerm': 30 } })).status).toBe(403);
    }
  });

  it('students cannot use faculty endpoints to change grades', async () => {
    const s = await login('student');
    const { demo } = seedData();
    const res = await s.put(`/api/app/faculty/sections/${demo.fullSectionId}/grades`, { grades: [{ registrationId: 'x', letter: 'A' }] });
    expect(res.status).toBe(403);
  });

  it('students cannot change protected fields on their own record', async () => {
    const s = await login('student');
    for (const body of [{ studentNumber: 'S0000001' }, { academicStanding: 'DEANS_LIST' }, { status: 'GRADUATED' }, { firstName: 'Hacker' }]) {
      const res = await s.patch('/api/app/student/profile', body);
      expect(res.status).toBe(400);
    }
    const ok = await s.patch('/api/app/student/profile', { phone: '+1 (978) 555-0199' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.phone).toBe('+1 (978) 555-0199');
  });

  it('students only ever see their own record', async () => {
    const s = await login('student');
    const { demo } = seedData();
    const res = await s.get('/api/app/student/profile');
    expect(res.body.data.id).toBe(demo.mayaId);
    // No student-scoped route accepts another student's ID.
    expect((await s.get(`/api/app/admin/students/${demo.jordanId}`)).status).toBe(403);
  });

  it('faculty can open assigned sections but get 404 for other sections', async () => {
    const s = await login('faculty');
    const { demo } = seedData();
    expect((await s.get(`/api/app/faculty/sections/${demo.fullSectionId}`)).status).toBe(200);
    const other = await prisma.section.findFirst({ where: { instructors: { none: { facultyId: demo.vasquezFacultyId } } } });
    expect((await s.get(`/api/app/faculty/sections/${other.id}`)).status).toBe(404);
    expect((await s.get(`/api/app/faculty/sections/${other.id}/grades`)).status).toBe(404);
    expect((await s.put(`/api/app/faculty/sections/${other.id}/attendance`, { date: '2026-01-01', records: [{ studentId: 'x', status: 'PRESENT' }] })).status).toBe(404);
  });

  it('registrars cannot manage integrations or policies', async () => {
    const s = await login('registrar');
    expect((await s.get('/api/app/admin/students')).status).toBe(200);
    expect((await s.get('/api/app/admin/integrations')).status).toBe(403);
    expect((await s.get('/api/app/admin/policies')).status).toBe(403);
  });

  it('enforces tenant boundaries for human users', async () => {
    const s = await login('lakeAdmin');
    const { demo } = seedData();
    expect((await s.get(`/api/app/admin/students/${demo.mayaId}`)).status).toBe(404);
    const list = await s.get('/api/app/admin/students?pageSize=100');
    expect(list.body.data.every((x) => !x.email.endsWith('feddrick.edu'))).toBe(true);
  });
});
