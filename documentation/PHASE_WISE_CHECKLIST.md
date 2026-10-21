# AI Swarm: phase-wise implementation checklist

Audit date: 22 October 2026. Compared current source, module registrations, migrations, container definitions and test bodies against [the master plan](README.md) and its feature-flow image.

## Database implementation update

The subsequent database change adds Prisma models for the seven existing domain tables plus legacy migration history, a run-domain baseline migration, and a dedicated Compose Prisma migration target. All workers now depend on successful migration. User/Account packages and schema were preserved. Repository conversion, populated-database onboarding and live Docker/PostgreSQL acceptance remain pending. See [database setup](DATABASE_SETUP.md). The detailed original audit below describes the pre-change baseline.

## How to read this checklist

- `[x]` means implemented and connected in source, or a concrete test/harness exists as specifically stated. It does **not** mean the current build or deployment passed.
- `[ ]` means pending implementation, incomplete integration, or an unverified acceptance gate. Notes distinguish these cases.
- A scaffold, installed dependency, table or TODO test does not establish an executable feature.

This was a static source audit with environment checks. `node --version` returned `v26.8.1`; `node_modules` is absent. Docker CLI `29.8.2` is installed, but its daemon socket is unavailable. Build, type checking, lint, Jest, Chromium compatibility and live-stack runs were not executed. Earlier passing checks in [implementation status](IMPLEMENTATION_STATUS.md) remain historical evidence only. No application code was changed by this audit.

## Phase summary

| Master-plan phase | Current assessment | Main remaining gate |
| --- | --- | --- |
| 0. Reproduce baseline | Foundation code and fixture suites exist; current verification pending | Install locked dependencies and reproduce build, tests and live stack |
| 1. Execution and deployment gaps | Partially implemented | Research cancellation, worker readiness, audit integration, migration deployment and isolation verification |
| 2. Consolidate persistence | Prisma implemented for users/accounts only | Run-domain schema parity, repository conversion and one migration owner |
| 3. Bounded research agent | Deterministic browser foundation implemented | Goal-driven model decisions, agent loop, semantic extraction path and usage limits |
| 4. Verified reports | Source capture implemented | Claims, verification, contradictions, synthesis and report APIs |
| 5. Specialist swarm | Not implemented | Bounded task graph, role execution and coordinated recovery |
| 6. Product controls | Basic asynchronous APIs and administrative users implemented | Events, report access, approvals and cost/progress interfaces |
| 7. Production qualification | Some development safeguards implemented | Live isolation/recovery, storage lifecycle, identity, telemetry and deployment qualification |

No phase is marked fully accepted: every phase either has implementation gaps or lacks a reproduced runtime acceptance gate. A percentage would hide the difference between substantial foundation code and unimplemented reasoning features.

## Phase 0 — Reproduce and establish the baseline

Implemented foundations:

- [x] Separate HTTP API and search/browser/orchestration entrypoints: [AppModule](../src/app.module.ts), [workers](../src/workers/).
- [x] Process-aware configuration, bounded settings and redacted configuration failures: [configuration](../src/config/configuration.ts).
- [x] Server-configured bearer principals and project authorization: [project guard](../src/common/guards/project-access.guard.ts).
- [x] Persisted creation idempotency and conflicting-payload rejection: [run repository](../src/persistence/run.repository.ts).
- [x] Temporal start with stable workflow IDs, pending-dispatch reconciliation and failed/cancelled workflow reconciliation: [Temporal service](../src/temporal/temporal.service.ts), [dispatch](../src/temporal/dispatch.service.ts).
- [x] Search, browser and combined research workflow definitions: [workflows](../src/workflows/).
- [x] SearXNG timeout/size/response boundary, result normalization and conservative URL deduplication: [client](../src/search/clients/searxng.client.ts), [mapper](../src/search/mappers/searxng.mapper.ts).
- [x] Persisted per-query recovery, transactional query/result writes and deterministic reciprocal-rank candidate scoring: [search execution](../src/search/search-execution.service.ts).
- [x] Search result, browser action, evidence, artifact and approval SQL tables: [initial SQL](../src/persistence/migrations/001_initial.sql).
- [x] Real-browser fixture test code, PGlite persistence tests, search boundary tests and authorization/API tests exist: [tests](../tests/), [HTTP tests](../test/).
- [x] Dockerfiles and Compose definitions for the application processes exist: [Compose](../docker-compose.yml).

Pending verification:

- [ ] Install locked dependencies and record whether the chosen Node runtime is supported by the full pinned dependency set; container builds use Node 24.
- [ ] Re-run build/client generation, TypeScript, lint and Jest suites with complete output and skipped/TODO counts.
- [ ] Run browser fixtures with the matching browser binary.
- [ ] Start real PostgreSQL, SearXNG, Temporal, API and all workers; demonstrate standalone and combined runs.
- [ ] Demonstrate duplicate activity handling, interrupted-worker recovery and cancellation against live Temporal.
- [ ] Record current results and environment in `IMPLEMENTATION_STATUS.md`.

Acceptance: reproducible local/CI checks plus live runs, with explicit failures and environment details. Source existence alone cannot close this phase.

## Phase 1 — Close execution and deployment gaps

Implemented:

- [x] Search and browser creation/status/cancellation services: [search service](../src/search/services/search.service.ts), [browser runs](../src/browser/services/browser-runs.service.ts).
- [x] Research create/status API requiring search, browser and research capabilities: [research module](../src/research/research.module.ts).
- [x] Atomic nonterminal run transition guard prevents terminal-state overwrites: [run repository](../src/persistence/run.repository.ts).
- [x] Search/browser activity heartbeats and cancellation signals are passed to execution services: [search bindings](../src/workers/searxng/activity-bindings.ts), [browser bindings](../src/workers/browser/activity-bindings.ts).
- [x] Browser session cleanup in execution `finally`, initialization-failure cleanup and process-local expiry cleanup: [browser execution](../src/browser/browser-execution.service.ts), [sessions](../src/browser/services/session-manager.service.ts), [cleanup job](../src/jobs/cleanup/session-cleanup.job.ts).
- [x] API liveness and dependency readiness for PostgreSQL, Temporal and SearXNG: [health controller](../src/health/health.controller.ts).
- [x] Worker concurrency limits and separate queue registration exist: [worker entrypoints](../src/workers/).
- [x] API enables Nest shutdown hooks; worker entrypoints close connection/application in `finally`.
- [x] Browser action outcomes persist sequence, kind, status, duration and error metadata.

Pending implementation/integration:

- [ ] Add a research cancellation endpoint and propagate cancellation through both discovery and capture.
- [ ] Make cancellation delivery durable: current search/browser services swallow Temporal cancellation errors and have no dedicated retry record for the failed cancel request.
- [ ] Handle dispatch/cancel races; verify a workflow started during cancellation cannot continue unbounded after its database run becomes terminal.
- [ ] Add worker polling/readiness signals. API Temporal connectivity does not prove a worker is consuming its queue.
- [ ] Make shutdown behavior explicit for worker Nest contexts and verify SIGTERM cleanup. API shutdown hooks are enabled; worker contexts do not explicitly enable them.
- [ ] Add externally coordinated abandoned-browser cleanup/leases. Current reaper only sees the owning process's in-memory sessions.
- [ ] Integrate audit emission. [AuditService](../src/common/logger/audit.service.ts) is exported but no `record()` execution call sites were found. Persisted browser outcome metadata is narrower than the planned full audit trail.
- [ ] Add a dedicated Prisma migration deployment path for users/accounts; current Compose migration command runs legacy SQL only.
- [ ] Order all database-dependent startup appropriately; orchestration currently depends on Temporal alone in Compose.

Pending acceptance:

- [ ] Test cancellation during retry backoff, page load, extraction and pending dispatch, including late completions and worker interruption.
- [ ] Validate Linux Chromium sandbox, public-IP policy, redirect/subrequest blocking and container egress isolation on a live deployment.
- [ ] Verify fresh deployment creates both run-domain and identity tables, and populated-database onboarding preserves existing data.

Acceptance: cancellation releases resources and is eventually delivered; runtime readiness and audit are observable; database startup is reproducible.

## Phase 2 — Consolidate persistence with Prisma

Detailed design and DB0–DB8 gates: [PostgreSQL, Prisma and schema plan](POSTGRES_PRISMA_SCHEMA_PLAN.md).

Implemented:

- [x] Prisma packages pinned and client generated before build: [package scripts](../package.json).
- [x] Prisma CLI config and generated-client configuration: [config](../prisma7.config.ts), [schema](../prisma/schema.prisma).
- [x] Nest Prisma provider using the PostgreSQL adapter, bounded pool/timeouts and shutdown disconnect: [provider](../src/persistence/prisma.service.ts).
- [x] User/Account schema and migrations, including unique email, provider identity and account cascade deletion: [Prisma migrations](../prisma/migrations/).
- [x] User CRUD uses Prisma with explicit public response fields and typed duplicate/not-found mapping: [users service](../src/users/users.service.ts).
- [x] Legacy run-domain `pg` repositories preserve scoped reads, idempotency and guarded transitions.

Pending:

- [ ] Introspect the existing run-domain schema against disposable PostgreSQL and model exact table/constraint parity.
- [ ] Add mapped Run, SearchQuery, SearchResult, BrowserAction, Artifact, Evidence, Approval and legacy migration-history models.
- [ ] Create and review a baseline for existing run-domain tables without replaying creation against populated databases.
- [ ] Define safe coexistence/onboarding with the already-existing User/Account Prisma migration history.
- [ ] Convert RunRepository and SQL in search, browser, artifact and health code behind stable service contracts.
- [ ] Preserve JSON-null behavior, numeric result ranking, timestamp semantics, BigInt API boundaries and transaction atomicity.
- [ ] Enforce source-evidence ownership/linkage explicitly. `saveEvidence()` accepts a source ID without a scoped source lookup; current browser flow passes discovered IDs, but the repository does not enforce the stronger plan invariant itself.
- [ ] Establish total connection budgets while pg and Prisma coexist.
- [ ] Add dedicated migration image/job with required CLI, schema/config and migrations; current runtime worker image omits Prisma CLI dev dependencies and Prisma migration files.
- [ ] Transfer run-domain migration ownership only after parity and onboarding gates pass; then retire the legacy runner as an active deployment path.
- [ ] Prove fresh migration, populated onboarding, drift rejection, repeated deployment, concurrent writes and restore behavior against real PostgreSQL.

Acceptance: all intended callers use the chosen persistence path without changing public behavior, with one documented migration owner after cutover. Installing Prisma for users does not complete this phase.

## Phase 3 — One bounded, goal-driven research agent

Implemented browser/search foundation:

- [x] Combined workflow schedules discovery then capture: [research workflow](../src/workflows/research.workflow.ts).
- [x] Goal is accepted/persisted, while queries are supplied by the caller.
- [x] Browser service validates typed actions, ownership, capabilities and resource budgets before dispatch: [dispatcher](../src/browser/services/browser.service.ts).
- [x] Core tools: open, observe, click, type, scroll, fixed article extraction, screenshot, new/list/close tabs, back and bounded waits: [action contract](../src/browser/contracts/browser-action.ts).
- [x] Target references bind to session/tab/page revision; actions serialize per session.
- [x] Browser session owns a Chromium process/context, tab registry and public-IP egress proxy.
- [x] Exact-domain checks cover routed requests; non-GET/HEAD requests, WebSockets and browser downloads are blocked; service workers are disabled: [sessions](../src/browser/services/session-manager.service.ts).
- [x] Configured action/tab/time budgets exist: [browser configuration](../src/config/browser.config.ts).
- [x] Fixed article schema validates URL/title/text; captured text is bounded to 20,000 characters: [Playwright adapter](../src/browser/adapters/playwright/playwright.adapter.ts).
- [x] Stagehand connection/observe/extract wrappers and a shared-browser compatibility harness exist: [Stagehand adapters](../src/browser/adapters/stagehand/), [harness](../scripts/browser-compatibility.ts).

Pending:

- [ ] Implement a model-provider abstraction with structured decision schemas, timeouts and bounded retries.
- [ ] Turn the goal into explicit completion criteria and bounded query/source plans.
- [ ] Implement observe → decide → validate → execute → re-observe → verify, with completion/no-progress detection.
- [ ] Persist AgentStep/ModelCall checkpoints and usage, prompt/schema/model versions and sanitized outcomes.
- [ ] Add total run-level token/cost/model-call/recovery limits. Existing browser budgets do not cover model or swarm spending.
- [ ] Integrate semantic extraction or explicitly choose a Playwright-only agent path. Stagehand is not registered in active BrowserModule.
- [ ] Pass Stagehand shared-context, stable tab identity, semantic observe/extract, target translation and cleanup checks before enabling it.
- [ ] Replace both Stagehand/compatibility TODO tests. The standalone harness explicitly excludes semantic model tests and currently matches a tab by URL rather than proving the full proposed registry identity contract.
- [ ] Add task-specific registered extraction schemas; current extraction accepts only `schemaId: article`.
- [ ] Add supplied-URL input to research if required. Only standalone browser runs accept URLs today.
- [ ] Add explicit switch-tab semantics if needed by the public contract; current tools target tab IDs directly but have no `switch_tab` action.
- [ ] Verify extracted fields against source excerpts beyond basic shape validation/nonempty text.
- [ ] Test prompt injection, malformed model output, repeated actions, budget exhaustion and restart re-observation.

Acceptance: a goal drives bounded decisions and produces source-supported structured evidence on representative tasks. Today the research goal does not influence the execution logic; the browser worker performs open/extract and optional screenshot for each URL.

## Phase 4 — Evidence-backed, verified reports

Implemented prerequisites:

- [x] Evidence captures requested/final URL, title, text, retrieval timestamp, extraction/schema labels and optional screenshot artifact reference: [browser execution](../src/browser/browser-execution.service.ts).
- [x] Evidence can reference its discovered search result; evidence writes deduplicate by run/URL.
- [x] Browser output distinguishes success, partial source failure and total failure.

Pending:

- [ ] Persist source/capture versions suitable for report reproduction and evidence review.
- [ ] Define Claim, ClaimEvidence and ResearchReport schemas and versioning.
- [ ] Add analyst extraction of candidate claims and cross-source comparisons.
- [ ] Verify excerpt support independently and distinguish supported, contradicted and insufficient-evidence claims.
- [ ] Identify source independence and conflicting evidence rather than counting agreement alone.
- [ ] Generate reports only from supported claims, with explicit limitations and unresolved questions.
- [ ] Render citations back to authorized evidence and artifacts; add report retrieval/export.
- [ ] Preserve discovery warnings through final research output. Current browser output returns its own warnings, and the research workflow does not merge search warnings into that final result.
- [ ] Add claim-support, citation-accuracy, contradiction and partial-completion evaluations.

Acceptance: each asserted factual report claim links to an accessible supporting excerpt, and source failures/contradictions remain visible. Current `verification: captured-source-text` is a provenance label, not fact checking.

## Phase 5 — Specialist swarm execution

Implemented prerequisites:

- [x] Search and browser are distinct worker responsibilities with durable workflow scheduling.
- [x] Separate queues and activity contracts provide a base for future specialization.

Pending:

- [ ] Planner, analyst, verifier, writer and supervisor implementations. Multiple worker processes do not constitute reasoning agents.
- [ ] Task/TaskDependency records with explicit role inputs/outputs and trusted inherited ownership.
- [ ] Bounded acyclic task graph, total task/depth limits and deterministic logical task identities.
- [ ] Controlled parallel role execution and explicit dependency joins.
- [ ] Shared, project-scoped evidence references and structured task results.
- [ ] Global budget reservation/reconciliation across parallel model calls.
- [ ] Supervisor retry/replan/stop decisions with no privilege escalation or unbounded spawning.
- [ ] Checkpoint recovery, deduplicated result writes and honest partial output after specialist failure.
- [ ] Compare swarm quality, latency and cost with the single-agent baseline using identical tasks/budgets.

Acceptance: specialist coordination improves measured quality or latency at an agreed cost and survives partial failure without losing provenance.

## Phase 6 — Product controls and user experience

Implemented:

- [x] Asynchronous create/status APIs for search, browser and research.
- [x] Search results pagination, search/browser cancellation and scoped artifact retrieval.
- [x] User CRUD/list API with scrypt password hashing, global `users` capability and secret-free responses: [users](../src/users/), [API reference](USER_API.md).
- [x] OAuth provider/account records and database relations exist; no OAuth login flow is implied.
- [x] Approval table exists; sensitive submissions remain blocked.

Pending:

- [ ] Project-scoped SSE/progress subscriptions with reconnect/replay behavior.
- [ ] Stage/task-level progress and durable event history.
- [ ] Report list/detail/version/export endpoints and user-facing citation inspection.
- [ ] Cost/token/budget exposure and clear failure/partial-result display.
- [ ] Approval creation/resolution, authorization, expiry, exact payload/policy binding and one-time consumption.
- [ ] Approval wait/resume that releases browser resources and re-observes after resumption.
- [ ] Frontend research submission, progress, evidence, reports and approvals screens; this repository currently supplies backend code.
- [ ] End-user signup/login/OAuth and project membership lifecycle if included in product scope. Administrative user CRUD is not authentication.
- [ ] Test unauthorized event/report/approval access, stale decisions and reconnect consistency.

Acceptance: users can follow, inspect, cancel and safely resume authorized research without losing the source/cost trail.

## Phase 7 — Production qualification

Implemented safeguards/configuration:

- [x] Local artifact write/read/delete, bounded size, checksum metadata and project-scoped retrieval: [artifact service](../src/artifacts/artifact.service.ts), [local storage](../src/artifacts/storage/local.storage.ts).
- [x] Local object cleanup after metadata-insert failure.
- [x] Development Compose volumes, loopback published ports, unprivileged application container users and browser seccomp settings.
- [x] Per-session browser process/context ownership and code-level destination/resource policies.
- [x] API dependency readiness and safe error envelopes provide an operational foundation.

Pending:

- [ ] Implement S3 storage, retention and reference-safe artifact cleanup. These files are scaffolds today.
- [ ] Add authorized uploads and browser download policies/listeners only when scoped capabilities are ready. Existing artifact retrieval is not browser download automation.
- [ ] External identity, tenant/project lifecycle and deployment secret management.
- [ ] Enforce and verify production container/network isolation, including private/metadata addresses, redirects, popups, DNS rebinding and subrequests.
- [ ] Add distributed quotas/admission control and resource limits based on measured Chromium capacity.
- [ ] Worker readiness, correlated metrics/traces, model usage/cost dashboards and operational alerts.
- [ ] Immutable infrastructure image selection and production Temporal configuration; current `start-dev` server is development infrastructure.
- [ ] Automated CI build, fixture, PostgreSQL migration, live-stack and security/evaluation gates; no `.github` CI workflow directory was found.
- [ ] Database/object-store backup, tested restore, retention/privacy policies and staged deployment/rollback runbooks.
- [ ] Load/soak tests, browser leak checks, provider outages, worker kill/restart and queue recovery.
- [ ] Set numerical quality, latency, cancellation, resource and cost release thresholds from measurements.

Acceptance: a recorded release qualification demonstrates isolation, bounded costs, recoverability, observability and data restoration under expected load.

## Scaffold and test inventory that affects completion claims

| Files/components | Actual status | Interpretation |
| --- | --- | --- |
| `src/artifacts/storage/s3.storage.ts`, `upload.service.ts`, `download.service.ts` | Empty exports with scaffold comments | S3 and browser file transfer pending |
| `src/jobs/cleanup/artifact-cleanup.job.ts`, `src/jobs/browser/browser-jobs.service.ts` | Scaffolds | Artifact retention and proposed job helper pending; Temporal dispatch exists elsewhere |
| `src/health/browser.health.ts`, `searxng.health.ts`, `scripts/browser-health.ts`, `scripts/cleanup.ts` | Scaffolds | Do not count these as health/cleanup features; API readiness and session expiry are implemented elsewhere |
| `src/browser/chromium/chromium.connection.ts` | Scaffold | Dedicated connection abstraction pending; active Chromium creation exists in ChromiumService |
| `src/browser/adapters/playwright/playwright-navigation.ts`, `playwright-interaction.ts`, `playwright-observation.ts`, `playwright-screenshot.ts` | Scaffolds | These helper files are unused placeholders; corresponding core operations exist in active tool files/dispatcher |
| `src/browser/adapters/playwright/playwright-download.ts` | Scaffold | Browser downloads pending |
| `tests/browser/stagehand.spec.ts`, `browser.compatibility.spec.ts` | `test.todo()` only | No passing semantic compatibility evidence |
| `test/users.e2e-spec.ts` | Real PostgreSQL suite gated by `USER_API_TEST_DATABASE_URL` | Skipped without explicit database configuration; not verified in this audit |

## Test coverage: present versus still needed

| Area | Concrete test code present | Remaining acceptance coverage |
| --- | --- | --- |
| Configuration/access | Role settings, invalid endpoint/limit rejection, token/project denial | End-to-end isolation for all run types and future report/event/approval routes |
| Search boundary | Encoding, response validation, 429/Retry-After, malformed/oversized responses and URL normalization | Live SearXNG, provider outages and cancellation across retries |
| Persistence | PGlite idempotency/conflict, ownership, duplicate delivery, terminal protection and warning recovery | Real PostgreSQL concurrency, transaction rollback, migration parity, drift and restore |
| Browser | Real-browser fixture interactions, stale references, ownership/cleanup, target scoping and proxy response behavior | Full dynamic/frame/popup matrix, live Linux isolation, interruption and browser execution persistence |
| User API | Real-PostgreSQL CRUD/auth/validation/pagination/concurrency/password/account-cleanup suite | Execute against configured test database and include in release evidence |
| Workflows/agent/reports | Workflow code exists; no dedicated workflow/agent/report suite found | Temporal integration/replay/cancellation, model-loop failures, claim/citation evals and swarm comparison |

## Recommended implementation order

1. Reproduce the baseline with locked dependencies and a working Docker daemon; publish results without upgrading historical claims automatically.
2. Close research cancellation, reliable cancellation delivery, worker readiness/shutdown and audit integration gaps.
3. Make both existing migration paths explicit in deployment, then carry out the reviewed run-domain Prisma adoption as a separate change.
4. Choose and validate the browser semantic path; implement one bounded model-driven agent and usage accounting.
5. Add claim verification, report synthesis and citation-quality evaluations.
6. Add specialist coordination only after the single-agent quality/cost baseline exists.
7. Finish progress/approval interfaces and production storage/isolation/operations gates before release.

Keep this checklist synchronized with executable changes and acceptance evidence. Check implementation items when wired behavior exists, and check verification gates only after recording the relevant result.
