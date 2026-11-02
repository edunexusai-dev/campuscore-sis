# CampusCore SIS: security and privacy

CampusCore is designed to eventually hold education records. This document lists the controls that are **implemented and tested**, followed by the **gaps that must be closed before any real student data is loaded**.

> Implementing these controls does **not** make CampusCore compliant with FERPA, GDPR, or any other regulation, and this project makes no such claim. Compliance depends on institutional policy, contracts, hosting, operations, and independent assessment.

## Implemented controls

### Human authentication
- Passwords are hashed with salted **scrypt** (N=16384, r=8, p=1). Hashes are compared in constant time.
- **Generic sign-in errors.** An unknown email and a wrong password return the same message and do the same scrypt work, so responses don't reveal which accounts exist.
- **Lockout.** After 5 consecutive failures the account locks for 15 minutes, and the lock is audited. Sign-in is also rate-limited to 20 attempts per 15 minutes per IP.
- **Sessions.** The session token is a random 256-bit value stored in an **HttpOnly, SameSite=Lax** cookie, marked `Secure` in production (startup refuses to run otherwise). The database stores only the token's SHA-256 hash. Sessions expire after a configurable lifetime.
- **CSRF protection.** Every state-changing portal request must send the per-session token in `X-CSRF-Token`. That token is held only in JavaScript memory, never in storage.
- **Password events.** Changing your own password ends your other sessions. An admin password reset or disabling an account ends all of that account's sessions.

### Authorization
- **Role → permission matrix** (`server/src/lib/permissions.js`), enforced on every admin route. The frontend's route guards only control navigation and are never the security boundary.
- **Resource-level checks:**
  - Faculty endpoints confirm the instructor is assigned to the section, and return 404 for sections they don't teach.
  - Student endpoints derive the student ID from the session. No route accepts another student's ID.
  - Students can update their contact fields only, enforced by a strict schema.
- **Separation of duties.** A registrar cannot approve a grade change they requested. Faculty cannot approve or publish grades. Published grades change only through an approved change request.
- **Tenant isolation.** Every query is scoped by the caller's `institutionId`. Cross-tenant IDs return 404, verified by tests for both humans and integrations.

### Integration API
- **OAuth 2.0 client credentials.** Secrets are 256-bit random values, shown once, and stored as HMAC-SHA-256 hashes keyed with a pepper that lives only in the environment.
- **Short-lived tokens.** Tokens are HS256 JWTs (5–60 minutes) bound to issuer and audience. Each one is checked against a server-side registry (`jti`), so revocation, client disablement, secret rotation, and scope narrowing take effect immediately.
- **Defence in depth on writes.** A write must pass the scope check, the per-institution policy switch, the business rules, and resource checks (for example, that the acting instructor teaches the section). Read-only clients cannot write, even with a valid token.
- **Explicit response DTOs.** Responses are built field by field, so new database columns can't leak. Student DTOs exclude date of birth, address, emergency contacts, and financial references.
- **Clients can't be enumerated.** Token errors for unknown, wrong, disabled, and revoked clients are identical.
- **Logging.** Every API request is logged per client (method, path, status, latency, error code, IP), and failed token attempts are audited.
- **Separate credentials per surface.** Human session cookies are not accepted on `/api/v1`, and bearer tokens are not accepted on `/api/app`.

### Cross-system identity and write-back (Feddrick / EdunexusAI)
- **Identity links are explicit.** Identity links are never inferred: reconciliation uses only email and institutional ID as hints and never names. Linking requires confirmation, and an email mismatch requires a written verification note. Partial unique indexes allow one active link per account and per record.
- **Student writes are field-level.** Each write is checked against scope ∧ institutional policy ∧ client preference. Protected fields can't be written at all. Concurrency is optimistic (ETag/If-Match).
- **Creates are idempotent.** `Idempotency-Key` is required on create, so a retry after a timeout can't duplicate a record. The connector only auto-retries writes that carry a key.
- **Deactivation never deletes.** There is no hard-delete endpoint.
- **Attribution is recorded but not trusted.** `X-Acting-User` attribution and rejected write attempts are audited (`outcome = REJECTED`). The asserted human is never trusted for authorization.

### Web and API hardening
- **Helmet** sets the security headers: a Content Security Policy with `frame-ancestors 'none'`, HSTS in production, `nosniff`, and a referrer policy. The `X-Powered-By` header is disabled.
- **CORS.** `/api/app` allows credentials only from the configured `CORS_ORIGINS`. `/api/v1` sends no CORS headers, because it is server-to-server.
- **Rate limits.** Portal: 300 requests/min per IP. Token endpoint: 30/min per IP. API: 600/min per client. Login: as described above.
- **Request size.** JSON bodies are limited to 200 KB and the token endpoint to 10 KB.
- **Validation.** Every request body and query is validated with Zod. Sort fields are allow-listed, which prevents injection through `orderBy`. All database access goes through Prisma's parameterised queries.
- **Error handling.** Errors return a stable code and a request ID. Stack traces are logged server-side only and never returned.
- **CSV export.** Exports neutralise spreadsheet formula injection, are served with `no-store`, and are audited along with the filters used.

### Auditing
- `AuditEvent` records actor (user, integration, or system), action, entity, a summary, before/after values, and IP. It covers:
  - every change to records, grades, registrations, holds, policies, users, terms, catalog, and integrations;
  - sign-ins and lockouts;
  - transcript views and student exports.
- Grade changes have their own full history (`GradeHistory`), and registrations keep their status history (`RegistrationEvent`).

### Secrets and configuration
- All secrets come from environment variables. Startup validates the configuration and refuses weak or missing values.
- `.env` files are git-ignored, and only `.env.example` files with placeholders are committed.
- The seed script refuses to run in production unless explicitly overridden.

## Gaps to close before real data

| Area | Gap | Recommendation |
|---|---|---|
| Identity | No SSO and no MFA | Integrate the institution's IdP (SAML/OIDC) and require MFA for staff |
| Identity | Temporary passwords are shown to the administrator and not forced to change | Use emailed one-time setup links and force a password change on first sign-in |
| Data at rest | Relies on the database or disk encryption of the host | Use encrypted managed Postgres and backups; consider column encryption for date of birth, address, and emergency contacts |
| Key management | JWT and pepper secrets live in environment variables | Store them in a secrets manager (AWS Secrets Manager, Vault) and define a rotation procedure |
| Integration security | No IP allow-listing, mTLS, or per-client rate limits configurable in the UI | Add these for high-trust write clients |
| Audit integrity | The audit log can be modified by anyone with database superuser access | Stream it to append-only storage or a SIEM; add hash chaining |
| Data minimisation | Single-record student reads aren't audited (only logged per request) | Add audit sampling or alerting on bulk access patterns |
| Retention | No retention or deletion schedules | Define retention for logs, sessions, applications, and documents to match institutional policy |
| Distributed rate limiting | Limits are held in process memory | Use a Redis store when running more than one instance |
| Assessment | No penetration test or dependency scanning in CI | Add SAST/DAST, `npm audit` gating, and an external penetration test before production |
| Privacy process | No FERPA directory-information opt-out flag | Add student privacy flags (directory suppression, release authorisations) and respect them in the API DTOs |
| Monitoring | No alerting | Alert on authentication failures, 5xx spikes, token failures, and unusual export volume |

## Dependency status (as of the last `npm audit`)

- **3 high-severity advisories, all in the Prisma CLI's tooling.** They come from `deepmerge-ts` < 8 (stack exhaustion on recursive objects), pulled in via `prisma` → `@prisma/config`.
- **Runtime exposure: none.** The CLI is a development and migration tool that only reads trusted local configuration. The runtime `@prisma/client` is not affected.
- **No clean fix yet.** npm's only suggested fix is a semver-major change of the CLI. Upgrade Prisma once a patched release is published, and re-run `npm audit` in CI.

## Reporting

Treat any suspected exposure of a client secret as an incident. Rotate it immediately (**Admin → Developer & integrations → client → Rotate secret**), which also revokes every outstanding token, then review that client's API activity and audit trail.
