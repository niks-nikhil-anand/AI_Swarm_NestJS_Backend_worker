# Authentication API

Implemented with Prisma/PostgreSQL sessions and salted scrypt password verification. The auth migration is `20261022000100_add_auth_sessions`. See [database setup](DATABASE_SETUP.md) before deploying migrations to an existing database; never reset populated tables.

## Routes

| Method | Path | Input | Success |
| --- | --- | --- | --- |
| POST | `/auth/register` | `email`, `password`, optional `name`, `avatar` | 201: public user, accessToken, tokenType, expiresAt |
| POST | `/auth/login` | `email`, `password` | 200: public user, accessToken, tokenType, expiresAt |
| POST | `/auth/logout` | Bearer token, no body | 204; current session revoked; repeated/unknown tokens are no-ops |
| POST | `/auth/logout-all` | Active bearer token, no body | 204; all sessions revoked |
| GET | `/auth/me` | Active bearer token | 200: current public user |
| PUT | `/auth/me` | Any of `name`, `avatar`, `email`, `newPassword`; `currentPassword` for sensitive changes | 200: `{ user, reauthenticationRequired }` |
| DELETE | `/auth/me` | `currentPassword` | 204; account deactivated and all sessions revoked |

Use `Authorization: Bearer <accessToken>` for protected requests. Public user fields are `id`, `email`, `name`, `avatar`, `createdAt`, `updatedAt`; password hashes, OAuth credentials and session digests are never returned.

`GET /users/:id` remains the separate administrative get-user API requiring a configured principal with the `users` capability. End-user tokens cannot list or manage other users and do not grant project/research access; persisted project membership integration remains separate work.

## Example requests

```sh
curl -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"person@example.com","password":"a-long-example-password","name":"Example User"}'

curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"person@example.com","password":"a-long-example-password"}'

# Set TOKEN to the accessToken from the response.
curl http://localhost:3000/auth/me -H "Authorization: Bearer $TOKEN"

curl -X PUT http://localhost:3000/auth/me \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Updated Name","avatar":null}'

curl -X POST http://localhost:3000/auth/logout -H "Authorization: Bearer $TOKEN"
```

Sensitive update body:

```json
{
  "email": "new-address@example.com",
  "newPassword": "a-different-long-password",
  "currentPassword": "a-long-example-password"
}
```

An email/password change requires the current password and invalidates **all** sessions, including the caller. Log in again afterward. Profile-only changes preserve sessions. PUT uses partial-update semantics: omitted fields stay unchanged; name/avatar can be cleared with null. Unknown fields and empty updates fail validation.

DELETE body: `{ "currentPassword": "..." }`. It logically deletes the current account; it does not instantly erase retained research/audit data. Its email remains reserved. Administrative DELETE continues to physically remove User/Account/session rows. Passwordless users require a future provider-based reauthentication flow for sensitive operations.

## Sessions and request controls

- Random prefixed bearer tokens; only SHA-256 digests stored in PostgreSQL.
- Absolute configurable expiry, immediate revocation, credential-version checks and bounded active sessions. Oldest sessions are revoked at the configured limit.
- Login, credential changes, logout and deletion coordinate through per-user database row locks. Password hashing happens outside open database transactions.
- Uniform invalid-credentials response for unknown, passwordless, deleted/disabled and incorrect-password accounts.
- Bounded scrypt concurrency and one-minute in-memory per-IP/per-email request limits. This limiter supports a single API instance; add a shared limiter before deploying replicas. Client IP forwarding is not trusted by default.
- No-store responses, exact allowed browser origins, and CORS for configured origins. Bearer clients keep tokens in memory; production requires HTTPS.
- Expired/revoked sessions older than seven days are cleaned up hourly. Access checks enforce expiry without waiting for cleanup.
- No refresh token, JWT signing secret, MFA, password reset, email verification or OAuth login is implied. Email is currently an unverified login identifier.

Configuration in `.env`:

```dotenv
AUTH_SESSION_TTL_SECONDS=86400
AUTH_MAX_ACTIVE_SESSIONS=5
AUTH_RATE_LIMIT=30
AUTH_HASH_CONCURRENCY=2
AUTH_ALLOWED_ORIGINS=http://localhost:5173
```

`AUTH_RATE_LIMIT` applies to auth requests, including protected routes, per 60-second window. Adjust it for your polling/UI usage. Allowed origins are exact origins without trailing slashes; leave empty for same-origin only. The API retains its existing `AUTH_CREDENTIALS` startup requirement for the separate administrative/project APIs. A locally generated server-held admin credential was added only when that configuration was missing; keep `.env` private.

## Errors

The existing `{ "error": { "code", "message", "retryable" } }` envelope applies. Important statuses: 400 validation/header failure, 401 invalid credentials/session/confirmation, 403 disallowed origin or privileges, 409 duplicate email, 429 rate limit with Retry-After, 503 hash-capacity limit. Concurrent revocation/credential changes may invalidate a previously authenticated request with 401.

Test expansion is scoped in the [user/auth Jest test plan](USER_AUTH_JEST_TEST_PLAN.md). The plan is now implemented; see [execution results](USER_AUTH_JEST_RESULTS.md).

Run the complete focused suite with `npm run test:user-api` or include coverage with `npm run test:user-api:cov`. These commands load `.env`, require both explicit test URLs, check PostgreSQL connectivity and fail instead of silently skipping integration tests. `npm run test:user-api:unit` requires no running database; `npm run test:user-api:watch` watches the scoped unit tests. The existing `test:auth`/`test:users` commands remain available for their original suites.

## Setup and verification

Only PostgreSQL is enabled in Compose; run the API on the host:

```sh
npm ci
npm run prisma:validate
npm run db:migrate
npm run build
npm run start:prod
```

For the auth and administrative user integration suites, set `AUTH_API_TEST_DATABASE_URL` and `USER_API_TEST_DATABASE_URL` to a PostgreSQL database whose test role can create schemas. Suites create unique schemas, execute migrations and remove schemas afterward. Without the corresponding environment variable, live tests are skipped.

```sh
npm run test:auth
npm run test:users
npm run test:e2e -- --runInBand
npm test -- --runInBand
```

Verified 22 October 2026: schema validation, client generation, build, TypeScript, ordinary lint, 21 HTTP integration tests and 23 unit/browser tests passed. Two pre-existing Stagehand tests remain TODO. Local application schema onboarding was backed up, reconciled and baselined without dropping data; the auth migration and repeated migration deployment passed. This does not establish live research/Temporal or Stagehand readiness.
