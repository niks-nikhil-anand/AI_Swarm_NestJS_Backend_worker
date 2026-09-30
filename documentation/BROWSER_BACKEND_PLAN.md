# AI Swarm NestJS Browser Backend Plan

Status: implementation plan. The repository contains a NestJS 12 starter and Docker definitions for PostgreSQL, SearXNG and a Chromium/Playwright/Stagehand development runtime. Application database integration, search/browser workers, LLM execution and Temporal are not implemented. See [Search and browser worker plan](WORKER_ARCHITECTURE_PLAN.md) for queue ownership, SearXNG execution and the proposed folder structure.

## Scope and first milestone

Build a NestJS backend that accepts a research goal and 3–5 public URLs, visits them through a controlled browser agent, extracts schema-valid information, verifies supporting source content, saves provenance, and terminates browser resources cleanly.

SearXNG remains the URL discovery layer. Playwright provides deterministic browser operations; Stagehand provides semantic discovery and extraction. The platform owns the Browser Tool Layer. The agent never calls either SDK directly.

Purchases, publishing, broad authenticated automation, arbitrary generated JavaScript, Firecracker, gVisor, noVNC, and WebRTC are deferred.

## Architecture

```text
AI Swarm frontend
  -> NestJS API: authentication, authorization, run creation and status
  -> Research orchestrator / Temporal workflow
  -> Search task queue -> NestJS SearXNG worker -> SearXNG HTTP API
  -> Persisted candidate URLs -> Browser task queue
  -> Browser worker: agent goal/state + LLM decisions
  -> Browser Tool Layer: policy, validation, audit, budgets
  -> Session Manager
       -> Playwright adapter: deterministic operations
       -> Stagehand adapter: semantic discovery and extraction
  -> Chromium/CDP session -> isolated context -> registered tabs
  -> Evidence repository + Artifact Store
  -> Research, fact-check and report pipeline
```

Run the API, orchestration worker, SearXNG worker and browser worker as separate processes. HTTP handlers enqueue work; they do not launch browsers or wait for whole research tasks. NestJS dependency injection composes worker services, while Temporal schedules durable execution.

Stagehand v4 uses its own browser abstraction and CDP transport. Shared-session integration is an experimental gate, not an assumption that SDK page objects are interchangeable. Pin exact compatible versions after the spike. Reference: https://docs.stagehand.dev/v4/first-steps/introduction

## NestJS modules and ownership

| Proposed module | Responsibility |
| --- | --- |
| AuthModule | Verified identity, project access and tenant authorization |
| ResearchModule | Research task creation and pipeline orchestration |
| SearchModule | Authorized search-run API and dispatch |
| SearchExecutionModule | Worker-only SearXNG client, normalization and candidate persistence |
| BrowserRunsModule | Run API, status, cancellation and persisted state |
| BrowserAgentModule | Observe, decide, execute, verify loop |
| BrowserToolsModule | Only callable browser capability boundary |
| BrowserSessionsModule | Lifecycle, context/tab registry and adapter ownership |
| LlmModule | Structured decisions, provider configuration and usage |
| EvidenceModule | Source excerpts, extracted fields and provenance |
| ArtifactsModule | Authorized object storage and file metadata |
| ApprovalsModule | Scoped approval requests and resolution |
| PersistenceModule | Database repositories and migrations |
| TemporalModule | API-side workflow client and worker configuration |

Do not register worker-only browser providers in the HTTP application. Export interfaces through injection tokens so adapters, repositories and LLM providers can be replaced in tests.

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

Names above are proposed files, not generated implementation.

## Browser compatibility spike

Before implementing the agent:

1. Pin SDK versions and browser binary; establish a supported lifecycle and CDP attachment mechanism.
2. Playwright opens a tab, navigates, clicks and reads content.
3. Stagehand observes and extracts from the same context and tab.
4. Playwright changes content; Stagehand sees the change.
5. Stagehand identifies a target; translate and validate it for Playwright execution.
6. Repeat with redirects, popups, multiple tabs and dynamic pages.
7. Disconnect an adapter, reconnect where supported, and verify tab identity.
8. Close the session and verify processes, connections and temporary files are released.

Use platform sessionId, contextId and tabId mapped to adapter handles. Never match pages by array position. One owner controls lifecycle; adapters must not independently terminate the shared browser.

Exit gate: no state divergence, wrong-tab execution or resource leaks. If interoperability fails, investigate supported connection paths or select a supported single-adapter execution mode behind the same contract. Record the decision before further work.

## Controlled tool API

The following is the platform contract, not SDK syntax:

```ts
browser.open({ url, tabId? })
browser.observe({ instruction?, tabId })
browser.click({ target, tabId })
browser.type({ target, text, mode: 'fill' | 'append', tabId })
browser.scroll({ direction, pixels, target?, tabId })
browser.extract({ instruction, schemaId, tabId })
browser.screenshot({ fullPage?, target?, tabId })
browser.new_tab({ url? })
browser.list_tabs()
browser.switch_tab({ tabId })
browser.close_tab({ tabId })
browser.go_back({ tabId })
browser.wait_for({ condition, target?, timeoutMs, tabId })

// Phase 5
browser.download({ trigger, tabId })
browser.upload({ target, artifactId, tabId })
browser.execute_js({ scriptId, args, tabId })
```

Targets support observed element references, accessible role/name, and CSS selectors for known workflows. Element references are scoped to context, tab and observation revision. Invalidate them after navigation or relevant page changes, and revalidate immediately before acting.

For each call: validate schema, ownership, tab, target freshness, destination policy, capability, approval and budget; serialize actions for the tab; dispatch; verify the result; record an audit event.

Return actionId, status, tabId, final URL, typed data, artifact references, duration and a typed error with retryability. Error codes should distinguish invalid arguments, stale target, policy denial, timeout, disconnected session, extraction failure and uncertain action outcome.

Server-side identity and permissions are trusted execution context. The model cannot supply userId, tenantId or project ownership to gain authority.

execute_js accepts only registered scriptId values and validated arguments. Arbitrary generated source is unsupported.

## Agent execution

Loop: goal and completion criteria -> observe -> structured LLM decision -> validate -> execute -> observe -> verify -> continue, complete, fail or await user action.

Persist goal, permissions, budgets, action history, evidence references and recovery state. Keep raw browser handles only in the owning worker.

Initial configurable budgets: 30 actions, 10 minutes, 5 tabs, 2 recovery attempts per failed step. Track deterministic execution cost and Stagehand inference cost separately. Select a model with validated structured tool-call behavior; do not assume the existing frontend model chain is suitable.

Detect repeated actions and unchanged observations. Verify extracted fields against supporting content and registered schemas. A successful click is not task completion. Partial source failures must be explicit and must not create invented evidence.

## HTTP API proposal

| Route | Purpose |
| --- | --- |
| POST /projects/:projectId/browser-runs | Create a research browser run |
| GET /projects/:projectId/browser-runs/:runId | Status, progress and evidence summary |
| GET /projects/:projectId/browser-runs/:runId/actions | Paginated redacted audit records |
| POST /projects/:projectId/browser-runs/:runId/cancel | Request cancellation |
| GET /projects/:projectId/browser-runs/:runId/events | Authorized server-sent progress events |
| GET /projects/:projectId/artifacts/:artifactId | Authorized artifact access |
| POST /projects/:projectId/browser-runs/:runId/approvals/:approvalId/resolve | Phase 5 approval resolution |

Require authentication and project authorization on every route. Apply DTO validation, request limits and server-assigned run identifiers. Return accepted status plus runId for creation. Use a creation idempotency key and durable dispatch/reconciliation so database writes and workflow starts cannot silently diverge.

Do not expose raw SDK operations or CDP endpoints through public HTTP routes.

## Persistence and provenance

Proposed entities:

- BrowserRun: owner, project, goal, policy snapshot, status, budgets, workflow ID and timestamps.
- BrowserAction: run, sequence, action ID, redacted input, outcome, timing and error.
- BrowserArtifact: project/run ownership, object key, MIME type, size, checksum and retention.
- BrowserApproval: exact action, destination, payload digest, requester, decision, expiry and consumption state.
- BrowserEvidence: requested/final URL, title, retrievedAt, source excerpt, structured fields, schema version and action/artifact references.

Use PostgreSQL with a selected NestJS persistence adapter; Prisma is a reasonable proposed choice because the existing AI Swarm application uses it. Decide database ownership and migration responsibility before sharing a schema between services. Do not copy a generated client from the frontend repository.

Store large files in object storage, with metadata in PostgreSQL. A browser artifact ID is an access-controlled reference, never a filesystem path.

## Temporal and recovery

Use separate swarm-orchestration, swarm-search and swarm-browser task queues. The orchestration worker registers workflows, the SearXNG worker registers search activities, and the browser worker registers browser activities. Set explicit concurrency and request budgets independently for each worker. Workflows contain serializable state; all browser, LLM, storage and database side effects run in activities.

Start with one bounded browser-task activity that owns session creation, the agent loop and cleanup. Heartbeat progress and cancellation; persist evidence incrementally. Long approval waits release browser resources and resume with re-observation after a workflow signal.

Reads and public extraction may retry with deduplicated evidence writes. Do not blindly retry submissions or other external mutations. A crash after an action but before its recorded result creates an uncertain outcome; reconcile before repeating. Action IDs do not guarantee idempotency on external sites.

A worker restart invalidates old handles and element references. Resume public research from stored URLs and checkpoints. Cleanup runs on success, failure, cancellation and shutdown; an independent reaper handles abandoned processes.

## Security from the first prototype

Enforce destination checks for navigation, redirects, popups and requests. Back application checks with network egress controls covering private addresses, metadata endpoints, DNS resolution and rebinding.

Treat page content as untrusted data that cannot grant capabilities or override system instructions. Restrict credentials and artifacts by tenant/project. Redact secrets from logs and observations.

BrowserContext isolates cookies and storage but is not a complete security boundary. Use dedicated browser processes/containers for production tenant isolation, unprivileged execution and no host filesystem mounts or exposed debugging ports.

Downloads register listeners before triggers and persist before context closure. Uploads resolve authorized artifact IDs. Apply type, size and storage limits. Reference: https://playwright.dev/docs/downloads

Approvals bind to a precise action and payload. Revalidate the destination, target and permissions after approval. Do not treat public browsing clicks as universally safe: a click that submits or causes a consequential effect requires the appropriate capability.

## Delivery phases

| Phase | Deliverable | Exit gate |
| --- | --- | --- |
| 1 Browser spike | Version pins, lifecycle and adapter compatibility harness | Same context/tab, state visibility, target translation and cleanup proven |
| 2 Tool layer | Core tools, registries, policy, audit and structured errors | All operations validated and predictable on fixtures |
| 3 Browser agent | Structured decisions, budgets, verification and recovery | Representative tasks complete without loops |
| 4 AI Swarm integration | SearXNG, Temporal, persistence, evidence and API | Research output traces to captured source material |
| 5 Files and approvals | Downloads, uploads, secrets, scoped authentication and scripts | No unauthorized file access or consequential action |
| 6 Production | Containers, quotas, cancellation, recovery and observability | Isolation and resource behavior verified under load |

Browser SDKs currently live in the isolated docker/browser development image. Application worker dependencies and integration are phased; the health-only runtime is not a job-processing worker. Phase 1 needs pinned Playwright/Stagehand and their documented browser setup. Later phases add runtime schema validation, configuration, PostgreSQL persistence, Temporal, object storage and provider clients.

## Validation and acceptance

Use fixture sites for dynamic content, ambiguous targets, stale references, frames, redirects, popups, blocked networks, malicious page instructions, downloads and uploads. Test crash-after-action recovery, cancellation, unauthorized project access and concurrent session isolation.

Track task success, schema validity, evidence coverage, unsupported-page failures, latency, model usage, recovery frequency and resource leaks. Set benchmark thresholds after collecting a baseline; report partial completion separately.

First milestone acceptance:

- Given a goal and 3–5 URLs, the run produces source-supported, schema-valid evidence.
- Every browser action passes through the tool layer and is auditable.
- Failed sources are reported without fabricated results.
- Cancellation and timeouts release browser resources.
- Cross-project session and artifact access is denied.
- API status and evidence remain available after the worker exits.

## Immediate implementation order

1. Create the compatibility harness and record tested version pins.
2. Define schemas, adapter interfaces and platform identity registries.
3. Implement session cleanup and the deterministic core tools.
4. Add Stagehand observation/extraction and target translation.
5. Add the bounded agent loop using fixture goals.
6. Introduce persistence, Temporal dispatch and authorized NestJS run APIs.
7. Implement the dedicated SearXNG worker track described in WORKER_ARCHITECTURE_PLAN.md and connect persisted candidates to browser evidence. Search development can proceed independently of steps 1–5.
8. Add files, approvals and production hardening after milestone validation.
