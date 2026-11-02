// Effective write capability for an integration client = scope granted on the token
//   AND institutional policy enabled (CampusCore administrators)
//   AND not disabled by the client's own write preferences (which can only narrow, never broaden).
// Field lists are intersected the same way. Every write endpoint calls assertOperation()/allowedFields().
import { z } from 'zod';
import { AppError, forbidden, ruleViolation, badRequest } from '../lib/errors.js';
import { getPolicies, CONTACT_FIELDS, PROFILE_FIELD_OPTIONS, ACADEMIC_FIELD_OPTIONS } from './policyService.js';

export const OPERATIONS = {
  'student.create': { label: 'Create student records', scope: 'students:create', policy: 'api.allowStudentCreation' },
  'student.update': { label: 'Update student profile fields', scope: 'students:update', policy: 'api.allowStudentProfileUpdates', fieldsPolicy: 'api.studentProfileFields', prefFields: 'profileFields', fieldOptions: PROFILE_FIELD_OPTIONS },
  'student.contact': { label: 'Update student contact details (legacy students:write)', scope: 'students:write', policy: 'api.allowStudentContactWrites', fixedFields: CONTACT_FIELDS },
  'student.academic': { label: 'Update approved academic attributes', scope: 'students:academic', policy: 'api.allowStudentAcademicUpdates', fieldsPolicy: 'api.studentAcademicFields', prefFields: 'academicFields', fieldOptions: ACADEMIC_FIELD_OPTIONS },
  'student.deactivate': { label: 'Deactivate students', scope: 'students:deactivate', policy: 'api.allowStudentDeactivation' },
  'registration.write': { label: 'Register and drop students', scope: 'registrations:write', policy: 'api.allowRegistrationWrites' },
  'attendance.write': { label: 'Record attendance', scope: 'attendance:write', policy: 'api.allowAttendanceWrites' },
  'grade.write': { label: 'Post draft grades', scope: 'grades:write', policy: 'api.allowGradeWrites' },
  'identity.link': { label: 'Link and unlink external accounts', scope: 'identity:write', policy: 'api.allowIdentityLinkWrites' },
};
export const OPERATION_NAMES = Object.keys(OPERATIONS);

export const writePreferencesSchema = z.object({
  disabledOperations: z.array(z.enum(OPERATION_NAMES)).max(OPERATION_NAMES.length).default([]),
  profileFields: z.array(z.enum(PROFILE_FIELD_OPTIONS)).max(PROFILE_FIELD_OPTIONS.length).nullable().default(null),
  academicFields: z.array(z.enum(ACADEMIC_FIELD_OPTIONS)).max(ACADEMIC_FIELD_OPTIONS.length).nullable().default(null),
}).strict();

export const readPreferences = (client) => {
  const r = writePreferencesSchema.safeParse(client.writePreferences ?? {});
  return r.success ? r.data : { disabledOperations: [], profileFields: null, academicFields: null };
};

function evaluateOne(name, { scopes, policies, prefs }) {
  const op = OPERATIONS[name];
  const scopeGranted = scopes.includes(op.scope);
  const policyEnabled = !!policies[op.policy];
  const clientEnabled = !prefs.disabledOperations.includes(name);
  let allowedFields;
  if (op.fixedFields) allowedFields = op.fixedFields;
  if (op.fieldsPolicy) {
    const byPolicy = policies[op.fieldsPolicy] ?? [];
    const byClient = prefs[op.prefFields];
    allowedFields = byClient ? byPolicy.filter((f) => byClient.includes(f)) : byPolicy;
  }
  const effective = scopeGranted && policyEnabled && clientEnabled && (!allowedFields || allowedFields.length > 0);
  const reason = !scopeGranted ? `Scope ${op.scope} is not granted to this client.` : !policyEnabled ? `Disabled by institutional policy (${op.policy}).` : !clientEnabled ? "Disabled by this client's write preferences." : allowedFields && !allowedFields.length ? 'No fields are enabled for this operation.' : null;
  return { operation: name, label: op.label, scope: op.scope, policy: op.policy, scopeGranted, policyEnabled, clientEnabled, ...(allowedFields ? { allowedFields } : {}), effective, reason };
}

export async function evaluateCapabilities(client, scopes, tx) {
  const [policies, prefs] = [await getPolicies(client.institutionId, tx), readPreferences(client)];
  return OPERATION_NAMES.map((n) => evaluateOne(n, { scopes, policies, prefs }));
}

// Throws the precise reason an operation is not allowed for this request.
export async function assertOperation(req, name) {
  const { client, scopes } = req.integration;
  const policies = await getPolicies(client.institutionId);
  const r = evaluateOne(name, { scopes, policies, prefs: readPreferences(client) });
  if (!r.scopeGranted) throw Object.assign(new AppError(403, 'insufficient_scope', `This operation requires the scope(s): ${r.scope}.`, { required: [r.scope], granted: scopes }), { oauth: true });
  if (!r.policyEnabled) throw ruleViolation('policy_disabled', `${OPERATIONS[name].label} via the API is disabled by institutional policy.`, { policy: r.policy });
  if (!r.clientEnabled) throw forbidden(`${OPERATIONS[name].label} is disabled in this integration's write preferences.`, 'disabled_by_client_preference');
  return r;
}

// For student PATCH: which requested fields are permitted, and by which operation.
export async function authorizeStudentFields(req, fields) {
  const { client, scopes } = req.integration;
  const policies = await getPolicies(client.institutionId);
  const prefs = readPreferences(client);
  const ops = ['student.contact', 'student.update', 'student.academic'].map((n) => evaluateOne(n, { scopes, policies, prefs }));
  const denied = [];
  const usedOps = new Set();
  for (const f of fields) {
    const granting = ops.find((o) => o.effective && o.allowedFields.includes(f));
    if (granting) { usedOps.add(granting.operation); continue; }
    const candidates = ops.filter((o) => (OPERATIONS[o.operation].fieldOptions ?? OPERATIONS[o.operation].fixedFields).includes(f));
    denied.push({ field: f, message: candidates.map((o) => o.reason ?? `Field not enabled for ${o.operation}.`).join(' ') || 'Field is not writable through the API.', requiredScopes: candidates.map((o) => o.scope) });
  }
  if (denied.length) throw new AppError(403, 'field_not_permitted', 'One or more fields cannot be changed by this integration.', denied);
  return [...usedOps];
}

export function validatePreferences(input) {
  const r = writePreferencesSchema.safeParse(input);
  if (!r.success) throw badRequest('Invalid write preferences.', r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  return r.data;
}
