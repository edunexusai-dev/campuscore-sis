# Integrating EdunexusAI (Feddrick University) with CampusCore SIS

**Audience:** the engineers who will implement the EdunexusAI side of the integration, and the operators who configure it.

**Status:**

- **CampusCore side: implemented and tested.** This repository contains the institution configuration, identity links, the student write API, write policies, idempotency, auditing, the connector library and a reference portal service.
- **EdunexusAI side: not implemented.** Nothing in the EdunexusAI codebase or database was read or modified during this work. Section 9 lists exactly what must be built there.

---

## 1. Architecture

```
Browser (Feddrick portal, React)
   │  EdunexusAI session cookie only — never CampusCore tokens or secrets
   ▼
EdunexusAI backend ───────────────► Moodle (assignments, submissions, LMS content)    [unchanged]
   │  SisPortalService (authorization: session → identity link → SIS record)
   │  CampusCoreAdapter → CampusCoreClient (OAuth client credentials, token cache, retries, idempotency)
   ▼  HTTPS  /api/v1
CampusCore SIS API ──► CampusCore PostgreSQL   (EdunexusAI never connects to this database)
```

- The two systems are deployed independently and share no database. They are coupled only through the versioned `/api/v1`.
- A user signs in to EdunexusAI the same way as today. The integration's OAuth **client-credentials** flow authenticates the *EdunexusAI backend* to CampusCore. It is not a user login and does not make the browser user anything.
- CampusCore authorizes the **integration client** on every request: scope, institutional policy, client write preferences, business rules and tenant. EdunexusAI must separately authorize the **portal user** (their role, their institution and their own record) before it calls CampusCore.

## 2. System of record

| Data | Owner | Rule for EdunexusAI |
|---|---|---|
| Student & faculty institutional identity, student/employee numbers, program, status, class level, standing | **CampusCore** | Read through the API. Don't keep an editable local copy. Cache for display only, with a short TTL. |
| Programs, departments, terms, course catalog, sections, meeting times, instructors | **CampusCore** | Read only |
| Registrations, waitlists, enrollment status, class schedules | **CampusCore** | Read; writes only through `/registrations` when permitted |
| Attendance managed by the SIS | **CampusCore** | Read; writes through `/sections/:id/attendance` when permitted |
| Published grades, GPA, credits, standing, transcript, academic history | **CampusCore** | Read only. Draft grades are never exposed. |
| Academic calendar | **CampusCore** | Read only |
| Assignments, submissions, LMS course content and activity | **Moodle** | Keep the existing Moodle integration. Never replace it with SIS data. |
| Portal preferences, AI interactions, engagement data, notifications UX | **EdunexusAI** | Unchanged. Never sent to CampusCore. |
| **Identity links** (EdunexusAI user ↔ SIS record) | **CampusCore** (`ExternalIdentityLink`) | EdunexusAI resolves them per request through `/identity/resolve` and may cache them for 60 s. Create or revoke them only through the API or the CampusCore admin UI. |

Seeded EdunexusAI academic records, such as demo grades and schedules, stop being the source for SIS-owned pages once a page is migrated (§9.3). **Do not delete them as part of this work.** Retire them later through a separately approved migration.

## 3. Institution configuration (done in CampusCore)

- The existing institution `3d82d7b8-367b-4bda-862c-cdd18699380f` was re-identified as **Feddrick University** (slug `feddrick`, short name `FU`). Its staff domain is `feddrick.edu` and its student domain is `students.feddrick.edu`.
  - Every ID, relationship and academic record was preserved.
  - 205 login addresses and 213 record addresses moved to the new domains.
  - The change is audited (`institution.rebranded`), and a database backup was taken first.
  - The change was made by `server/scripts/rebrand-institution.js`, which can be re-run safely (it dry-runs by default).
- The institution's name, slug and email domains are configuration. Email domains are stored on `Institution` and editable in **Admin → Institution**. The sign-in branding is chosen by `DEFAULT_INSTITUTION_SLUG`.
- **Lakeshore Community College** remains a separate tenant. Every client, link and query is institution-scoped.
- **Renaming did not make CampusCore's students the same people as EdunexusAI's users.** They are separate fictional datasets. Identity is reconciled explicitly (§4).

## 4. Identity mapping strategy

### Model: `ExternalIdentityLink`, stored in CampusCore

| Field | Meaning |
|---|---|
| `institutionId` | The tenant. Every link belongs to exactly one institution. |
| `externalSystem` | `edunexusai` (future SSO issuers can use their own system names) |
| `externalUserId` | EdunexusAI's **stable internal user id**. Not the email, which can change. |
| `recordType` + `studentId` / `facultyId` | The CampusCore record. A check constraint enforces that the target column matches the type. |
| `status` | `ACTIVE` / `REVOKED`. Revoked links are kept for history. |
| `method`, `evidence` | `MANUAL_ADMIN` / `API_CONFIRMED`. Evidence records whether the email matched, who verified the link, and any mismatch reason. |
| `createdBy…`, `revoked…`, timestamps | Accountability |

**Database guarantees** (partial unique indexes): at most **one ACTIVE link per external account**, and at most **one ACTIVE link per SIS record**, per institution and external system.

### Reconciliation workflow

1. **Classify.** EdunexusAI sends its users to `POST /api/v1/identity/reconcile` in batches of up to 200: `{ externalUserId, recordType, email?, institutionalId?, firstName?, lastName? }`. The response classifies each one:
   - `LINKED`: already linked. `warnings` flags it if the supplied email or number now points elsewhere.
   - `CANDIDATE`: exactly one unlinked record matches by email and/or student number, and the identifiers don't disagree.
   - `AMBIGUOUS`: the email and number point to different records, several records match, or the matching record is already linked to someone else.
   - `UNMATCHED`: nothing matches. **Names are never used to match.** A name-only candidate is always `UNMATCHED`.
2. **Review.** An authorized EdunexusAI administrator reviews the candidates. Nothing is linked automatically.
3. **Link.** `POST /api/v1/identity/links` with `confirm: true`.
   - If `externalEmail` doesn't match the record's institutional or personal email, the request fails with `422 identity_evidence_mismatch` unless `evidenceMismatchReason` is given, for example "verified photo ID".
   - Duplicate links fail with `409 identity_already_linked` or `409 record_already_linked`.
4. **Change.** Revoke the link (`POST /identity/links/:id/revoke` with a reason), then link again. Both steps are audited and attributed to the acting administrator.
5. **Resolve per request.** On every authenticated portal request, EdunexusAI calls `GET /api/v1/identity/resolve?externalUserId=<session user id>`, cached for up to 60 s. `UNMAPPED` means no SIS data is shown for that user.

CampusCore registrars can perform the same steps under **Admin → Identity links** (link, revoke, and "Check an account").

**Unmapped users** (for example, an EdunexusAI demo user who doesn't exist in CampusCore) see an explicit "not linked" state. CampusCore never invents a record for them or substitutes a different student. The administrator can then:

- link the user to the correct existing record;
- create the student in CampusCore (if allowed) and then link it; or
- leave the user unlinked.

**SSO readiness:** a future OIDC or SAML login can become another `externalSystem` (using `issuer`/`subject` as `externalUserId`) without changing the model. Signing in to EdunexusAI and the integration's client credentials remain separate concerns.

## 5. Student write-back

| Operation | Endpoint | Scope | CampusCore policy (Admin → Policies) |
|---|---|---|---|
| Create | `POST /api/v1/students` (**Idempotency-Key required**) | `students:create` | `api.allowStudentCreation` |
| Update profile fields | `PATCH /api/v1/students/:id` | `students:update` | `api.allowStudentProfileUpdates` + field list `api.studentProfileFields` |
| Update contact (legacy) | `PATCH /api/v1/students/:id` | `students:write` | `api.allowStudentContactWrites` (contact fields only, unchanged behaviour) |
| Update approved academic attributes | `PATCH /api/v1/students/:id` | `students:academic` | `api.allowStudentAcademicUpdates` + field list `api.studentAcademicFields` (programId, admitTermId, expectedGraduation) |
| Deactivate | `POST /api/v1/students/:id/deactivate` | `students:deactivate` | `api.allowStudentDeactivation` |
| Audit history | `GET /api/v1/students/:id/audit` | `audit:read` | none |

- **Never writable through the API:** student number, status (except through deactivation), standing, class level, institutional email, financial references, grades.
- **Field-level enforcement.** Each requested field must be permitted by an operation that is in effect. If not, the response is `403 field_not_permitted` with a reason for each field.
- **Optimistic concurrency.** `GET` returns an `ETag`. Send `If-Match` on `PATCH`; a stale value returns `412 precondition_failed`.
- **Deactivation doesn't delete anything.** It sets the status to WITHDRAWN and disables the student's CampusCore portal login. Registrations, grades, transcript and audit history are all kept.
  - Refused with `active_term_registrations` while the student is registered in a term in progress. The registrar must handle withdrawals.
  - Refused with `future_registrations` while the student has upcoming-term registrations, unless the request sets `dropFutureRegistrations: true`. Freed seats go to the waitlist.
- **No hard delete.** There is no hard-delete endpoint. Permanent deletion would need a separate retention process, which is out of scope.
- **Idempotency.** A retry with the same `Idempotency-Key` and body replays the stored response, with `Idempotent-Replayed: true`. The same key with a different body returns `422`, and a concurrent duplicate returns `409` with `Retry-After`. **Generate one key per logical submission**, for example when the "create student" form opens, and reuse it for every retry of that submission.
- **Attribution.** Send `X-Acting-User: edunexusai:<portal user id>`. It is stored as `onBehalfOf` on every audit event, including rejected writes (`integration.write_rejected`, outcome `REJECTED`). It is accountability information only and is never used for authorization.
- **Scope narrowing is immediate.** When an administrator removes scopes, CampusCore revokes the client's existing tokens. Effective scopes are always the intersection of the token's scopes and the client's current scopes.

## 6. Configurable write-back policy (three layers, all enforced by CampusCore)

```
effective(operation) = scope granted to the client
                     ∧ CampusCore institutional policy (Admin → Policies, CampusCore administrators)
                     ∧ client write preference (set by EdunexusAI administrators; can only narrow)
```

- `GET /api/v1/capabilities` returns, for each operation, `scopeGranted`, `policyEnabled`, `clientEnabled`, `allowedFields`, `effective` and a human-readable `reason`. **EdunexusAI's admin UI should display this** to show whether each capability is granted by the client and enabled by policy.
- `PUT /api/v1/integration/write-preferences` (scope `integration:configure`) lets **EdunexusAI administrators** switch operations or fields off for their integration: `{ disabledOperations: [...], profileFields: [...] | null, academicFields: [...] | null }`. These preferences are stored and enforced by CampusCore, so a direct API call can't bypass them. They are audited, and they can never broaden access.
- CampusCore administrators see and edit the same matrix under **Admin → Developer & integrations → client → Write capabilities**.
- **EdunexusAI must still check that its own user is an administrator of the right institution** before calling any of these endpoints. The integration token doesn't make the browser user an administrator.

## 7. Connector and reference portal service (in this repository: `connector/`)

Reuse the connector rather than writing a second client:

| File | Purpose |
|---|---|
| `src/CampusCoreClient.js` | Token cache. Refreshes 30 s before expiry, collapses concurrent refreshes into one, refreshes and retries once on `401`, and backs off exponentially with jitter (honouring `Retry-After`). **Only retries writes that carry an Idempotency-Key.** A write that may already have reached the server is reported as `sis_outcome_unknown` instead of being blindly repeated. It never logs tokens or secrets, keeps the secret in a private field, and provides `health()` and `revokeCurrentToken()`. |
| `src/adapters/CampusCoreAdapter.js` | Canonical mapping plus every operation in §4–6: `verifyInstitution`, `getCapabilities`, `createStudent` (requires an idempotency key), `updateStudent` (ETag), `deactivateStudent`, `getStudentAudit`, `reconcileIdentities`, `resolveIdentity`, `linkIdentity`, `revokeIdentityLink`, `setWritePreferences`, schedules, rosters, calendar, and more. |
| `src/portal/SisPortalService.js` | **Reference authorization layer for EdunexusAI routes.** It resolves the SIS identity from the server session (never from client input), returns `UNMAPPED` / `NOT_A_STUDENT` / `UNAVAILABLE` / `FORBIDDEN` states for each section, restricts faculty rosters to their own sections, and requires the portal admin role plus an effective capability for writes. It rejects cross-tenant users and attributes writes with `X-Acting-User`. |
| `src/index.js` → `createSisAdapter(env)` | Builds the adapter from environment variables. It refuses missing configuration and non-HTTPS URLs in production. |

## 8. EdunexusAI configuration (server-side only)

| Variable | Example (development) | Notes |
|---|---|---|
| `SIS_PROVIDER` | `campuscore` | Selects the adapter |
| `CAMPUSCORE_BASE_URL` | `http://localhost:4000` | `https://sis-api.feddrick.edu` in production (HTTPS is required) |
| `CAMPUSCORE_CLIENT_ID` | `cc_…` | From **CampusCore Admin → Developer & integrations** |
| `CAMPUSCORE_CLIENT_SECRET` | `ccs_…` | **Secret.** Use a secrets manager in production. Never put it in the frontend, browser storage, logs or git. |
| `CAMPUSCORE_EXPECTED_INSTITUTION` | `feddrick` | Call `adapter.verifyInstitution()` at startup. It fails with `institution_mismatch` if the credentials belong to another tenant. |
| `CAMPUSCORE_TIMEOUT_MS` | `10000` | Optional |
| `SIS_TENANT_KEY` | `feddrick` | EdunexusAI's own key for the institution this connection serves. Passed to `SisPortalService({ tenantKey })`. |

**Recommended client scopes for EdunexusAI:**

- **Read:** `institution:read terms:read calendar:read programs:read courses:read sections:read students:read faculty:read registrations:read schedules:read grades:read attendance:read announcements:read identity:read audit:read`
- **Write (add only what is needed):** `students:create students:update students:deactivate identity:write integration:configure`, and optionally `registrations:write attendance:write`

The token lifetime can be set up to 60 minutes. No one needs to generate tokens by hand: the connector requests and refreshes them automatically.

### Rotating the client secret

1. In **CampusCore Admin → Developer & integrations → EdunexusAI client**, click **Rotate secret**. The new secret is shown once, and every outstanding token is revoked at the same moment.
2. Put the new secret into EdunexusAI's secret store immediately and restart or redeploy the backend. Until then the connector receives `invalid_client` and reports an unhealthy status. It doesn't retry indefinitely.
3. Confirm through EdunexusAI's integration status page, which calls `adapter.health()`, and through the client's **API activity** in CampusCore.

To rotate without downtime, create a second client with the same scopes, switch EdunexusAI to it, and then revoke the old client.

## 9. Work required in EdunexusAI (not done; outside this repository)

### 9.1 Backend

1. **Add the connector.** Vendor `connector/src`, or depend on it as a package. Construct a single `SisPortalService` per tenant at startup with `createSisAdapter(process.env)`, `tenantKey`, and an `isAdmin(user)` function that matches EdunexusAI's real role model. Call `verifyInstitution(CAMPUSCORE_EXPECTED_INSTITUTION)` and log the result without logging secrets.
2. **Add server routes** that use only `req.user` from the authenticated session. Every route takes its identity from the session; none accept a student ID from the browser:
   - `GET /api/sis/me/overview` → `studentOverview(req.user)`
   - `GET /api/sis/faculty/teaching` and `GET /api/sis/faculty/sections/:sectionId/roster` → `facultyTeaching` / `facultyRoster`
   - Admin routes: `GET /api/sis/admin/capabilities`, `GET /api/sis/admin/students`, `GET /api/sis/admin/students/:sisId`, `POST /api/sis/admin/students` (idempotency key from the client form, validated as a UUID), `PATCH /api/sis/admin/students/:sisId` (forwards `If-Match`), `POST /api/sis/admin/students/:sisId/deactivate`, and `POST /api/sis/admin/identity/reconcile|link|revoke`, plus `PUT /api/sis/admin/write-preferences`
   - Map `SisError` to HTTP responses: `status`, `code`, `message` and `requestId`. Use `503` with "SIS unavailable" when `retryable`. **Never fall back to seeded local data for SIS-owned fields.**
3. **Add an integration status page or endpoint** that shows `adapter.health()`, the connected institution, and the last error. It must not show tokens or secrets.
4. **Optional local cache.** If EdunexusAI wants mappings available offline, it may store `{ tenantKey, externalSystem, userId, sisRecordType, sisId, linkId, syncedAt }`, refreshed from `/identity/links`. CampusCore stays the authority, and any change still goes through the API. This is an additive table in EdunexusAI, not a change to existing tables.

### 9.2 Frontend

- **Student pages:** show the SIS-owned sections from `/api/sis/me/overview`. These are profile, academic overview and progress, schedule, registrations, published grades and GPA, calendar and transcript. Render explicit states:
  - **loading**;
  - **unavailable**, with a retry option;
  - **not linked**: "contact the registrar";
  - **permission denied**;
  - **empty**.

  Keep the Moodle assignment and submission widgets wired to Moodle.
- **Faculty pages:** teaching assignments and rosters from the SIS, combined on the backend with the existing Moodle teaching data.
- **Admin:**
  - an SIS student directory with search and pagination, a profile view with SIS source and mapping status, create, edit of permitted fields, and deactivate (never delete);
  - a capability matrix from `/capabilities`, with toggles that write the client's preferences;
  - a reconciliation screen (matched, candidate, ambiguous, unmatched; link and revoke with a reason);
  - a link to the record's audit history (`/students/:id/audit`).
- **Forms:** keep unsaved form state when a write fails, and show CampusCore's per-field reasons.
- **Duplicate submissions:** disable double-submit, and reuse the same idempotency key until the form is reset.

### 9.3 Page migration inventory (to be filled in after inspecting EdunexusAI)

For each existing page, record its current data source, which system owns each data element after migration (CampusCore, Moodle or EdunexusAI), the replacement backend route, and the test that covers it. Migrate pages one at a time, behind a feature flag if available, and leave the seeded EdunexusAI data untouched until a separately approved clean-up.

| Page | Current source (EdunexusAI) | SIS-owned parts → route | Moodle-owned parts (keep) | EdunexusAI-owned parts (keep) |
|---|---|---|---|---|
| Student dashboard | *to inspect* | profile, GPA, credits, schedule → `/api/sis/me/overview` | assignments due, submissions | AI insights, preferences |
| Schedule | *to inspect* | `/api/sis/me/overview.schedule` | — | — |
| Grades / transcript | *to inspect* | published grades, GPA → overview `grades`, `academic` | assignment scores | — |
| Registration | *to inspect* | registrations (read); writes only if `registrations:write` is granted and the policy is on | — | — |
| Faculty courses / rosters | *to inspect* | `/api/sis/faculty/*` | course content, submissions | — |
| Admin student management | *to inspect* | `/api/sis/admin/*` | — | portal accounts |

### 9.4 Tests EdunexusAI must add

- Student A cannot obtain student B's SIS data through any route. Try changing IDs in URLs and bodies; the response must still be A's data or a refusal.
- Faculty member X cannot read the roster of a section they don't teach. Expect 403 `not_section_instructor`.
- A user from another tenant is refused (`tenant_mismatch`).
- An unmapped user sees "not linked" and no data from another person.
- An SIS outage returns an explicit unavailable state, not stale seeded data.
- Non-admin users can't call admin routes, even directly.
- Create-student retries with the same idempotency key produce one record.
- Moodle-backed widgets still read from Moodle.
- Existing EdunexusAI records are unchanged before and after the integration is enabled. Compare row counts in a test copy of the database.

`connector/test/portal.test.js` contains the same authorization cases against the reference service and can be adapted.

## 10. Verifying CampusCore

- **Automated (test database):** `npm test` from the repository root runs 87 backend tests. `npm test --workspace connector` runs 20 connector tests.
- **Live end to end:** `CAMPUSCORE_ADMIN_EMAIL=admin@feddrick.edu CAMPUSCORE_ADMIN_PASSWORD=… npm run e2e --workspace connector` runs 23 checks against the running API. It uses a temporary client and one fictional student, restores the policies, and revokes its client and links when it finishes.
- **Postman:** import `docs/postman/CampusCore-Feddrick.postman_collection.json` and `CampusCore-local.postman_environment.json`. Steps are in `docs/POSTMAN_VERIFICATION.md`.

## 11. AWS deployment notes (integration-specific)

- **API endpoint.** Expose only the API over HTTPS, for example `https://sis-api.feddrick.edu`:
  - put an Application Load Balancer in front, with an ACM certificate and an HTTPS listener;
  - redirect HTTP to HTTPS;
  - add a Route 53 record for the hostname;
  - set `PUBLIC_API_URL` to that URL, because tokens are issued for it as issuer and audience;
  - run the API on ECS/Fargate or EC2 in private subnets.
- **Database.** Use RDS PostgreSQL in **private subnets** with no public access, storage encryption, automated backups and point-in-time recovery. Its security group allows port 5432 **only from the API's security group**.
- **Reaching CampusCore from EdunexusAI:**
  - **Same VPC or peered:** use an internal ALB with security-group rules (EdunexusAI backend SG → ALB SG on 443).
  - **Separate networks:** use a public HTTPS ALB, optionally with an AWS WAF IP allow-list for EdunexusAI's NAT egress IPs.
- **Secrets.** Store CampusCore secrets (`JWT_SIGNING_SECRET`, `CLIENT_SECRET_PEPPER`, `DATABASE_URL`) and EdunexusAI's `CAMPUSCORE_CLIENT_SECRET` in AWS Secrets Manager or SSM Parameter Store, injected through the task role. Never put them in task definitions as plain text or in images.
- **Shared rate limits.** If more than one API task runs, back the rate limiters with ElastiCache Redis (see DEPLOYMENT.md).
- **Separate environments.** Development, staging and production each get their own CampusCore deployment, database, integration client and secrets. Don't reuse production credentials elsewhere.
- **Monitoring.** Send API logs to CloudWatch Logs, and alarm on 5xx responses, `invalid_client` spikes and `integration.write_rejected` volume.
