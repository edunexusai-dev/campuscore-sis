# Automatic university-account provisioning (CampusCore → Keycloak)

When an administrator creates or changes a student or faculty record, CampusCore creates or updates that person's university account in Keycloak by itself. Nobody runs a script. The rules are the identity sync's own (`identity-sync/src/plan.js`). The server runs that code: there is no second implementation.

## Flow

```
 Administrator / API / script                     CampusCore database (one transaction)
 ───────────────────────────                      ─────────────────────────────────────────────
 create / update Student or Faculty  ──────────►  Student / Faculty row written
 merge records, exclude a person                  └─ trigger ─► IdentityProvisioning row for the person
                                                                 status PENDING, requestedVersion + 1
                                                       (both commit, or neither does)

 Provisioning worker (in the API process, every 5 s)
 ───────────────────────────────────────────────────
 claim due rows  (FOR UPDATE SKIP LOCKED; PROCESSING with a 5-minute claim)
   │
   ├─ person excluded ─────────────────────────────────────────────► SKIPPED  (IDENTITY_EXCLUDED)
   ├─ person merged away ── enabled account still has its number? ─► NEEDS_REVIEW / SKIPPED
   └─ syncPerson(person) via Keycloak Admin API (service account campuscore-identity-sync)
        find account: 1. person_number  2. student/employee number AND one of the person's addresses
                      (3. an administrator-confirmed account id)        never email alone
        ├─ CREATE / ADOPT / UPDATE / UNCHANGED ──────────────────────► PROVISIONED (+ Keycloak user id)
        ├─ conflict (ambiguous, other person's number, email only) ──► NEEDS_REVIEW (reason)
        ├─ nothing current, no account ──────────────────────────────► SKIPPED
        ├─ Keycloak down / 5xx / 429 ── attempts < max ──────────────► PENDING, retry 30 s, 1 m, 2 m … 1 h
        └─ refused credentials, missing role, retries exhausted ─────► FAILED
   record outcome + audit event; if the person changed meanwhile → PENDING again

 Administrator (student / faculty page → "University account")
   Retry  (identity.manage)          Confirm existing account  (users.manage = ADMIN only)
```

Afterwards the person signs in through the existing OIDC flow. CampusCore links their login on the token's verified institutional numbers (`routes/app/oidc.js`).

## Guarantees

| Requirement | How |
|---|---|
| Nothing missed, whatever writes the record | Database triggers on `Student`, `Faculty` and `Person`, in the writer's transaction. A rollback leaves no request. |
| Retries never duplicate an account | One row per person. The worker reconciles the person's *current* state and finds the account by `person_number` first. An account whose create response was lost is found on the next attempt. |
| Keycloak down never loses or blocks data | Records commit independently of Keycloak. The row stays `PENDING` with exponential backoff, and nothing is rolled back. |
| One identity per person | Accounts are keyed by `person_number`. Student and faculty numbers and roles go on the same account. |
| No adoption on email alone | Inherited from `plan.js`. An email-only match is `NEEDS_REVIEW` (`EMAIL_IN_USE_WITHOUT_NUMBER`). |
| Ambiguity is never decided automatically | `AMBIGUOUS_ACCOUNTS`, `NUMBER_HELD_BY_OTHER_PERSON`, `EVIDENCE_MISMATCH`, `DUPLICATE_PERSON_NUMBER`, `MERGED_PERSON_HAS_ACCOUNT` and `KEYCLOAK_USERNAME_OR_EMAIL_TAKEN` all go to `NEEDS_REVIEW`. |
| CampusCore stays the authority | Only `learner`, `faculty` and `alumni`, the three identity attributes, names, the email and the enabled flag are managed. Other roles (for example `it-admins`) are never added or removed. CampusCore never reads roles from tokens. |
| Staff are separate | ADMIN and REGISTRAR logins have no person, so they never reach this flow. Staff accounts in Keycloak are managed by hand. |
| No passwords | Accounts are created without credentials, with the required action `UPDATE_PASSWORD`. See "First sign-in" below. |
| Audit | `identity.account_created`, `identity.account_adopted`, `identity.account_updated`, `identity.provisioning_needs_review`, `identity.provisioning_failed` (first failure and when giving up), `identity.provisioning_retried`, `identity.account_adoption_confirmed`. They carry person numbers and field names, never names or addresses. |

## Configuration (server environment, names only)

| Variable | Meaning |
|---|---|
| `IDENTITY_SYNC_ENABLED` | `true` starts the worker. Default `false`: rows queue up and nothing is lost. |
| `IDENTITY_SYNC_KEYCLOAK_URL` | Keycloak base URL. Must be https in production. |
| `IDENTITY_SYNC_KEYCLOAK_REALM` | `edunexusai-feddrick` |
| `IDENTITY_SYNC_CLIENT_ID` / `IDENTITY_SYNC_CLIENT_SECRET` | The `campuscore-identity-sync` service account. The server refuses to start if these equal the sign-in client's (`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`). |
| `IDENTITY_SYNC_SEND_SETUP_EMAIL` | `true` only once the realm has SMTP. |
| `IDENTITY_SYNC_POLL_INTERVAL_MS`, `IDENTITY_SYNC_MAX_ATTEMPTS`, `IDENTITY_SYNC_TIMEOUT_MS` | Defaults 5000, 12, 10000 |

## Keycloak service account (`campuscore-identity-sync`)

- **Client:** confidential, with **only** *Service accounts* enabled. No standard flow, no direct access grants and no redirect URIs.
- **Service-account roles: realm-management `manage-users`, `view-users`, `query-users`.** Nothing else:
  - not `realm-admin`, `manage-realm`, `manage-clients` or `impersonation`;
  - not `query-groups` either, which the sync never uses.
- **Why each is needed:**
  - `query-users` and `view-users`: search accounts by attribute and email, and read accounts and their role mappings.
  - `manage-users`: create and update accounts, map realm roles, and send the set-password email.
- **Residual breadth:** `manage-users` can manage *every* user in the realm, including resetting passwords. Keycloak stops it from granting realm-management roles it doesn't hold, but it could map other realm roles. To narrow that, enable Keycloak's fine-grained admin permissions (v2) and restrict this client's role mapping to `learner`, `faculty` and `alumni`.
- **The secret** goes only in the server's environment file on the host. Never in git, logs or CI.

## First sign-in, passwords and SMTP

Accounts are created **without a password**. A common or predictable starting password would let anyone who knows a student number sign in as that student.

Two consequences:
- **Until the realm has SMTP,** a new account exists but its owner can't sign in yet.
- **"Forgot password?" also needs SMTP.**

**What's required for self-service onboarding:**
1. **Realm SMTP** (Realm settings → Email): a host and port with TLS, a *From* address on `edunexusai.online`, and credentials. Amazon SES works, but it's a new AWS resource. SES also needs the domain verified (DKIM and SPF records), plus production access to leave the sandbox. Any other transactional mail provider works too.
2. **Link lifetime:** raise *Realm settings → Tokens → "Default admin-initiated action lifespan"* (default 12 h) to, say, 72 h.
3. **Turn the email on:** set `IDENTITY_SYNC_SEND_SETUP_EMAIL=true`. New accounts then get Keycloak's own "set your password" email, which is a single-use, expiring link.
4. **Accounts created before SMTP existed:** send the email once, from the Keycloak console (Users → the user → *Credentials* → *Credential reset* → Update Password), or with the CLI.

**Interim without SMTP**, for a few pilot users only: an administrator sets a **temporary** password in the Keycloak console. Keycloak forces a change at first sign-in. The administrator passes it to the person out of band (in person, not by email). Never script this in bulk.

## Keycloak account vs. CampusCore login (`OIDC_JIT_ACCOUNTS`)

These are two different things:

1. **Keycloak identity (this feature):** the person's university account, created from their CampusCore record by the worker. It's how they authenticate.
2. **CampusCore application login (`User`):** CampusCore's own account, which holds the session, role and record ownership.
   - It is created by an administrator (with a temporary CampusCore password), or at the first successful SSO sign-in when `OIDC_JIT_ACCOUNTS=true`.
   - With JIT, `routes/app/oidc.js` creates a login **without a password**, linked to issuer and subject. It does that only after:
     - the token's verified `student_number`/`employee_number` all resolve to one person
     - the provider's verified email is one of that person's addresses
     - the person has a current relationship and isn't excluded
   - JIT never creates ADMIN or REGISTRAR logins.
   - Tests: `tests/multi-role.test.js` ("without OIDC_JIT_ACCOUNTS…", "with it, the person gets one login without a password…", and the refusals).

**Recommendation: enable `OIDC_JIT_ACCOUNTS=true` in production together with this feature.**
- **Without it:** a student whose record was created without a CampusCore login (`createLogin: false`, faculty without a login, or records created through the API) gets a Keycloak account but is refused at CampusCore with `NO_CAMPUSCORE_LOGIN`.
- **The alternative:** an administrator creates logins with temporary CampusCore passwords, which is exactly the password handling SSO-first avoids.
- **JIT's checks are the same evidence rules as provisioning.** The Keycloak accounts created here carry the numbers and a verified address, so JIT's checks pass for them and only for them.

## Local testing

```
cd server
npx vitest run tests/identity-provisioning.test.js   # in-process Keycloak stub; never a real realm
npx vitest run                                       # everything (needs the *_test database from .env.test)
cd ../identity-sync && npm test
```

To try it against your **local** Keycloak (never production), add `IDENTITY_SYNC_*` to `server/.env` with `IDENTITY_SYNC_KEYCLOAK_URL=http://localhost:8080` and the local sync client's secret. Then run `npm run db:deploy` and start the server. Create a student, and the "University account" card on their page shows the result within seconds.

## Operations

- **Queue:** `GET /api/app/admin/identity-provisioning` (defaults to `NEEDS_REVIEW` and `FAILED`; `?status=` filters).
- **Monitoring:** the log has one line per person, with person number, status, action, reason and error code. Alert on a growing number of `FAILED` or `NEEDS_REVIEW` rows.
- **Pause:** `IDENTITY_SYNC_ENABLED=false`. Changes keep queueing, and resume when it's turned back on.
- **Reconciliation:** the CLI `identity-sync` (`npm run sync -- --full`, a dry run by default) still compares everything and changes nothing unless given `--apply`.

## Deployment and rollback

- **The migration** `20261103100000_identity_provisioning` is additive:
  - an enum, a table, three functions, three triggers, and a backfill of existing people with records.
  - On a fresh database the backfill inserts nothing.
  - Its header lists the exact rollback statements.
- **First deploy:** use `IDENTITY_SYNC_ENABLED=false`. Verify, then enable it.
- **Rolling back the application image** without the migration is safe. Older code ignores the table, and the triggers keep filling it.
- **Accounts already created in Keycloak stay.** Accounts are never deleted automatically, including on rollback. Disable unwanted ones in Keycloak.
