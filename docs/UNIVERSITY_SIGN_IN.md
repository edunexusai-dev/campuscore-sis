# University sign-in (OpenID Connect) for the CampusCore web app

CampusCore keeps its own accounts, roles (ADMIN, REGISTRAR, FACULTY, STUDENT), permission matrix and
sessions. University sign-in only proves WHO the person is; CampusCore decides what they may do.

## Flow
1. `GET /api/app/auth/oidc/start` → sealed transaction cookie (state, nonce, PKCE verifier) → 302 to the
   provider. No `prompt`, so an existing university session (e.g. from EdunexusAI) is reused silently.
2. `GET /api/app/auth/oidc/callback` → code exchange; ID token verified (JWKS signature, issuer,
   audience = this client, expiry, nonce, state, exact callback address).
3. Account: an existing link (`UserIdentityLink`, issuer + subject), or at first sign-in the ONE person who owns the
   student/faculty records named by the token's `student_number` / `employee_number` (all of them), with the verified
   email being one of that person's addresses. Never email alone. The person's login is used; without one, and with
   `OIDC_JIT_ACCOUNTS=true`, a login with no password is created and attached to all of the person's records.
   Refusals: NO_INSTITUTIONAL_ID, NO_MATCHING_RECORD, NO_CAMPUSCORE_LOGIN (JIT off), NO_CURRENT_RELATIONSHIP,
   EMAIL_IN_USE, AMBIGUOUS_RECORDS, EMAIL_NOT_VERIFIED, EVIDENCE_MISMATCH, ACCOUNT_DISABLED,
   ACCOUNT_LINKED_TO_ANOTHER_IDENTITY, STAFF_ACCOUNT_NEEDS_ADMIN_LINK (audited).
4. A normal CampusCore session (`Session.authMethod = OIDC`), roles and permissions from the account (staff role, plus
   Student/Faculty from its records). Provider roles/groups are never read for authorization. A person with several
   roles lands on the persona chooser unless `returnTo` names an area.

## Staff accounts
ADMIN/REGISTRAR accounts are never linked automatically. An administrator links another person's account:
`POST /api/app/admin/users/:id/identity-links { subject, note }` (users.manage; not one's own account).
`DELETE …/identity-links/:linkId` removes it and signs out its sessions at once.

## Sign-out
- "Sign out of CampusCore": `POST /api/app/auth/logout` (this app only; the university session stays).
- "Sign out of all university apps": `POST /api/app/auth/oidc/logout-everywhere` → provider end-session
  with `id_token_hint` (no confirmation page); the provider then back-channels every app.
- `POST /api/app/auth/oidc/backchannel-logout`: signed logout token (JWKS, issuer, audience, iat ≤ 5 min,
  event, no nonce) → matching sessions deleted.

## Configuration
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_APP_URL` (all four enable it), optional
`OIDC_ALLOW_HTTP` (development only), `OIDC_DISPLAY_NAME`, `OIDC_INSTITUTION_SLUG`, claim names, `OIDC_JIT_ACCOUNTS`. Local
setup: Keycloak realm `edunexusai-feddrick`, client **`campuscore`** (its own client, secret and redirect
`http://localhost:5180/api/app/auth/oidc/callback`; back-channel
`http://host.docker.internal:4000/api/app/auth/oidc/backchannel-logout`). Migration
`20261024100000_oidc_sign_in` (additive; rollback in its header). Tests: `server/tests/oidc.test.js`.

## Several roles
One login holds every role its records give: a person who teaches and studies (e.g. Rahul, P0000210) uses both the
faculty and the student area, chosen at sign-in and switched from the sidebar. See IDENTITY_ARCHITECTURE.md.
