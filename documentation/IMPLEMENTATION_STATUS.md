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

## Verified locally

Nest build, full TypeScript checking, ordinary oxlint, Jest unit tests and HTTP end-to-end tests pass. Temporal workflow bundling is checked separately. Browser tests exercise real headless Chromium with local fixtures. Production dependency audit reported no vulnerabilities at the time of implementation.

Search restart recovery reconstructs warnings from persisted query outcomes. Proxy tests cover delayed upstream responses. Browser capture closes sessions in finally blocks, including initialization failures.

## Blockers and scope

Compose runtime behavior (`up`, live Temporal/PostgreSQL) remains unverified; `docker compose --profile engine config` validates. The Linux Chromium sandbox is verified for browser sessions in the containers described below.

The Playwright headless shell launches successfully on the Windows development host. Full Chromium fails there with spawn UNKNOWN (Windows reports a side-by-side configuration error), so Stagehand integration is verified in Linux containers only. No semantic compatibility or LLM agent readiness is claimed.

Approval records exist in the schema but no approval execution flow is enabled. Current actions deny sensitive submissions. execute_js, uploads, arbitrary browser downloads and authenticated state reuse remain deferred. Research output is captured source text with provenance, not verified claims or a generated final report.

## Browser runtime and Stagehand (Phase 1)

Ownership: a session owns its egress proxy, one `ChromiumConnection` (process, temporary profile, persistent context, pages) and, with Stagehand enabled, a worker egress guard. The optional `StagehandAdapter` borrows that browser and never stops it. Teardown detaches Stagehand (bounded to 1s), stops Chromium and removes the profile, releases the CDP socket, then the guard and the proxy. A crashed or disconnected Chromium closes its session; a lost guard connection stops the browser (fail closed).

Request policy: pages are filtered by Playwright routing (allowlisted domain, GET/HEAD only). Extension and worker targets (the Stagehand service worker and its offscreen document) are not covered by Playwright routing, and their HTTPS requests reach the proxy as tunnels whose method it cannot see. `worker-egress-guard.ts` auto-attaches every service/shared worker and background page paused over CDP, enables `Fetch` interception, and applies the same predicate before releasing it. Before this guard, a POST from the extension worker to an allowlisted HTTPS host reached the server (verified: HTTP 405 from example.com); with it the request is blocked.

Stagehand 4.1.0 specifics, confirmed against the installed package (the online v4 docs describe a later 4.x where `extensionId` is ignored and `extensionCdpUrl` exists; 4.1.0 accepts only `{ cdpUrl, extensionId }`):

- Stagehand runs as an MV3 extension. With `STAGEHAND_ENABLED=true`, sessions launch full Chromium (`channel: 'chromium'`; the headless shell cannot load extensions) with the bundled extension, `--remote-debugging-port=0` on 127.0.0.1 and `--enable-unsafe-extension-debugging`.
- The extension opens its own WebSocket to the browser CDP endpoint. That connection goes through the session egress proxy, which tunnels exactly the session's CDP port (CONNECT only; the `/json` HTTP endpoints stay denied). Chromium accepts the WebSocket only from `chrome-extension://<id>`; the id is derived from the extension path before launch and verified after.
- The extension exports telemetry from inside Chromium; the 4.1.0 default endpoint is `https://example.com/v1/traces`. Sessions set `https://telemetry.invalid/v1/traces`; the worker guard blocks it before it reaches the proxy, and the proxy would deny the host anyway.

Settings: `STAGEHAND_ENABLED` (default `false`), `STAGEHAND_CONNECT_TIMEOUT_MS` (30000; also bounds guard setup), `BROWSER_HEADLESS` (default `true`; `false` on Linux needs a display and does not change `CHROMIUM_SANDBOX`), `BROWSER_LAUNCH_TIMEOUT_MS` (30000). `BROWSER_CDP_URL`/`STAGEHAND_CDP_URL` are rejected: sessions never attach to an external browser.

### Verification (2026-10-22)

| Check | Command | Result |
| --- | --- | --- |
| Unit tests (Windows host) | `npm test` | 14 suites passed, 60 tests passed, 5 skipped (Linux-only Stagehand session suite), 1 todo |
| Browser suite (Linux, non-root, sandbox on, repo seccomp profile) | see below | 10 suites passed, 54 tests passed, 0 skipped, 1 todo |
| Typecheck | `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| Lint | `npm run lint`; `npx oxlint --type-aware tests/browser tests/config` | exit 0; one pre-existing warning in `test/users.e2e-spec.ts:257` |
| Build | `npm run build` | exit 0; compiled adapter keeps the native `import()` required for the ESM-only Stagehand package |
| Production worker image | `docker build -f infrastructure/chromium/Dockerfile .` | exit 0 |
| Compose | `docker compose --profile engine config -q` (with `DOCKER_DATABASE_URL` set) | exit 0 |

Linux browser suite:

```bash
docker build -t swarm-browser-test -f docker/browser-test/Dockerfile .
docker run --rm --init --shm-size=1g --security-opt seccomp=docker/browser/seccomp_profile.json -e STAGEHAND_INTEGRATION=1 -v "$PWD:/src:ro" swarm-browser-test
```

Without `STAGEHAND_INTEGRATION=1`, `tests/browser/stagehand-session.spec.ts` is skipped.

Production-image smoke (compiled `dist/`, `node` user, sandbox on, repo seccomp profile, real network to example.com), run with ad-hoc scripts not kept in the repository. All checks passed:

- Two sessions get distinct CDP endpoints and profiles; each Stagehand instance sees only its own tabs.
- Playwright `open` to https://example.com through the egress proxy and `observe` succeed.
- Stagehand deterministic reads work: `page.title()` and `page.snapshot()` (accessibility tree containing the page text).
- Pages cannot POST to an allowlisted host, reach a non-allowlisted host, or reach their own or another session's CDP endpoint over HTTP or WebSocket.
- Extension worker requests are blocked for a non-allowlisted host, 169.254.169.254, another session's CDP port, and POST/PUT to the allowlisted host over HTTP and HTTPS; worker GET to the allowlisted host returns 200.
- The proxies opened loopback connections only to each session's own CDP port, and external connections only to example.com addresses. Telemetry never reached the network.
- Startup failure (missing browser build) fails with `BROWSER_LAUNCH_FAILED`, leaving no session, profile or process; a 1ms Stagehand attach deadline fails with `STAGEHAND_CONNECT_TIMEOUT` and cleans up; closing a session during an in-flight `wait_for` fails that action and stops its browser in about 1s; `app.close()` with open sessions leaves no Chromium processes; SIGKILL of the worker process leaves no Chromium processes.

### Known limitations

- Stagehand 4.1.0 `act`/`observe`/`extract` need an LLM: without one, `observe` rejects with "An LLM was not configured during Stagehand initialization". Model-provider egress is a Phase 2 decision.
- Correction (Phase 2): the Phase 1 smoke reported Stagehand `page.locator('h1')` failing on example.com. The page simply has no `h1` (it is now a single paragraph); Stagehand locators and XPath actions work, as the Phase 2 tests show.
- Stagehand's content script does not run in `about:blank` documents; pages must navigate to http(s) first. Stagehand's own `context.newPage()` does not become ready under the session's Playwright request interception, so tabs are opened through Playwright (`new_tab`).
- SIGKILL of the worker leaves its temporary `swarm-chromium-*` profile directory in the container's temp directory (processes do exit). No startup sweep is done, because a sweep could remove a live profile if workers ever shared a temp directory.
- Chromium's own background requests (component updates, time sync, accounts) go to the proxy and are denied unless their hosts are allowlisted. The proxy cannot check the method of HTTPS tunnels for that browser-internal traffic.
- The CDP port is bound to 127.0.0.1 inside the worker container. Any process in that container can reach it; this relies on the container holding only the worker.

## Agent browser actions (Phase 2)

### What was added

- **Step runs through the existing API.** `POST /projects/:projectId/browser-runs` accepts either the existing capture body `{ urls, screenshot }` or `{ steps, maxStepAttempts }` (`src/browser/contracts/browser-step.ts`). Steps: `navigate`, `inspect`, `read`, `click`, `type`, `scroll`, `wait_for`, `go_back`, `new_tab`, `switch_tab`, `observe`, `act`. Up to 25 steps; http(s) URLs only; there is no key-press, submit or script step. Runs use the unchanged dispatch → `browserWorkflow` → `executeBrowserTask` path.
- **Every step goes through `BrowserService`**: session ownership, capability and action budget checks, per-session serialization, page routing (allowlisted domain, GET/HEAD), the egress proxy and the worker egress guard all apply as in Phase 1.
- **Stagehand `observe` / `act`** (`src/browser/tools/browser-semantic.tool.ts`). `observe` returns model-proposed candidates (read-only). `act` asks Stagehand `observe()` for one action, validates it, then executes exactly that `Action` with Stagehand `act()`; free-form `act("…")` is never called. Validation: method in `click`, `fill`, `type`, `scrollTo`, `hover`; the selector must resolve to exactly one element in the session's own tab; clicks pass the same risky-click rule as Playwright clicks (form submit, buy, delete, …); fills only target plain text fields with one argument. The Stagehand page is matched to the Playwright tab by CDP target id, so Stagehand never acts on another tab or session.
- **Model provider** (`src/browser/adapters/stagehand/model-provider.ts`). Stagehand 4.1.0's client-side `model.generate` hook is answered in the browser worker process with `@anthropic-ai/sdk` 0.137.0 (pinned). Model calls never leave from Chromium, so page and extension egress are unchanged. Requests use `claude-opus-5-5` by default, `output_config.effort`, structured outputs for Stagehand's `json_schema` requests (unsupported schema keywords stripped), no sampling parameters, and server-side refusal fallback (`fallbacks: "default"`) for models that support it. SDK errors map to typed codes `MODEL_AUTH_FAILED`, `MODEL_RATE_LIMITED`, `MODEL_TIMEOUT`, `MODEL_UNAVAILABLE`, `MODEL_REQUEST_REJECTED`, `MODEL_REFUSED`, `MODEL_OUTPUT_INVALID`; messages carry the HTTP status only, never request content or keys.
- **Records and evidence.** Each step is written to `browser_actions` as `step:<kind>` (status, attempts, duration, URL, error, result; typed text is stored as its length only) next to the underlying policy-checked actions. `read` steps persist evidence rows. Output is `{ status, steps, evidence, warnings }` with `COMPLETED`, `PARTIAL` (stopped at a failed step) or `FAILED`.
- **Retries without blind replay.** Within a session a failed step is retried (`maxStepAttempts`, 1–3) only when its error is retryable and either the step is replayable or the failure was a model error before `act` executed anything. Clicks, typing and timed-out `act`s are never retried. Across Temporal attempts (`BROWSER_MAX_ATTEMPTS = 3`, only for errors marked retryable such as Chromium launch or Stagehand attach), replayable steps rebuild page state; if a click, type or act was already attempted, the run ends with `RESUME_UNSAFE` instead of replaying it. A retryable failure keeps the run `RUNNING` until the final attempt.
- **Fixes found during verification:** `wait_for` failed at once for elements not yet present (it required exactly one match before waiting); it now waits, and more than one match is still refused. Playwright timeouts are reported as retryable `BROWSER_TIMEOUT`. Step URLs must be http(s) at the API boundary.

Settings (browser worker only): `STAGEHAND_MODEL_PROVIDER` (`none` by default, or `anthropic`, which requires `STAGEHAND_ENABLED=true` and `ANTHROPIC_API_KEY`), `STAGEHAND_MODEL` (`claude-opus-5-5`), `STAGEHAND_MODEL_EFFORT` (`medium`), `STAGEHAND_MODEL_TIMEOUT_MS` (60000), `STAGEHAND_MODEL_MAX_RETRIES` (2), `STAGEHAND_ACTION_TIMEOUT_MS` (120000). The key is held in a `Secret` that serializes and prints as `[redacted]`; configuration errors name variables, never values. Without a provider, `observe`/`act` steps fail with `MODEL_NOT_CONFIGURED`.

### Verification (2026-10-22)

| Check | Command | Exit | Result |
| --- | --- | --- | --- |
| Host tests | `npm test` | 0 | 16 suites passed; 105 tests passed, 19 skipped (Linux-only suites: `stagehand-session` 5, `browser-steps.integration` 14), 1 todo |
| HTTP e2e | `npm run test:e2e` | 0 | 3 passed, 5 skipped (pre-existing users suite needs `USER_API_TEST_DATABASE_URL`) |
| Linux browser suite | documented `docker run … swarm-browser-test` with `STAGEHAND_INTEGRATION=1` | 0 | 13 suites passed; 113 tests passed, 0 skipped, 1 todo |
| Typecheck | `npx tsc --noEmit -p tsconfig.json` | 0 | |
| Lint | `npm run lint`; `npx oxlint --type-aware tests/browser tests/config` | 0; 0 | one pre-existing warning in `test/users.e2e-spec.ts:257` |
| Build | `npm run build` | 0 | |
| Compose stack | `docker compose -p swarm-p2-verify --profile engine up -d --build` | 0 | postgres, temporal, searxng healthy; migrate exited 0; api healthy; three workers running |

The Linux integration suite (`tests/browser/browser-steps.integration.spec.ts`) runs the real `BrowserExecutionService` with Chromium, Stagehand and the worker guard against PGlite. Fixture pages come from one extra Playwright route on `https://example.com/fixture/*`; every other request uses the session policy. A deterministic stand-in model answers Stagehand's real `Observation` requests. Covered: navigate → inspect → click → read with persisted evidence, step log and screenshot artifact; observe/act click and fill; blocked form-submit click (Playwright and Stagehand), off-allowlist navigation and a model-proposed key press; model rate limit (retried, typed), model hang (`STAGEHAND_ACTION_TIMEOUT`, not retried) and no provider; Stagehand on one session cannot reach another session's tab; extension POST still blocked; `wait_for` on a late element; cancellation mid-wait; no replay after a state-changing step; a retryable launch failure keeps the run open until the final attempt.

**Full-stack acceptance** (real HTTP API on the compiled `api` image → PostgreSQL → Temporal `browserWorkflow` → compiled `browser-worker` image → live web), with `BROWSER_ALLOWED_DOMAINS=www.iana.org` and `STAGEHAND_ENABLED=true`, using ad-hoc client scripts not kept in the repository:

- Deterministic run: navigate `https://www.iana.org/help/example-domains` → inspect (31 elements, target link present) → click link "IANA-managed Reserved Domains" → read. `202 QUEUED` → `COMPLETED` in about 2 s. Temporal `swarm-<runId>`: `browserWorkflow`, one `executeBrowserTask` activity, `COMPLETED`. PostgreSQL: run `COMPLETED/DISPATCHED`, one evidence row for `https://www.iana.org/domains/reserved` (2495 characters), 4 `step:*` rows plus 4 action rows with durations. Repeated after the worker rebuild: `COMPLETED`.
- API checks on the same deployment: no token 401, other project 403, invalid step 400.
- Model provider through the compiled worker: `STAGEHAND_MODEL_PROVIDER=anthropic` with a random fake key and `ANTHROPIC_BASE_URL` pointing at a local mock of the Messages API (verification overlay only). Run navigate → observe → act "click the IANA-managed Reserved Domains link" → read: `COMPLETED`. Observe proposed `link: IANA-managed Reserved Domains`, act clicked it, the page became `https://www.iana.org/domains/reserved`, and evidence was persisted. All 9 model requests carried the key header, `claude-opus-5-5`, effort `medium`, `json_schema` output and `fallbacks: "default"` with `server-side-fallback-2026-07-01`, and no `temperature`.
- Failures through the stack: mock 429 → step `MODEL_RATE_LIMITED` after 2 attempts, run `PARTIAL`; mock 401 → `MODEL_AUTH_FAILED` after 1 attempt; navigation to `www.icann.org` → `DOMAIN_DENIED`.
- Cancellation: `POST …/browser-runs/:id/cancel` during a `wait_for` → `CANCELLED`; Temporal workflow `CANCELED`; no Chromium processes or `swarm-chromium-*` profiles left in the worker container.
- Key handling: `ANTHROPIC_API_KEY` set only in the `browser-worker` container (absent or empty in api, migrate, orchestration worker, searxng worker, postgres, temporal, searxng and the mock); 0 occurrences in all container logs and in a full `pg_dump` of the database.

### Limitations and remaining work

- No real Claude call was made, because no credentials are available in this environment. The provider is verified with the real SDK against local mock APIs (unit tests and the live stack); a run with a real key is the remaining gate for semantic quality.
- A timed-out `act` has an unknown outcome (Stagehand may still complete it). It is reported as failed, never retried, and blocks resume.
- Step runs stop at the first failed step; later steps are not attempted.
- Steps address elements by role/name or CSS; `inspect` element references are not usable across steps.
- Stagehand's content script does not run in `about:blank`, and Stagehand's own `newPage()` does not work under session request interception (Phase 1); `new_tab` uses Playwright.
- The SDK honours `ANTHROPIC_BASE_URL`, which decides where the key is sent; only operators may set it.
- Out of scope for this phase: custom-schema extraction, approval-based form submission and an LLM planning loop.

## Structured extraction (Phase 3)

### What was added

- **`extract` step** on the existing `POST /projects/:projectId/browser-runs` steps API: `{ kind: 'extract', instruction, schema, scope? }`. `schema` is caller JSON Schema; `scope` is an optional CSS selector limiting extraction to part of the page. Capture requests and all Phase 2 steps are unchanged.
- **Schema contract** (`src/browser/extraction/extraction-schema.ts`). Root must be a non-nullable `object`. Supported: `object` (`properties`, `required`, `additionalProperties: false`), `array` (`items`, `maxItems` ≤ 100, default 100), `string` (`enum` ≤ 50 values, `maxLength` ≤ 10000), `number`, `integer`, `boolean`, nullable types as `type: [T, "null"]`, and `description`. Rejected: `$ref`, `pattern`, `format`, `oneOf`/`anyOf`/`allOf`, open objects, unknown keywords, invalid property names. Limits: 16 KB schema, depth 5, 64 schema nodes. HTTP callers send JSON Schema; it is converted to a strict Zod schema (`toZod`) for Stagehand and for re-validation, so TypeScript callers can use the same Zod form.
- **Missing values**: a property not in `required` may be absent, a nullable type may be null; every absent or null value is reported as a JSON path in `missing`. A required, non-nullable value the page lacks makes the output invalid.
- **Execution** (`semanticExtractTool`): Stagehand 4.1.0 `extract(instruction, zodSchema, { page, timeout, locator })` on the session's own tab, through the Phase 2 worker-side model provider. Stagehand makes two model calls per page chunk (`Extraction`, then `Metadata` progress). The output is validated by Stagehand inside the extension, then again here, and limited to `EXTRACT_MAX_RESULT_BYTES` (64 KB). Extraction is read-only: it fails with `EXTRACT_PAGE_CHANGED` if the page URL changes.
- **Persistence** (`002_extractions.sql`): `extractions(run_id, tenant_id, project_id, step, url, instruction, schema_hash, schema, data, missing, evidence_id, model_calls, model_tokens, retrieved_at)`, one row per run step. Each extraction also captures the page's source text (deterministic DOM) as an `evidence` row (`purpose: extraction-source`) and links to it. `GET /projects/:projectId/browser-runs/:runId/extractions` returns results with their evidence; it is scoped by tenant and project (the run lookup and the query both filter on them).
- **Limits on model usage** (all semantic steps): `STAGEHAND_STEP_MAX_MODEL_CALLS` (12) and `STAGEHAND_STEP_MAX_MODEL_TOKENS` (300000) per step, enforced in the connector's `generate` hook; the call that would exceed the budget is refused (`MODEL_BUDGET_EXCEEDED`, not retried). Time is bounded by `STAGEHAND_ACTION_TIMEOUT_MS`.
- **Untrusted pages**: every model request carries a system notice that page content is data, not instructions. Enforcement does not depend on it: extraction output can only be schema-valid data, extraction cannot navigate, and all Phase 1/2 network and action policies still apply.
- **Typed errors**: `EXTRACT_SCHEMA_INVALID` (400 at submission, naming step and path; also checked again in the worker), `EXTRACT_OUTPUT_INVALID` (paths only, never page values; retryable within the step budget), `EXTRACT_OUTPUT_TOO_LARGE`, `EXTRACT_PAGE_CHANGED`, `MODEL_BUDGET_EXCEEDED`, plus the Phase 2 `MODEL_*` and `STAGEHAND_ACTION_TIMEOUT` codes.
- **Migrations** now run as an ordered list (`MIGRATIONS` in `src/persistence/migrate.ts`), each applied once inside the existing locked transaction.

### Bugs found and fixed during verification

- **Steps after a navigating click saw a half-loaded page.** `click` (and Stagehand `act`) returned once the navigation had started; on www.iana.org, `extract` right after the click received an accessibility tree containing only the root, so the model had nothing to read. `click` and `act` now wait for the new document's `domcontentloaded`, and `observe`/`extract` wait before their snapshot. The regression test (`extraction right after a … click sees the page the click navigated to`) uses a page whose parser waits on a delayed external script; it fails without the fix (`Received: ""`) and passes with it.
- **Egress proxy could crash the worker** (Phase 1 code). When Chromium closed with a `CONNECT` tunnel open (for example the extension's CDP WebSocket), writing to the vanished client socket raised an unhandled `EPIPE`/`ECONNRESET`. It surfaced as an intermittent `write EPIPE` in the Linux suite. The tunnel's client socket now has an error handler; policy logic is unchanged. Unit test `a client vanishing mid-tunnel does not crash the process` fails without the fix (5 uncaught `write ECONNRESET`) and passes with it.

New settings: `STAGEHAND_STEP_MAX_MODEL_CALLS` (12), `STAGEHAND_STEP_MAX_MODEL_TOKENS` (300000), `EXTRACT_MAX_RESULT_BYTES` (65536).

### Verification (2026-10-22)

| Check | Command | Exit | Result |
| --- | --- | --- | --- |
| Host tests | `npm test` | 0 | 17 suites passed; 137 tests passed, 31 skipped (Linux-only suites: `stagehand-session` 5, `browser-steps.integration` 26), 1 todo |
| HTTP e2e | `npm run test:e2e` | 0 | 6 passed (including 3 extraction API tests), 5 skipped (pre-existing users suite needs `USER_API_TEST_DATABASE_URL`) |
| Linux browser suite | documented `docker run … swarm-browser-test` with `STAGEHAND_INTEGRATION=1`, run twice | 0, 0 | 14 suites passed; 157 tests passed, 0 skipped, 1 todo (both runs) |
| Typecheck | `npx tsc --noEmit -p tsconfig.json` | 0 | |
| Lint | `npm run lint`; `npx oxlint --type-aware tests/browser tests/config` | 0; 0 | one pre-existing warning in `test/users.e2e-spec.ts:257` |
| Build | `npm run build` | 0 | |
| Compose stack | `docker compose -p swarm-p3-verify --profile engine up -d --build` (with the verification overlay) | 0 | migrations `001`, `002` applied; api healthy; workers running |

New tests: `tests/browser/extraction-schema.spec.ts` (28: valid and invalid schemas, limits, nested/array/nullable/missing conversion), `test/browser-extraction.e2e-spec.ts` (3: typed invalid-schema 400, capture compatibility, persisted results with evidence and tenant isolation on the same project id), extraction cases in `browser-steps.spec.ts`, connector budget tests in `stagehand.spec.ts`, and 12 real-Chromium extraction tests in `browser-steps.integration.spec.ts`: nested/nullable/missing data persisted with source evidence and tenant/project; malformed output (typed, retried, nothing persisted); provider auth and rate-limit failures; model hang timeout; call budget; result size limit; prompt-injection page (no navigation, no form POST, `evil.test` requests all blocked); invalid schema reaching the worker (no model call); extraction right after a Playwright click and after a Stagehand act (navigation settle); cancellation during extraction.

**Full-stack acceptance** (compiled `api`, `migrate` and `browser-worker` images; PostgreSQL; Temporal; live www.iana.org; `BROWSER_ALLOWED_DOMAINS=www.iana.org`, `STAGEHAND_ENABLED=true`, `STAGEHAND_MODEL_PROVIDER=anthropic` with a random fake key and `ANTHROPIC_BASE_URL` pointing at a local mock of the Messages API whose `Extraction` answers fill the requested schema from the page's real headings; two random verification principals, tenant A and tenant B, both on project `demo`):

- Invalid schema → `400 EXTRACT_SCHEMA_INVALID` ("Step 0: Extraction schema $.s: keyword "pattern" is not supported for string").
- Run navigate `https://www.iana.org/help/example-domains` → click "IANA-managed Reserved Domains" → extract `{ pageTitle, sections[{heading}] (maxItems 10), contactEmail: string|null }`: `202` → `COMPLETED`. Extraction on `https://www.iana.org/domains/reserved` with 5 section headings from that page, `missing: ["$.contactEmail"]`, 2 model calls. `GET …/extractions` returned it with evidence `{ url: https://www.iana.org/domains/reserved, title: "IANA-managed Reserved Domains", retrievedAt }`.
- Temporal: `browserWorkflow` `COMPLETED`. PostgreSQL: extraction row `tenant-a/demo`, step 2, linked to an evidence row of 2495 characters for the same URL; 3 `step:*` rows.
- Tenant B: run and extractions → 404. No token → 401.
- Before the navigation fix, the same run completed with empty `pageTitle` and `sections` because Stagehand saw an empty page; the comparison navigate→extract / click→extract / click→wait_for→extract isolated the cause.
- Phase 2 checks rerun on the Phase 3 build: deterministic run `COMPLETED`; semantic act, rate limit, auth failure, blocked domain and API cancellation all passed.
- Key handling: `ANTHROPIC_API_KEY` set only in the browser worker; 0 occurrences in all container logs and in a `pg_dump`. Browser worker: 0 restarts, no leftover Chromium processes or profiles, no uncaught errors in its logs.

### Limitations and remaining work

- No real Claude call was made (no credentials here). Extraction quality with a real model is unverified; the stack used a deterministic mock.
- Cancellation during extraction is covered in the Linux suite; through the live stack the mock answers too quickly to cancel mid-extraction.
- Long pages cost two model calls per chunk; with the default budget (12 calls) extraction covers about 6 chunks before `MODEL_BUDGET_EXCEEDED`.
- Array `maxItems` and string `maxLength` are not passed to the model (they are not in the structured-output subset used); output over them fails validation instead of being truncated.
- `scope` is a CSS selector and must match the page; links are extracted as text, there is no URL-typed field.
- Approval-based form submission remains out of scope.

## End-to-end hardening (Phase 4)

### Audit of the execution path (before changes)

Flow: `POST /projects/:projectId/browser-runs` validates the request (including extraction schemas) and inserts a `runs` row (`QUEUED`, `dispatch_state=PENDING`, idempotency key per tenant/project/kind). `DispatchService` starts Temporal workflow `swarm-<runId>` (`browserWorkflow`, or `researchWorkflow` for search → browser), marks the run `DISPATCHED` and reconciles every 5 s: `PENDING` runs are re-dispatched after outages, and workflows that ended `FAILED`/`TIMED_OUT`/`TERMINATED`/`CANCELLED` are reflected in the run. The workflow calls activity `executeBrowserTask` on the browser queue (start-to-close 10 min, heartbeat timeout 20 s, 3 attempts, only failures the activity marks retryable). The activity heartbeats every 5 s and per action and passes Temporal's cancellation signal and attempt number to `BrowserExecutionService.execute`, which: loads the run (terminal runs return their stored output); moves it to `RUNNING`; refuses to resume after a recorded non-replayable step; creates a session (own Chromium, egress proxy, worker guard, Stagehand); runs the steps through `BrowserService` (policy, budget, lock), recording every action and step in `browser_actions`; upserts evidence `(run_id, url)` and extractions `(run_id, step)`; and writes the terminal status and output. The session is closed in `finally`; the API cancel endpoint sets `CANCELLED` and cancels the workflow.

Existing guarantees: terminal statuses are never overwritten; evidence and extractions are upserted on their natural keys; within one attempt, clicks/typing/acts are never retried; after a recorded click/type/act a later attempt ends with `RESUME_UNSAFE` instead of replaying; sessions close on success, failure and cancellation; per-step model budgets and timeouts; secrets stay out of outputs and logs.

Gaps and failure modes found:

1. **Lifecycle.** `transition()` only protects terminal states. Any non-terminal status can move to any other (e.g. `QUEUED → COMPLETED`), and callers cannot tell whether the update applied, so a worker can report `COMPLETED` to Temporal while the run is already `CANCELLED`.
2. **Concurrent attempts.** Temporal starts a new attempt when heartbeats stop for 20 s even if the first worker is only stalled. Nothing prevents two attempts executing the same run at once: duplicate clicks, and `browser_actions (run_id, sequence)` collisions.
3. **Write-after-effect.** A step is recorded only after it ran. If the record fails (database outage) after a click, a retried attempt does not see the click and may replay it.
4. **Database failures** while persisting evidence are reported as a non-retryable `STEP_FAILED`, so a transient outage permanently fails the run.
5. **Atomicity and duplicates.** Evidence and extraction for one step are separate statements; a screenshot creates a new artifact row and file on every retry.
6. **Partial results.** Cancelled runs, and runs failing on their final attempt, keep `output = null` although evidence and step records exist.
7. **Workflow history.** The activity result carries full evidence text and extracted data into Temporal history (2 MB payload limit; duplicates data held in PostgreSQL).
8. **Cancellation.** An in-flight model request is not aborted when the session closes, and the workflow reports cancellation without waiting for the activity to close its browser.

### Guarantees established

- **Lifecycle** (`RUN_TRANSITIONS` in `run.repository.ts`): `QUEUED → RUNNING | CANCELLED | FAILED`; `RUNNING → RUNNING (idempotent re-entry) | COMPLETED | PARTIAL | NO_RESULTS | FAILED | CANCELLED`; terminal statuses never change. `transition()` reports whether it applied; when the final transition is rejected (e.g. cancelled meanwhile) the worker keeps the stored status, records what it did as that run's output (warning `RUN_<status>`), and returns the stored result. Cancelled runs and runs failing on their final attempt get a partial output built from PostgreSQL (latest record per step, evidence, extractions, warning code).
- **One attempt per run** (migration `003_hardening.sql`, `lease_owner`/`lease_expires_at`): an attempt claims a 30 s lease, renews it every 5 s, and releases it in `finally`. A duplicate or overlapping attempt waits up to 35 s for the lease (returning the stored result if the run finished meanwhile, else retryable `RUN_BUSY`). An attempt whose lease was taken over is fenced: it re-checks the lease after every browser action and before every write, stops with `LEASE_LOST` and never touches the run.
- **No unsafe replay**: before any click, type or act, a `started` record is written; if that write fails the action does not run. A later attempt that finds any record of a non-replayable step ends the run `PARTIAL` with `RESUME_UNSAFE` and the completed steps, instead of replaying. Replayable steps (navigate, inspect, read, scroll, wait_for, go_back, tabs, observe, extract) are replayed to rebuild state.
- **Infrastructure versus step failures**: database errors become retryable `PERSISTENCE_UNAVAILABLE` and end the attempt (not a step failure); Temporal retries it (3 attempts, retryable errors only). Policy, validation and action failures stay step outcomes.
- **Durable, de-duplicated writes**: evidence and the extraction made from it are written in one transaction (an extraction never exists without its source evidence; extraction fails with `EXTRACT_PAGE_CHANGED` if the evidence page differs from the extracted page); replays upsert on `evidence (run_id, url)` and `extractions (run_id, step)`; screenshots use idempotency keys (`artifacts (run_id, idempotency_key)`), so a replay reuses the stored artifact and file. Step records are append-only history per attempt (`runAttempt`).
- **Cancellation**: the API marks the run `CANCELLED` and cancels the workflow. The worker sees the status through its lease renewal within 5 s, even inside a slow model call, closes the session (which aborts the in-flight model request through the SDK's `AbortSignal`, `MODEL_ABORTED`) and releases the lease. The activity then waits for Temporal's cancellation and reports itself cancelled, and the browser activity is proxied with `WAIT_CANCELLATION_COMPLETED`, so the workflow ends `CANCELED` only after cleanup.
- **Workflow history**: the activity returns references only (`runId`, status, step outcomes, evidence URLs, extraction ids, warnings); page text and extracted data stay in PostgreSQL. Activity failure messages come only from `ServiceError` messages, which carry no request content or secrets.

### Verification (2026-10-22)

| Check | Command | Exit | Result |
| --- | --- | --- | --- |
| Host tests | `npm test` | 0 | 19 suites passed; 163 tests passed, 31 skipped (Linux-only suites: `stagehand-session` 5, `browser-steps.integration` 26), 1 todo |
| HTTP e2e | `npm run test:e2e` | 0 | 6 passed, 5 skipped (pre-existing users suite needs `USER_API_TEST_DATABASE_URL`) |
| Linux browser suite | documented `docker run … swarm-browser-test` with `STAGEHAND_INTEGRATION=1`, run 3 times | 0, 0, 0 | 15 suites passed; 176 tests passed, 0 skipped, 1 todo |
| Typecheck | `npx tsc --noEmit -p tsconfig.json` | 0 | |
| Lint | `npm run lint`; `npx oxlint --type-aware tests test src` | 0; 0 | only pre-existing warnings (`test/users.e2e-spec.ts:257`, `tests/persistence/search-persistence.spec.ts:77,113`) |
| Format | `npx prettier --check` on changed and new files (except `browser-execution.service.ts`, which keeps its existing compact style) | 0 | |
| Build | `npm run build` | 0 | |
| Compose acceptance | fresh `docker compose -p swarm-p4-verify --profile engine up -d --build` with the verification overlay, then the Phase 4 acceptance client | 0; 0 | migrations `001`, `002`, `003` applied; 29 of 29 checks passed |

New and extended tests:

- `tests/browser/execution-recovery.spec.ts` (11, real `BrowserExecutionService` and SQL on PGlite with a scripted browser): database outage while saving evidence then retry without duplicates; outage after a click never followed by a replayed click (`RESUME_UNSAFE`); duplicate concurrent attempt waits and returns the stored result without re-executing; stalled attempt that lost its lease stops without overwriting the run; API cancellation keeps completed steps and evidence; cancellation detected by lease renewal while a step is stuck (under 8 s, lease released); cancel landing just before completion keeps `CANCELLED` with output; final infrastructure failure → `FAILED` with partial output; policy failure after successful steps → `PARTIAL` with evidence; finished runs are not re-executed or re-leased; workflow result carries no page text or extracted data.
- `tests/persistence/run-lifecycle.spec.ts` (7): transition table and idempotency; lease claim/renew/takeover/release and terminal refusal; terminal output recorded once; evidence+extraction atomic, upserted on replay, foreign keys consistent; failure during the extraction write rolls back its evidence; idempotent screenshot artifact and file.
- `tests/browser/browser-steps.spec.ts`: `started` intent records, intent-write failure prevents the click, storage outage ends the attempt, screenshot idempotency key, evidence/extraction page match, `started` blocks resume.
- `tests/browser/model-provider.spec.ts` and `stagehand.spec.ts`: an aborted slow request ends at once as `MODEL_ABORTED`; closing the session aborts the in-flight model request.
- Linux integration: cancellation during extraction now also asserts the model request was aborted; step-log expectations include the `started` record.

**Full-stack acceptance** (fresh stack: compiled `api`, `migrate`, `orchestration-worker`, `browser-worker`; PostgreSQL; Temporal; live www.iana.org; mock Messages API with a deterministic `Extraction` filler and a 15 s "slow" mode; random fake key; two random verification tenants on project `demo`). All 29 checks passed:

- S1 navigate → click "IANA-managed Reserved Domains" → custom-schema extraction: `COMPLETED`; extraction and evidence on `https://www.iana.org/domains/reserved`; Temporal `WORKFLOW_EXECUTION_STATUS_COMPLETED`; decoded workflow history contains `extractionIds` and no page text; run `COMPLETED` with lease released.
- S2 browser worker killed (`docker kill`) during extraction, restarted: Temporal retried the activity (attempt 2, after the heartbeat timeout), run `COMPLETED`, 1 evidence row and 1 extraction.
- S3 worker killed during extraction after the click: run `PARTIAL` with `RESUME_UNSAFE`, steps `navigate:success, click:success`, exactly 1 click executed.
- S4 API cancel during a slow model request: run `CANCELLED`; browser closed and lease released 3.2 s after the cancel; workflow `WORKFLOW_EXECUTION_STATUS_CANCELED` with the activity's cancellation recorded; the mock logged the aborted model request.
- S5 PostgreSQL stopped (`docker stop`, 16 s) during extraction: attempt failed retryably, retry `COMPLETED` (attempt 2), 1 evidence row and 1 extraction.
- S6 tenant B: run, extractions and cancel all 404.
- S7 across all runs: no duplicate evidence per (run, url) or extraction per (run, step); every extraction references evidence of the same run and URL; extraction tenant/project equal the run's; every run terminal, with output, lease released.
- S8 the fake key is absent from all container logs, a full `pg_dump` and every decoded workflow history; no Chromium processes left in the worker.

Development-time findings fixed in this phase (caught by the new tests and the live acceptance): a stalled attempt could write after losing its lease (now fenced before every write); a duplicate attempt waited for a lease even after the run finished (now returns the stored result); cancellation reached a worker blocked in a model call only after Temporal's throttled heartbeat (now through lease renewal within 5 s, cleanup measured at 3.2 s); a fast database-detected cancellation made the workflow end `FAILED` (now reported as an activity cancellation, workflow `CANCELED`).

### Remaining limitations

- No real Claude call was made; all model behaviour in this phase is a deterministic mock (fixture model in tests, mock Messages API in Compose).
- A run whose final attempt fails while PostgreSQL is unavailable stays `RUNNING` until the dispatcher reconciles it from the failed workflow (`FAILED`, warning `WORKFLOW_FAILED`); its partial output is then not recorded.
- Fencing is checked before each action and write, not atomically with them: a write already in progress when a lease is taken over can still land (the takeover attempt upserts the same keys, so it cannot duplicate evidence or extractions).
- A `click`, `type` or `act` interrupted by a crash ends the run `PARTIAL` (`RESUME_UNSAFE`) rather than completing; this is deliberate.
- A database-only cancellation (no Temporal cancel) makes the activity wait up to 30 s for a cancellation before failing it; the run itself is already `CANCELLED` and cleaned up.
- SIGKILL of the worker leaves its temporary Chromium profile directory (Phase 1).
- Approval-gated actions and form submission remain out of scope.

### Ready to commit

All automated tests, typecheck, lint, formatting, build and the Compose acceptance pass. Phases 1–4 are uncommitted in the working tree (56 changed or new files plus `@anthropic-ai/sdk` 0.137.0 in `package.json`/`package-lock.json`); they are ready to commit as one branch or as one commit per phase.

## Approval-gated browser actions (Phase 5)

### Design (recorded before implementation)

**Action classes**

| Class | Steps | Rule |
| --- | --- | --- |
| Read-only | `navigate`, `inspect`, `read`, `observe`, `extract`, `scroll`, `wait_for`, `go_back`, `new_tab`, `switch_tab` | Run freely; replayable. |
| Safe, reversible | `click` and `act` on non-risky elements, `type` (fills a field, never submits) | Run freely within budgets; the existing risky-click check still refuses submit buttons, buy/delete/publish/confirm/checkout/subscribe controls. Replayed only when resuming from a clean approval pause. |
| Consequential | `submit` (new): activate one submit control of a form, or a link, that the risky check would refuse | Never runs without a consumed approval bound to the exact action and page state. At most one per run. |

A plain `click`/`act` on a risky element still fails with `APPROVAL_REQUIRED`; only an explicit `submit` step in the caller's run definition can request approval, so a model instruction can never create, approve or widen one.

**Run states**: `QUEUED → RUNNING → AWAITING_APPROVAL → RUNNING → COMPLETED | PARTIAL | FAILED | CANCELLED`. `AWAITING_APPROVAL` is non-terminal and holds no browser session or lease. From it a run resumes (`RUNNING`), ends `PARTIAL` (rejected, revoked, expired, or the page changed) or `CANCELLED`.

**Approval states**: `PENDING → APPROVED → CONSUMED` (outcome `SUCCEEDED`, `FAILED` or `UNKNOWN`); `PENDING → REJECTED | EXPIRED | CANCELLED`; `APPROVED → REVOKED | EXPIRED | CANCELLED`. Every change is a single conditional `UPDATE` on the expected previous state and appends a sanitized audit entry (time, event, actor, detail without page values).

**Flow**

1. The run reaches `submit`. The worker writes the step's `started` intent, computes the page fingerprint (URL, target element, form action, method, field names and types, and a hash of field values that is never stored in clear) and the action payload hash (run, step, target, description, page URL, form action/method or link). It creates the step's approval (unique per run and step, so a duplicate request returns the same row), records `awaiting_approval` for the step, moves the run to `AWAITING_APPROVAL`, closes the browser and releases the lease. The workflow waits on signal `approvalDecided` or the approval's expiry.
2. An approver reviews `GET /projects/:projectId/approvals/:approvalId` (proposed action, target, page URL, field names, hashes, expiry, audit) and calls `approve` with the `payloadHash` they reviewed, or `reject`. `cancel` (named `revoke` in this design; see "What was implemented") withdraws a pending or approved, not yet consumed approval. The API signals the workflow; the dispatcher re-signals decided approvals if a signal was lost.
3. The workflow runs the activity again. The worker re-reads the approval: pending and unexpired → keep waiting; rejected, revoked, cancelled or expired → `PARTIAL` with an explicit warning; approved → reopen a fresh session, replay the earlier steps, recompute payload hash and page fingerprint, and atomically consume the approval (`UPDATE … SET status='CONSUMED' WHERE id, run, tenant, project, step, status='APPROVED', unexpired, payload_hash and page_hash equal RETURNING`). Only then does the session receive a one-request write allowance (the approved form's method and action URL, https only, 30 s), and the target is activated without the risky-click refusal. The outcome is recorded on the approval.

**Authorization boundary**

- Approvals are decided only through the authenticated API. The approver identity comes from the bearer token's principal, never from the request body; the principal needs the new `approve` capability and access to the project; by default the approver must differ from the user who submitted the run (`APPROVAL_REQUIRE_DISTINCT_APPROVER=true`).
- Every lookup and decision is scoped by the principal's tenant and project; a client-supplied run or tenant id is never trusted on its own. The decision must echo the reviewed `payloadHash`.
- The worker cannot approve: it can only request, consume (`APPROVED → CONSUMED`) and record outcomes. Consumption checks run, tenant, project, step, status, expiry, payload hash and page fingerprint in one statement, so concurrent attempts cannot both consume.
- Page content and extracted data are untrusted: they are never used to identify or authorize an approval; stored summaries are labels and field names only.

**Retry and crash rules**

- The `started` intent is written before the approval is consumed and the action runs. A later attempt that finds a `started` record without an outcome for that attempt reports the step's outcome as `UNKNOWN`, marks the approval outcome `UNKNOWN`, and ends the run `PARTIAL` (`RESUME_UNSAFE`). It never replays it.
- A consumed approval is never reused: a retry finds it `CONSUMED` and stops (`APPROVAL_ALREADY_CONSUMED`); a retry is never fresh authorization.
- When a run reaches a terminal state, its open approvals are closed (`CANCELLED`); approvals for terminal runs cannot be decided or consumed.

### What was implemented

The design above was implemented with these refinements:

- **API.** All routes are behind `ProjectAccessGuard`, and the scope comes from the bearer token. Request bodies are strict, so extra fields such as `tenantId` or `runId` are rejected with 400.
  - An approval is requested by a run's `submit` step.
  - `GET /projects/:projectId/browser-runs/:runId/approvals` lists a run's approvals.
  - `GET /projects/:projectId/approvals/:approvalId` inspects one approval: action, target, page URL, field names, both hashes, expiry, decision, outcome and audit trail. Reading also expires a due approval.
  - `POST …/approvals/:approvalId/approve` takes `{payloadHash}`.
  - `POST …/approvals/:approvalId/reject` takes `{reason?}`.
  - `POST …/approvals/:approvalId/cancel` takes `{reason?}`. It turns `PENDING` into `CANCELLED` and `APPROVED` into `REVOKED`, and is allowed for an approver or the run's submitter.
  - `POST …/browser-runs/:runId/cancel` now also cancels a run in `AWAITING_APPROVAL` and closes its approvals.
- **Decision checks.**
  - The approver needs the `approve` capability.
  - When `APPROVAL_REQUIRE_DISTINCT_APPROVER` is true (the default), the approver must not be the run's submitter.
  - The run must be `AWAITING_APPROVAL` and the approval `PENDING`.
  - A decision on a terminal run first closes the run's open approvals.
  - Every attempt, including refusals, is written to the audit log by ids and outcome only (`AuditService`), and is also appended to the approval's own audit trail.
- **Crash rule, refined.** A `submit` step can act only after its approval was consumed. Until then its `started` record is not treated as an uncertain outcome:
  - A crash before consumption resumes safely.
  - A crash after consumption without a recorded result ends the run `PARTIAL` with `RESUME_UNSAFE` and `OUTCOME_UNKNOWN`, and sets the approval outcome to `UNKNOWN`.
  - A failure inside the activation itself (`APPROVED_ACTION_UNCERTAIN`) is recorded as `UNKNOWN` and is not retried.
  - A refusal before the click (page changed, no authorization) is recorded as `FAILED`.
- **Pause.** A clean approval pause (`started` followed by `awaiting_approval` from the same attempt) is not uncertain. On resume after approval, earlier steps with known outcomes are replayed to rebuild the page. This includes `type`, because the field values are part of the page fingerprint, and a changed value refuses the approval.
- **Temporal.**
  - `browserWorkflow` handles signal `approvalDecided`. While the run is `AWAITING_APPROVAL`, it waits with `condition()` until the signal arrives or until expiry plus 5 s, then runs the activity again, for at most 20 rounds.
  - The waiting activity returns at once, so no activity, browser or lease is held while waiting.
  - The API signals after each decision, and the dispatcher re-signals runs whose approval was decided or has expired (`awaitingDecision()`).
  - When the dispatcher reconciles a run as cancelled or failed from Temporal, it closes the run's approvals.
- **Write allowance.** It lives only in the page route (`session.allows`) and is granted for one request, with the exact method and action URL, within the domain allowlist, for 30 s. Extension and worker targets still use the strict policy, and the egress proxy still enforces its domain and public-IP checks. Approved form actions must be https, because the proxy sees only `CONNECT` for https.
- **Configuration.** `APPROVAL_TTL_MS` (60000–1200000, default 600000; browser worker) and `APPROVAL_REQUIRE_DISTINCT_APPROVER` (default true; API) are in `.env.example` and `docker-compose.yml`. The TTL bound keeps a decision inside the 30-minute workflow execution timeout.

### Changed files (Phase 5)

- **New:**
  - `src/persistence/migrations/004_approvals.sql`
  - `src/persistence/approval.repository.ts`
  - `src/config/approval.config.ts`
  - `src/browser/tools/browser-consequential.tool.ts`
  - `src/browser/services/approvals.service.ts`
  - `src/browser/controllers/approvals.controller.ts`
  - `tests/persistence/approvals.spec.ts`
  - `test/browser-approvals.e2e-spec.ts`
- **Modified:**
  - `src/persistence/migrate.ts`, `src/persistence/run.repository.ts` (`AWAITING_APPROVAL` transitions, `awaitingDecision`)
  - `src/browser/contracts/browser-step.ts` (`submit`, at most one per run), `src/browser/contracts/browser-action.ts` (`fingerprint`, `approved_activate`), `src/browser/contracts/browser-session.ts`
  - `src/browser/browser-steps.runner.ts`, `src/browser/browser-execution.service.ts`, `src/browser/services/browser.service.ts`, `src/browser/services/session-manager.service.ts`, `src/browser/services/browser-runs.service.ts`, `src/browser/browser-api.module.ts`
  - `src/workflows/browser.workflow.ts`, `src/workers/browser/activity-bindings.ts` (`approval` in the summary), `src/temporal/temporal.service.ts` (`signal`), `src/temporal/dispatch.service.ts`
  - `src/config/configuration.ts`, `src/config/security.config.ts`, `src/common/types/execution-context.ts` (`approve` capability)
  - `.env.example`, `docker-compose.yml`
  - Tests: `tests/browser/browser-steps.spec.ts`, `tests/browser/execution-recovery.spec.ts`, `tests/browser/browser-steps.integration.spec.ts`, `tests/config/configuration.spec.ts`

### Verification (2026-10-22)

| Check | Command | Exit | Result |
| --- | --- | --- | --- |
| Host tests | `npm test` | 0 | 20 suites passed, 2 skipped; 199 tests passed, 34 skipped (Linux-only), 1 todo |
| HTTP e2e | `npm run test:e2e` | 0 | 4 suites passed, 1 skipped; 10 passed, 5 skipped (the existing users suite needs `USER_API_TEST_DATABASE_URL`) |
| Linux browser suite | documented `docker run … swarm-browser-test` with `STAGEHAND_INTEGRATION=1`, run twice (the second time with `--verbose`, after formatting) | 0, 0 | 15 suites passed; 202 and then 203 tests passed (one configuration test was added between the runs), 0 skipped, 1 todo |
| Typecheck | `npx tsc --noEmit -p tsconfig.json` | 0 | |
| Lint | `npm run lint`; `npx oxlint --type-aware tests/` | 0; 0 | only the existing warnings |
| Format | `npx prettier --write`/`--check` on changed and new files | 0 | `browser-execution.service.ts`, `dispatch.service.ts` and `temporal.service.ts` keep the compact style they already had at HEAD |
| Build | `npm run build` | 0 | |
| Compose acceptance | fresh `docker compose -p swarm-p5-verify --env-file <temporary env> -f docker-compose.yml -f <verification overlay> --profile engine up -d --build --wait`, then the Phase 5 acceptance client; stack removed with `down -v` | 0; 0 | migrations `001`–`004` applied; 43 of 43 checks passed |

New tests:

- `tests/browser/browser-steps.spec.ts` (Phase 5, 13 tests):
  - pause and request without activation;
  - a pending approval pauses again with no duplicate request;
  - an approved action is consumed, authorized and activated exactly once, and a retry finds it consumed;
  - rejected, expired, revoked and cancelled approvals fail the step without acting;
  - a changed description is refused with `APPROVAL_PAYLOAD_CHANGED`, and a changed page with `APPROVAL_PAGE_CHANGED`;
  - a failure after activation began is `UNKNOWN` and is not retried, while a refusal before the click is `FAILED`;
  - validation allows one submit per run;
  - resume rules.
- `tests/browser/execution-recovery.spec.ts` (Phase 5, 10 tests; real service and SQL on PGlite, scripted browser):
  - the pause releases the browser and the lease, and a pending wake-up opens no browser;
  - after approval the page is reopened and revalidated and the action runs exactly once, and a duplicate delivery does nothing;
  - rejected, revoked and expired approvals end the run `PARTIAL` without a browser;
  - a page changed after approval is refused and the approval retired;
  - a crash after the action started gives `OUTCOME_UNKNOWN` with a single activation;
  - a crash before consumption resumes and acts once;
  - a final infrastructure failure closes the approval;
  - read-only runs create no approvals.
- `tests/persistence/approvals.spec.ts` (12 tests, PGlite):
  - durable, idempotent request;
  - approve, with audit and workflow signal;
  - reject;
  - capability, distinct approver and payload-hash binding;
  - other tenant or project gets 404 on read, decide, cancel and list;
  - expired approvals cannot be decided or consumed;
  - cancel and revoke, and a consumed approval cannot be revoked;
  - consumption bound to run, step, payload, page and tenant, with exactly one of 4 concurrent consumers succeeding;
  - outcome recorded once;
  - a terminal run closes its approvals;
  - run cancellation cancels the approval;
  - the dispatcher query.
- `test/browser-approvals.e2e-spec.ts` (4 tests, HTTP):
  - at most one submit step;
  - inspect, approve, signal and duplicate approve;
  - 401, 403 and other-tenant 404;
  - payload mismatch 409, and 400 for missing or extra body fields;
  - reject, cancel and run cancel.
- Linux integration (3 tests, real Chromium with a local fixture form):
  - The form is POSTed only after approval, exactly once, with the reviewed values. The approval holds field names but never the typed value. The result page's own second POST is refused, which shows the allowance is single-use.
  - A page changed after approval is not submitted.
  - A plain click on the submit control is still refused.
  - Allowed submissions are answered by the fixture route, never sent to a real server.

**Full-stack acceptance**

Setup:

- **Stack:** a fresh stack (compiled `api`, `migrate`, `orchestration-worker` and `browser-worker`; PostgreSQL; Temporal) against the live www.iana.org, with `APPROVAL_TTL_MS=60000`.
- **Principals:** three random verification principals on project `demo`: a tenant A submitter with `browser`, a tenant A approver with `approve`, and a tenant B approver.
- **Model:** a random fake model key; the mock Messages API was running but unused.
- **Consequential target:** the "IANA-managed Reserved Domains" link, so an approved action is only a GET navigation and nothing real is submitted.

All 43 checks passed:

- **A1 (pause).** The run paused in `AWAITING_APPROVAL` with a durable `PENDING` approval for step 1, bound to the link `href` and a payload hash. The run output names the approval and its expiry. The workflow was `RUNNING` with no pending activity. No lease was held, no Chromium was running, and nothing was activated.
- **A2 (authorization).**
  - Unauthenticated requests got 401.
  - Tenant B, using the same project id, got 404 when reading, listing, approving and cancelling.
  - The submitter got 403 `CAPABILITY_DENIED`.
  - A wrong payload hash got 409 `APPROVAL_PAYLOAD_MISMATCH`.
  - A body carrying `tenantId`/`runId` got 400.
  - The approval was still `PENDING` afterwards.
- **A3 (approval while the worker was down).**
  - The browser worker was stopped and the approval granted; a duplicate approve got 409.
  - For 8 s with no worker, the run kept waiting.
  - After the worker restarted, the run `COMPLETED` with the approval `CONSUMED`/`SUCCEEDED` and exactly one `approved_activate`.
  - Evidence came from `https://www.iana.org/domains/reserved`.
  - Audit trail: `requested, approved, consumed, outcome-succeeded`.
  - The workflow `COMPLETED`; its history contains the signal and no page text.
  - Approving again got 409 `APPROVAL_CONSUMED`.
- **A4 (reject).** The run ended `PARTIAL` with `APPROVAL_REJECTED`, no activation, and the workflow completed.
- **A5 (run cancel while waiting).** The run and its approval became `CANCELLED` (`RUN_CANCELLED`); a later approve got 409 `APPROVAL_CANCELLED`; the workflow was cancelled; nothing was activated.
- **A6 (submitter withdraws).** The run ended `PARTIAL` with `APPROVAL_CANCELLED`.
- **A7 (expiry).** The workflow woke at expiry; the run ended `PARTIAL` with `APPROVAL_EXPIRED` and the approval `EXPIRED`. A later approve got 409, and nothing was activated.
- **A8 (read-only).** A read-only run completed with no approval.
- **A9 (integrity, across all 6 runs).** Every run is terminal, with output and the lease released. No approval is left open, there is at most one activation per run (only for consumed approvals), and approval tenant and project match the run.
- **A10 (audit and secrets).** API audit lines cover `APPROVED`, `REJECTED`, `CANCELLED`, `CAPABILITY_DENIED`, `APPROVAL_PAYLOAD_MISMATCH`, `APPROVAL_APPROVED`, `APPROVAL_CONSUMED`, `APPROVAL_CANCELLED` and `APPROVAL_EXPIRED`. The model key and all bearer tokens are absent from the container logs, a full `pg_dump` and every decoded workflow history. No Chromium processes were left.

Afterwards the stack and its volumes were removed, and the temporary env file and credentials were deleted.

### Remaining limitations and risks

- **Mocks only.** No real Claude call was made. The approval flow uses no model, and the semantic steps are covered only by the mock.
- **No real POST in the stack.** The Compose acceptance uses a link as the consequential target, so the write allowance for real POST submissions is verified only against the local fixture in the Linux suite. In production, an approved form POST goes to the real site through the egress proxy.
- **Page fingerprint scope.** The fingerprint covers URL, target element, form action and method, field names and types, and value hashes. It does not cover other page content, so a page that changes only outside the form still matches. Values that a site's scripts add at submit time are not covered either.
- **Link targets.** For a consequential link, the approved effect is the GET navigation to the reviewed href. A same-site link already allowed by the read policy gains nothing from approval except the bypass of the risky-click check.
- **Approval timing.** `PENDING → APPROVED` can race the worker's `RUNNING → AWAITING_APPROVAL` transition for a moment. An approver who acts in that window gets `APPROVAL_RUN_NOT_WAITING` and must retry.
- **Waiting limits.** Waiting is bounded by the 30-minute workflow execution timeout. A run that is still waiting when the workflow times out is marked `FAILED` by the dispatcher, and its approval is closed.
- **Concurrency evidence.** The concurrent-consumption test runs on PGlite (one connection) and shows the conditional `UPDATE` is single-use. On PostgreSQL the same statement relies on row locking under READ COMMITTED, where the second `UPDATE` re-checks `status='APPROVED'` after the first commits. That is standard behaviour, but no multi-connection load test was run.
- **Approver authentication.** Approvers authenticate with the same static bearer credentials as other principals. There is no second factor or per-decision re-authentication.
- **Not production-ready.** Passing these tests, which rely on mocks and fixtures, does not establish production readiness.
