# Jest test plan — implemented user and authentication APIs

Prepared: 22 October 2026. Implementation update: the user/auth-only runner, isolated fixtures and pending endpoint/security/transaction cases are now implemented. See [execution results](USER_AUTH_JEST_RESULTS.md) for verified counts, coverage and commands. The baseline inventory below describes the starting point; checked cases now include the added suites. No new endpoints were added.

## 1. Scope

Primary endpoints:

| Method | Endpoint | Expected success |
| --- | --- | --- |
| POST | `/auth/register` | 201; public user and new session token |
| POST | `/auth/login` | 200; public user and new session token |
| POST | `/auth/logout` | 204; current session revoked |
| POST | `/auth/logout-all` | 204; all current-user sessions revoked |
| GET | `/auth/me` | 200; authenticated user's public profile |
| PUT | `/auth/me` | 200; partial profile/credential update |
| DELETE | `/auth/me` | 204; current account logically deleted |

Keep existing administrative `/users` CRUD regression tests because they share the User model and can change or delete login credentials. Normal user-session tokens must not gain administrative access.

Do not add search, browser, Temporal, research, report, swarm, OAuth, reset-password, MFA or email-verification tests in this work. Those features are outside this focused test delivery.

## 2. Starting Jest baseline

Jest, ts-jest, Nest testing utilities and Supertest are already declared in [package.json](../package.json). No second test framework or reinstallation of Jest is needed unless dependency installation is incomplete.

| File | Current coverage | Follow-up |
| --- | --- | --- |
| [auth.e2e-spec.ts](../test/auth.e2e-spec.ts) | 13 broad tests covering all auth endpoints, token storage, expiry, credentials, deletion, rollback, a logout-all race, request limits and cleanup | Preserve coverage; separate important failure cases so test names identify exactly what failed |
| [users.e2e-spec.ts](../test/users.e2e-spec.ts) | 5 administrative CRUD/auth/validation/concurrency/pagination tests | Keep as shared-user regression coverage; add only gaps affecting identity/session behavior |
| [password.spec.ts](../tests/auth/password.spec.ts) | 2 tests for scrypt verification, malformed hash rejection and concurrency bounds | Add targeted boundary cases if HTTP tests cannot isolate the behavior clearly |
| [jest-e2e.json](../test/jest-e2e.json) | Shared HTTP configuration matching every `.e2e-spec.ts` | Add a narrowly scoped entrypoint so this task cannot accidentally run unrelated suites |

These are pre-expansion counts. T0 reproduced all 20 starting tests (18 HTTP and 2 password tests) successfully. Expanded results are recorded separately; a skipped PostgreSQL suite is not a pass.

## 3. Test approach

Use three layers:

1. **HTTP contract tests:** real Nest controllers/guards/filter, Supertest, Prisma and PostgreSQL. Assert status, response fields, headers and subsequent API behavior.
2. **Persistence/concurrency assertions:** inspect session/user state through Prisma in the same isolated test schema. Use real transactions and controlled barriers for races; mock only a narrow failure boundary when deliberately testing rollback.
3. **Focused unit tests:** password verification, guard rejection and limiter behavior that are difficult or expensive to trigger through HTTP. Avoid duplicate tests that merely restate implementation code.

Keep the primary endpoint assertions in real PostgreSQL integration tests. Mocked Prisma calls cannot establish uniqueness, transaction rollback, row-lock coordination or cascading deletion.

## 4. Endpoint case checklist

`[x]` means the existing suite exercises the scenario, sometimes inside a broad test. `[ ]` means add explicit coverage or strengthen an existing assertion. These are coverage markers, not new test results.

### Register — POST `/auth/register`

- [x] Valid email/password creates user and returns 201.
- [x] Email is trimmed/lowercased and a generated user ID is returned.
- [x] Only public profile fields are exposed; password differs from stored hash.
- [x] Token format is valid; only its digest is persisted; `Cache-Control: no-store` is present.
- [x] Invalid email, short password, unknown role/tenant fields return 400.
- [x] Concurrent duplicate normalized emails yield one user and 201/409 responses.
- [x] Session persistence failure rolls back user creation.
- [x] Parameterize missing email/password, null fields, wrong JSON types, whitespace-only input and nested/array payloads.
- [x] Check password lengths 7/8/128/129 and email/name/avatar limits, preserving password whitespace semantics.
- [x] Cover optional name/avatar storage, nullable values and unsupported avatar schemes independently.
- [x] Assert conflicting registration creates no extra session and never changes the existing password/profile.
- [x] Assert error envelopes never echo passwords or token-like payload values.

### Login — POST `/auth/login`

- [x] Valid credentials create a session and return 200.
- [x] Wrong password, unknown email, passwordless, disabled and deleted users receive the same 401 error body.
- [x] A missing required credential returns 400.
- [x] Session count is bounded and oldest sessions are revoked.
- [x] Test email normalization on login explicitly, including surrounding whitespace and mixed case.
- [x] Parameterize invalid bodies, unknown fields and boundary lengths separately.
- [x] Assert a failed login creates zero new sessions and preserves the stored hash/profile.
- [x] Assert repeated successful logins return different raw tokens/digests with valid configured expiry.
- [x] Assert no password/session/provider secret appears in successful responses except the intentionally issued raw accessToken.
- [x] Exercise login while hashing capacity is exhausted; expect bounded 503 without a session insert.

### Logout — POST `/auth/logout`

- [x] Current session becomes invalid immediately; another session remains valid.
- [x] Repeated logout, missing token and unknown correctly formatted token return 204.
- [x] Explicitly assert empty response bodies and no-store headers.
- [x] Cover malformed, expired and already-revoked tokens independently.
- [x] Verify a supplied body/userId cannot revoke another user's session.
- [x] Simulate database failure for a known session: it must not be reported as successful revocation, and must not modify another session.

### Logout all — POST `/auth/logout-all`

- [x] A login paused after password verification is rejected after logout-all increments credential version.
- [x] Current session is invalid afterward; a fresh login remains possible.
- [x] Create two users and multiple sessions; assert all caller sessions are revoked while all other-user sessions remain valid.
- [x] Missing, malformed, expired and revoked credentials return 401.
- [x] Test concurrent logout-all requests: define/assert permitted 204/401 outcomes and final fully revoked state.
- [x] Force revocation failure and prove version/session changes roll back together.

### Get current user — GET `/auth/me`

- [x] Valid session returns exactly the public user shape.
- [x] Missing, malformed, expired, revoked, disabled/deleted and version-invalidated sessions are denied.
- [x] Auth user tokens do not authorize administrative user listing.
- [x] Two-user test proves the token selects its own profile, independent of body/query hints.
- [x] Assert updated profile data is visible on the next GET and timestamps serialize as valid ISO strings.
- [x] Check cache headers on both successful and rejected GET requests.
- [x] Assert no OAuth token, password hash, credential version, token digest or internal session field is returned.

### Update current user — PUT `/auth/me`

- [x] Name/avatar updates preserve sessions; omitted email remains unchanged; avatar null is supported.
- [x] Empty updates, currentPassword-only bodies, foreign ID/capabilities and invalid field values fail.
- [x] New password without current-password confirmation fails.
- [x] Duplicate email conflicts return 409 and preserve the original session.
- [x] Combined email/password change revokes sessions; old password fails and new credentials succeed.
- [x] Test name null, avatar replacement and each optional field independently.
- [x] Cover wrong/null/missing currentPassword for effective email/password changes.
- [x] Test unchanged normalized email without confirmation: profile sessions remain valid.
- [x] Split email-only and password-only changes; assert reauthenticationRequired and all-session invalidation independently.
- [x] Passwordless-account sensitive changes fail without modifying profile/session state.
- [x] Two-user test proves request body/query cannot change another account.
- [x] Race two credential updates verified against the same version; only a valid serialized update succeeds, with stale work rejected.
- [x] Force a write/revocation failure and prove the whole sensitive update rolls back.

### Delete current user — DELETE `/auth/me`

- [x] Wrong current password fails; a foreign userId field is rejected.
- [x] Successful DELETE marks deletedAt, invalidates session, denies login and leaves another user's session valid.
- [x] Deleted account's email remains reserved; registration returns 409.
- [x] Multiple-session deletion: assert every caller session is revoked, not merely the presented token.
- [x] Missing/malformed body and missing/expired/revoked session cases.
- [x] Repeated DELETE with the now-revoked token returns 401; no second mutation occurs.
- [x] Passwordless account cannot bypass confirmation.
- [x] Verify User/Account retention and unchanged unrelated users; do not introduce research tests to assert the account deletion contract.
- [x] Delete versus paused login and delete versus profile update races end with no usable session or account resurrection.
- [x] Inject revocation failure and assert deletedAt/version/session state rolls back.

## 5. Shared administrative user regression

Limit additions to the existing implemented `/users` endpoints:

- [x] Static admin bearer authentication, capability denial and CRUD success/not-found behavior.
- [x] Input validation, duplicate email concurrency, password hashing and secret-free responses.
- [x] Pagination and linked OAuth account cleanup on administrative deletion.
- [x] Admin password change revokes an end-user session; physical deletion removes sessions.
- [x] Add admin email-only change invalidation across multiple sessions.
- [x] Confirm admin profile-only updates preserve valid end-user sessions.
- [x] Assert ordinary user tokens fail GET/PUT/DELETE targeting another user through `/users/:id`.
- [x] Verify a failed admin email conflict leaves credentials and existing sessions unchanged.

Self-service DELETE is logical deletion; administrative DELETE is physical deletion. Tests must preserve this distinction rather than expect identical behavior.

## 6. Cross-cutting user/auth assertions

- [x] Disallowed origin and oversized Authorization header are rejected; request throttling returns 429 with Retry-After.
- [x] Bounded password hashing rejects excess concurrent work and releases capacity afterward.
- [x] Session cleanup removes sufficiently old records and preserves live sessions.
- [x] Test successful and failed responses for `Cache-Control: no-store` on every auth route.
- [x] Check correct HTTP CORS preflight/response headers in an app configured with the same CORS settings as production bootstrap. Current guard-origin tests alone do not establish middleware behavior.
- [x] Test account-based limits across different client-IP fixtures and IP limits across different email addresses; ensure bucket cleanup and the bucket cap bound memory.
- [x] Verify password verification preserves current scrypt format and rejects hostile parameters/invalid encodings without unbounded work.
- [x] Capture sanitized auth logs; confirm passwords, bearer strings, digests and OAuth secrets never appear.
- [x] Prove expiry checks do not rely on the cleanup job.
- [x] A PostgreSQL outage produces a safe server error, no fabricated authenticated user and no success claim for a failed write. Assert current API behavior; do not require a new error mapping without an explicit API change.

## Coverage-to-suite mapping

| Added coverage | Executable tests |
| --- | --- |
| Registration/login boundaries, normalization, uniqueness, capacity and secret-free logs | [auth-registration.e2e-spec.ts](../test/auth-registration.e2e-spec.ts) |
| GET isolation, field updates, confirmation, passwordless operations, deletion, rollback and races | [auth-profile.e2e-spec.ts](../test/auth-profile.e2e-spec.ts) |
| Logout variants, multi-session behavior, invalid credentials, cache/CORS, admin regression and actual unavailable PostgreSQL | [auth-sessions.e2e-spec.ts](../test/auth-sessions.e2e-spec.ts) |
| Account/IP rate limits, expiry, memory cap, origins, header limits and trusted session identities | [guard unit tests](../tests/auth/) |
| Password format, hostile parameters, salts and bounded hashing | [password.spec.ts](../tests/auth/password.spec.ts) |
| Missing/invalid/unreachable explicit test DB configuration | [test-runner.spec.ts](../tests/auth/test-runner.spec.ts) |

T0–T5 are implemented: baseline, scoped runner, endpoint cases, real transaction/race cases, security/admin regression, coverage and execution report. The layout/command specification below is retained as design context; actual files and measured results take precedence.

## 7. File and command plan

Keep the existing suites and extract shared fixtures without weakening real HTTP/database coverage:

```text
test/
  auth.e2e-spec.ts                   # Register/login/logout/session HTTP cases
  auth-profile.e2e-spec.ts           # Optional split once profile cases grow
  users.e2e-spec.ts                  # Existing administrative user regression
  helpers/user-api-test-app.ts       # Proposed isolated schema/app lifecycle
  jest-user-api.json                # Proposed focused HTTP suite selection
  run-user-api-tests.mjs             # Proposed preflight + focused suite runner
tests/auth/
  password.spec.ts                   # Existing password/capacity cases
  auth-request.guard.spec.ts         # Proposed focused limiter/origin boundaries
  auth-session.guard.spec.ts         # Proposed invalid-session boundaries
jest.user-api.config.ts              # Proposed scoped unit selection/coverage
```

Do not create empty test files or placeholder TODO cases merely to match this tree. Split only when a group is substantial; update suite selection whenever a real file is added.

Available commands:

| Command | Intended behavior |
| --- | --- |
| `npm run test:user-api` | Run focused unit + HTTP tests for auth/users only; require configured test PostgreSQL; fail if live tests cannot run |
| `npm run test:user-api:unit` | Run only auth/user unit tests without PostgreSQL |
| `npm run test:user-api:watch` | Watch scoped unit tests; no automatic destructive DB reset |
| `npm run test:user-api:cov` | Focused auth/user coverage, excluding unrelated backend modules |

Retain working existing commands:

```sh
npm run prisma:generate
npm run test:auth
npm run test:users
```

The existing integration commands require `AUTH_API_TEST_DATABASE_URL` and `USER_API_TEST_DATABASE_URL`, respectively. Without them the live suites skip. The implemented aggregate runner checks both variables before invoking Jest, checks connectivity, and fails on absent/unavailable PostgreSQL. Do not silently substitute the application's DATABASE_URL.

No new npm package is expected. Use the currently locked Jest/ts-jest/Supertest/Prisma versions and Node experimental-VM invocation already used by the repository.

## 8. Test-data and database safety

1. Use an explicitly configured PostgreSQL test database and a role allowed to create/drop temporary schemas.
2. Generate a fresh schema identifier per suite/run. Never use the application's public tables as test fixtures.
3. Apply the required committed migrations inside the isolated schema, set Prisma's schema URL, and retain real constraints and transactions.
4. Generate unique emails and synthetic credentials; never copy real accounts or production tokens into fixtures.
5. Isolate cases with factory-created users/sessions. Avoid assertions depending on earlier test order or global user counts.
6. Await every HTTP request and promise; always close Nest, Prisma and pg resources and clear timers/spies.
7. Teardown may drop only the schema identifier generated by that test run. Assert the expected prefix before destructive cleanup.
8. Coordinate races with promise barriers/latches instead of sleeps. Restore injected failures in `finally` blocks.
9. Freeze or control time only for expiry/limiter units; avoid globally faking timers around real PostgreSQL/hash operations.
10. Shared static configuration must reset after every test. Keep security-control tests independent of accumulated successful API traffic.

## 9. Phase-wise delivery checklist

| Phase | Deliverable | Exit condition |
| --- | --- | --- |
| T0 — baseline | Inventory current cases; run only existing auth/user/password suites | Actual pass/skip/failure counts recorded with test database availability |
| T1 — focused runner | Explicit test DB preflight, suite selection, scripts and shared safe fixtures | One command executes only user/auth tests; missing DB fails visibly; schemas clean up |
| T2 — core endpoint cases | Parameterized success/validation/auth cases for register/login/logout/GET/PUT/DELETE | Every primary endpoint has independent positive and negative cases with public response assertions |
| T3 — sessions and transactions | Expiry, multi-session revocation, password/email/delete races and rollback cases | Final database/session state is correct under real PostgreSQL concurrency |
| T4 — user regression and controls | Admin credential changes, permissions, limiter/origin/cache/log cases | Normal users cannot acquire admin authority; security controls remain explicit and testable |
| T5 — coverage and report | Focused coverage output, repeatability check and case-to-test mapping | No skipped required user/auth acceptance case; remaining gaps stated explicitly |

Run T0 first. Preserve existing passing tests, then add missing cases; do not rewrite all tests merely to change naming or duplicate implementation checks.

## 10. Completion requirements

- All seven implemented auth/self-service endpoints have readable Jest case names and clear HTTP/body/database assertions.
- Administrative user regression remains green without granting end-user tokens privileged access.
- Focused commands run user/auth tests only; database-required acceptance cannot silently skip.
- No unrelated backend service or browser is required to run this scoped suite.
- Concurrency/rollback tests use real PostgreSQL and clean up their isolated state.
- Coverage reports focus on auth/users and relevant guard/config paths. Set numerical thresholds from the measured baseline; percentages do not replace critical security cases.
- Record commands, runtime/database details, test counts, skips, failures and coverage gaps. If a planned case exposes a bug, report and fix it explicitly instead of weakening the assertion.
