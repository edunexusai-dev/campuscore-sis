# CampusCore SIS

*The academic system of record for modern higher education.*

CampusCore is a standalone Student Information System (SIS) for a university. It has three portals (administrator/registrar, faculty and student), a PostgreSQL system of record, and a versioned OAuth 2.0 integration API. EdunexusAI, or any other campus application, uses that API to read academic records and, where an administrator allows it, to submit changes.

> **Fictional data only.** Every person, institution and record in the seed data is invented. See [docs/SECURITY.md](docs/SECURITY.md) before you load any real student data.

---

## Contents

1. [What's included](#whats-included)
2. [Architecture](#architecture)
3. [Local setup](#local-setup)
4. [Demo accounts and data](#demo-accounts-and-data)
5. [Testing](#testing)
6. [Connecting EdunexusAI](#connecting-edunexusai)
7. [Project structure](#project-structure)
8. [Feature status](#feature-status)
9. [Known limitations](#known-limitations)

Further documentation:

- [docs/EDUNEXUSAI_INTEGRATION.md](docs/EDUNEXUSAI_INTEGRATION.md): **Feddrick ↔ EdunexusAI integration**, covering system-of-record rules, identity mapping, write-back policy, connector usage, the work remaining in EdunexusAI, and AWS notes
- [docs/POSTMAN_VERIFICATION.md](docs/POSTMAN_VERIFICATION.md): step-by-step Postman verification, with collection and environment files in `docs/postman/`
- [docs/INTEGRATION_CONTRACT.md](docs/INTEGRATION_CONTRACT.md): the external API contract (authentication, scopes, endpoints, errors, write rules, data ownership)
- [docs/SECURITY.md](docs/SECURITY.md): implemented controls and the gaps to close before real data
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): production configuration, deployment, backup and recovery
- Interactive API reference: `http://localhost:4000/api/docs` (OpenAPI JSON at `/api/openapi.json`)

---

## What's included

| Area | Highlights |
|---|---|
| **Administrator portal** | Live operations dashboard and reports. Student records with search, filters, sort, pagination and audited CSV export. Holds, lifecycle status, admissions and matriculation. Terms, colleges, departments, programs and degree requirements. Course catalog and prerequisites, sections, meeting times and instructors. Registrations with rule overrides. Grade approval and publication, grade-change review, document requests, announcements and calendar. Policies, users and roles, institution profile and grade scale, Developer & Integrations, audit log and system health. |
| **Faculty portal** | Assigned sections only: rosters, attendance taking, a gradebook (draft, submit, request a change), class announcements, and a weekly teaching schedule. |
| **Student portal** | Dashboard, weekly schedule, and class search that shows eligibility per section. Add, drop and withdraw, published grades with GPA, degree audit, attendance, a printable unofficial transcript, document requests, and profile/holds with self-service contact updates. |
| **Integration API** | `/api/v1` with the OAuth 2.0 client-credentials grant. Short-lived signed tokens that can be revoked, 17 granular scopes, explicit response DTOs, pagination, filtering and sorting, and a consistent error envelope. OpenAPI documentation and an in-app API playground. |
| **Feddrick / EdunexusAI integration** | Institution configuration (name, slug, email domains). Explicit cross-system **identity links** with reconciliation (LINKED / CANDIDATE / AMBIGUOUS / UNMATCHED), uniqueness enforced in the database, and audited revoke-and-relink. Narrowly scoped **student write-back**: create (idempotent), field-level update, academic attributes, and deactivate without deleting anything. Three-layer **write capabilities** (scope ∧ institutional policy ∧ client preference). `X-Acting-User` attribution, audited rejected writes, ETag concurrency. |
| **EdunexusAI connector** | `connector/`: a replaceable `SisAdapter`, a canonical data model, token caching, refresh on 401, and retries with backoff. Includes a live verification script and a small demo portal that renders records it fetches through the API. |

## Architecture

```
┌────────────────────────┐   session cookie + CSRF   ┌──────────────────────────────────────┐
│  React + Vite + Tailwind │ ───────── /api/app ──────▶ │  Express API (Node 22)                │
│  admin · faculty · student│                           │  routes → services → Prisma → Postgres│
└────────────────────────┘                           │  ├─ policyService (configurable rules)│
                                                      │  ├─ registrationService (eligibility) │
┌────────────────────────┐   OAuth2 bearer token     │  ├─ gradeService (workflow)           │
│  EdunexusAI backend      │ ───────── /api/v1 ───────▶ │  ├─ academicService (GPA, audit)      │
│  connector/ SisAdapter   │  (client credentials)     │  └─ integrationService (clients/JWT)  │
└────────────────────────┘                           └──────────────────────────────────────┘
```

- **Two API surfaces, two auth mechanisms.** Humans use `/api/app` with an HttpOnly session cookie and a CSRF header. Machines use `/api/v1` with bearer tokens only. Neither surface accepts the other's credentials.
- **One rules engine.** Registrations, grades and attendance go through the same service functions whether they come from the student portal, the admin portal or the API. Every channel enforces the same rules.
- **Policies are data.** Registration limits, grade-workflow switches and integration write permissions live in the `Policy` table. Administrators change them in the UI, the server validates them with Zod, every service enforces them, and every change is audited.
- **Multi-tenant.** Every institution-owned row carries `institutionId`, and every query filters on it. Records belonging to another tenant return 404. The seed includes a second institution, Lakeshore Community College, so tests can verify isolation.
- **Stack:** Node 22, Express 5, Prisma 6 with PostgreSQL (tested on 18), Zod, React 19, React Router 7, TanStack Query, Tailwind CSS 4, Recharts, Vitest with Supertest, and swagger-ui.

## Local setup

**Prerequisites:** Node.js 20 or later (22 recommended) and PostgreSQL 14 or later.

### 1. PostgreSQL

Any local PostgreSQL works. With [DBngin](https://dbngin.com): create a PostgreSQL server named `campuscore` on port **5434**, then start it. The default user is `postgres` with no password. Prisma creates the `campuscore` database itself.

### 2. Configure

```bash
cp server/.env.example server/.env
# Generate the two secrets:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # → JWT_SIGNING_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # → CLIENT_SECRET_PEPPER
```

| Variable | Purpose | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection | `postgresql://postgres@127.0.0.1:5434/campuscore?schema=public` |
| `JWT_SIGNING_SECRET` | HMAC key for integration access tokens (32 characters or more) | random |
| `CLIENT_SECRET_PEPPER` | Server-side pepper for hashing client secrets | random |
| `PUBLIC_API_URL` | Token issuer/audience and docs base URL | `http://localhost:4000` |
| `CORS_ORIGINS` | Browser origins allowed on `/api/app` | `http://localhost:5180` |
| `SESSION_TTL_HOURS` | Human session lifetime | `12` |
| `COOKIE_SECURE` | `true` behind HTTPS (required in production) | `false` |
| `TRUST_PROXY` | Express trust-proxy setting behind a load balancer | `false` / `1` |
| `PORT` | API port | `4000` |

Tests use `server/.env.test`. It must point at a database whose name ends in `_test`, which the test setup creates if it doesn't exist.

### 3. Install, migrate, seed, run

```bash
npm install                 # installs server, client and connector workspaces
npm run db:migrate          # prisma migrate dev (creates the DB and applies migrations; also runs the seed)
npm run db:seed             # (re)load fictional demo data; DELETES existing data in that database
npm run dev                 # API on :4000 and web app on :5180
```

Open **http://localhost:5180**. The web app's dev server proxies `/api` to the API, so the session cookie stays same-origin.

## Demo accounts and data

The password for every demo account is **`Northbridge#2026`**.

| Role | Email | Try this |
|---|---|---|
| Administrator | `admin@feddrick.edu` | Policies, Developer & Integrations, the audit log, user management |
| Registrar | `registrar@feddrick.edu` | Grades → approve and publish, admissions, holds. No access to integrations or policies. |
| Faculty | `e.vasquez@feddrick.edu` | CS 301-01 (full, with a waitlist): take attendance, enter and submit grades |
| Student | `maya.chen@students.feddrick.edu` | Class search for next term, degree progress, transcript |
| Student with a hold | `jordan.rivera@students.feddrick.edu` | A financial hold blocks registration |
| Second tenant admin | `admin@lakeshore.edu` | Sees only Lakeshore records |

The seed's dates are relative to the day it runs: eight completed terms, one term in progress (registration closed, withdrawal still open) and one upcoming term with registration open. It creates 180 students, 23 faculty, about 600 sections, about 3,000 registrations with published grade histories, attendance for the current term, waitlists, holds, applications, a grade change request awaiting review, and sections at each stage of the grade workflow.

The seed also creates two integration clients. It prints their secrets once, because only hashes are stored, and writes the EdunexusAI client's credentials to the git-ignored `connector/.env`.

## Testing

```bash
npm test                              # backend: 87 Vitest + Supertest tests against the _test database
npm test --workspace connector        # connector: 20 unit tests (mocked HTTP), incl. portal authorization
CAMPUSCORE_ADMIN_EMAIL=admin@feddrick.edu CAMPUSCORE_ADMIN_PASSWORD=… npm run e2e --workspace connector   # live: 23 Feddrick integration checks
npm run verify --workspace connector  # live end-to-end integration check against a running API
npm run build                         # production build of the web app
```

The backend suite covers:

- **Authentication:** login, lockout-safe errors, cookie flags, CSRF, logout.
- **Authorization:** role and resource-level checks, protected student fields, faculty limited to their own sections, registrar boundaries, tenant isolation.
- **Enrollment rules:** registration window, prerequisites, holds, credit limit, duplicates, the self-service policy switch, staff overrides with a reason, waitlist and automatic promotion.
- **Grade workflow:** draft, submit, lock, approve, publish, visibility to students, GPA, change requests, separation of duties.
- **Attendance rules.**
- **OAuth and the API:** token issuance (valid, invalid, unknown, wrong grant, wrong scope), missing, forged, expired and revoked tokens, `insufficient_scope`, read-only clients unable to write, audited API writes, policy kill switches, scope narrowing, rotation, revocation, pagination and validation, tenant isolation.
- **Documentation:** every implemented `/api/v1` route is documented, and every documented route exists.

## Connecting EdunexusAI

1. Sign in as the administrator and go to **Developer & integrations → Register application**. Choose scopes and copy the secret. It is shown only once.
2. Put `CAMPUSCORE_BASE_URL`, `CAMPUSCORE_CLIENT_ID` and `CAMPUSCORE_CLIENT_SECRET` in EdunexusAI's **backend** environment.
3. Use the adapter from `connector/src` (copy it in or depend on it as a package):

```js
import { createSisAdapter } from '@campuscore/edunexus-connector';
const sis = createSisAdapter();                        // reads the env vars above
const term = await sis.getCurrentTerm();               // → CanonicalTerm
const { items } = await sis.searchStudents({ search: 'Chen' });
const schedule = await sis.getStudentSchedule(items[0].source.id);
await sis.enroll(studentId, sectionId);                // only if registrations:write is granted and the policy allows it
```

4. Run `npm run demo --workspace connector` and open http://localhost:4100. A minimal EdunexusAI stand-in shows live SIS records and can submit a registration request.

To support another SIS, implement a new adapter against the `SisAdapter` interface. The portal code doesn't change. The full contract is in [docs/INTEGRATION_CONTRACT.md](docs/INTEGRATION_CONTRACT.md).

## Project structure

```
server/
  prisma/schema.prisma        # 35 models: institution, terms, programs, courses, sections, students, registrations, grades, policies, integrations, audit…
  prisma/migrations/          # SQL migrations
  prisma/seed-lib.js, seed.js # deterministic fictional data generator
  src/config.js               # validated environment configuration
  src/app.js, server.js       # Express app (helmet, CORS, rate limits, docs) and entrypoint
  src/middleware/             # session + CSRF, bearer-token auth + scopes, errors, API request log
  src/services/               # business logic: policies, registration, grades, academic records, attendance, integrations, queries
  src/routes/app/             # portal API (auth, student, faculty, admin/*)
  src/routes/v1/              # integration API + explicit DTOs
  src/openapi/spec.js         # OpenAPI 3.1 document
  tests/                      # Vitest suites
client/
  src/components/             # design system (ui.jsx), layout, schedule grid, transcript
  src/pages/{admin,faculty,student,shared}/
connector/
  src/                        # CampusCoreClient, SisAdapter, CampusCoreAdapter, canonical model
  demo/server.js              # EdunexusAI stand-in portal
  scripts/verify.js, sync.js  # live integration checks
docs/                         # integration contract, security, deployment
```

## Feature status

**Implemented**
- Institution profile; academic years and terms (registration windows, add/drop, withdrawal and grades-due dates, current term)
- Colleges, departments and programs with degree requirements and minimum GPA; course catalog with prerequisites and minimum grades
- Sections with capacity, waitlist capacity, delivery mode, meeting times and multiple instructors
- Student records: lifecycle with validated transitions, holds, academic standing, class level, contact and emergency details, financial and aid reference fields, search, filters, sort, pagination, CSV export
- Admissions: applications, review decisions and matriculation into student records with portal logins
- Registration engine: window, holds, student status, prerequisites (including in-progress), credit limit, time conflicts, duplicate course, capacity, waitlist with automatic promotion, drop vs. withdraw deadlines, staff overrides with an audited reason, registration history
- Attendance by class date, with an edit window and a per-student summary
- Grades: configurable grade scale; DRAFT → SUBMITTED → APPROVED → PUBLISHED, plus RETURNED; policy-driven automatic approval and publication; change requests with registrar review and separation of duties; full grade history; GPA, credit, standing and class level recalculated on publication
- Degree audit and graduation eligibility (graduating is blocked unless eligible)
- Unofficial transcript (printable, viewing audited) and document request workflow
- Announcements (institution-wide and per class), notifications, academic calendar, faculty and department directory
- Configurable policies (18), the role/permission matrix, user management (staff accounts, enable/disable, unlock, password reset)
- Integration clients: create, scope, enable/disable, rotate, revoke tokens, revoke the client, token list, API activity log, audit trail, playground
- Reports: enrollment trend, grade distribution, standing, class level, programs, section fill, registration channels
- Audit log with before/after values, and system health

**Partially implemented**
- *Billing and financial aid*: reference fields only (bursar account reference, aid status). No ledger or packaging.
- *Roles*: four built-in roles with a fixed permission matrix. Custom roles are not yet supported.
- *Grade scale*: existing letters can be edited, but letters can't be added or removed.
- *Document requests*: the workflow and notifications exist. Generating official PDFs, charging fees and delivering electronically are out of scope.
- *Admissions*: staff record applications. There is no public application form.

**Deferred**
- SSO (SAML/OIDC) and MFA for human users; password self-reset by email
- Repeat-course GPA replacement, transfer credit, course equivalencies
- Bulk imports, scheduled exports and webhooks/event delivery to integrations
- Notifications by email or SMS (in-app only today)

## Known limitations

- Rate limiting uses in-process memory. When running more than one API instance, switch to a shared store such as Redis (see DEPLOYMENT.md).
- Times are stored as `HH:MM` local institution time. There is no daylight-saving-aware scheduling across time zones.
- The CSV export, transcript and API reads are logged, but there is no data-loss-prevention or download watermarking.
- The audit log is append-only by convention and permissions, not cryptographically tamper-evident.
