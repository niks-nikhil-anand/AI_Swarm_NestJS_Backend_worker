# Authentication API implementation plan

Status update, 22 October 2026: the core auth/account APIs and session migration are implemented and verified. See [Authentication API](AUTH_API.md) for actual contracts and results. The design below remains the original plan; project membership integration (A5), shared multi-instance limiting and later identity features remain pending.

## 1. Scope and existing code

Deliver register, login, logout, authenticated profile retrieval, PUT profile/password update and DELETE account APIs. Keep existing `/users/:id` routes as explicitly privileged administrative CRUD; a normal signed-in user can manage only their own account.

Current foundations:

- [User and Account models](../prisma/schema.prisma) already exist. Email is globally unique; password hash is nullable for accounts that may later use OAuth.
- [PasswordService](../src/users/password.service.ts) hashes with salted scrypt but has no verification method.
- [UsersService](../src/users/users.service.ts) provides Prisma CRUD and public-field selection.
- [UserAccessGuard](../src/users/user-access.guard.ts) and [ProjectAccessGuard](../src/common/guards/project-access.guard.ts) currently authenticate server-configured bearer principals, not database users.
- [ApiExceptionFilter](../src/common/errors/api-exception.filter.ts) already provides a consistent error envelope.
- There is no AuthModule, user session table, login verification, end-user membership resolver or logout/revocation flow.

PostgreSQL is currently the only uncommented Compose service. Run the NestJS API on the host for development. Do not silently re-enable the commented services while implementing authentication.

## 2. Authentication design

Use cryptographically random opaque bearer session tokens with PostgreSQL-backed revocation for the first implementation. This fits the existing bearer request style, provides immediate logout and avoids adding JWT/refresh-token infrastructure before it is needed.

- Generate at least 32 random bytes and encode as base64url with an explicit user-session prefix such as `swu_`.
- Return the raw token only on register/login. Persist only its SHA-256 digest; do not store or log bearer secrets.
- An AuthGuard resolves the digest to an unrevoked, unexpired session and active user on every protected request.
- Proposed initial absolute TTL: 24 hours, configurable and bounded. No sliding expiry or refresh endpoint in this first release; sign in again after expiration.
- First-party browser clients keep the bearer token in memory and send `Authorization: Bearer ...`; no token in URLs or persistent browser storage. Reload requires sign-in in this initial design.
- Production uses HTTPS. Cookie sessions and cross-site deployment, refresh rotation, MFA, email verification, password reset and OAuth login are explicit follow-up work, not implied capabilities.
- Register creates identity and a session only. It never accepts or assigns arbitrary tenant, project, role, capabilities or administrative access.

A signed-in user initially has self-service account access. Research/project access additionally requires persisted membership, addressed in Phase A5 below. Do not infer membership from an email address or reuse configured principal permissions merely because IDs match.

## 3. API contract

All JSON request bodies use strict schemas; reject unknown fields. Responses set `Cache-Control: no-store`. Public user shape: `id`, `email`, `name`, `avatar`, `createdAt`, `updatedAt`. Never return password hashes, session digests or OAuth credentials.

| Method | Route | Authentication | Success and behavior |
| --- | --- | --- | --- |
| POST | `/auth/register` | Public, rate limited | 201; create user and session atomically; return public user, access token and expiry |
| POST | `/auth/login` | Public, rate limited | 200; verify credentials; create fresh session and return public user/token/expiry |
| POST | `/auth/logout` | Presented bearer token, rate limited | 204; revoke that session; repeated/expired/unknown token is a no-op; never revoke a session selected through the body |
| POST | `/auth/logout-all` | Active user session | 204; revoke all sessions for the current user, including the caller |
| GET | `/auth/me` | Active user session | 200; return current public user |
| PUT | `/auth/me` | Active user session | 200; update allowed self-service fields; password/email changes require current password and invalidate all sessions |
| DELETE | `/auth/me` | Active user session plus current password | 204; deactivate account and revoke sessions atomically; schedule any later retention cleanup separately |

PUT deliberately uses partial-update semantics to match current `/users/:id` behavior: omitted values are unchanged; `name`/`avatar` accept null; at least one actual update field is required. State this in API documentation so clients do not assume full replacement.

### Register

```json
{
  "email": "person@example.com",
  "password": "a-long-example-password",
  "name": "Example User",
  "avatar": null
}
```

Reuse current normalization and limits: trim/lowercase email, maximum 254 characters; password 8–128 characters without trimming; name maximum 100 characters; avatar nullable HTTP/HTTPS URL up to 2048 characters. Avatar is stored, not fetched. No `id`, `role`, `tenantId`, `projectId`, `capabilities`, `passwordHash` or account-token fields are accepted.

Proposed register/login response:

```json
{
  "user": {
    "id": "server-generated-id",
    "email": "person@example.com",
    "name": "Example User",
    "avatar": null,
    "createdAt": "2026-10-22T00:00:00.000Z",
    "updatedAt": "2026-10-22T00:00:00.000Z"
  },
  "accessToken": "swu_<random-secret>",
  "tokenType": "Bearer",
  "expiresAt": "2026-10-23T00:00:00.000Z"
}
```

Duplicate normalized email returns 409 `EMAIL_IN_USE`, consistent with current administrative CRUD. This intentionally discloses registration availability; use rate limits. Do not expose the same distinction on login or password confirmation.

### Login

Body: `{ "email": "person@example.com", "password": "..." }`.

Normalize email identically to registration. Wrong password, unknown email, deleted/disabled account, or null password hash returns the same 401 `INVALID_CREDENTIALS`. Use a dummy scrypt verification for unknown/passwordless accounts so failures follow comparable expensive paths. Validate/cap the request and rate-limit before hashing.

### PUT current user

Profile example: `{ "name": "Updated Name", "avatar": null }`.

Sensitive update example:

```json
{
  "email": "new-address@example.com",
  "newPassword": "a-different-long-password",
  "currentPassword": "a-long-example-password"
}
```

Allow `email`, `name`, `avatar`, `newPassword`, `currentPassword` only. `currentPassword` alone is not an update. Require it for an effective email change or any password change. Verify outside the write transaction, then use an optimistic credential-version condition inside the transaction so concurrent credential changes cannot authorize stale updates.

For password/email changes, atomically update fields, increment credential version and revoke all sessions. Return `{ "user": <public user>, "reauthenticationRequired": true }`; subsequent protected calls with the old token return 401. Profile-only updates return `reauthenticationRequired: false` and preserve sessions. Concurrent email conflicts return 409; a credential-version conflict returns 409 `AUTH_STATE_CHANGED` and requires reauthentication.

For initial scope, unverified email is a login identifier only: do not treat it as proof of ownership, organization membership or a password-recovery destination until verification is implemented. When verification is added, email changes must use a pending-address confirmation flow.

### DELETE current user

Body: `{ "currentPassword": "..." }`. Never accept a target user ID.

Deactivate via `deletedAt` and increment credential version, revoke all sessions in the same transaction, then return 204. Deny subsequent login/session use immediately. Keep the unique email reserved initially; document that re-registration requires a separate recovery/release policy. Do not claim this instantly erases research/audit data.

This self-service endpoint is logical account deletion. Retention-driven anonymization, OAuth credential removal and object-store cleanup need a separately specified idempotent deletion job and retention policy. Existing administrative DELETE physically removes User/Account records; preserve that documented behavior only with explicit privilege, session cascade deletion and a compatibility review before membership FKs are introduced.

Passwordless accounts cannot satisfy current-password operations in this release. Return a generic reauthentication failure and defer alternate provider-based reauthentication until OAuth login exists; never bypass confirmation for a null hash.

## 4. Prisma/PostgreSQL changes

Add one forward migration after the current history; do not rewrite existing migrations or reset populated databases. Confirm the existing run-domain baseline onboarding is complete before applying subsequent migrations.

### User additions

| Field | PostgreSQL type | Purpose |
| --- | --- | --- |
| `credentialVersion` / `credential_version` | INTEGER NOT NULL DEFAULT 0 | Invalidate concurrent credential operations and session issuance |
| `deletedAt` / `deleted_at` | TIMESTAMPTZ(6) nullable | Logical deletion and login denial |
| `disabledAt` / `disabled_at` | TIMESTAMPTZ(6) nullable | Administrative suspension distinct from deletion |
| `sessions` | Prisma relation | User's authentication sessions |

Keep existing IDs as TEXT, global email uniqueness, scrypt hashes, User/Account timestamps and account relationships. Existing users receive version zero and remain active by default. Email/password verification is not backfilled or fabricated.

### AuthSession model

| Field | Type and constraints |
| --- | --- |
| `id` | UUID primary key, server generated |
| `userId` / `user_id` | TEXT, required User FK, delete cascade |
| `tokenHash` / `token_hash` | TEXT, unique digest, required |
| `credentialVersion` / `credential_version` | INTEGER, version at issuance |
| `createdAt` / `created_at` | TIMESTAMPTZ(6), default now |
| `expiresAt` / `expires_at` | TIMESTAMPTZ(6), required |
| `revokedAt` / `revoked_at` | TIMESTAMPTZ(6), nullable |

Map the model to `auth_sessions`. Index userId+revokedAt for logout-all and expiresAt for cleanup. Add an expiry-after-creation SQL CHECK. Do not persist raw tokens, passwords, full headers or arbitrary client metadata. Define a bounded per-user active-session limit and retention window before implementation; revoke oldest sessions atomically when the limit is reached, coordinated by a user-row lock.

AuthSessionGuard checks user active state, expiry, revocation and matching credentialVersion. No JWT signing secret is required for opaque tokens. Session tokens are authentication state; project roles/capabilities remain authorization data resolved separately.

## 5. Service behavior and concurrency

### Password service

Add `verify(password, storedHash)` to the existing hash service using Node crypto:

- Parse only a bounded, recognized scrypt format; reject malformed/oversized salt, digest or parameters.
- Permit supported stored parameter sets rather than letting database hash text request arbitrary CPU/memory costs.
- Derive the same key and compare equal-length buffers with `timingSafeEqual`.
- Keep hashing/verification outside open database transactions; cap concurrent hashing separately from HTTP request limits.
- Never trim, lowercase, log or silently truncate passwords.

### Register/login/session issuance

Register hashes first, then creates user and session in one Prisma transaction. A unique email race maps to 409. Failure must not leave a user without its intended session response state; raw tokens must not be persisted or emitted before commit.

Login verifies against a user snapshot outside the transaction. Inside the issuance transaction, lock/revalidate the user, credential version, active state and password snapshot before inserting a session. Credential change/delete/logout-all use the same user locking convention. This prevents a login verified before revocation from issuing a new stale session after it.

`logout-all` increments credential version as well as revoking session rows; issuance revalidation rejects earlier snapshots. The current-session logout uses an atomic update by digest and is idempotent. State changes commit before returning success. Existing in-flight reads may complete; define fresh session/state rechecks for consequential writes. Revoking a login session does not implicitly cancel already-authorized Temporal jobs; account/job cancellation is a separate policy.

Sensitive PUT/DELETE obtains a current credential snapshot, verifies confirmation, then locks/rechecks version and active state before mutation. Session deletion/revocation and user mutation are transactional. Rate-limit confirmation failures as well as login failures.

### Existing administrator routes

Update administrative password/email changes and suspension/deletion to revoke sessions and increment credential version atomically. Otherwise an administrator could change a password while prior sessions remain usable. Apply self-service active-account checks without accidentally granting self-service users access to `/users`.

## 6. Authorization integration

Keep two explicit identity paths during transition:

1. Existing configured bearer principals for current machine/admin/project access.
2. New prefixed user-session tokens for end-user auth.

Reject ambiguous credentials. New session tokens must never fall back to matching configured credentials after session verification fails. Keep `/users` restricted to the explicit administrative guard; a User record or email does not grant the global `users` capability.

For project access, implement a dedicated membership resolver backed by the Tenant/Project/TenantMember/ProjectMember design in the [database plan](POSTGRES_PRISMA_SCHEMA_PLAN.md). Construct the existing trusted execution context from the verified user plus membership. Never accept tenant/project ownership or capability grants in register/login bodies. Until membership is implemented, self-service auth endpoints work but new users do not automatically gain research access.

The API currently requires `AUTH_CREDENTIALS` during startup; preserve that requirement for the first compatibility release. Auth-only startup configuration can be a separate change, not an accidental guard bypass.

## 7. Module and file plan

```text
src/auth/
  auth.module.ts
  auth.controller.ts
  auth.service.ts
  auth-session.service.ts
  auth.repository.ts
  auth-session.guard.ts
  contracts/auth-request.ts
  contracts/auth-response.ts
  types/authenticated-request.ts
  jobs/session-cleanup.job.ts
src/users/password.service.ts      # add verification; retain stored hash format
src/users/users.service.ts         # integrate admin-triggered session revocation
src/users/users.module.ts          # share/export password provider without duplicate ownership
src/config/auth.config.ts
prisma/schema.prisma
prisma/migrations/<new_auth_migration>/migration.sql
tests/auth/password.spec.ts
tests/auth/session.spec.ts
test/auth.e2e-spec.ts
```

AuthModule imports Prisma and a clearly owned password provider. Avoid circular AuthModule/UsersModule dependencies: share low-level credential/session repositories through a small provider module or let UsersService depend on a session revocation interface. Controllers validate DTOs and delegate; repositories own transaction/concurrency logic.

Configuration to add with validation:

- `AUTH_SESSION_TTL_SECONDS`: proposed 86400 default with documented upper/lower bounds.
- `AUTH_MAX_ACTIVE_SESSIONS`: positive bounded integer; initial proposed limit 5.
- `AUTH_ALLOWED_ORIGINS`: explicit browser origins; no wildcard credential policy.
- Auth endpoint throttle and hash-concurrency settings, shared across API replicas when deployed with multiple replicas.
- Session cleanup retention/schedule; cleanup is not relied on for expiry enforcement.

Do not add unused JWT secrets or Redis services. For the initial single API instance, bounded in-memory throttling can be used with a documented deployment limit; multi-instance production requires a shared limiter before rollout. Only trust proxy-derived client IPs with explicit trusted proxy configuration.

## 8. Errors, logging and abuse controls

Use the existing `{ "error": { "code", "message", "retryable" } }` envelope.

| HTTP | Codes and meaning |
| --- | --- |
| 400 | `INVALID_ARGUMENT`: malformed body, missing required fields, unsupported properties |
| 401 | `INVALID_CREDENTIALS`, `SESSION_INVALID`, `REAUTHENTICATION_FAILED`: generic credential/session failures |
| 403 | `CAPABILITY_DENIED` / project membership denial after successful authentication |
| 409 | `EMAIL_IN_USE`, `AUTH_STATE_CHANGED`: uniqueness or optimistic credential conflict |
| 429 | `RATE_LIMITED`: include bounded Retry-After |
| 503 | Dependency unavailable or bounded hash capacity exhausted; redact internal details |

Rate-limit register/login/logout and sensitive changes by bounded IP/account keys; cap concurrent scrypt operations so parallel login attempts cannot exhaust memory. Do not create permanent account lockout from untrusted attempts. A failed database operation must not become a successful login or silent successful logout for an existing valid session.

Emit sanitized auth events for registration, login outcome, revocation, profile/credential change and deactivation. Exclude passwords, raw tokens, token digests, OAuth secrets and full authorization headers. Never echo invalid request bodies in logs. Set response caching controls and bound request body/header sizes.

## 9. Phased checklist and acceptance gates

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| A0 — baseline | Restore dependencies; validate existing Prisma schema/history and User API compatibility | Current build/tests pass; disposable test PostgreSQL is available |
| A1 — database | User state/version fields and AuthSession migration | Fresh and existing users migrate safely; indexes/FKs/defaults verified; no raw token storage |
| A2 — credentials/sessions | Password verification, token issuance, guard, revocation and cleanup | Hash-format rejection, timing-safe comparison, expiry, version and revocation tests pass |
| A3 — auth routes | Register, login, logout, logout-all and GET me | API contracts/errors/rate limits tested; duplicate races yield one identity; invalid login is generic |
| A4 — account routes | PUT/DELETE me, current-password checks and admin-triggered revocation | Cross-user updates impossible; password/email/delete races invalidate sessions; retained data policy explicit |
| A5 — project access | Persisted membership resolver for end-user sessions | Login alone grants no projects; cross-tenant access fails; configured principals still work |
| A6 — release | Frontend integration, HTTP controls, shared throttling if replicated, audit and deployment docs | Real PostgreSQL concurrency, auth regression, logout behavior and secret-free logs demonstrated |

Immediate implementation order: A0 → A1 → A2 → A3 → A4. A5 is required before newly registered users can operate the AI research product. A6 is required before public release.

## 10. Required test matrix

- [ ] Register validation, normalized duplicate emails and concurrent registration races.
- [ ] Public response allowlists: no password/session/provider secrets.
- [ ] Correct/incorrect password, unknown account, null hash, disabled/deleted user and malformed stored hash.
- [ ] Token entropy/format, hash-only persistence, missing/invalid token, expiry and revocation.
- [ ] Repeated logout, logout-all, active-session limit and expiry cleanup.
- [ ] Login versus password change, logout-all, deletion and administrative credential-change races.
- [ ] PUT profile omission/null semantics, sensitive confirmation, duplicate email conflict and credential-version conflict.
- [ ] DELETE only the authenticated user; all sessions revoked; re-login denied; no unintended research-data deletion.
- [ ] Normal users denied administrative `/users` routes and unauthorized project routes.
- [ ] Existing configured principals retain expected behavior; revoked user sessions cannot fall back to configured credentials.
- [ ] Rate limits, hash concurrency limits, no-store responses, CORS and trusted-proxy behavior.
- [ ] Transaction failures roll back mutations/session changes; raw tokens never appear in logs.
- [ ] Real PostgreSQL suite isolates test schemas and requires an explicit `AUTH_API_TEST_DATABASE_URL`; skipped live tests are reported as unverified.

## 11. Definition of done

All requested auth/account routes are implemented, documented and tested against real PostgreSQL; migrations preserve existing users; logout immediately prevents subsequent session use; self-service operations cannot change another account or grant permissions; existing administrative/project APIs remain compatible. Project-enabled product access additionally requires A5. OAuth, refresh tokens, email verification, password reset and MFA remain separately tracked follow-up features.
