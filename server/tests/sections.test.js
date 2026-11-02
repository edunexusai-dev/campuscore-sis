import { describe, it, expect } from 'vitest';
import { login, prisma } from './helpers.js';

// Section schedules: sections without meeting times are findable so an administrator can
// complete them; nothing is invented for them.
describe('section meeting times', () => {
  it('lists sections with no meeting times separately, and the filter reflects edits', async () => {
    const admin = await login('admin');
    const term = await prisma.term.findFirst({ where: { institution: { slug: 'feddrick' }, isCurrent: true } });
    const course = await prisma.course.findFirst({ where: { code: 'ENGL 220' } });
    const created = await admin.post('/api/app/admin/sections', { termId: term.id, courseId: course.id, sectionNumber: '77', capacity: 10, waitlistCapacity: 0, meetings: [] });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const unscheduled = await admin.get(`/api/app/admin/sections?termId=${term.id}&scheduled=false&pageSize=100`);
    expect(unscheduled.status).toBe(200);
    expect(unscheduled.body.data.map((s) => s.id)).toContain(id);
    expect(unscheduled.body.data.every((s) => s.meetings.length === 0)).toBe(true);
    const scheduled = await admin.get(`/api/app/admin/sections?termId=${term.id}&scheduled=true&pageSize=100`);
    expect(scheduled.body.data.map((s) => s.id)).not.toContain(id);
    expect(scheduled.body.data.every((s) => s.meetings.length > 0)).toBe(true);
    expect((await admin.get(`/api/app/admin/sections?scheduled=maybe`)).status).toBe(400);

    // The administrator adds meeting times; the section leaves the unscheduled list.
    const edited = await admin.patch(`/api/app/admin/sections/${id}`, { meetings: [{ dayOfWeek: 2, startTime: '09:00', endTime: '09:50', room: 'Hall 1' }, { dayOfWeek: 6, startTime: '10:00', endTime: '11:30', room: 'Hall 2' }] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const after = await admin.get(`/api/app/admin/sections?termId=${term.id}&scheduled=false&pageSize=100`);
    expect(after.body.data.map((s) => s.id)).not.toContain(id);
    const meetings = await prisma.meetingTime.findMany({ where: { sectionId: id }, orderBy: { dayOfWeek: 'asc' } });
    expect(meetings.map((m) => [m.dayOfWeek, m.startTime, m.room])).toEqual([[2, '09:00', 'Hall 1'], [6, '10:00', 'Hall 2']]);
  });
});
