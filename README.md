# AI Swarm backend

See the [documentation review and overall AI swarm plan](documentation/README.md) for the target architecture, analysis of every design document, implementation phases and acceptance gates.

NestJS API with PostgreSQL persistence, SearXNG search activities, Temporal orchestration and an isolated Playwright/Chromium browser worker.

The API creates project-scoped jobs. An orchestration worker routes activities to separate search and browser queues. Search discovers and ranks candidates; browser activities capture source text and optional screenshots. Stagehand adapters are present but are not enabled until the compatibility gate passes. Captured evidence is source material, not a fact-checked report.

## Folder responsibilities

| Folder                      | Responsibility                                                      |
| --------------------------- | ------------------------------------------------------------------- |
| src/config                  | Validated settings for each process role                            |
| src/common, src/security    | Typed errors, project authorization and audit infrastructure        |
| src/persistence             | Parameterized PostgreSQL repositories and versioned SQL migrations  |
| src/search                  | SearXNG client, normalization, API and persisted execution          |
| src/browser                 | Action contracts, policies, session lifecycle, targets and adapters |
| src/artifacts               | Scoped artifact metadata and local storage                          |
| src/temporal, src/workflows | Dispatch recovery and deterministic workflows                       |
| src/workers/searxng         | Search activity worker                                              |
| src/workers/browser         | Browser activity worker                                             |
| src/workers/orchestration   | Workflow worker                                                     |
| src/research                | Search-to-browser research job API                                  |
| infrastructure              | API/worker images and supporting configuration                      |
| tests, test                 | Unit, SQL, browser fixture and HTTP tests                           |

Prisma 7 models the existing research/search/browser schema and User/Account records. Prisma migrations now own fresh Compose database setup; research execution still uses pg repositories. See [database setup and existing-database onboarding](documentation/DATABASE_SETUP.md). See [User API](documentation/USER_API.md) for CRUD routes, authorization and setup.

## Setup

Use Node.js 24 and Docker with Compose. Copy .env.example to .env only for a fresh checkout; preserve existing credentials.

Configure POSTGRES_PASSWORD, SEARXNG_SECRET, DATABASE_URL for host access and DOCKER_DATABASE_URL for the postgres service hostname. AUTH_CREDENTIALS is a JSON array of server-owned principals with token, tenantId, userId, projectIds and capabilities. Tokens must be unique and at least 32 characters; placeholder tokens are rejected. Use capabilities search, browser and research as appropriate. Keep .env out of Git.

BROWSER_ALLOWED_DOMAINS is an explicit comma-separated list of exact hostnames. The default example.com permits only that host. Add the domains your jobs need.

```sh
npm ci
npm run build
docker compose --profile engine up --build -d
```

The engine profile starts PostgreSQL, SearXNG, a persistent Temporal development server, migration, API and three workers. The API is at localhost:3000, SearXNG at localhost:8080 and Temporal UI at localhost:8233. Published ports bind to loopback. Prisma migration completes before the API and all workers start. Existing databases require the reviewed onboarding in the database setup guide before this migration job runs.

For host-based development, start PostgreSQL, SearXNG and Temporal, then run migration and the processes in separate terminals:

```sh
npm run db:migrate:prisma
npm run start:prod
npm run worker:orchestration
npm run worker:search
npm run worker:browser
```

Install a matching local Chromium with npx playwright install chromium before running the browser worker outside Docker. Host DATABASE_URL, TEMPORAL_ADDRESS and SEARXNG_URL must point to host-accessible ports.

The browser-smoke Compose profile retains the earlier standalone browser runtime. It is separate from the engine worker.

## API

Send Authorization: Bearer <configured-token>. Project access and capabilities come from the configured principal. Creation also requires an Idempotency-Key header; reusing a key with different input returns 409.

| Method and path                                      | Body or behavior                                               |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| POST /projects/:projectId/search-runs                | queries array, optional language, safeSearch and maxCandidates |
| GET /projects/:projectId/search-runs/:runId          | Status and output                                              |
| GET /projects/:projectId/search-runs/:runId/results  | Paginated normalized results                                   |
| POST /projects/:projectId/search-runs/:runId/cancel  | Persist cancellation and request Temporal cancellation         |
| POST /projects/:projectId/browser-runs               | urls array and optional screenshot boolean                     |
| GET /projects/:projectId/browser-runs/:runId         | Status and output                                              |
| POST /projects/:projectId/browser-runs/:runId/cancel | Cancel browser run                                             |
| POST /projects/:projectId/research-runs              | goal string and search object                                  |
| GET /projects/:projectId/research-runs/:runId        | Discovery and capture outcome                                  |
| GET /projects/:projectId/artifacts/:artifactId       | Project-scoped artifact download                               |
| GET /health/live                                     | API liveness                                                   |
| GET /health/ready                                    | PostgreSQL, Temporal and SearXNG readiness                     |

Example search body: {"queries":["example topic"],"safeSearch":1,"maxCandidates":5}.
Example browser body: {"urls":["https://example.com"],"screenshot":true}.
Research currently performs deterministic discovery and capture. The stored goal does not drive an LLM loop.

Runs use QUEUED, RUNNING, COMPLETED, PARTIAL, NO_RESULTS, FAILED and CANCELLED. Pending dispatch is retried; activity writes are idempotent and terminal states cannot regress.

## Browser controls

Internal tools support open, observe, click, type, scroll, extract, screenshot, tabs, back and bounded waits. Each run owns an ephemeral context and egress proxy. Exact domain and public-IP policies, redirect checks, page references, action/tab/time budgets and per-session serialization apply. Form submission and risky actions are denied. Raw JavaScript execution, arbitrary upload and download are not exposed. No public CDP endpoint is published.

## Validation

```sh
npm run build
npx tsc --noEmit --incremental false
npm test -- --runInBand
npm run test:e2e -- --runInBand
npx oxlint src/ test/ tests/ scripts/
npm run browser:compatibility
```

The local test suite uses PGlite for PostgreSQL semantics and real headless Playwright fixture interactions. It does not replace live Compose integration testing. The implementation status records a prior native-helper failure for type-aware lint; reproduce validation on the current host. TypeScript checking and ordinary lint can run separately.

See documentation/IMPLEMENTATION_STATUS.md for verified work and outstanding gates. Temporal start-dev and floating infrastructure image tags are development configuration; production deployment remains a separate phase.
