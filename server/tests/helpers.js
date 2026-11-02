import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

export const app = createApp();
export const seedData = () => inject('seed');
export const PASSWORD = 'Northbridge#2026';
export const USERS = {
  admin: 'admin@feddrick.edu',
  registrar: 'registrar@feddrick.edu',
  faculty: 'e.vasquez@feddrick.edu',
  student: 'maya.chen@students.feddrick.edu',
  heldStudent: 'jordan.rivera@students.feddrick.edu',
  lakeAdmin: 'admin@lakeshore.edu',
};

// Signs in and returns helpers that send the session cookie and CSRF header.
export async function login(who) {
  const agent = request.agent(app);
  const res = await agent.post('/api/app/auth/login').send({ email: USERS[who] ?? who, password: PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${who}: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.csrfToken;
  return {
    user: res.body.user,
    get: (url) => agent.get(url),
    post: (url, body) => agent.post(url).set('X-CSRF-Token', csrf).send(body ?? {}),
    put: (url, body) => agent.put(url).set('X-CSRF-Token', csrf).send(body ?? {}),
    patch: (url, body) => agent.patch(url).set('X-CSRF-Token', csrf).send(body ?? {}),
    del: (url) => agent.delete(url).set('X-CSRF-Token', csrf),
    agent,
  };
}

export async function getToken(clientId, clientSecret, scope) {
  const res = await request(app).post('/api/v1/oauth/token').type('form').send({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, ...(scope ? { scope } : {}) });
  return res;
}

export function api(token) {
  const auth = (r) => r.set('Authorization', `Bearer ${token}`);
  return {
    get: (url) => auth(request(app).get(url)),
    post: (url, body) => auth(request(app).post(url)).send(body ?? {}),
    put: (url, body) => auth(request(app).put(url)).send(body ?? {}),
    patch: (url, body) => auth(request(app).patch(url)).send(body ?? {}),
  };
}

export async function setPolicy(key, value) {
  const inst = await prisma.institution.findUnique({ where: { slug: 'feddrick' } });
  await prisma.policy.upsert({ where: { institutionId_key: { institutionId: inst.id, key } }, create: { institutionId: inst.id, key, value }, update: { value } });
}

export { prisma, request };
