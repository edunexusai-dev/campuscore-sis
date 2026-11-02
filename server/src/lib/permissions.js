// Role → permission matrix for human users. Enforced server-side by requirePermission().
import { forbidden, unauthorized } from './errors.js';
import { rolesOf } from './roles.js';

export const PERMISSIONS = {
  'students.manage': { label: 'Manage student records, holds and status', roles: ['ADMIN', 'REGISTRAR'] },
  'students.export': { label: 'Export student data (CSV)', roles: ['ADMIN', 'REGISTRAR'] },
  'admissions.manage': { label: 'Review applications and make admission decisions', roles: ['ADMIN', 'REGISTRAR'] },
  'academics.manage': { label: 'Manage terms, programs, courses and sections', roles: ['ADMIN', 'REGISTRAR'] },
  'registrations.manage': { label: 'Register/drop students and override registration rules', roles: ['ADMIN', 'REGISTRAR'] },
  'grades.approve': { label: 'Approve, return and publish grades; review grade changes', roles: ['ADMIN', 'REGISTRAR'] },
  'documents.manage': { label: 'Process transcript and verification requests', roles: ['ADMIN', 'REGISTRAR'] },
  'communications.manage': { label: 'Manage announcements and the academic calendar', roles: ['ADMIN', 'REGISTRAR'] },
  'reports.view': { label: 'View reports and analytics', roles: ['ADMIN', 'REGISTRAR'] },
  'faculty.manage': { label: 'Manage faculty profiles and assignments', roles: ['ADMIN'] },
  'users.manage': { label: 'Manage user accounts and roles', roles: ['ADMIN'] },
  'policies.manage': { label: 'Change institutional policies', roles: ['ADMIN'] },
  'institution.manage': { label: 'Edit institution profile and grade scale', roles: ['ADMIN'] },
  'identity.manage': { label: 'Link and unlink external accounts (e.g. EdunexusAI users) to SIS records', roles: ['ADMIN', 'REGISTRAR'] },
  'integrations.manage': { label: 'Manage integration clients and API credentials', roles: ['ADMIN'] },
  'audit.view': { label: 'View the audit log and system health', roles: ['ADMIN'] },
  'teaching.manage': { label: 'Manage rosters, attendance and grades for assigned sections', roles: ['FACULTY'] },
  'self.service': { label: 'Student self-service (own records only)', roles: ['STUDENT'] },
};

// Permissions of an account holding `roles` (one role or several): the union of what each role grants.
export const permissionsFor = (roles) => {
  const held = [].concat(roles);
  return Object.entries(PERMISSIONS).filter(([, p]) => p.roles.some((r) => held.includes(r))).map(([k]) => k);
};

export const requirePermission = (perm) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!PERMISSIONS[perm]?.roles.some((r) => rolesOf(req.user).includes(r))) return next(forbidden());
  next();
};
