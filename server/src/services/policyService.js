// Institutional policy registry. Each policy has a typed schema, default and description.
// Values are persisted per institution in the `Policy` table and enforced by the services.
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';

const bool = z.boolean();

// Student fields grouped by sensitivity. Anything not listed here is never writable through the integration API.
export const CONTACT_FIELDS = ['preferredName', 'phone', 'personalEmail', 'addressLine', 'city', 'region', 'postalCode', 'country', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation'];
export const PROFILE_FIELD_OPTIONS = [...CONTACT_FIELDS, 'firstName', 'lastName', 'dateOfBirth'];
export const ACADEMIC_FIELD_OPTIONS = ['programId', 'admitTermId', 'expectedGraduation'];

export const POLICY_DEFINITIONS = {
  // Registration
  'registration.maxCreditsPerTerm': { category: 'Registration', label: 'Maximum credits per term', description: 'Students cannot register beyond this many credits in a single term (waitlisted credits excluded).', schema: z.number().int().min(1).max(40), default: 18 },
  'registration.enforcePrerequisites': { category: 'Registration', label: 'Enforce prerequisites', description: 'Block registration unless prerequisite courses are completed with the minimum grade (or currently in progress).', schema: bool, default: true },
  'registration.enforceRegistrationWindow': { category: 'Registration', label: 'Enforce registration window', description: 'Students and integrations can only add classes between the term registration open and close dates. Administrators may override.', schema: bool, default: true },
  'registration.allowWaitlist': { category: 'Registration', label: 'Enable waitlists', description: 'When a section is full, place students on the waitlist (up to the section waitlist capacity) and auto-promote when seats open.', schema: bool, default: true },
  'registration.allowStudentSelfService': { category: 'Registration', label: 'Student self-registration', description: 'Allow students to add and drop classes from the student portal.', schema: bool, default: true },

  // Grades
  'grades.requireApproval': { category: 'Grading', label: 'Require registrar approval of submitted grades', description: 'If disabled, submitted grades are approved automatically.', schema: bool, default: true },
  'grades.autoPublishOnApproval': { category: 'Grading', label: 'Publish grades automatically on approval', description: 'If disabled, approved grades must be published explicitly by the registrar.', schema: bool, default: false },
  'grades.allowFacultyChangeRequests': { category: 'Grading', label: 'Allow faculty grade change requests', description: 'Faculty may request changes to published grades; requests require registrar approval.', schema: bool, default: true },
  'grades.facultyCanEnterGradesBeforeTermEnd': { category: 'Grading', label: 'Allow grade entry before term end', description: 'Allow faculty to enter draft grades before the term ends.', schema: bool, default: true },

  // Attendance
  'attendance.facultyEditWindowDays': { category: 'Attendance', label: 'Attendance edit window (days)', description: 'Faculty may record or correct attendance for class dates up to this many days in the past.', schema: z.number().int().min(0).max(365), default: 14 },
  'attendance.visibleToStudents': { category: 'Attendance', label: 'Students can view their attendance', description: 'Show attendance records in the student portal.', schema: bool, default: true },

  // Academic standing
  'standing.probationGpa': { category: 'Academic standing', label: 'Probation GPA threshold', description: 'Cumulative GPA below this places a student on academic probation.', schema: z.number().min(0).max(4), default: 2.0 },
  'standing.deansListGpa': { category: 'Academic standing', label: "Dean's list GPA threshold", description: "Cumulative GPA at or above this earns Dean's list standing.", schema: z.number().min(0).max(4), default: 3.5 },

  // Integration API
  'api.allowStudentContactWrites': { category: 'Integration API', label: 'Allow integrations to update student contact details', description: 'Permits clients with students:write to update phone, preferred name, address and emergency contact. Never identity or academic fields.', schema: bool, default: true },
  'api.allowRegistrationWrites': { category: 'Integration API', label: 'Allow integrations to register/drop students', description: 'Permits clients with registrations:write to add or drop registrations. All registration rules still apply.', schema: bool, default: true },
  'api.allowAttendanceWrites': { category: 'Integration API', label: 'Allow integrations to record attendance', description: 'Permits clients with attendance:write to record attendance on behalf of an assigned instructor.', schema: bool, default: true },
  'api.allowGradeWrites': { category: 'Integration API', label: 'Allow integrations to submit grades', description: 'Permits clients with grades:write to post draft grades on behalf of an assigned instructor. Integrations can never approve or publish grades.', schema: bool, default: false },
  'api.allowStudentCreation': { category: 'Integration API', label: 'Allow integrations to create student records', description: 'Permits clients with students:create to create student records (new records start as ADMITTED or ACTIVE; student numbers must be unique).', schema: bool, default: false },
  'api.allowStudentProfileUpdates': { category: 'Integration API', label: 'Allow integrations to update student profiles', description: 'Permits clients with students:update to change the profile fields selected below.', schema: bool, default: false },
  'api.studentProfileFields': { category: 'Integration API', label: 'Profile fields integrations may change', description: 'Fields a students:update client may change. Legal name and date of birth are identity data; enable them only if the integrating system verifies identity documents.', schema: z.array(z.enum(PROFILE_FIELD_OPTIONS)).max(PROFILE_FIELD_OPTIONS.length), default: CONTACT_FIELDS, options: PROFILE_FIELD_OPTIONS },
  'api.allowStudentAcademicUpdates': { category: 'Integration API', label: 'Allow integrations to update approved academic attributes', description: 'Permits clients with students:academic to change the academic attributes selected below. Status, standing, class level and grades are never writable this way.', schema: bool, default: false },
  'api.studentAcademicFields': { category: 'Integration API', label: 'Academic attributes integrations may change', description: 'Academic attributes a students:academic client may change, subject to program and term validation.', schema: z.array(z.enum(ACADEMIC_FIELD_OPTIONS)).max(ACADEMIC_FIELD_OPTIONS.length), default: ['expectedGraduation'], options: ACADEMIC_FIELD_OPTIONS },
  'api.allowStudentDeactivation': { category: 'Integration API', label: 'Allow integrations to deactivate students', description: 'Permits clients with students:deactivate to withdraw a student record. Registrations, grades, transcripts and audit history are always retained.', schema: bool, default: false },
  'api.allowIdentityLinkWrites': { category: 'Integration API', label: 'Allow integrations to link external accounts', description: 'Permits clients with identity:write to link or unlink external accounts (e.g. EdunexusAI users) to CampusCore student and faculty records.', schema: bool, default: false },
  'api.gradeWritesAutoSubmit': { category: 'Integration API', label: 'Integration grades are submitted for approval', description: 'If enabled, grades posted by integrations move directly to SUBMITTED (awaiting registrar approval) instead of staying as DRAFT.', schema: bool, default: false },
};

export const POLICY_KEYS = Object.keys(POLICY_DEFINITIONS);

const defaults = () => Object.fromEntries(POLICY_KEYS.map((k) => [k, POLICY_DEFINITIONS[k].default]));

export async function getPolicies(institutionId, tx = prisma) {
  const rows = await tx.policy.findMany({ where: { institutionId } });
  const values = defaults();
  for (const row of rows) {
    if (row.key in POLICY_DEFINITIONS) {
      const parsed = POLICY_DEFINITIONS[row.key].schema.safeParse(row.value);
      if (parsed.success) values[row.key] = parsed.data;
    }
  }
  return values;
}

export async function getPolicy(institutionId, key, tx = prisma) {
  return (await getPolicies(institutionId, tx))[key];
}

export async function listPolicyDefinitions(institutionId) {
  const values = await getPolicies(institutionId);
  const rows = await prisma.policy.findMany({ where: { institutionId } });
  const meta = Object.fromEntries(rows.map((r) => [r.key, r]));
  return POLICY_KEYS.map((key) => {
    const d = POLICY_DEFINITIONS[key];
    return {
      key,
      category: d.category,
      label: d.label,
      description: d.description,
      type: Array.isArray(d.default) ? 'fields' : typeof d.default,
      options: d.options,
      value: values[key],
      default: d.default,
      updatedAt: meta[key]?.updatedAt ?? null,
    };
  });
}

export async function updatePolicies(actor, changes) {
  const unknown = Object.keys(changes).filter((k) => !(k in POLICY_DEFINITIONS));
  if (unknown.length) throw badRequest('Unknown policy keys.', unknown.map((k) => ({ field: k, message: 'Unknown policy' })));
  const errors = [];
  for (const [key, value] of Object.entries(changes)) {
    const r = POLICY_DEFINITIONS[key].schema.safeParse(value);
    if (!r.success) errors.push({ field: key, message: r.error.issues[0].message });
  }
  if (errors.length) throw badRequest('Invalid policy values.', errors);

  return prisma.$transaction(async (tx) => {
    const before = await getPolicies(actor.institutionId, tx);
    for (const [key, value] of Object.entries(changes)) {
      if (JSON.stringify(before[key]) === JSON.stringify(value)) continue;
      await tx.policy.upsert({
        where: { institutionId_key: { institutionId: actor.institutionId, key } },
        create: { institutionId: actor.institutionId, key, value, updatedById: actor.id },
        update: { value, updatedById: actor.id },
      });
      await audit(actor, { action: 'policy.updated', entityType: 'Policy', entityId: key, summary: `Changed policy "${POLICY_DEFINITIONS[key].label}" from ${JSON.stringify(before[key])} to ${JSON.stringify(value)}`, before: { [key]: before[key] }, after: { [key]: value } }, tx);
    }
    return getPolicies(actor.institutionId, tx);
  });
}
