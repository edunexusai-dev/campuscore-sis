# Identity architecture: one person, one university identity, several roles

This document covers how a person is created, signed in and given access across CampusCore, the university identity provider (Keycloak) and campus applications such as EdunexusAI and Moodle.

## The rule in one line

**CampusCore registers the person → the identity sync gives them one Keycloak account → every application creates its own account at the person's first sign-in (JIT).**

| System | Owns | Never does |
|---|---|---|
| **CampusCore** (system of record and person registry) | Who is a student or faculty member: records, numbers, statuses, and which records are the same human being (`Person`) | Store or check university passwords for SSO users |
| **Identity sync** (`identity-sync/`) | Copying people from CampusCore into Keycloak: one account per person | Read the CampusCore database, delete accounts, or match on email alone |
| **Keycloak** | Proving who is signing in: passwords, MFA, sessions, single sign-on and logout | Decide who is a student |
| **EdunexusAI, CampusCore web app, Moodle** | What the person may do in that application | Create university identities |

```
 CampusCore ──(people:read API)──► identity-sync ──(Admin API, manage-users)──► Keycloak
   Person P0000210                                                    user rahul.multirole
   ├─ Faculty F01024 (active)                                          person_number  P0000210
   └─ Student S2600187 (active)                                        employee_number F01024
                                                                       student_number  S2600187
                                                                       roles: faculty, learner
                                                                              │ one sign-in (OIDC)
                     ┌────────────────────────────────────────────────────────┼──────────────────┐
                     ▼                                                        ▼                  ▼
          EdunexusAI (JIT account,                               CampusCore web app      Moodle (OAuth 2,
          both roles from CampusCore)                            (JIT login, personas)   one account)
```

## 1. Person registry (CampusCore)

- **`Person`** is one human being. It holds only `personNumber` (`P` + 7 digits, never reused) and `mergedIntoId`.
- **Every record has a person.** `Student.personId` and `Faculty.personId` are required and unique: one student record and one faculty record per person. A CampusCore login is `User.personId`; staff-only logins have none.
- **Everything else is worked out, never copied** (`services/personService.js`):
  - names come from the faculty record, else the student record;
  - **primary email**: the current faculty email, else the current student email, else the latest record email. A staff mailbox outlives a degree;
  - **a current relationship**: a student who is `ACTIVE`, `ADMITTED` or `LEAVE_OF_ABSENCE`, or a faculty member who is `ACTIVE`;
  - **person status**: `ACTIVE` if anything is current, `ALUMNI` if they graduated and nothing is current, else `INACTIVE`.
- **The same person is never guessed.** A record joins an existing person only when an administrator says so:
  - "enrol this faculty member as a student" (`personOfFacultyId`);
  - "appoint this student as faculty" (`personOfStudentId`);
  - "same person" (`POST /api/app/admin/persons/:id/records`, audited, a reason is required). The emptied person is kept as merged.
- **The login follows its records.** It is disabled only when none of the person's records still gives access, and its email follows the primary email. A lecturer who withdraws from a degree keeps signing in as faculty.
- **Integration API:** `GET /api/v1/people` and `/api/v1/people/{id}`, scope `people:read`.
  - Filters: `personNumber`, `studentNumber`, `employeeNumber`, `email`, and `updatedSince` (the sync's change feed).
  - Student and faculty responses now include `personId`.

**Migration `20261101100000_person_registry`** is additive.
- **Backfill:** a login that owns records becomes one person with all of them (how CampusCore already expressed "same person"). Every record without a login becomes its own person.
- **Result on the dev database:** 214 records became 213 people; the one shared person is Rahul (`P0000210`).
- **Rollback** is in the migration header.

### Excluding people from identity provisioning

`Person.identityExcluded` (migration `20261101140000_person_identity_exclusion`, additive, default false) keeps a
person's records and academic history but removes them from every provisioning path, enforced in CampusCore itself:

| Path | Effect for an excluded person |
|---|---|
| `GET /api/v1/people`, `/people/{id}` (identity sync, portal JIT) | not listed / 404, also not in `updatedSince` |
| `POST /api/v1/identity/links` (portal onboarding, relationships, JIT) | `422 person_identity_excluded` |
| CampusCore first sign-in (`OIDC_JIT_ACCOUNTS`) | refused `IDENTITY_EXCLUDED` (an existing login is untouched) |

The sync never deletes, and once a person is excluded it no longer sees them, so an excluded person's existing
university account is removed by an administrator. Toggle: `PUT /api/app/admin/persons/:id/identity-exclusion
{ excluded, reason }` (identity.manage, audited). Keep-list for a demo environment (dry run unless `--apply`):
`node --env-file=.env scripts/identity-exclusion.js --institution feddrick --keep P0000210,P0000107 --reason "…"`.
Including a person again makes them appear in the next incremental sync.

## 2. Roles and personas (CampusCore web app)

- **Effective roles** (`lib/roles.js`):
  - ADMIN and REGISTRAR are granted to the account (`User.role`);
  - STUDENT and FACULTY come from the account's records (a student record that isn't `WITHDRAWN`, a faculty record that is `ACTIVE`). One account can hold both.
- **The server checks any role the account holds** (`requireRole`, `requirePermission`, announcements). `/auth/me` returns `roles`, `home` and `hasPassword`; `role` stays for older clients.
- **The web app:**
  - after sign-in, a person with several roles sees **"Where would you like to start?"** (`/choose`);
  - the sidebar's **Viewing as** switch moves between Teaching and Studying, and the last choice is remembered on that device;
  - a `returnTo` (for example from EdunexusAI's "CampusCore · Student records" link) opens an area directly.

## 3. University sign-in into CampusCore (SSO-first)

`routes/app/oidc.js` handles a first sign-in like this:
1. Every institutional number in the token must belong to **one** person (`AMBIGUOUS_RECORDS` otherwise).
2. The verified email must be one of that person's addresses.
3. **The person's login is used.** If they have none and `OIDC_JIT_ACCOUNTS=true`, one is **created with no password**, attached to all of the person's records.

Refusals are `NO_CURRENT_RELATIONSHIP` and `EMAIL_IN_USE`. Staff accounts are still never linked automatically. Migration `20261101110000_sso_only_logins` makes `User.passwordHash` nullable.

## 4. Identity sync (CampusCore → Keycloak)

`identity-sync/` is a separate Node worker that uses only public interfaces:
- CampusCore's API with an integration client holding **only `people:read`**;
- Keycloak's Admin API as a **service account** of a dedicated client holding realm-management `manage-users`, `view-users` and `query-users`.

| Person in CampusCore | Account in Keycloak |
|---|---|
| New, with a current relationship | **Created**: username = primary email's local part, email = primary (verified), names, `person_number` and the numbers, roles, required action "update password" (or the setup email with `SYNC_SEND_SETUP_EMAIL=true`) |
| Teaches and studies | **One** account, both numbers, roles `faculty` + `learner` |
| Stops studying, still teaches | `learner` removed; still enabled |
| Graduates | `alumni` added; still enabled |
| Nothing current | **Disabled**, never deleted |
| No current relationship and no account | Nothing is created |

How the sync finds a person's account:
1. **By `person_number`.**
2. **Adopting an existing account** that carries one of the person's institutional numbers **and** one of their addresses. This is how Rahul's hand-made account is taken over.
3. **An account with the address but no number** (for example Keshav's) is reported as `EMAIL_IN_USE_WITHOUT_NUMBER`. An administrator checks it and confirms with `--adopt P0000123=<keycloak id>`. Never decided on email alone.
4. Conflicts (`DUPLICATE_PERSON_NUMBER`, `NUMBER_HELD_BY_OTHER_PERSON`, `AMBIGUOUS_ACCOUNTS`, `EVIDENCE_MISMATCH`) change nothing and are reported.

Only email, verified flag, names, enabled, the three identity attributes and the realm roles `learner`, `faculty` and `alumni` are managed. Every other attribute (for example `demo`) and role (for example `it-admins`) is carried over untouched.

```
cd identity-sync
cp .env.example .env              # fill in the two clients (secrets stay in .env)
npm run sync                      # dry run: what would change
npm run sync -- --apply --full    # first run: everybody
npm run sync -- --apply           # then: only people changed since the last successful run
npm run sync -- --person P0000300 --adopt P0000300=<keycloak id> --apply
```

**Scheduling:** run it every few minutes and nightly with `--full`. Exit code 2 means some people need attention; the output names person numbers and field names, never emails or names.

**Keycloak configuration** (realm `edunexusai-feddrick`):
- **Done:**
  - the user profile declares `person_number`, `student_number` and `employee_number` (users can view them, only admins can edit them; undeclared attributes are still allowed);
  - the `edunexusai` and `campuscore` clients map `person_number` into the ID token.
- **To do** (needs an administrator): create the sync client, see "Pending" below.

## 5. EdunexusAI JIT

When the sign-in option's **"Create portal accounts at first sign-in"** switch is on (`identity_providers.jitProvisioning`, off by default) and nobody matches the token's numbers, `sisService.provisionFromSignIn`:
1. asks CampusCore (`/people`) for the person behind every claimed number: one person, or `AMBIGUOUS_RECORDS`;
2. requires a verified email that is one of the person's addresses (`EMAIL_NOT_VERIFIED` / `EVIDENCE_MISMATCH`);
3. needs at least one current relationship (`NO_ELIGIBLE_RECORD`), and provisions **all** of them;
4. refuses if the address or a record already belongs to someone (`EMAIL_IN_USE`, `RECORD_ALREADY_LINKED`), for an administrator to link;
5. creates, in one transaction:
   - the user (no portal password);
   - the profiles and SIS-sourced roles;
   - the CampusCore links (the record carrying the sign-in address first; CampusCore accepts the second because it is the same person).

   If CampusCore fails mid-way, the account rolls back and links already made are withdrawn. Then the sign-in link (`linkMethod JIT_PROVISIONED`) is made and the normal role evaluation runs.

Other refusals: `JIT_NOT_PERMITTED` (no `people:read`) and `SIS_UNAVAILABLE`. ADMIN is never granted. An SSO-only account has no "Change password".

## 6. Moodle

Moodle stays behind EdunexusAI: one Moodle account per person, with the second profile reusing it (`SAME_PERSON`). Enrolments follow CampusCore registrations and teaching sections.

| Setting | Effect |
|---|---|
| `MOODLE_ACCOUNT_AUTH=oauth2` | New Moodle accounts sign in with the university sign-in (`auth=oauth2`) and get no Moodle password. Needs Moodle's OAuth 2 service configured against the same realm; check the MoodleCloud plan allows it. |
| `MOODLE_JIT_PROVISIONING=true` | After an EdunexusAI JIT account is created, its Moodle account and SIS enrolments are created in the background. Needs `MOODLE_WRITES_ENABLED`. |

Both are off by default; existing behaviour is unchanged.

## 7. The administrator's workflow (target)

1. Register the person in CampusCore: admission, then matriculation, or a faculty record. For someone who already exists, use "enrol this faculty member" / "appoint this student".
2. The identity sync creates or updates their Keycloak account (automatic).
3. The person signs in once. EdunexusAI and CampusCore create their own accounts; nothing is typed by hand anywhere.

## 8. Pending (needs an administrator)

These steps grant privileges, so they were deliberately not done automatically:
1. **Keycloak sync client:**
   - Clients → Create: `campuscore-identity-sync`, confidential, only *Service accounts* enabled;
   - Service account roles: realm-management `manage-users`, `view-users`, `query-users`;
   - put its secret in `identity-sync/.env`.
2. **CampusCore integration client for the sync:** Admin → Developer & integrations → new client with only `people:read`; put it in `identity-sync/.env`.
3. **EdunexusAI's CampusCore client:** add the `people:read` scope (Admin → Developer & integrations → the EdunexusAI client).
4. Then turn on **Create portal accounts at first sign-in** in EdunexusAI → Admin → Sign-in & role mapping, and run the sync (dry run first).
