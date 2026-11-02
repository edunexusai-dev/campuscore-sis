// What a signed-in account may act as. ADMIN and REGISTRAR are granted to the account explicitly (User.role);
// STUDENT and FACULTY come from the records on the account: one login can hold both (a lecturer who also studies).
// Authorization checks ANY role the account holds; the persona a person is "in" only decides which home and
// navigation the web app shows, never what the server allows.
import { LOGIN_ACCESS } from '../services/personService.js';

export const STAFF_ROLES = ['ADMIN', 'REGISTRAR'];
export const HOME = { ADMIN: '/admin', REGISTRAR: '/admin', FACULTY: '/faculty', STUDENT: '/student' };

/** `user` needs `role`, and `student` / `faculty` with at least `status` (or null). */
export function effectiveRoles(user) {
  const roles = [];
  if (STAFF_ROLES.includes(user.role)) roles.push(user.role);
  if (user.faculty && LOGIN_ACCESS.FACULTY(user.faculty)) roles.push('FACULTY');
  if (user.student && LOGIN_ACCESS.STUDENT(user.student)) roles.push('STUDENT');
  return roles;
}

export const rolesOf = (user) => user.roles ?? effectiveRoles(user);

/** Where to land after sign-in: the only home, or the persona chooser ("/") when there are several. */
export function homeFor(roles) {
  const homes = [...new Set(roles.map((r) => HOME[r]))];
  return homes.length === 1 ? homes[0] : '/';
}

// Prisma `include` for an account with what effectiveRoles() needs.
export const roleInclude = { student: { select: { id: true, status: true } }, faculty: { select: { id: true, status: true } } };
