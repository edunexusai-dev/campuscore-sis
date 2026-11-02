import { describe, it, expect, beforeAll } from 'vitest';
import { login, prisma, seedData, request, app } from './helpers.js';
import { computeRecord, standingFor } from '../src/services/academicService.js';
import { meetingsOverlap } from '../src/services/registrationService.js';

let faculty, registrar, admin, sectionId;

beforeAll(async () => {
  faculty = await login('faculty');
  registrar = await login('registrar');
  admin = await login('admin');
  sectionId = seedData().demo.fullSectionId;
});

describe('grade workflow', () => {
  it('faculty can save draft grades for an assigned section', async () => {
    const gb = await faculty.get(`/api/app/faculty/sections/${sectionId}/grades`);
    expect(gb.status).toBe(200);
    const rows = gb.body.data.rows.filter((r) => r.registrationStatus === 'REGISTERED');
    const letters = ['A', 'B+', 'B', 'A-', 'C+', 'B-'];
    const res = await faculty.put(`/api/app/faculty/sections/${sectionId}/grades`, { grades: rows.map((r, i) => ({ registrationId: r.registrationId, letter: letters[i % letters.length] })) });
    expect(res.status).toBe(200);
    expect(res.body.data.counts.DRAFT).toBe(rows.length);
  });

  it('rejects letters outside the grade scale', async () => {
    const gb = await faculty.get(`/api/app/faculty/sections/${sectionId}/grades`);
    const res = await faculty.put(`/api/app/faculty/sections/${sectionId}/grades`, { grades: [{ registrationId: gb.body.data.rows[0].registrationId, letter: 'Z' }] });
    expect(res.status).toBe(400);
  });

  it('students cannot see draft grades', async () => {
    const student = await login('student');
    const res = await student.get('/api/app/student/grades');
    const current = res.body.data.terms.find((t) => t.courses.some((c) => c.sectionId === sectionId));
    expect(current.courses.find((c) => c.sectionId === sectionId).grade).toBeNull();
  });

  it('submits grades, then locks them against faculty edits', async () => {
    const submit = await faculty.post(`/api/app/faculty/sections/${sectionId}/grades/submit`);
    expect(submit.status).toBe(200);
    expect(submit.body.data.counts.SUBMITTED).toBeGreaterThan(0);
    const row = submit.body.data.rows.find((r) => r.grade?.status === 'SUBMITTED');
    const edit = await faculty.put(`/api/app/faculty/sections/${sectionId}/grades`, { grades: [{ registrationId: row.registrationId, letter: 'F' }] });
    expect(edit.status).toBe(422);
    expect(edit.body.error.code).toBe('grade_locked');
  });

  it('faculty cannot approve or publish their own grades', async () => {
    expect((await faculty.post(`/api/app/admin/sections/${sectionId}/grades/approve`)).status).toBe(403);
    expect((await faculty.post(`/api/app/admin/sections/${sectionId}/grades/publish`)).status).toBe(403);
  });

  it('registrar approves and publishes; students then see official grades and GPA', async () => {
    const approve = await registrar.post(`/api/app/admin/sections/${sectionId}/grades/approve`);
    expect(approve.status).toBe(200);
    expect(approve.body.data.counts.APPROVED).toBeGreaterThan(0);
    const publish = await registrar.post(`/api/app/admin/sections/${sectionId}/grades/publish`);
    expect(publish.status).toBe(200);
    expect(publish.body.data.counts.PUBLISHED).toBeGreaterThan(0);

    const regs = await prisma.registration.findMany({ where: { sectionId, status: { in: ['REGISTERED', 'COMPLETED'] } } });
    expect(regs.every((r) => r.status === 'COMPLETED')).toBe(true);

    const student = await login('student');
    const res = await student.get('/api/app/student/grades');
    const course = res.body.data.terms.flatMap((t) => t.courses).find((c) => c.sectionId === sectionId);
    expect(course.grade).toBeTruthy();
    expect(course.state).toBe('GRADED');
    expect(res.body.data.cumulativeGpa).toBeGreaterThan(0);
    const audit = await prisma.auditEvent.findFirst({ where: { action: 'grade.published', entityId: sectionId } });
    expect(audit).toBeTruthy();
  });

  it('published grades change only through an approved change request', async () => {
    const gb = await faculty.get(`/api/app/faculty/sections/${sectionId}/grades`);
    const row = gb.body.data.rows.find((r) => r.grade?.status === 'PUBLISHED');
    const direct = await faculty.put(`/api/app/faculty/sections/${sectionId}/grades`, { grades: [{ registrationId: row.registrationId, letter: 'A' }] });
    expect([422]).toContain(direct.status);

    const target = row.grade.letter === 'A' ? 'A-' : 'A';
    const req = await faculty.post('/api/app/faculty/grade-changes', { gradeId: row.grade.id, toLetter: target, reason: 'Arithmetic error in final exam total' });
    expect(req.status).toBe(201);
    const review = await registrar.post(`/api/app/admin/grade-changes/${req.body.data.id}/review`, { approve: true, note: 'Verified with instructor' });
    expect(review.status).toBe(200);
    const grade = await prisma.grade.findUnique({ where: { id: row.grade.id }, include: { history: true } });
    expect(grade.letter).toBe(target);
    expect(grade.history.some((h) => h.fromLetter === row.grade.letter && h.toLetter === target)).toBe(true);
  });

  it('enforces separation of duties for registrar-initiated grade changes', async () => {
    const grade = await prisma.grade.findFirst({ where: { status: 'PUBLISHED', changeRequests: { none: { status: 'PENDING' } }, letter: 'B' } });
    const req = await registrar.post('/api/app/admin/grade-changes', { gradeId: grade.id, toLetter: 'B+', reason: 'Transcription error on paper roster' });
    expect(req.status).toBe(201);
    const self = await registrar.post(`/api/app/admin/grade-changes/${req.body.data.id}/review`, { approve: true });
    expect(self.status).toBe(403);
    const other = await admin.post(`/api/app/admin/grade-changes/${req.body.data.id}/review`, { approve: false, note: 'Insufficient documentation' });
    expect(other.status).toBe(200);
  });
});

describe('attendance', () => {
  it('faculty records attendance for an assigned section within the edit window', async () => {
    const detail = await faculty.get(`/api/app/faculty/sections/${sectionId}`);
    const roster = detail.body.data.roster.filter((r) => ['REGISTERED', 'COMPLETED'].includes(r.status));
    const date = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const res = await faculty.put(`/api/app/faculty/sections/${sectionId}/attendance`, { date, records: roster.map((r) => ({ studentId: r.student.id, status: 'PRESENT' })) });
    expect(res.status).toBe(200);
    expect(res.body.data.recorded).toBe(roster.length);
  });

  it('rejects future dates', async () => {
    const detail = await faculty.get(`/api/app/faculty/sections/${sectionId}`);
    const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const res = await faculty.put(`/api/app/faculty/sections/${sectionId}/attendance`, { date, records: [{ studentId: detail.body.data.roster[0].student.id, status: 'PRESENT' }] });
    expect(res.status).toBe(422);
  });
});

describe('academic calculations', () => {
  const scale = { byLetter: { A: { points: 4, countsInGpa: true, earnsCredit: true }, B: { points: 3, countsInGpa: true, earnsCredit: true }, F: { points: 0, countsInGpa: true, earnsCredit: false }, P: { points: 0, countsInGpa: false, earnsCredit: true } } };
  const term = { id: 't1', code: 'T1', name: 'T1', startDate: new Date() };
  const reg = (letter, credits, status = 'COMPLETED') => ({ id: Math.random().toString(), sectionId: 's', status, creditsAttempted: credits, grade: letter ? { letter, status: 'PUBLISHED' } : null, section: { term, course: { id: 'c', code: 'X 1', title: 'X' } } });

  it('computes credit-weighted GPA from published grades only', () => {
    const r = computeRecord([reg('A', 4), reg('B', 3), reg('F', 3), reg('P', 3), reg(null, 3, 'REGISTERED'), reg(null, 3, 'WITHDRAWN')], scale);
    expect(r.cumulativeGpa).toBe(Number(((16 + 9 + 0) / 10).toFixed(2)));
    expect(r.creditsEarned).toBe(10);
    expect(r.creditsInProgress).toBe(3);
  });

  it('derives academic standing from policy thresholds', () => {
    const p = { 'standing.probationGpa': 2, 'standing.deansListGpa': 3.5 };
    expect(standingFor(1.9, p)).toBe('PROBATION');
    expect(standingFor(3.6, p)).toBe('DEANS_LIST');
    expect(standingFor(2.8, p)).toBe('GOOD');
    expect(standingFor(null, p)).toBe('GOOD');
  });

  it('detects meeting-time conflicts', () => {
    expect(meetingsOverlap([{ dayOfWeek: 1, startTime: '09:00', endTime: '09:50' }], [{ dayOfWeek: 1, startTime: '09:30', endTime: '10:45' }])).toBe(true);
    expect(meetingsOverlap([{ dayOfWeek: 1, startTime: '09:00', endTime: '09:50' }], [{ dayOfWeek: 1, startTime: '09:50', endTime: '10:45' }])).toBe(false);
    expect(meetingsOverlap([{ dayOfWeek: 1, startTime: '09:00', endTime: '09:50' }], [{ dayOfWeek: 2, startTime: '09:00', endTime: '09:50' }])).toBe(false);
  });
});

describe('health', () => {
  it('reports healthy', async () => {
    expect((await request(app).get('/healthz')).body.status).toBe('ok');
  });
});
