import { describe, it, expect, beforeAll } from 'vitest';
import { login, getToken, api, prisma } from './helpers.js';

// Class announcements reach an integration per student: only those of sections the student is registered in.
let reader, me, mine, other;

beforeAll(async () => {
  const admin = await login('admin');
  const c = await admin.post('/api/app/admin/integrations', { name: 'Announcements reader', scopes: ['announcements:read'] });
  reader = api((await getToken(c.body.client.clientId, c.body.clientSecret)).body.access_token);
  me = await prisma.student.findFirst({ where: { email: 'maya.chen@students.feddrick.edu' } });
  const reg = await prisma.registration.findFirst({ where: { studentId: me.id, status: 'REGISTERED' } });
  const otherSection = await prisma.section.findFirst({ where: { institutionId: me.institutionId, registrations: { none: { studentId: me.id } } } });
  mine = await prisma.announcement.create({ data: { institutionId: me.institutionId, sectionId: reg.sectionId, title: 'Quiz moved to Thursday', body: 'See you in class.', audience: 'STUDENTS', authorName: 'Instructor' } });
  other = await prisma.announcement.create({ data: { institutionId: me.institutionId, sectionId: otherSection.id, title: 'Not for Maya', body: 'Other section.', audience: 'STUDENTS', authorName: 'Instructor' } });
});

describe('class announcements for a student', () => {
  it('returns announcements of the student\'s registered sections only, with the section named', async () => {
    const res = await reader.get(`/api/v1/students/${me.id}/announcements`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((a) => a.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
    expect(res.body.data.find((a) => a.id === mine.id).section.label).toMatch(/^[A-Z]+ \d+-\w+$/);
  });
});
