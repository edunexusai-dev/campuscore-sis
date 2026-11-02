# CampusCore SIS — Integration Contract (API v1)

This document is for engineers building server-side integrations with CampusCore SIS, such as the EdunexusAI campus experience platform. It covers authentication, authorization, every endpoint, error handling, the rules on write operations, and which system owns which data.

The machine-readable specification (OpenAPI 3.1) is served at `GET /api/openapi.json`. The interactive reference is at `/api/docs`. An automated test checks that every documented route is implemented and every implemented route is documented.

---

## 1. Principles

- **CampusCore is the system of record** for the data listed in [§8](#8-data-ownership). Integrations read through the API and never touch CampusCore's database.
- **Server-to-server only.** Client secrets and access tokens belong in the integrating system's backend. They must never be shipped to browsers or mobile apps.
- **Least privilege.** Each client gets only the scopes an administrator grants it. A write scope is **not** blanket permission: every write is also gated by an institutional policy switch and by the same business rules the CampusCore portals enforce.
- **Tenant-bound.** A client belongs to exactly one institution. Other institutions' records are invisible to it and return `404`.
- **Stable and versioned.** Breaking changes ship under a new prefix (`/api/v2`). Additive changes, such as new optional fields or new endpoints, can appear in v1, so clients must ignore unknown fields.

## 2. Getting credentials

1. A CampusCore administrator opens **Admin → Developer & integrations → Register application**.
2. They give the application a name and description, and choose its scopes and token lifetime (5–60 minutes, 15 by default).
3. CampusCore returns a **client ID** (`cc_…`) and a **client secret** (`ccs_…`). The secret is displayed **once**. CampusCore stores only an HMAC-SHA-256 hash of it, keyed with a server-side pepper.
4. The administrator puts the credentials in the integrating system's server-side configuration, for example:

```env
CAMPUSCORE_BASE_URL=https://sis-api.feddrick.edu
CAMPUSCORE_CLIENT_ID=cc_…
CAMPUSCORE_CLIENT_SECRET=ccs_…
```

From the same admin page they can also disable the client, change its scopes, **rotate** the secret (which revokes all outstanding tokens), revoke every token, or permanently revoke the client. The page also shows its tokens, API activity and audit trail.

## 3. Authentication: OAuth 2.0 client credentials (RFC 6749 §4.4)

### Request a token

```http
POST /api/v1/oauth/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&scope=students:read%20schedules:read
```

`client_id` and `client_secret` can also be sent as form fields. `scope` is optional: leave it out to receive every scope granted to the client, or pass a space-separated subset.

```bash
curl -X POST https://sis-api.feddrick.edu/api/v1/oauth/token \
  -u "$CAMPUSCORE_CLIENT_ID:$CAMPUSCORE_CLIENT_SECRET" \
  -d grant_type=client_credentials
```

**200 OK** (`Cache-Control: no-store`)

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "institution:read terms:read students:read registrations:read registrations:write"
}
```

| Status | `error` | Cause |
|---|---|---|
| 400 | `unsupported_grant_type` | `grant_type` is not `client_credentials` |
| 400 | `invalid_scope` | A requested scope isn't granted to this client |
| 401 | `invalid_client` | Unknown client, wrong secret, or the client is disabled or revoked. The response is identical in each case, so it can't be used to probe which clients exist. |
| 429 | `rate_limited` | More than 30 token requests per minute from one IP |

### Use the token

```http
GET /api/v1/students?pageSize=25
Authorization: Bearer <access_token>
```

Tokens are HS256-signed JWTs with a `jti`, the issuer and audience bound to this deployment, and an expiry. **Treat the token as opaque.** The server checks it against its token registry on every request. A token is rejected (`401 invalid_token`) when any of the following is true:

- it has expired;
- it was revoked, either through `/oauth/revoke` or by an administrator;
- the client has been disabled or revoked;
- the client secret was rotated after the token was issued;
- an administrator narrowed the client's scopes. Tokens issued before the change are revoked, and the new scopes apply to the next token.

### Revoke a token (RFC 7009)

```http
POST /api/v1/oauth/revoke
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

token=<access_token>
```

The response is always `200 {"revoked": true}` for an authenticated client, whether or not the token was valid.

### Recommended client behaviour

- Cache the token and refresh it about 30 seconds before `expires_in` elapses. Collapse concurrent refreshes into a single token request.
- On `401 invalid_token`, discard the cached token, get a new one, and retry the request **once**.
- On `429`, `502`, `503`, `504` or a network failure, retry with exponential backoff and jitter, and honour `Retry-After`.
- **Never retry `400`, `403`, `404`, `409` or `422`.** These are permanent for that request.

`connector/src/CampusCoreClient.js` implements all of the above and has unit tests.

## 4. Scopes

| Scope | Grants |
|---|---|
| `institution:read` | Institution profile |
| `terms:read` | Academic terms and their registration dates |
| `calendar:read` | Academic calendar events |
| `programs:read` | Departments and programs |
| `courses:read` | Course catalog and prerequisites |
| `sections:read` | Sections, seats, meeting times and instructors |
| `students:read` | Student directory and academic profile. Excludes date of birth, home address, emergency contacts and financial references. |
| `students:write` | *Legacy:* update a student's **contact** fields only |
| `students:create` | Create student records (`Idempotency-Key` required) |
| `students:update` | Update the profile fields selected in policy `api.studentProfileFields` |
| `students:academic` | Update approved academic attributes selected in `api.studentAcademicFields` |
| `students:deactivate` | Deactivate (withdraw) a student. History is always retained. |
| `people:read` | Person registry: one entry per human being with every student/faculty relationship, primary email and status (`GET /people`, `GET /people/{id}`) |
| `identity:read` | Reconcile and resolve external accounts to SIS records |
| `identity:write` | Link and unlink external accounts |
| `audit:read` | Read a student record's audit history |
| `integration:configure` | Narrow this client's own write preferences |
| `faculty:read` | Faculty directory and teaching assignments |
| `registrations:read` | Registrations, waitlists, rosters and registration history |
| `registrations:write` | Register and drop students |
| `schedules:read` | Student and faculty weekly schedules |
| `grades:read` | **Published** grades, GPA, credits and standing |
| `grades:write` | Post **draft** grades on behalf of an assigned instructor |
| `attendance:read` | Attendance records |
| `attendance:write` | Record attendance on behalf of an assigned instructor |
| `announcements:read` | Current institution-wide announcements |

A request without a required scope gets:

```json
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer realm="campuscore", error="insufficient_scope", scope="grades:read"

{ "error": { "code": "insufficient_scope", "message": "This operation requires the scope(s): grades:read.",
             "details": { "required": ["grades:read"], "granted": ["students:read"] }, "requestId": "…" } }
```

## 5. Conventions

- **Base path:** `/api/v1`. JSON only. Request bodies are limited to 200 KB.
- **IDs** are opaque, non-sequential strings. Don't parse them.
- **Dates:** calendar dates are `YYYY-MM-DD`; instants are ISO-8601 UTC. Meeting times are `HH:MM` in the institution's local time zone (`GET /institution` → `timezone`).
- **Single resources:** `{ "data": { … } }`. **Collections:** `{ "data": [ … ] }`, or for paginated collections:

```json
{ "data": [ … ], "pagination": { "page": 1, "pageSize": 25, "total": 171, "totalPages": 7 } }
```

- **Pagination:** `page` (≥ 1) and `pageSize` (1–100, default 25).
- **Sorting** (where offered): `sort=field` or `sort=-field` for descending. Only the fields listed per endpoint are allowed; anything else returns `400`.
- **Rate limit:** 600 requests per minute per client. The `RateLimit` header (IETF draft 7) reports remaining capacity.
- **Tracing:** every response carries `X-Request-Id`, and error bodies repeat it as `requestId`. Include it when reporting problems.

### Request headers for writes

| Header | Purpose |
|---|---|
| `Idempotency-Key` | 8–128 characters. Required on `POST /students`, optional on other writes. A retry with the same key and body replays the stored response (`Idempotent-Replayed: true`). The same key with a different body returns `422 idempotency_key_reused`; a concurrent duplicate returns `409 idempotency_in_progress` with `Retry-After`. Keys expire after 24 h. |
| `If-Match` | ETag from `GET /students/:id`. A stale value returns `412 precondition_failed`. |
| `X-Acting-User` | The human the integrating system is acting for (for example `edunexusai:1234`). Recorded as `onBehalfOf` in the audit log; never used for authorization. |

### Effective write capability

`effective = scope ∧ institutional policy ∧ client write preference`. `GET /capabilities` reports each part per operation. Client preferences (`PUT /integration/write-preferences`) can only narrow access. See [EDUNEXUSAI_INTEGRATION.md](EDUNEXUSAI_INTEGRATION.md) §5–6.

## 6. Errors

```json
{ "error": { "code": "prerequisite_not_met", "message": "Requires CS 350 with a minimum grade of D.",
             "details": [ { "code": "prerequisite_not_met", "message": "Requires CS 350 with a minimum grade of D." } ],
             "requestId": "4a42028d-e7ca-4708-b8c0-68dbdbe26e50" } }
```

| Status | Typical `code` values | Meaning |
|---|---|---|
| 400 | `validation_error`, `invalid_json` | The request is malformed. `details[]` lists `{ field, message }`. |
| 401 | `invalid_request`, `invalid_token` | The token is missing, invalid, expired or revoked |
| 403 | `insufficient_scope`, `not_section_instructor`, `field_not_permitted`, `disabled_by_client_preference` | Missing scope, a field that isn't permitted (with per-field reasons), an operation switched off by the client's preferences, or an acting instructor not assigned to the section |
| 404 | `not_found`, `route_not_found` | Doesn't exist **or** belongs to another institution |
| 409 | `already_registered`, `registration_exists`, `duplicate`, `duplicate_student`, `duplicate_student_number`, `identity_already_linked`, `record_already_linked`, `idempotency_in_progress` | Conflicts with existing state |
| 412 | `precondition_failed` | The `If-Match` ETag is stale |
| 413 | `payload_too_large` | The body exceeds the size limit |
| 422 | see [§7](#7-write-operations-and-their-rules) | Business rule or institutional policy violation |
| 429 | `rate_limited` | Slow down |
| 5xx | `internal_error` | Server-side failure. Safe to retry with backoff. |

## 7. Write operations and their rules

Every write is attributed to the integration in the audit log (`actorType = INTEGRATION`), stores before/after values where applicable, and is recorded in the client's API activity.

| Endpoint | Scope | Policy switch | Rules enforced |
|---|---|---|---|
| `POST /registrations` `{studentId, sectionId}` | `registrations:write` | `api.allowRegistrationWrites` | Student status must be ACTIVE or ADMITTED; no registration hold; registration window open; section open and term not completed; not already in this section or another section of the same course; prerequisites met (an earlier term in progress counts); credit limit; no meeting-time conflict; capacity. A full section with waitlist space results in `WAITLISTED`. |
| `POST /registrations/{id}/drop` `{reason?}` | `registrations:write` | `api.allowRegistrationWrites` | Before the add/drop deadline the registration becomes `DROPPED`; before the withdrawal deadline it becomes `WITHDRAWN` (W on the transcript); after that, `422 withdraw_deadline_passed`. Not allowed once a grade has been submitted. A freed seat promotes the next eligible waitlisted student. |
| `POST /students` | `students:create` | `api.allowStudentCreation` | Program must be active and belong to this institution; admit term valid; email unique (`409 duplicate_student`); student number unique (`409 duplicate_student_number`); `Idempotency-Key` required |
| `PATCH /students/{id}` | `students:write` (contact), `students:update` (policy field list), `students:academic` (programId / admitTermId / expectedGraduation) | `api.allowStudentContactWrites`, `api.allowStudentProfileUpdates` + `api.studentProfileFields`, `api.allowStudentAcademicUpdates` + `api.studentAcademicFields` | Each field must be permitted by an operation in effect (otherwise `403 field_not_permitted`). Protected fields return `400`. Academic changes are refused for withdrawn or graduated students. Optional `If-Match`. |
| `POST /students/{id}/deactivate` | `students:deactivate` | `api.allowStudentDeactivation` | Sets WITHDRAWN, never deletes anything. Refused with `active_term_registrations`, or with `future_registrations` unless `dropFutureRegistrations: true`. Idempotent. |
| `POST /identity/links`, `POST /identity/links/{id}/revoke` | `identity:write` | `api.allowIdentityLinkWrites` | Requires `confirm: true`; one active link per account and per record; email evidence mismatch needs `evidenceMismatchReason` |
| `POST /sections/{id}/attendance` `{actingFacultyId, date, records[]}` | `attendance:write` | `api.allowAttendanceWrites` | `actingFacultyId` must teach the section; the date must fall within the term, not in the future, and within the attendance edit window; every student must be on the roster. |
| `PUT /sections/{id}/grades` `{actingFacultyId, grades[]}` | `grades:write` | `api.allowGradeWrites` (**off by default**) | `actingFacultyId` must teach the section; letters must be on the grade scale; students must be actively registered; only DRAFT or RETURNED grades can change (`422 grade_locked` otherwise). Saved as DRAFT, or SUBMITTED if `api.gradeWritesAutoSubmit` is on. **Integrations can never approve or publish grades**, and published grades change only through a registrar-reviewed grade change request. |

Rule-violation codes you may receive (all `422`): `invalid_program`, `program_inactive`, `invalid_term`, `student_inactive`, `student_graduated`, `active_term_registrations`, `future_registrations`, `identity_evidence_mismatch`, `idempotency_key_reused`, `student_not_eligible`, `registration_hold`, `section_cancelled`, `section_closed`, `term_completed`, `registration_window_closed`, `already_registered`, `already_waitlisted`, `duplicate_course`, `prerequisite_not_met`, `credit_limit_exceeded`, `time_conflict`, `section_full`, `registration_not_active`, `grade_on_record`, `withdraw_deadline_passed`, `policy_disabled`, `no_changes`, `grade_locked`, `student_not_on_roster`, `grading_not_open`, `date_outside_term`, `future_date`, `edit_window_closed`.

When several rules fail, `error.code` is the first one and `error.details[]` lists all of them.

## 8. Data ownership

| Data | System of record | Integration guidance |
|---|---|---|
| Student identity, student number, program, status, class level, standing | **CampusCore** | Read-only. Never cache it as authoritative; refresh it. |
| Contact details | **CampusCore** | May be updated through `PATCH /students/{id}` when permitted |
| Terms, calendar, catalog, sections, meeting times, instructors | **CampusCore** | Read-only |
| Registrations and waitlists | **CampusCore** | Write only through the registration endpoints |
| Official (published) grades, GPA, transcript | **CampusCore** | Read published grades only. Drafts are never exposed. |
| Attendance | **CampusCore** | Write through the attendance endpoint on behalf of the instructor |
| LMS assignments, submissions, gradebook items | **Moodle** (LMS, external) | CampusCore stores none of this and never overwrites it |
| Billing ledger, payments, aid packages | **Bursar / financial aid systems** | CampusCore holds reference IDs and status text only |
| Portal preferences, AI interactions, engagement data | **EdunexusAI** | Never sent to CampusCore |
| Identity links (external account ↔ SIS record) | **CampusCore** (`ExternalIdentityLink`) | Resolve through `/identity/resolve`; create or revoke only through `/identity/links` or the CampusCore admin UI |

## 9. Endpoint reference

All endpoints require a bearer token unless noted otherwise.

| Method & path | Scopes | Notes |
|---|---|---|
| `POST /oauth/token` | none (client authentication) | Token issuance |
| `POST /oauth/revoke` | none (client authentication) | Token revocation |
| `GET /me` | none | Describes the calling client and the token's scopes |
| `GET /institution` | `institution:read` | |
| `GET /terms` | `terms:read` | Filters: `status`, `current=true` |
| `GET /terms/{id}` | `terms:read` | |
| `GET /calendar` | `calendar:read` | Filters: `termId`, `from`, `to`, `category` |
| `GET /departments` | `programs:read` | |
| `GET /programs` | `programs:read` | Filters: `departmentId`, `level` |
| `GET /courses` | `courses:read` | Paginated; `search`, `departmentId`, `sort` |
| `GET /courses/{id}` | `courses:read` | Includes prerequisites |
| `GET /sections` | `sections:read` | Paginated; `termId`, `courseId`, `facultyId`, `search`, `status` |
| `GET /sections/{id}` | `sections:read` | Seats, meetings, instructors |
| `GET /sections/{id}/roster` | `registrations:read` | Registered, waitlisted and completed students |
| `GET /sections/{id}/grades` | `grades:read` | Workflow status per student; letters only once published |
| `PUT /sections/{id}/grades` | `grades:write` | See §7 |
| `GET /sections/{id}/attendance` | `attendance:read` | Optional `date` |
| `POST /sections/{id}/attendance` | `attendance:write` | See §7 |
| `GET /students` | `students:read` | Paginated; `search`, `status`, `programId`, `classLevel`, exact `email` / `studentNumber`, `sort` |
| `GET /students/{id}` | `students:read` | |
| `PATCH /students/{id}` | field-level (see §7) | Contact, profile and approved academic fields |
| `GET /students/{id}/registrations` | `registrations:read` | Filters: `termId`, `status` |
| `GET /students/{id}/schedule` | `schedules:read` | Defaults to the current term; each class carries `registrationStatus` and `waitlistPosition` |
| `GET /students/{id}/grades` | `grades:read` | Published grades by term |
| `GET /students/{id}/academic-record` | `grades:read` | GPA, credits, standing, term GPAs |
| `GET /students/{id}/attendance` | `attendance:read` | Optional `termId` |
| `GET /faculty` | `faculty:read` | Paginated; `search`, `departmentId`, `sort` |
| `GET /faculty/{id}` | `faculty:read` | |
| `GET /faculty/{id}/sections` | `faculty:read` + `sections:read` | Optional `termId` |
| `GET /faculty/{id}/schedule` | `schedules:read` | Defaults to the current term |
| `GET /registrations` | `registrations:read` | Paginated; `termId`, `studentId`, `sectionId`, `status` |
| `POST /registrations` | `registrations:write` | See §7 |
| `GET /registrations/{id}` | `registrations:read` | Includes status history |
| `POST /registrations/{id}/drop` | `registrations:write` | See §7 |
| `GET /announcements` | `announcements:read` | Optional `audience` |
| `GET /capabilities` | none | Effective write capabilities |
| `GET/PUT /integration/write-preferences` | none / `integration:configure` | View or narrow this client's write operations and fields |
| `POST /students` | `students:create` | See §7 |
| `POST /students/{id}/deactivate` | `students:deactivate` | See §7 |
| `GET /students/{id}/audit` | `audit:read` | Paginated audit history |
| `POST /identity/reconcile` | `identity:read` | Classifies accounts as LINKED, CANDIDATE, AMBIGUOUS or UNMATCHED |
| `GET /people`, `GET /people/{id}` | `people:read` | One entry per person: `personNumber`, names, `primaryEmail`, `emails`, `status` (ACTIVE/ALUMNI/INACTIVE), `relationships[]` (type, sisId, number, email, status, current). Exact filters `personNumber`, `studentNumber`, `employeeNumber`, `email`; `updatedSince` for incremental provisioning. Students and faculty carry `personId`. People excluded from identity provisioning by CampusCore are never returned (404 by id), and linking their records answers `person_identity_excluded`. A second link of one external account must be the same person (`identity_different_person` otherwise; fixed in CampusCore with "same person") |
| `GET /identity/resolve` | `identity:read` | `externalUserId` (+ optional `recordType` STUDENT/FACULTY) → linked SIS record or `UNMAPPED`. An account may hold one STUDENT and one FACULTY link of the same person; without `recordType` such an account returns `LINKED_MULTIPLE` with `links[]` and no single record |
| `GET/POST /identity/links`, `POST /identity/links/{id}/revoke` | `identity:read` / `identity:write` | List, link and revoke |

### Example: a student's schedule

```http
GET /api/v1/students/{id}/schedule
```

```json
{
  "data": {
    "term": { "id": "dea171ce-…", "code": "2026FA", "name": "Fall 2026" },
    "classes": [
      {
        "id": "06b38f78-…", "termId": "dea171ce-…", "termCode": "2026FA",
        "course": { "id": "6f1e2e55-…", "code": "ENGL 101", "title": "College Writing", "credits": 3 },
        "sectionNumber": "01", "status": "OPEN", "deliveryMode": "IN_PERSON", "location": "Morrison Hall 287",
        "capacity": 21, "waitlistCapacity": 5,
        "meetings": [
          { "day": "MON", "dayOfWeek": 1, "startTime": "14:00", "endTime": "14:50", "room": "Morrison Hall 287" },
          { "day": "WED", "dayOfWeek": 3, "startTime": "14:00", "endTime": "14:50", "room": "Morrison Hall 287" }
        ],
        "instructors": [ { "facultyId": "84058092-…", "name": "Margaret Ellison", "email": "m.ellison@feddrick.edu", "isPrimary": true } ],
        "registrationId": "f38c7062-…", "registrationStatus": "REGISTERED", "waitlistPosition": null
      }
    ]
  }
}
```

### Example: registering a student

```bash
curl -X POST https://sis-api.feddrick.edu/api/v1/registrations \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"studentId":"…","sectionId":"…"}'
```

`201 Created` (with a `Location` header) when the student is registered or waitlisted, or `422` with the rule that blocked it:

```json
{ "data": { "id": "…", "studentId": "…", "sectionId": "…", "status": "WAITLISTED", "waitlistPosition": 2,
            "credits": 3, "source": "API", "registeredAt": "2026-10-12T09:14:03.112Z", … } }
```

## 10. Adapter pattern for EdunexusAI

EdunexusAI should depend on an **SIS adapter interface**, not on CampusCore directly:

```
EdunexusAI portal ──▶ SisAdapter (interface) ──▶ CampusCoreAdapter ──▶ CampusCoreClient ──▶ /api/v1
                                            └─▶ (future) VendorXAdapter ──▶ vendor API
```

- `connector/src/canonical.js` defines the canonical model: `CanonicalTerm`, `CanonicalStudent`, `CanonicalSection`, `CanonicalEnrollment`, `CanonicalAcademicSummary`. Every record carries `source: { system, id }`, so updates can be routed back to the owning system.
- `connector/src/adapters/SisAdapter.js` is the contract. `CampusCoreAdapter.js` maps CampusCore's DTOs into the canonical model and refuses writes the connection isn't scoped for (`SisError` with code `not_supported`).
- `createSisAdapter()` picks the adapter from `SIS_PROVIDER`, so adding a commercial SIS means adding one adapter class. The portal code doesn't change.
- Errors arrive as `SisError` with `status`, `code`, `retryable` and `requestId`. Use `retryable` to decide between queuing a retry and showing the user the message.

`npm run verify --workspace connector` runs the full flow against a live SIS: token, reads, canonical mapping, a permitted write, rule enforcement, and recovery after revocation.
