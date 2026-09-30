# AI Swarm Search and Browser Worker Plan

This plan extends the browser backend architecture with a dedicated SearXNG worker. Search discovers candidate URLs; browser execution visits selected sources and captures evidence. NestJS composes application services, and Temporal orchestrates separately deployable worker processes.

Status: planning only. The repository currently has a NestJS starter and Docker definitions for PostgreSQL, SearXNG and a Chromium/Playwright/Stagehand development runtime. Temporal, application workers, persistence integration and agent execution are not implemented. The attached browser plan is design input, not evidence of an existing backend implementation.

## Architecture and process boundaries

```text
Frontend -> NestJS API -> persisted ResearchRun -> Temporal
                            |
                      research workflow
                            |
                  swarm-search task queue
                            |
               NestJS SearXNG worker
                            |
                HTTP -> SearXNG engine
                            |
               PostgreSQL search results
                            |
                   3–5 candidate URLs
                            |
                  swarm-browser task queue
                            |
                NestJS browser worker
                            |
                 Browser Agent + LLM
                            |
                  Browser Tool Layer
                            |
                Playwright / Stagehand
                            |
                      Chromium
                            |
              Evidence + Artifact Store
                            |
                research/report pipeline
```

The SearXNG worker is an application process, not a modification to the SearXNG engine. It needs no Chromium, Playwright, Stagehand, or model credentials. Browser workers need browser dependencies but cannot bypass the tool layer. HTTP handlers authorize and enqueue; they do not execute searches or launch browsers.

## Repository folder structure

Use the existing single NestJS repository with multiple explicit process entrypoints. Avoid creating a second monorepo layout until independent packages are needed.

```text
src/
  main.ts                         # HTTP API entrypoint
  app.module.ts                   # API-only composition
  common/
    config/
    contracts/                    # Serializable worker inputs and outputs
    errors/
    telemetry/
  modules/
    auth/
    research/
    search/
      dto/
      contracts/
      search.controller.ts        # Create/status/results/cancel endpoints
      search.service.ts           # Authorized run creation and dispatch
      search.module.ts            # API composition; no worker bootstrap
      search-execution.module.ts  # Worker providers; no HTTP controllers
      search-execution.service.ts # Query -> validate -> normalize -> persist
      searxng/
        searxng.client.ts          # Fixed service URL; bounded HTTP requests
        searxng-response.schema.ts
      normalization/
        normalize-results.ts
        canonicalize-url.ts
        rank-candidates.ts
      repositories/
        search-run.repository.ts
        search-result.repository.ts
    browser-runs/
    browser-agent/
    browser-tools/
      contracts/
      policy/
      scripts/
      browser-tools.service.ts
    browser-sessions/
      session-manager.service.ts
      tab-registry.service.ts
      target-registry.service.ts
      adapters/
        playwright.adapter.ts
        stagehand.adapter.ts
    llm/
    evidence/
    artifacts/
    approvals/
    persistence/
    temporal/
      temporal-client.module.ts
      task-queues.ts
      workflow-dispatch.service.ts
  workflows/
    research.workflow.ts          # Pure orchestration across queues
    search.workflow.ts            # Standalone search-run lifecycle
    browser.workflow.ts           # Standalone browser-run lifecycle
  workers/
    orchestration/
      main.ts                     # Polls swarm-orchestration
    searxng/
      main.ts                     # Polls swarm-search
      searxng-worker.module.ts     # Nest application context, no HTTP server
      activities.ts               # Delegates to SearchExecutionService
      activity-bindings.ts
    browser/
      main.ts                     # Polls swarm-browser
      browser-worker.module.ts
      activities.ts
      activity-bindings.ts
  health/
    worker-readiness.ts
test/
  fixtures/
    searxng/
    browser/
  search/
  browser/
  workflows/
  isolation/
docker/
  searxng/
    settings.yml                  # Existing search engine config
  browser/                        # Existing development SDK runtime
    Dockerfile
    package.json
    package-lock.json
    runtime.mjs
    smoke.mjs
    healthcheck.mjs
    seccomp_profile.json
  workers/                        # Proposed application worker images
    searxng.Dockerfile
    orchestration.Dockerfile
documentation/
  BROWSER_BACKEND_PLAN.md
  WORKER_ARCHITECTURE_PLAN.md
```

These are proposed paths. Do not generate empty placeholder modules merely to match the tree.

API modules expose controllers and workflow dispatch. Execution modules expose services needed by workers. Worker entrypoints create Nest application contexts and Temporal workers; they do not start public HTTP servers. Define build outputs and workflow bundling explicitly when adding start:worker:* scripts, and verify every entrypoint exists in the compiled output.

## Queue ownership and execution

| Queue | Worker | Registered responsibilities |
| --- | --- | --- |
| swarm-orchestration | Orchestration worker | Research, standalone search and standalone browser workflows |
| swarm-search | SearXNG worker | executeSearch activity |
| swarm-browser | Browser worker | executeBrowserTask activity |

Initial choice: workflows run on the orchestration queue, and specify the appropriate taskQueue for each activity. The search worker does not need to register workflows. This keeps ownership unambiguous; child workflows are optional later.

Temporal workflow code imports only deterministic helpers, types and Temporal workflow APIs. It does not import NestJS providers, database clients, HTTP clients or browser SDKs. Activity bindings resolve execution services from the owning Nest application context.

Search concurrency and per-instance request rate are separate configurable limits. Browser concurrency is capped by available memory and browser-process capacity. Do not add BullMQ/Redis as another job queue for this initial design.

## Search execution contract

Proposed activity input:

```ts
type SearchJob = {
  researchRunId: string;
  searchRunId: string;
  projectId: string;
  tenantId: string;
  queries: string[];
  options: {
    language?: string;
    categories?: string[];
    safeSearch: 0 | 1 | 2;
    maxResultsPerQuery: number;
    maxCandidates: number;
  };
  policyVersion: string;
};
```

Ownership fields come from the authorized API and persisted run, never from model-generated identity. Revalidate run ownership, state and policy before executing. Activity results return searchRunId, candidateResultIds, counts and warnings; the browser activity resolves selected results within the same project.

Suggested initial defaults: at most 3 queries, 10 results per query, 5 browser candidates, 15-second HTTP timeout, 30-second Temporal activity timeout, 3 total attempts and 2 concurrent requests per worker. These are proposed tuning values. Request cancellation aborts fetches, and activity heartbeats report completed query progress.

Normalize every result into queryId, requested query, title, original URL, conservative canonical URL, snippet, engine names, original ranks and retrievedAt. Search snippets are discovery metadata, not verified browser evidence.

## SearXNG client and search pipeline

1. Validate bounded query strings and whitelisted options.
2. Call the configured SEARXNG_URL with /search and format=json, using URLSearchParams.
3. Reject untrusted service URLs, unexpected redirects, oversized payloads and malformed JSON.
4. Validate response structure and safely normalize optional fields.
5. Filter candidate URLs to supported public HTTP/HTTPS destinations according to task policy.
6. Deduplicate conservatively, preserving original URLs and all contributing query/engine provenance.
7. Rank using a documented deterministic method; select 3–5 candidates.
8. Persist query outcomes, normalized results and candidate selection.
9. Return identifiers and explicit warnings to the workflow.

Do not strip arbitrary query parameters: they can change source meaning. Remove fragments and only known tracking parameters, normalize host/default ports, and keep the original URL. Preserve source ranking and explain the selection score.

For MVP, store each query separately and let orchestration aggregate successful query results. Retry network failures, 429 and transient 5xx with bounded backoff and Retry-After where appropriate. Do not retry invalid arguments, permanent policy failures or invalid configuration. Model an empty successful response separately from an outage.

Partial query failures can produce PARTIAL status with explicit warnings. If every query fails, the run fails and no browser task is scheduled. A successful empty search produces NO_RESULTS. Explicit user-provided URLs may bypass discovery but must still pass browser destination policy.

## Persistence and lifecycle

| Entity | Proposed stored data |
| --- | --- |
| ResearchRun | Goal, owner/project, workflow ID, stage status and task policy |
| SearchRun | Owner/project, input snapshot, limits, status, timestamps and warning summary |
| SearchQuery | Query index/text/options, attempts, timestamps, outcome and engine errors |
| SearchResult | Query linkage, original/canonical URL, title, snippet, engines and source rank |
| SearchCandidate | Run-scoped selection, score, rationale and selected result reference |
| BrowserRun | Parent research/search linkage, selected sources, status and budgets |
| BrowserEvidence | Search-result linkage, requested/final URL, excerpts, schema and artifact IDs |

Search states: QUEUED, RUNNING, COMPLETED, PARTIAL, NO_RESULTS, FAILED and CANCELLED. Persist transitions consistently and prevent terminal state regression during duplicate deliveries.

Use unique keys such as searchRunId plus queryIndex, and queryId plus canonicalUrl for retry-safe writes. A tenant-scoped request idempotency key deduplicates API creation. Temporal activities can execute more than once; reconcile completed query records and upsert results rather than appending duplicates.

Use durable dispatch/reconciliation for the database-to-Temporal boundary. Cancellation goes through the owning workflow, stops scheduled work and propagates to in-flight requests. Search deletion and retention are project-scoped.

## API proposal

- POST /projects/:projectId/research-runs: goal, bounded search options and optional supplied URLs.
- GET /projects/:projectId/research-runs/:runId: stage status and result summary.
- POST /projects/:projectId/search-runs: standalone discovery task.
- GET /projects/:projectId/search-runs/:runId: status, query outcomes and warnings.
- GET /projects/:projectId/search-runs/:runId/results: paginated normalized results.
- POST /projects/:projectId/search-runs/:runId/cancel: cancellation request.

Authorize every route and SSE subscription. Return 202 with a server-assigned run identifier for creation. Users do not supply arbitrary SearXNG endpoints or Temporal queue names.

## Docker and configuration plan

Keep the existing postgres and searxng services. Keep browser-runtime as a development dependency/Chromium smoke harness until a real browser-worker image replaces it.

Proposed additions when worker code exists:

- temporal: a local development Temporal service, or a configured external Temporal endpoint.
- orchestration-worker: application workflow bundle and Temporal worker bootstrap.
- searxng-worker: Node/NestJS execution image without browser binaries.
- browser-worker: compiled NestJS worker plus Chromium, Playwright and Stagehand.

Do not add idle placeholder containers or route jobs to the existing health-only runtime. Worker image builds need the actual application code and its lockfile; the isolated docker/browser package does not contain NestJS or Temporal.

Proposed variables: TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_ORCHESTRATION_QUEUE, TEMPORAL_SEARCH_QUEUE, TEMPORAL_BROWSER_QUEUE, SEARXNG_URL, SEARCH_MAX_CONCURRENT_ACTIVITIES, SEARCH_REQUEST_TIMEOUT_MS and DATABASE_URL.

Inside Docker, SEARXNG_URL is http://searxng:8080; host development uses http://localhost:8080. Workers use postgres:5432 as their database host. Search workers receive only the credentials they need. Compose health dependencies help startup but workers must also handle unavailable dependencies and graceful shutdown at runtime.

Readiness checks verify polling and critical connections, with startup timeout and reconnection. Keep liveness distinct from readiness. Search workers stop polling and abort requests on shutdown; browser workers also close sessions.

## Delivery sequence and acceptance gates

1. Define contracts, configuration, queue names and database entities; validate limits and ownership.
2. Implement the SearXNG client and deterministic normalization against fixture responses.
3. Implement persistence and retry-safe query processing.
4. Add search workflow, Nest worker bootstrap, cancellation and authorized API endpoints.
5. Add actual worker Dockerfiles, Compose wiring and health checks.
6. Complete the existing browser compatibility spike and tool/agent phases.
7. Connect search candidates to browser activities and evidence persistence.
8. Add quotas, isolation, telemetry and failure recovery tests.

Search implementation can progress independently of the browser compatibility spike. The combined milestone requires both tracks to pass.

Search acceptance: the real engine can return validated JSON; query/engine provenance is stored; duplicate activity delivery produces no duplicate records; partial, empty and failed outcomes are distinct; cancellation aborts requests; cross-project access is denied.

Combined acceptance: a goal produces candidate URLs, 3–5 selected pages are visited, source-supported evidence links back to search results, failures are explicit, and cancellation releases browser resources.

## Verification and metrics

Fixture cases: missing optional fields, malformed JSON, oversized body, timeouts, 429/Retry-After, 5xx, duplicate URLs, unsafe destinations, zero results and engine-level failures. Worker cases: crash after write, duplicate delivery, cancellation, startup failure and shutdown. Integration cases: real SearXNG JSON plus browser evidence linkage.

Track queue delay, search latency, attempt count, engine failures, result count, duplicate count, selected-source count, browser success and evidence coverage. Redact private query content from routine logs while retaining access-controlled audit data.

