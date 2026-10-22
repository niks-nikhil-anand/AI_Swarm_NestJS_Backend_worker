| Tests                      | Unit, PGlite API e2e, real-Chromium integration (Linux image) and full Compose stack acceptance | Compatibility-matrix TODO; real-model run || Browser tools              | Deterministic navigation, inspection, interaction, waits, tabs, DOM extraction, screenshot; validated Stagehand observe/act; caller-schema extraction (Phase 3) | Real-model extraction quality || Persistence                | pg repositories, ordered SQL migrations (001 runs/evidence, 002 extractions), idempotency and ownership | Live PostgreSQL integration beyond the Compose verification || Tests                      | Unit, real-Chromium integration (Linux image) and full Compose stack acceptance | Compatibility-matrix TODO; real-model run || Agent                      | Sequential agent step runs (navigate, inspect, click, type, act, read) with persisted step log and evidence | LLM planning loop and evidence synthesis || Workflows/API              | Search, browser capture, agent step runs and research workflows; bounded activity retries; cancel API verified live | Research cancellation API || Browser tools              | Deterministic navigation, inspection, interaction, waits, tabs, DOM extraction, screenshot; validated Stagehand observe/act | Custom-schema extraction (deferred) || Adapter compatibility      | Stagehand 4.1.0 on each session's own Chromium; observe/act through a worker-side model provider (Phase 2) | Live verification with real Claude credentials |# Implementation status

This records the implementation delivered against SERVICE_IMPLEMENTATION_PLAN.md. Files that remain scaffolds are not counted as implemented services.

| Plan area                  | Delivered                                                                         | Remaining gate                                                  |
| -------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Configuration              | Process-specific validated settings, redacted startup errors                      | Deployment-specific secrets management                          |
| Errors/security            | Typed failures, bearer principals, project/capability enforcement                 | External identity provider and operational audit integration    |
| Persistence                | pg repositories, SQL migration, idempotency and ownership                         | Live PostgreSQL integration                                     |
| SearXNG                    | Bounded JSON client, retries, normalization and persisted candidates              | Live engine/provider integration                                |
| Search worker              | Temporal activities, heartbeat and recovery                                       | Live Temporal worker execution                                  |
| Browser contracts/policies | Typed controlled actions, domain/public-IP proxy, budgets, fresh references       | Production network isolation validation                         |
| Chromium/session lifecycle | One Chromium process and private profile per session, disconnect/crash cleanup, sandboxed in a Linux container | Live worker integration                            |
| Adapter compatibility      | Stagehand 4.1.0 attached to each session's own Chromium (opt-in, STAGEHAND_ENABLED) | Semantic act/observe/extract with model credentials (Phase 2) |
| Browser tools              | Deterministic navigation, observation, interaction, DOM extraction and screenshot | Semantic observation/extraction                                 |
| Artifacts                  | Local storage, checksums, scoped metadata/download                                | S3, upload and browser download policy                          |
| Browser worker             | Persisted capture activities and cleanup                                          | Live worker integration                                         |
| Workflows/API              | Search, browser and search-to-browser research workflows                          | Research cancellation API and operational failure scenarios     |
| Agent                      | Research goal accepted and deterministic source capture                           | LLM client, bounded agent loop and evidence synthesis           |
| Cleanup/health             | Session cleanup and API dependency readiness                                      | Artifact retention, worker health endpoints                     |
| Docker                     | API, migration, Temporal and three workers wired into engine profile              | Build/start checks with Docker                                  |
| Tests                      | SQL semantics, auth API, browser fixtures, policy and artifact tests, Stagehand session integration | Compatibility-matrix TODO and live stack tests |

## Database integration update — 22 October 2026

Prisma now models the existing run-domain tables as well as User/Account. An append-only run-domain baseline and dedicated migration Docker target are wired into Compose; all workers depend on migration completion. Research services still use pg repositories. Populated databases require reviewed onboarding in [DATABASE_SETUP.md](DATABASE_SETUP.md); do not run the new baseline blindly against legacy tables. Current validation results are recorded in the task completion note below the database setup guide.

## Verified locally

Nest build, full TypeScript checking, ordinary oxlint, Jest unit tests and HTTP end-to-end tests pass. Temporal workflow bundling is checked separately. Browser tests exercise real headless Chromium with local fixtures. Production dependency audit reported no vulnerabilities at the time of implementation.

Search restart recovery reconstructs warnings from persisted query outcomes. Proxy tests cover delayed upstream responses. Browser capture closes sessions in finally blocks, including initialization failures.

## Blockers and scope

Compose runtime behavior (`up`, live Temporal/PostgreSQL) remains unverified; `docker compose --profile engine config` validates. The Linux Chromium sandbox is verified for browser sessions in the containers described below.

The Playwright headless shell launches successfully on the Windows development host. Full Chromium fails there with spawn UNKNOWN (Windows reports a side-by-side configuration error), so Stagehand integration is verified in Linux containers only. No semantic compatibility or LLM agent readiness is claimed.

Approval records exist in the schema but no approval execution flow is enabled. Current actions deny sensitive submissions. execute_js, uploads, arbitrary browser downloads and authenticated state reuse remain deferred. Research output is captured source text with provenance, not verified claims or a generated final report.

## Browser runtime and Stagehand (Phase 1)

1. On a Docker-enabled machine, run docker compose --profile engine config, build and up; test migrations and health.
2. Exercise search, browser and research jobs against the live stack; interrupt workers to validate retries and cancellation.
3. Pass the full Chromium/Stagehand shared-session compatibility matrix with model credentials and extension support.
4. Add semantic observation/extraction and the bounded browser agent only after that gate passes.
5. Implement approval handling, artifact retention, S3 and worker observability before production rollout.

## Authentication update — 22 October 2026

Implemented `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/logout-all` and GET/PUT/DELETE `/auth/me`, Prisma AuthSession and user credential-state fields. Existing admin email/password updates revoke sessions. Local PostgreSQL application schema was backed up under `.data/backups/pre-auth-20261022.dump`, reconciled with the committed pre-auth migrations, baselined and upgraded with the additive auth migration; repeated deployment passed. No application tables or rows were dropped.

Build, schema/client generation, TypeScript, ordinary lint, 21 HTTP tests against isolated PostgreSQL schemas and 23 unit/browser tests passed. Two prior Stagehand TODOs remain. See [Auth API](AUTH_API.md). Project membership, OAuth/reset/verification/MFA and shared production throttling remain separate work.

## Focused user/auth Jest expansion — 22 October 2026

The user/auth-only test plan is implemented: 155 tests in 9 suites pass (130 real HTTP/PostgreSQL cases and 25 unit/runner cases), with no skips/TODOs. Scoped coverage is 98.72% lines and 88.51% branches, meeting the measured gates. Added explicit database preflight, isolated fixtures, validation/boundary cases, session/credential races, rollback injection, CORS/cache/logging controls and administrative user regression. Unrelated backend suites are excluded. See [execution results](USER_AUTH_JEST_RESULTS.md) and run `npm run test:user-api:cov` to reproduce.

## Swagger user/auth explorer — 22 October 2026

Installed the pinned NestJS 12-compatible `@nestjs/swagger` 12.0.2 package. `/docs` serves interactive documentation for the seven auth/self-service and five admin-user operations; `/docs-json` serves the spec. Zod-derived requests, public response schemas, examples, errors, pagination and separate user-session/admin-token schemes are documented. Authorization is not persisted in browser storage. The API is running locally for manual testing.

Seven Swagger tests and the existing focused regressions pass: 162 tests in 10 suites, no skips/TODOs, 98.75% line and 88.51% branch coverage. Build, TypeScript and scoped lint pass. See the [Swagger walkthrough](AUTH_API.md).
