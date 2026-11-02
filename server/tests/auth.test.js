import { describe, it, expect } from 'vitest';
import { app, request, login, USERS, PASSWORD } from './helpers.js';

describe('human authentication', () => {
  it.each(['admin', 'registrar', 'faculty', 'student'])('%s can sign in and load their profile', async (who) => {
    const s = await login(who);
    const me = await s.get('/api/app/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(USERS[who]);
    expect(me.body.user.permissions.length).toBeGreaterThan(0);
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const bad = await request(app).post('/api/app/auth/login').send({ email: USERS.student, password: 'wrong-password' });
    const missing = await request(app).post('/api/app/auth/login').send({ email: 'nobody@feddrick.edu', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(bad.body.error.message).toBe(missing.body.error.message);
  });

  it('sets an HttpOnly SameSite session cookie', async () => {
    const res = await request(app).post('/api/app/auth/login').send({ email: USERS.admin, password: PASSWORD });
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('requires a session for portal endpoints', async () => {
    const res = await request(app).get('/api/app/student/dashboard');
    expect(res.status).toBe(401);
  });

  it('rejects state-changing requests without the CSRF token', async () => {
    const s = await login('student');
    const res = await s.agent.patch('/api/app/student/profile').send({ phone: '555' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_failed');
  });

  it('signs out and invalidates the session', async () => {
    const s = await login('student');
    expect((await s.post('/api/app/auth/logout')).status).toBe(200);
    expect((await s.get('/api/app/auth/me')).status).toBe(401);
  });

  it('does not accept a human session on the integration API', async () => {
    const s = await login('admin');
    const res = await s.get('/api/v1/students');
    expect(res.status).toBe(401);
  });
});
