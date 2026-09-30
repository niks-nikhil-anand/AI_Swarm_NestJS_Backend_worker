# Folder Wise Service Implementation Plan

Implement the scaffold in dependency order: foundations, search, browser lifecycle, controlled tools, workers, orchestration, agent execution, and production capabilities. Each step below identifies files to implement, dependencies and an acceptance gate.

Current implementation: PostgreSQL persistence, authenticated APIs, search and browser activities, Temporal workflows and Docker process wiring are implemented. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for verified checks and outstanding gates. Stagehand compatibility, the LLM agent and live container integration remain pending.

This plan uses the actual src/browser and src/search layout. It supersedes proposed src/modules paths in earlier design documents. The architecture principles in BROWSER_BACKEND_PLAN.md and WORKER_ARCHITECTURE_PLAN.md still apply.

## Execution rules

- Implement only the providers needed by the current step. Replace placeholders with working behavior before registering them.
- Keep HTTP API and worker execution in separate NestJS composition modules. An API controller must not start Chromium.
- Keep browser actions behind Browser Tool Layer validation, including internal agent calls.
- Workflows contain deterministic orchestration; network, database, model and browser effects are activities.
- Add meaningful tests for service behavior and failures. Pending tests do not establish capability.
- Mark a step complete only after its acceptance gate passes. Do not assume matching Playwright and Stagehand imports prove shared-session compatibility.

## Ordered delivery map

| Step | Folder or component                                | Depends on | Deliverable                                   |
| ---- | -------------------------------------------------- | ---------- | --------------------------------------------- |
| 1    | src/config                                         | None       | Validated process configuration               |
| 2    | src/common and src/security                        | 1          | Trusted execution context, errors and audit   |
| 3    | src/persistence, proposed                          | 1–2        | PostgreSQL repositories and migrations        |
| 4    | src/search/contracts, clients, mappers             | 1–2        | Working bounded SearXNG client                |
| 5    | src/search/services                                | 3–4        | Retry-safe persisted search execution         |
| 6    | src/browser/contracts and policies                 | 1–2        | Controlled browser API and policy boundary    |
| 7    | src/browser/chromium and services                  | 6          | Owned browser/context/tab lifecycle           |
| 8    | src/browser/adapters and scripts                   | 7          | Deterministic adapter and compatibility spike |
| 9    | src/browser/targets and tools                      | 6–8        | Validated tool dispatcher                     |
| 10   | src/artifacts                                      | 3, 7–9     | Authorized screenshots and file storage       |
| 11   | src/temporal and src/workers, proposed/existing    | 3, 5, 9    | Real separately runnable workers              |
| 12   | src/workflows and controllers                      | 11         | Authorized asynchronous search/browser APIs   |
| 13   | src/research, src/llm, src/browser/agent, proposed | 9–12       | Search-to-browser agent research pipeline     |
| 14   | src/health and src/jobs                            | 7, 10–12   | Readiness, cancellation and cleanup           |
| 15   | infrastructure and Docker                          | 11–14      | Real application worker containers            |
| 16   | tests and operational controls                     | Throughout | Verified milestone and production hardening   |

Search steps 4–5 and browser steps 6–9 can be developed independently after foundations. This is dependency guidance, not a requirement to run multiple agents.

## Step 1 Configuration

Files: src/config/configuration.ts, browser.config.ts, searxng.config.ts and security.config.ts.

1. Add application configuration loading and runtime validation.
2. Define database, Temporal, search endpoint, browser launch, budgets and storage options.
3. Set bounded defaults; distinguish host and container service addresses.
4. Validate secret references, ports, supported protocols and required values for each process.
5. Load only process-relevant configuration. A search worker should start without model credentials.

Gate: missing or invalid required configuration fails startup clearly; secret values are never logged.

## Step 2 Shared errors and security

Files: src/common/errors/_, common/types, common/logger, common/guards, common/interceptors and src/security/_.

1. Define trusted tenantId, userId, projectId, runId and requestId context.
2. Implement stable error codes, safe error mapping and retryability.
3. Implement authentication and project authorization; establish how the frontend supplies verified identity.
4. Add structured logging and audit events with credential/private-input redaction.
5. Add capabilities and policy snapshots. Page content and model output cannot change permissions.

Gate: unauthorized project access is rejected; audit events retain useful context without credentials. Do not expose new controller routes until authentication and authorization work.

## Step 3 PostgreSQL persistence

Add src/persistence/ with a NestJS module, repositories and migrations; choose one ORM. Prisma is a proposed option, not an installed integration.

1. Define ResearchRun, SearchRun, SearchQuery, SearchResult, SearchCandidate, BrowserRun, BrowserAction, Artifact, Approval and Evidence records.
2. Add ownership relations, required indexes and uniqueness constraints.
3. Implement run transitions and retry-safe upserts.
4. Handle API creation idempotency and the database-to-Temporal dispatch boundary using durable reconciliation.
5. Define retention and controlled artifact deletion.

Gate: migrations apply to the Compose database; duplicate deliveries do not duplicate results; tenant/project scoping is enforced in repository access.

## Step 4 SearXNG client and normalization

Files: src/search/contracts/search-request.ts, search-result.ts, search-response.ts; clients/searxng.client.ts; mappers/searxng.mapper.ts; common/errors/search.errors.ts.

1. Define validated bounded queries and allowed search options.
2. Request /search with format=json at the configured service endpoint.
3. Enforce timeout, cancellation, response-size limit, response validation and redirect restrictions.
4. Map results into title, original/canonical URL, snippet, engine, rank, query and retrieval time.
5. Deduplicate conservatively; preserve source provenance and meaningful query parameters.
6. Distinguish empty results, partial engine failures, rate limits, malformed responses and outages.

Gate: fixture and real JSON searches pass. Search snippets remain discovery metadata; they are not verified evidence.

## Step 5 Search execution service

Files: src/search/services/search.service.ts and search.module.ts. Add search-execution.service.ts, search-execution.module.ts, repositories/ and candidate-selection helpers under src/search.

1. Keep search.service.ts responsible for authorized run creation, dispatch and retrieval.
2. Use SearchExecutionService for worker-side querying, normalization and persistence.
3. Start with at most 3 queries, 10 results per query and 5 candidates; keep limits configurable.
4. Persist outcomes per query and select candidates with a documented deterministic score.
5. Retry transient failures with bounded backoff; support Retry-After and cancellation.
6. Return identifiers and warnings. Represent PARTIAL, NO_RESULTS, FAILED and CANCELLED distinctly.

Gate: retries produce stable records; all-query failure schedules no browser work; selected URLs trace to their query and engine.

## Step 6 Browser contracts and policies

Files: src/browser/contracts/* and src/browser/policies/*.

1. Define discriminated action inputs, result envelopes, target types, sessions and tabs.
2. Implement BrowserPolicyService as the validation entrypoint.
3. Implement domain, capability, network and resource policies.
4. Check ownership, allowed actions, destination, tab/target validity and budget.
5. Add mandatory checks to every dispatch route, including worker-internal actions.
6. Pair network checks with runtime egress controls before unrestricted public crawling.

Gate: invalid calls, cross-project targets and blocked destinations are rejected before SDK execution. Policies must cover redirects, popups and subsequent requests, not only initial URLs.

## Step 7 Chromium and session lifecycle

Files: src/browser/chromium/*; services/session-manager.service.ts, tab-manager.service.ts and browser-health.service.ts.

1. ChromiumService/launcher owns process creation and shutdown.
2. Connection code owns SDK attachment and reconnect limits.
3. SessionManager owns contexts, policy, budgets and lifecycle.
4. TabManager maps platform tab IDs to adapter handles and registers popups.
5. Create ephemeral contexts initially; keep cookies out of routine persistence.
6. Clean up on completion, failure, cancellation and shutdown.

Gate: open, navigate, create/close tabs and terminate resources on success and failure. Verify sessions cannot access each other's tab identifiers.

## Step 8 Adapters and compatibility spike

Files: src/browser/adapters/playwright/_, stagehand/_; scripts/browser-compatibility.ts; tests/browser/browser.compatibility.spec.ts.

1. Implement deterministic navigation, interaction, DOM observation and screenshot helpers.
2. Pin supported SDK/browser versions and keep them aligned with image dependencies.
3. Implement Stagehand semantic observation/extraction with registered schemas.
4. Prove both adapters see the same context/tab and updates.
5. Translate Stagehand targets into validated Playwright targets.
6. Verify lifecycle ownership and cleanup; record the tested configuration.

Gate: same-tab navigation, state visibility, target translation and teardown pass. If incompatible, resolve attachment or select a supported single-adapter path before agent work.

## Step 9 Target registry and browser tools

Files: src/browser/targets/_, src/browser/tools/_ and services/browser.service.ts.

1. Bind element references to session, tab and page revision.
2. Reject stale targets after navigation or relevant DOM changes.
3. Implement open, observe, click, type, scroll, extract, screenshot, tabs and wait.
4. Add go_back support through the navigation adapter/tool contract.
5. BrowserService dispatches through policy, tracks action IDs and records outcomes.
6. Serialize actions per tab and verify observable results; report uncertain effects separately.

Gate: all core tools work against fixtures with typed failures. A click result does not imply task completion.

## Step 10 Artifacts and file operations

Files: src/artifacts/_, storage/_ and contracts/artifact.ts; playwright-download.ts and playwright-screenshot.ts.

1. Define storage interface, artifact metadata and access checks.
2. Implement local storage for development and S3-compatible storage when configured.
3. Persist screenshots and return artifact IDs.
4. Add downloads: register listeners before triggers and persist before context closure.
5. Add uploads: resolve authorized artifact IDs, with size/type limits and path containment.
6. Bind deletion to retention and ownership; avoid deleting files still referenced by active runs.

Gate: files remain accessible after context closure; cross-project access and path traversal fail. Downloads/uploads beyond the public-research milestone are deferred until scoped capabilities exist.

## Step 11 Temporal and workers

Files: src/workers/searxng/_, browser/_ and orchestration/main.ts. Add src/temporal/ for client configuration, queue constants and dispatch.

1. Configure swarm-orchestration, swarm-search and swarm-browser queues.
2. Each worker creates a Nest application context and registers only its activities/providers.
3. SearXNG activity bindings delegate to SearchExecutionService.
4. Browser bindings delegate to the controlled browser execution service.
5. Orchestration registers deterministic workflow bundles.
6. Set per-worker concurrency, heartbeat, timeout, retry and shutdown behavior.

Gate: compiled entrypoints start and poll the intended queues; duplicate activity execution is safe. Search workers do not import browser SDKs or require browser/model configuration.

## Step 12 Workflows and controllers

Files: src/workflows/*; search/controllers/search.controller.ts; browser/controllers/browser.controller.ts; browser.module.ts; app.module.ts and main.ts.

1. Implement standalone search and browser workflow lifecycle.
2. Implement searchRun -> candidate selection -> browser task dependency flow.
3. Route activities to their respective queues.
4. Expose authorized create/status/results/cancel endpoints with validated DTOs and 202 responses.
5. Add project-scoped progress streams and approval resolution when required.
6. Compose only API providers into AppModule. Add BrowserExecutionModule to worker composition instead of registering browser lifecycle in the API.

Gate: HTTP returns run IDs promptly; worker progress appears in stored state; cancellation reaches in-flight work. Controllers never expose raw SDK operations, arbitrary JavaScript or CDP endpoints.

## Step 13 Agent and research integration

Add src/browser/agent/, src/llm/ and src/research/; reuse src/workflows/research.workflow.ts.

1. Define completion criteria and a structured LLM decision schema.
2. Implement observe -> decide -> validated tool -> observe -> verify.
3. Enforce budgets and detect repeated actions/no progress.
4. Connect selected search URLs to browser visits.
5. Validate extracted fields against source content and store evidence linked to SearchResult.
6. Return partial failures honestly and hand source-supported evidence to downstream research agents.

Gate: a research goal produces discovery results and visits 3–5 candidates, or fewer when fewer usable sources exist; evidence is traceable and the browser is cleaned up. Supplied URLs can bypass search while preserving destination checks.

## Step 14 Health and cleanup jobs

Files: src/health/_; src/jobs/cleanup/_; src/jobs/browser/browser-jobs.service.ts; scripts/browser-health.ts and cleanup.ts.

1. Separate HTTP liveness from dependency and worker readiness.
2. Check database, Temporal polling, SearXNG and browser readiness without launching a fresh browser for every health request.
3. BrowserJobsService schedules/reconciles browser runs; it is not a second job-queue implementation.
4. Add session cleanup using ownership/leases and stale thresholds.
5. Add artifact cleanup using retention and active-reference checks.
6. Run scheduled cleanup in one owner process or through coordinated leases.

Gate: unavailable dependencies affect readiness; cancelled/abandoned runs release resources; cleanup never terminates another worker's active session.

## Step 15 Docker and deployment structure

Files: root Dockerfile, infrastructure/docker/Dockerfile, infrastructure/chromium/Dockerfile, infrastructure/searxng/* and docker-compose.yml.

1. Root Dockerfile builds the NestJS API.
2. infrastructure/docker/Dockerfile builds browser-free orchestration/search worker targets.
3. infrastructure/chromium/Dockerfile builds the real browser worker with pinned SDKs and Chromium.
4. Migrate active SearXNG config from docker/searxng to infrastructure/searxng deliberately; update mounts and remove stale duplicates only after validation.
5. Replace the development health-only browser runtime with the actual worker service once implemented.
6. Add/configure Temporal and worker services, health checks, quotas and graceful stop settings.

Gate: clean image builds and full Compose startup pass; workers use container service addresses. Placeholder Dockerfiles remain unused until implemented; no privileged browser or public CDP port is introduced.

## Step 16 Verification and release gates

Folders: tests/browser, tests/search and tests/fixtures; add tests/workflows and tests/isolation when needed.

Replace pending tests with real cases: dynamic content, stale references, frames, popups, downloads, malformed search responses, rate limits, retries, worker crashes, cancellation and tenant isolation. Use controlled fixtures for repeatability and separate live-engine checks from deterministic CI checks.

First usable delivery: validated configuration + security + persistence + working standalone search worker/API. Next delivery: controlled deterministic browser worker/API. Combined milestone: search -> selected sources -> agent extraction -> source-supported evidence -> clean termination.

Authenticated workflows, approval persistence, registered scripts and advanced file transfer follow the public-research milestone. Production release additionally requires egress restrictions, tenant process/container isolation, resource quotas, retention, operational alerts and recovery validation.

## First implementation batch

Begin with steps 1–3 and then step 4: configuration, trusted context/errors, PostgreSQL integration, and SearXNG client/mapper. Confirm their gates before adding the search worker. Do not register every scaffold module in AppModule at once.
