# Postman verification: CampusCore SIS for Feddrick University

Use these steps to verify the integration API by hand. Each step names the request in the collection `docs/postman/CampusCore-Feddrick.postman_collection.json`.

## 0. Prepare (one time)

**Note before you start:** sections 3 and 4 create and change real records in the CampusCore database you point at. They create one fictional student and an identity link, and a later step deactivates the student. Run them against a development database, not production.

1. **Start CampusCore** (`npm run dev` from the repository root), sign in at http://localhost:5180 as `admin@feddrick.edu`, and go to **Developer & integrations → Register application**:
   - Name: `Postman verification`
   - Scopes: select all **read** scopes, then add `students:create`, `students:update`, `students:deactivate`, `identity:read`, `identity:write`, `audit:read` and `integration:configure`.
   - Token lifetime: 60 minutes.
   - Copy the **client ID** and **client secret**. The secret is shown only once.
2. **Turn on the write policies** under **Admin → Policies → Integration API**:
   - **Allow integrations to create student records:** on
   - **Allow integrations to update student profiles:** on. Under *Profile fields integrations may change*, keep the contact fields.
   - **Allow integrations to deactivate students:** on
   - **Allow integrations to link external accounts:** on
   - Click **Save**, then **Apply changes**.
3. **Set up Postman.** Import the collection and `docs/postman/CampusCore-local.postman_environment.json`, and select the **CampusCore local (Feddrick)** environment:
   - `baseUrl`: `http://localhost:4000`
   - `clientId`: the client ID
   - `clientSecret`: the client secret. Put it in the **current value** column only, so it is never synced or exported.

## 1. Authenticate

| Step | Request | Expected |
|---|---|---|
| 1.1 | **Get access token** (`POST /api/v1/oauth/token`, Basic auth with `clientId:clientSecret`, body `grant_type=client_credentials`) | `200` with `token_type: Bearer`, `expires_in: 3600` and the granted `scope`. The test stores `{{accessToken}}`. |
| 1.2 | **Who am I** (`GET /api/v1/me`) | `institution.slug = feddrick`, `institution.name = Feddrick University` |
| 1.3 | **Effective write capabilities** (`GET /api/v1/capabilities`) | `student.create`, `student.update`, `student.deactivate` and `identity.link` show `effective: true`. The console prints a reason for each blocked operation. |

## 2. Institution and reads

| Step | Request | Expected |
|---|---|---|
| 2.1 | **Institution** | `name: Feddrick University`, `emailDomain: feddrick.edu`, `studentEmailDomain: students.feddrick.edu` |
| 2.2 | **Programs** | Stores `{{programId}}` (BS-CS) |
| 2.3 | **Search students** (`?search=chen`) | Paginated list. Stores `{{studentId}}`. |
| 2.4 | **Get student** | `200` with an `ETag: W/"…"` header |
| 2.5–2.6 | **Schedule** and **Academic record** | Current-term classes, each with `registrationStatus`; GPA and credits |

## 3. Student write-back

| Step | Request | Expected |
|---|---|---|
| 3.1 | **Create student** (headers `Idempotency-Key: postman-<guid>`, `X-Acting-User: postman:verifier`) | `201`, `status: ADMITTED`, a generated `studentNumber`. Stores `{{newStudentId}}`. |
| 3.2 | **Retry create with the SAME key** | `201` with header `Idempotent-Replayed: true` and **the same id**. No second student is created. |
| 3.3 | **Update permitted field** (`phone`) | `200`, `meta.changedFields: ["phone"]` |
| 3.4 | **Update protected field** (`studentNumber`, `academicStanding`) | `400 validation_error`. Protected fields are never written. |
| 3.5 | **Deactivate** (`reason`) | `200`, `status: WITHDRAWN`, and `meta.retained` confirms that history is kept |
| 3.6 | **Student audit history** | `student.created`, `student.updated` and `student.deactivated`, each with `onBehalfOf: postman:verifier` |

Optional negative checks:

- **Create without a key:** send 3.1 without `Idempotency-Key`. Expect `400 idempotency_key_required`.
- **Duplicate email:** send 3.1 with a new key and the same email. Expect `409 duplicate_student`, with the existing id in `details`.
- **Policy off:** turn off *Allow integrations to create student records* and send 3.1 again. Expect `422 policy_disabled`, with no token change needed.

## 4. Identity mapping

| Step | Request | Expected |
|---|---|---|
| 4.1 | **Reconcile** (two candidates: an email for Maya Chen, and a name only) | The first is `CANDIDATE` (or `LINKED` if already linked); the name-only candidate is `UNMATCHED`. Stores `{{candidateSisId}}`. |
| 4.2 | **Link account** (`confirm: true`) | `201`, `status: ACTIVE`, `evidence.emailMatch: true`. Running it again returns `409 identity_already_linked`. |
| 4.3 | **Resolve** (`externalUserId=postman-user-1`) | `status: LINKED`, `recordType: STUDENT`, `sisId`, `institutionalId`, `recordStatus` |
| 4.4 | **Revoke link** (reason) | `200`, `status: REVOKED`. Run 4.3 again: `status: UNMAPPED`. |

## 5. Token lifecycle

| Step | Request | Expected |
|---|---|---|
| 5.1 | **Revoke current token** (`POST /api/v1/oauth/revoke`) | `200 {"revoked": true}` |
| 5.2 | **Call with revoked token** | `401 invalid_token`, "The access token has been revoked." |
| 5.3 | Run **1.1** again | A new token works immediately. The EdunexusAI connector does this automatically on a `401`. |

More negative checks:

- **Missing scope:** in the client settings, remove `audit:read`, save, then request a new token and call 3.6. Expect `403 insufficient_scope`. Tokens issued before the change were revoked when the scope was removed.
- **Rotation:** **Rotate secret** in the admin UI. Calls with the old token now fail with `401`, and requesting a token with the old secret fails with `401 invalid_client`.

## 6. Clean up

- Turn the write policies back off if you don't need them.
- Revoke the `Postman verification` client.
- The student you created stays in CampusCore as WITHDRAWN. Records are never hard-deleted.

## Command-line equivalent

`npx newman run docs/postman/CampusCore-Feddrick.postman_collection.json -e docs/postman/CampusCore-local.postman_environment.json --env-var clientId=… --env-var clientSecret=…`

With a read-only client, the write steps are rejected or skipped, and the scope-aware tests still pass.
