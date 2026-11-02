// OpenAPI 3.1 description of the external integration API (/api/v1).
// A test (tests/openapi.test.js) verifies every route here exists and every v1 route is documented.
import { config } from '../config.js';
import { SCOPES } from '../services/integrationService.js';

const enumStr = (...values) => ({ type: 'string', enum: values });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const dataOf = (schema) => ({ type: 'object', properties: { data: schema } });
const listOf = (schema) => ({ type: 'object', properties: { data: { type: 'array', items: schema } } });
const pagedOf = (schema) => ({ type: 'object', properties: { data: { type: 'array', items: schema }, pagination: ref('Pagination') } });
const idParam = (name = 'id', description = 'Resource ID') => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });
const q = (name, schema, description) => ({ name, in: 'query', required: false, schema, description });
const pageParams = [q('page', { type: 'integer', minimum: 1, default: 1 }), q('pageSize', { type: 'integer', minimum: 1, maximum: 100, default: 25 })];
const termIdParam = q('termId', { type: 'string' }, 'Filter by term ID (defaults to the current term where relevant)');
const h = (name, description, required = false) => ({ name, in: 'header', required, schema: { type: 'string' }, description });
const idemKey = (required) => h('Idempotency-Key', `${required ? 'Required. ' : ''}8–128 characters. Retries with the same key and body replay the original response (header Idempotent-Replayed: true) instead of repeating the write; the same key with a different body returns 422 idempotency_key_reused.`, required);
const actingUser = h('X-Acting-User', 'Optional. The human in the integrating system on whose behalf this write is made (recorded in the audit log; never used for authorization).');
const studentFieldProps = Object.fromEntries(['preferredName', 'phone', 'personalEmail', 'addressLine', 'city', 'region', 'postalCode', 'country', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation', 'firstName', 'lastName', 'dateOfBirth', 'programId', 'admitTermId', 'expectedGraduation'].map((k) => [k, { type: ['string', 'null'] }]));
const linkSchema = { type: 'object', properties: { id: { type: 'string' }, externalSystem: { type: 'string' }, externalUserId: { type: 'string' }, externalEmail: { type: ['string', 'null'] }, recordType: enumStr('STUDENT', 'FACULTY'), status: enumStr('ACTIVE', 'REVOKED'), method: { type: 'string' }, evidence: { type: 'object' }, sisRecord: { type: 'object' }, createdBy: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, revokedAt: { type: ['string', 'null'] } } };

const errors = (...codes) => Object.fromEntries(codes.map((c) => [c, { $ref: `#/components/responses/E${c}` }]));
const std = errors(401, 403, 429);

function op(tag, summary, scopes, { params = [], response, body, extraErrors = [], description, status = 200 } = {}) {
  return {
    tags: [tag],
    summary,
    description: [description, scopes.length ? `**Required scopes:** ${scopes.map((s) => `\`${s}\``).join(', ')}` : null].filter(Boolean).join('\n\n'),
    security: [{ oauth2: scopes }],
    parameters: params,
    ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
    responses: { [status]: json(response), ...std, ...errors(...extraErrors) },
  };
}


export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'CampusCore SIS Integration API',
    version: '1.0.0',
    description: `The CampusCore SIS external API lets authorised systems (such as EdunexusAI) read institutional academic records and, where explicitly permitted, submit changes.

**Authentication** — OAuth 2.0 client-credentials. An administrator creates an integration client in *Admin → Developer & Integrations*, which issues a client ID and secret. Exchange them at \`POST /api/v1/oauth/token\` for a short-lived bearer token and send it as \`Authorization: Bearer <token>\`.

**Authorisation** — every endpoint requires specific scopes. Write scopes are additionally gated by institutional policy switches and all business rules (registration eligibility, grade workflow state, instructor assignment). A write scope is never blanket permission.

**Errors** — all errors use the envelope \`{ "error": { "code", "message", "details?", "requestId" } }\`. The token endpoint uses RFC 6749 fields (\`error\`, \`error_description\`).

**Tenancy** — a client belongs to exactly one institution; records of other institutions are invisible (404).`,
  },
  servers: [{ url: config.publicApiUrl }],
  tags: [
    { name: 'OAuth', description: 'Token issuance and revocation' },
    { name: 'Institution' }, { name: 'Terms & Calendar' }, { name: 'Programs' }, { name: 'Courses & Sections' },
    { name: 'Students' }, { name: 'Faculty' }, { name: 'Identity', description: 'Cross-system account ↔ SIS record links' }, { name: 'Integration' }, { name: 'Registrations' }, { name: 'Grades' }, { name: 'Attendance' }, { name: 'Announcements' },
  ],
  paths: {
    '/api/v1/oauth/token': {
      post: {
        tags: ['OAuth'],
        summary: 'Issue an access token (client credentials grant)',
        description: 'Authenticate with HTTP Basic (`client_id:client_secret`) or form fields. Optionally request a subset of the client\'s scopes. Tokens are JWTs valid for the client\'s configured lifetime (default 15 minutes) and can be revoked server-side.',
        security: [],
        requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['grant_type'], properties: { grant_type: enumStr('client_credentials'), client_id: { type: 'string' }, client_secret: { type: 'string' }, scope: { type: 'string', description: 'Space-separated subset of granted scopes' } } } } } },
        responses: {
          200: json({ type: 'object', properties: { access_token: { type: 'string' }, token_type: enumStr('Bearer'), expires_in: { type: 'integer' }, scope: { type: 'string' } } }),
          400: json(ref('OAuthError'), 'unsupported_grant_type or invalid_scope'),
          401: json(ref('OAuthError'), 'invalid_client'),
          429: { $ref: '#/components/responses/E429' },
        },
      },
    },
    '/api/v1/oauth/revoke': {
      post: {
        tags: ['OAuth'], summary: 'Revoke an access token (RFC 7009)', security: [],
        requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' }, client_id: { type: 'string' }, client_secret: { type: 'string' } } } } } },
        responses: { 200: json({ type: 'object', properties: { revoked: { type: 'boolean' } } }), 401: json(ref('OAuthError'), 'invalid_client') },
      },
    },
    '/api/v1/me': { get: op('OAuth', 'Describe the calling client and token', [], { response: { type: 'object', properties: { clientId: { type: 'string' }, name: { type: 'string' }, institutionId: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } }, tokenExpiresAt: { type: 'string', format: 'date-time' } } } }) },
    '/api/v1/institution': { get: op('Institution', 'Get institution profile', ['institution:read'], { response: dataOf(ref('Institution')) }) },
    '/api/v1/terms': { get: op('Terms & Calendar', 'List academic terms', ['terms:read'], { params: [q('status', enumStr('PLANNED', 'REGISTRATION_OPEN', 'IN_PROGRESS', 'COMPLETED')), q('current', enumStr('true', 'false'))], response: listOf(ref('Term')) }) },
    '/api/v1/terms/{id}': { get: op('Terms & Calendar', 'Get a term', ['terms:read'], { params: [idParam()], response: dataOf(ref('Term')), extraErrors: [404] }) },
    '/api/v1/calendar': { get: op('Terms & Calendar', 'List academic calendar events', ['calendar:read'], { params: [termIdParam, q('from', { type: 'string', format: 'date' }), q('to', { type: 'string', format: 'date' }), q('category', enumStr('ACADEMIC', 'DEADLINE', 'HOLIDAY', 'EXAM', 'EVENT'))], response: listOf(ref('CalendarEvent')), extraErrors: [400] }) },
    '/api/v1/departments': { get: op('Programs', 'List departments', ['programs:read'], { response: listOf(ref('Department')) }) },
    '/api/v1/programs': { get: op('Programs', 'List academic programs', ['programs:read'], { params: [q('departmentId', { type: 'string' }), q('level', enumStr('UNDERGRADUATE', 'GRADUATE'))], response: listOf(ref('Program')) }) },
    '/api/v1/courses': { get: op('Courses & Sections', 'List catalog courses', ['courses:read'], { params: [...pageParams, q('search', { type: 'string' }), q('departmentId', { type: 'string' }), q('sort', { type: 'string', example: '-credits' }, 'code | title | credits | level; prefix with - for descending')], response: pagedOf(ref('Course')), extraErrors: [400] }) },
    '/api/v1/courses/{id}': { get: op('Courses & Sections', 'Get a course', ['courses:read'], { params: [idParam()], response: dataOf(ref('Course')), extraErrors: [404] }) },
    '/api/v1/sections': { get: op('Courses & Sections', 'List course sections', ['sections:read'], { params: [...pageParams, termIdParam, q('courseId', { type: 'string' }), q('facultyId', { type: 'string' }), q('search', { type: 'string' }), q('status', enumStr('OPEN', 'CLOSED', 'CANCELLED'))], response: pagedOf(ref('Section')), extraErrors: [400] }) },
    '/api/v1/sections/{id}': { get: op('Courses & Sections', 'Get a section with seats, meetings and instructors', ['sections:read'], { params: [idParam()], response: dataOf(ref('Section')), extraErrors: [404] }) },
    '/api/v1/sections/{id}/roster': { get: op('Registrations', 'Class roster (registered, waitlisted, completed)', ['registrations:read'], { params: [idParam()], response: listOf(ref('Registration')), extraErrors: [404] }) },
    '/api/v1/sections/{id}/grades': {
      get: op('Grades', 'Section grade status (published letters only)', ['grades:read'], { params: [idParam()], response: dataOf({ type: 'object' }), extraErrors: [404], description: 'Returns the grading workflow status for each student. Letter grades are included only once PUBLISHED.' }),
      put: op('Grades', 'Post draft grades on behalf of an instructor', ['grades:write'], {
        params: [idParam()],
        body: { type: 'object', required: ['actingFacultyId', 'grades'], additionalProperties: false, properties: { actingFacultyId: { type: 'string', description: 'Must be an instructor assigned to this section' }, grades: { type: 'array', items: { type: 'object', required: ['studentId', 'letter'], properties: { studentId: { type: 'string' }, letter: { type: 'string', example: 'B+' }, comment: { type: 'string' } } } } } },
        response: dataOf({ type: 'object' }), extraErrors: [400, 404, 422],
        description: 'Requires policy **api.allowGradeWrites**. Grades are saved as DRAFT (or SUBMITTED if **api.gradeWritesAutoSubmit** is on) and still require registrar approval and publication. Grades that are already submitted, approved or published cannot be changed (`grade_locked`).',
      }),
    },
    '/api/v1/sections/{id}/attendance': {
      get: op('Attendance', 'Section attendance', ['attendance:read'], { params: [idParam(), q('date', { type: 'string', format: 'date' })], response: dataOf({ type: 'object' }), extraErrors: [404] }),
      post: op('Attendance', 'Record attendance for a class date', ['attendance:write'], {
        params: [idParam()],
        body: { type: 'object', required: ['actingFacultyId', 'date', 'records'], additionalProperties: false, properties: { actingFacultyId: { type: 'string' }, date: { type: 'string', format: 'date' }, records: { type: 'array', items: { type: 'object', required: ['studentId', 'status'], properties: { studentId: { type: 'string' }, status: enumStr('PRESENT', 'ABSENT', 'LATE', 'EXCUSED'), note: { type: 'string' } } } } } },
        response: dataOf({ type: 'object', properties: { sectionId: { type: 'string' }, date: { type: 'string' }, recorded: { type: 'integer' } } }), extraErrors: [400, 404, 422],
        description: 'Requires policy **api.allowAttendanceWrites**. The acting faculty member must teach the section; the date must be in the term, not in the future, and within the attendance edit window.',
      }),
    },
    '/api/v1/students': {
      post: op('Students', 'Create a student record', ['students:create'], {
        status: 201, params: [idemKey(true), actingUser],
        body: { type: 'object', required: ['firstName', 'lastName', 'email', 'programId'], additionalProperties: false, properties: { firstName: { type: 'string' }, lastName: { type: 'string' }, email: { type: 'string', format: 'email', description: 'Institutional email; must be unique among the institution\'s students' }, studentNumber: { type: 'string', description: 'Optional; generated when omitted; must be unique' }, programId: { type: 'string' }, admitTermId: { type: 'string' }, status: enumStr('ADMITTED', 'ACTIVE'), dateOfBirth: { type: 'string', format: 'date' }, expectedGraduation: { type: 'string', example: 'Spring 2030' }, preferredName: { type: 'string' }, phone: { type: 'string' }, personalEmail: { type: 'string' } } },
        response: dataOf(ref('Student')), extraErrors: [400, 409, 422],
        description: 'Requires policy **api.allowStudentCreation**. Validates program (active, same institution), admit term, unique email (**409 duplicate_student** with the existing id) and unique student number (**409 duplicate_student_number**). Requires an **Idempotency-Key** so a retried request after a timeout never creates a second record.',
      }),
      get: op('Students', 'List students', ['students:read'], { params: [...pageParams, q('search', { type: 'string' }, 'Name, email or student number'), q('email', { type: 'string' }, 'Exact institutional email'), q('studentNumber', { type: 'string' }, 'Exact student number'), q('status', enumStr('APPLICANT', 'ADMITTED', 'ACTIVE', 'LEAVE_OF_ABSENCE', 'SUSPENDED', 'WITHDRAWN', 'GRADUATED')), q('programId', { type: 'string' }), q('classLevel', enumStr('FRESHMAN', 'SOPHOMORE', 'JUNIOR', 'SENIOR', 'GRADUATE')), q('sort', { type: 'string' }, 'lastName | firstName | studentNumber | updatedAt | createdAt; prefix - for descending')], response: pagedOf(ref('Student')), extraErrors: [400] }),
    },
    '/api/v1/students/{id}': {
      get: op('Students', 'Get a student (returns an ETag)', ['students:read'], { params: [idParam()], response: dataOf(ref('Student')), extraErrors: [404] }),
      patch: op('Students', 'Update permitted student fields', [], {
        params: [idParam(), h('If-Match', 'Optional ETag from GET; 412 precondition_failed if the record changed since.'), actingUser],
        body: { type: 'object', additionalProperties: false, properties: studentFieldProps },
        response: dataOf(ref('Student')), extraErrors: [400, 404, 412, 422],
        description: `Field-level authorization. Each field must be permitted by one effective operation:\n\n- **students:write** (legacy) + policy **api.allowStudentContactWrites** → contact fields only\n- **students:update** + policy **api.allowStudentProfileUpdates** → fields listed in policy **api.studentProfileFields**\n- **students:academic** + policy **api.allowStudentAcademicUpdates** → fields listed in **api.studentAcademicFields** (programId, admitTermId, expectedGraduation; validated against the institution and not allowed for withdrawn/graduated students)\n\nFields not permitted → **403 field_not_permitted** with per-field reasons. Student number, status, standing, class level and institutional email are never writable (400). A client's write preferences can narrow these further.`,
      }),
    },
    '/api/v1/students/{id}/deactivate': {
      post: op('Students', 'Deactivate (withdraw) a student record', ['students:deactivate'], {
        params: [idParam(), idemKey(false), actingUser],
        body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 5 }, dropFutureRegistrations: { type: 'boolean', default: false } } },
        response: dataOf(ref('Student')), extraErrors: [400, 404, 422],
        description: 'Requires policy **api.allowStudentDeactivation**. Sets status WITHDRAWN and disables the student\'s CampusCore portal login. Nothing is deleted: registrations, grades, transcript and audit history are retained. Rejected with **422 active_term_registrations** if the student is registered in a term in progress, and **422 future_registrations** for upcoming-term registrations unless `dropFutureRegistrations: true`. Idempotent: deactivating an already-withdrawn student returns 200 with `meta.changed: false`.',
      }),
    },
    '/api/v1/students/{id}/audit': { get: op('Students', "A student record's audit history", ['audit:read'], { params: [idParam(), ...pageParams], response: pagedOf({ type: 'object' }), extraErrors: [404] }) },
    '/api/v1/capabilities': { get: op('OAuth', "Effective write capabilities for this client (scope × institutional policy × client preferences)", [], { response: dataOf({ type: 'object' }) }) },
    '/api/v1/integration/write-preferences': {
      get: op('Integration', "This client's write preferences and effective capabilities", [], { response: dataOf({ type: 'object' }) }),
      put: op('Integration', "Narrow this client's own write operations and fields", ['integration:configure'], {
        params: [actingUser],
        body: { type: 'object', additionalProperties: false, properties: { disabledOperations: { type: 'array', items: { type: 'string' } }, profileFields: { type: ['array', 'null'], items: { type: 'string' } }, academicFields: { type: ['array', 'null'], items: { type: 'string' } } } },
        response: dataOf({ type: 'object' }), extraErrors: [400],
        description: 'Lets the integrating system\'s own administrators switch off write operations or fields. Preferences can only narrow access: effective = scope ∧ institutional policy ∧ preference. Audited.',
      }),
    },
    '/api/v1/identity/reconcile': {
      post: op('Identity', 'Classify external accounts against SIS records (never links)', ['identity:read'], {
        body: { type: 'object', required: ['candidates'], properties: { externalSystem: { type: 'string', default: 'edunexusai' }, candidates: { type: 'array', maxItems: 200, items: { type: 'object', required: ['externalUserId', 'recordType'], properties: { externalUserId: { type: 'string' }, recordType: enumStr('STUDENT', 'FACULTY'), email: { type: 'string' }, institutionalId: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' } } } } } },
        response: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: { externalUserId: { type: 'string' }, status: enumStr('LINKED', 'CANDIDATE', 'AMBIGUOUS', 'UNMATCHED'), candidates: { type: 'array', items: { type: 'object' } }, reason: { type: 'string' } } } }, summary: { type: 'object' } } },
        extraErrors: [400],
        description: 'Uses only strong identifiers (institutional/personal email, student or employee number). Names are returned for review but never used to match. CANDIDATE = exactly one unlinked record matches; AMBIGUOUS = identifiers disagree, several records match, or the record is already linked elsewhere.',
      }),
    },
    '/api/v1/identity/resolve': { get: op('Identity', 'Resolve an external account to its linked SIS record (per record type when recordType is given; LINKED_MULTIPLE without it when the account holds several links)', ['identity:read'], { params: [q('externalSystem', { type: 'string', default: 'edunexusai' }), { name: 'externalUserId', in: 'query', required: true, schema: { type: 'string' } }, q('recordType', enumStr('STUDENT', 'FACULTY'))], response: dataOf({ type: 'object', properties: { status: enumStr('LINKED', 'LINKED_MULTIPLE', 'UNMAPPED'), recordType: { type: 'string' }, sisId: { type: 'string' }, institutionalId: { type: 'string' }, links: { type: 'array', items: { type: 'object' } } } }), extraErrors: [400] }) },
    '/api/v1/identity/links': {
      get: op('Identity', 'List identity links', ['identity:read'], { params: [...pageParams, q('externalSystem', { type: 'string' }), q('externalUserId', { type: 'string' }), q('recordType', enumStr('STUDENT', 'FACULTY')), q('status', enumStr('ACTIVE', 'REVOKED')), q('sisRecordId', { type: 'string' })], response: pagedOf(linkSchema), extraErrors: [400] }),
      post: op('Identity', 'Link an external account to a SIS record', ['identity:write'], {
        status: 201, params: [idemKey(false), actingUser],
        body: { type: 'object', required: ['externalUserId', 'recordType', 'sisRecordId', 'confirm'], additionalProperties: false, properties: { externalSystem: { type: 'string', default: 'edunexusai' }, externalUserId: { type: 'string' }, recordType: enumStr('STUDENT', 'FACULTY'), sisRecordId: { type: 'string' }, externalEmail: { type: 'string' }, externalLabel: { type: 'string' }, confirm: { type: 'boolean', const: true }, evidenceMismatchReason: { type: 'string' } } },
        response: dataOf(linkSchema), extraErrors: [400, 404, 409, 422],
        description: 'Requires policy **api.allowIdentityLinkWrites**. One ACTIVE link per external account and per SIS record (409 identity_already_linked / record_already_linked). If externalEmail does not match the record\'s email, 422 identity_evidence_mismatch unless evidenceMismatchReason is supplied. To change a mapping: revoke, then link.',
      }),
    },
    '/api/v1/identity/links/{id}/revoke': { post: op('Identity', 'Revoke an identity link (history kept)', ['identity:write'], { params: [idParam(), actingUser], body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 5 } } }, response: dataOf(linkSchema), extraErrors: [400, 404, 422] }) },
    '/api/v1/students/{id}/registrations': { get: op('Registrations', "A student's registrations", ['registrations:read'], { params: [idParam(), termIdParam, q('status', enumStr('REGISTERED', 'WAITLISTED', 'DROPPED', 'WITHDRAWN', 'COMPLETED'))], response: listOf(ref('Registration')), extraErrors: [404] }) },
    '/api/v1/students/{id}/schedule': { get: op('Students', "A student's class schedule for a term", ['schedules:read'], { params: [idParam(), termIdParam], response: dataOf({ type: 'object', properties: { term: { type: 'object' }, classes: { type: 'array', items: { allOf: [ref('Section'), { type: 'object', properties: { registrationId: { type: 'string' }, registrationStatus: enumStr('REGISTERED', 'WAITLISTED', 'COMPLETED'), waitlistPosition: { type: ['integer', 'null'] } } }] } } } }), extraErrors: [404] }) },
    '/api/v1/students/{id}/grades': { get: op('Grades', "A student's published grades by term", ['grades:read'], { params: [idParam()], response: listOf({ type: 'object' }), extraErrors: [404] }) },
    '/api/v1/students/{id}/academic-record': { get: op('Grades', 'GPA, credits and standing', ['grades:read'], { params: [idParam()], response: dataOf(ref('AcademicRecord')), extraErrors: [404] }) },
    '/api/v1/students/{id}/attendance': { get: op('Attendance', "A student's attendance by section", ['attendance:read'], { params: [idParam(), termIdParam], response: listOf({ type: 'object' }), extraErrors: [404] }) },
    '/api/v1/people': { get: op('People', 'List or look up people (person registry)', ['people:read'], { params: [...pageParams, q('personNumber', { type: 'string' }), q('studentNumber', { type: 'string' }), q('employeeNumber', { type: 'string' }), q('email', { type: 'string', format: 'email' }), q('updatedSince', { type: 'string', format: 'date-time' })], response: pagedOf(ref('Person')), extraErrors: [400], description: 'One entry per human being. Identifier filters are exact. `updatedSince` returns people whose person entry or any student/faculty record changed at or after that instant (incremental provisioning feed). People merged into another person are not listed.' }) },
    '/api/v1/people/{id}': { get: op('People', 'Get a person', ['people:read'], { params: [idParam()], response: dataOf(ref('Person')), extraErrors: [404] }) },
    '/api/v1/faculty': { get: op('Faculty', 'List faculty', ['faculty:read'], { params: [...pageParams, q('search', { type: 'string' }), q('departmentId', { type: 'string' }), q('sort', { type: 'string' })], response: pagedOf(ref('Faculty')), extraErrors: [400] }) },
    '/api/v1/faculty/{id}': { get: op('Faculty', 'Get a faculty member', ['faculty:read'], { params: [idParam()], response: dataOf(ref('Faculty')), extraErrors: [404] }) },
    '/api/v1/faculty/{id}/sections': { get: op('Faculty', 'Sections taught by a faculty member', ['faculty:read', 'sections:read'], { params: [idParam(), termIdParam], response: listOf(ref('Section')), extraErrors: [404] }) },
    '/api/v1/faculty/{id}/schedule': { get: op('Faculty', "A faculty member's teaching schedule", ['schedules:read'], { params: [idParam(), termIdParam], response: dataOf({ type: 'object' }), extraErrors: [404] }) },
    '/api/v1/registrations': {
      get: op('Registrations', 'List registrations', ['registrations:read'], { params: [...pageParams, termIdParam, q('studentId', { type: 'string' }), q('sectionId', { type: 'string' }), q('status', enumStr('REGISTERED', 'WAITLISTED', 'DROPPED', 'WITHDRAWN', 'COMPLETED'))], response: pagedOf(ref('Registration')), extraErrors: [400] }),
      post: op('Registrations', 'Register a student in a section', ['registrations:write'], {
        status: 201,
        body: { type: 'object', required: ['studentId', 'sectionId'], additionalProperties: false, properties: { studentId: { type: 'string' }, sectionId: { type: 'string' } } },
        response: dataOf(ref('Registration')), extraErrors: [400, 404, 409, 422],
        description: 'Requires policy **api.allowRegistrationWrites**. All registration rules apply exactly as in the student portal: student status, holds, registration window, prerequisites, credit limit, time conflicts, duplicate course and capacity. When a section is full and has waitlist space the student is WAITLISTED. Violations return 422 with the rule `code` (e.g. `prerequisite_not_met`, `registration_hold`, `section_full`).',
      }),
    },
    '/api/v1/registrations/{id}': { get: op('Registrations', 'Get a registration with its status history', ['registrations:read'], { params: [idParam()], response: dataOf(ref('Registration')), extraErrors: [404] }) },
    '/api/v1/registrations/{id}/drop': { post: op('Registrations', 'Drop or withdraw a registration', ['registrations:write'], { params: [idParam()], body: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string' } } }, response: dataOf(ref('Registration')), extraErrors: [400, 404, 422], description: 'Before the add/drop deadline the registration is DROPPED (removed from the record); before the withdrawal deadline it is WITHDRAWN (W on transcript); afterwards the request is rejected. Opening a seat promotes the next eligible waitlisted student.' }) },
    '/api/v1/announcements': { get: op('Announcements', 'Current institution-wide announcements', ['announcements:read'], { params: [q('audience', enumStr('ALL', 'STUDENTS', 'FACULTY', 'STAFF'))], response: listOf(ref('Announcement')) }) },
  },
  components: {
    securitySchemes: {
      oauth2: { type: 'oauth2', description: 'Client credentials grant', flows: { clientCredentials: { tokenUrl: '/api/v1/oauth/token', scopes: SCOPES } } },
    },
    responses: {
      E400: json(ref('Error'), 'Validation error (`validation_error`) with field details'),
      E401: json(ref('Error'), 'Missing, invalid, expired or revoked token (`invalid_request`, `invalid_token`)'),
      E403: json(ref('Error'), 'Token lacks a required scope (`insufficient_scope`) or acting user not permitted'),
      E404: json(ref('Error'), 'Not found, or not visible to this client\'s institution'),
      E409: json(ref('Error'), 'Conflict with existing state'),
      E412: json(ref('Error'), 'If-Match precondition failed (record changed)'),
      E422: json(ref('Error'), 'Business rule or institutional policy violation; `code` identifies the rule'),
      E429: json(ref('Error'), 'Rate limit exceeded'),
    },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } } } } },
      OAuthError: { type: 'object', properties: { error: { type: 'string' }, error_description: { type: 'string' } } },
      Pagination: { type: 'object', properties: { page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } } },
      Institution: { type: 'object', properties: { id: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' }, shortName: { type: 'string' }, timezone: { type: 'string' }, website: { type: 'string' }, address: { type: 'object' } } },
      Term: { type: 'object', properties: { id: { type: 'string' }, code: { type: 'string', example: '2026FA' }, name: { type: 'string' }, startDate: { type: 'string', format: 'date' }, endDate: { type: 'string', format: 'date' }, status: { type: 'string' }, isCurrent: { type: 'boolean' }, registration: { type: 'object' }, gradesDueDate: { type: 'string', format: 'date-time' } } },
      CalendarEvent: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, startDate: { type: 'string', format: 'date' }, endDate: { type: ['string', 'null'] }, termId: { type: ['string', 'null'] } } },
      Department: { type: 'object', properties: { id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, college: { type: 'object' } } },
      Program: { type: 'object', properties: { id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, degreeType: { type: 'string' }, level: { type: 'string' }, requiredCredits: { type: 'integer' } } },
      Course: { type: 'object', properties: { id: { type: 'string' }, code: { type: 'string', example: 'CS 201' }, title: { type: 'string' }, credits: { type: 'integer' }, level: { type: 'integer' }, department: { type: 'object' }, prerequisites: { type: 'array', items: { type: 'object', properties: { courseId: { type: 'string' }, code: { type: 'string' }, minGrade: { type: 'string' } } } } } },
      Section: { type: 'object', properties: { id: { type: 'string' }, termId: { type: 'string' }, termCode: { type: 'string' }, course: { type: 'object' }, sectionNumber: { type: 'string' }, status: { type: 'string' }, deliveryMode: { type: 'string' }, location: { type: 'string' }, capacity: { type: 'integer' }, enrolled: { type: 'integer' }, waitlisted: { type: 'integer' }, seatsAvailable: { type: 'integer' }, meetings: { type: 'array', items: { type: 'object', properties: { day: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' }, room: { type: 'string' } } } }, instructors: { type: 'array', items: { type: 'object' } } } },
      Student: { type: 'object', description: 'Excludes date of birth, home address, emergency contacts and financial references.', properties: { id: { type: 'string' }, personId: { type: 'string' }, studentNumber: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' }, preferredName: { type: ['string', 'null'] }, email: { type: 'string' }, phone: { type: ['string', 'null'] }, status: { type: 'string' }, classLevel: { type: 'string' }, academicStanding: { type: 'string' }, program: { type: ['object', 'null'] }, admitTerm: { type: ['string', 'null'] }, expectedGraduation: { type: ['string', 'null'] }, hasRegistrationHold: { type: 'boolean' }, updatedAt: { type: 'string', format: 'date-time' } } },
      Person: { type: 'object', description: 'A human being and their relationships. Names and emails are derived from the relationship records. primaryEmail: the current faculty email, else the current student email, else the most recent record email. status: ACTIVE (any current relationship), ALUMNI (graduated, nothing current) or INACTIVE.', properties: { id: { type: 'string' }, personNumber: { type: 'string' }, firstName: { type: ['string', 'null'] }, lastName: { type: ['string', 'null'] }, preferredName: { type: ['string', 'null'] }, primaryEmail: { type: ['string', 'null'] }, emails: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['ACTIVE', 'ALUMNI', 'INACTIVE'] }, relationships: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['STUDENT', 'FACULTY'] }, sisId: { type: 'string' }, number: { type: 'string' }, email: { type: 'string' }, status: { type: 'string' }, current: { type: 'boolean' } } } }, hasCampusCoreLogin: { type: 'boolean' }, mergedInto: { type: ['string', 'null'] }, updatedAt: { type: 'string', format: 'date-time' } } },
      Faculty: { type: 'object', properties: { id: { type: 'string' }, personId: { type: 'string' }, employeeNumber: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' }, email: { type: 'string' }, title: { type: 'string' }, department: { type: 'object' }, officeLocation: { type: 'string' }, officeHours: { type: 'string' } } },
      Registration: { type: 'object', properties: { id: { type: 'string' }, studentId: { type: 'string' }, sectionId: { type: 'string' }, status: enumStr('REGISTERED', 'WAITLISTED', 'DROPPED', 'WITHDRAWN', 'COMPLETED'), waitlistPosition: { type: ['integer', 'null'] }, credits: { type: 'integer' }, source: enumStr('STUDENT_PORTAL', 'ADMIN', 'API', 'SYSTEM'), registeredAt: { type: 'string', format: 'date-time' } } },
      AcademicRecord: { type: 'object', properties: { studentId: { type: 'string' }, cumulativeGpa: { type: ['number', 'null'] }, creditsAttempted: { type: 'integer' }, creditsEarned: { type: 'integer' }, creditsInProgress: { type: 'integer' }, academicStanding: { type: 'string' }, classLevel: { type: 'string' }, terms: { type: 'array', items: { type: 'object' } } } },
      Announcement: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, audience: { type: 'string' }, pinned: { type: 'boolean' }, publishedAt: { type: 'string', format: 'date-time' } } },
    },
  },
};
