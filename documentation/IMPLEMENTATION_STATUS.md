# Implementation status

This records the implementation delivered against SERVICE_IMPLEMENTATION_PLAN.md. Files that remain scaffolds are not counted as implemented services.

| Plan area                  | Delivered                                                                         | Remaining gate                                                  |
| -------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Configuration              | Process-specific validated settings, redacted startup errors                      | Deployment-specific secrets management                          |
| Errors/security            | Typed failures, bearer principals, project/capability enforcement                 | External identity provider and operational audit integration    |
| Persistence                | pg repositories, SQL migration, idempotency and ownership                         | Live PostgreSQL integration                                     |
| SearXNG                    | Bounded JSON client, retries, normalization and persisted candidates              | Live engine/provider integration                                |
| Search worker              | Temporal activities, heartbeat and recovery                                       | Live Temporal worker execution                                  |
| Browser contracts/policies | Typed controlled actions, domain/public-IP proxy, budgets, fresh references       | Production network isolation validation                         |
| Chromium/session lifecycle | Playwright contexts, tabs, serialization and cleanup                              | Linux container sandbox verification                            |
| Adapter compatibility      | Stagehand 4.1.0 adapter and full-Chromium compatibility script                    | Stagehand extension/shared-session/semantic tests               |
| Browser tools              | Deterministic navigation, observation, interaction, DOM extraction and screenshot | Semantic observation/extraction                                 |
| Artifacts                  | Local storage, checksums, scoped metadata/download                                | S3, upload and browser download policy                          |
| Browser worker             | Persisted capture activities and cleanup                                          | Live worker integration                                         |
| Workflows/API              | Search, browser and search-to-browser research workflows                          | Research cancellation API and operational failure scenarios     |
| Agent                      | Research goal accepted and deterministic source capture                           | LLM client, bounded agent loop and evidence synthesis           |
| Cleanup/health             | Session cleanup and API dependency readiness                                      | Artifact retention, worker health endpoints                     |
| Docker                     | API, migration, Temporal and three workers wired into engine profile              | Build/start checks with Docker                                  |
| Tests                      | SQL semantics, auth API, browser fixtures, policy and artifact tests              | Two explicit Stagehand compatibility TODOs and live stack tests |

## Verified locally

Nest build, full TypeScript checking, ordinary oxlint, Jest unit tests and HTTP end-to-end tests pass. Temporal workflow bundling is checked separately. Browser tests exercise real headless Chromium with local fixtures. Production dependency audit reported no vulnerabilities at the time of implementation.

Search restart recovery reconstructs warnings from persisted query outcomes. Proxy tests cover delayed upstream responses. Browser capture closes sessions in finally blocks, including initialization failures.

## Blockers and scope

Docker is not installed or available on this host, so Compose runtime behavior and Linux sandbox behavior remain unverified.

The Playwright headless shell launches successfully here. Full Chromium, required by the Stagehand 4 extension compatibility experiment, fails with spawn UNKNOWN on this host. Stagehand is therefore installed and isolated behind an adapter but is not on the execution path. No semantic compatibility or LLM agent readiness is claimed.

The type-aware lint native helper also fails to spawn on this host. Ordinary lint and tsc are independent passing checks.

Approval records exist in the schema but no approval execution flow is enabled. Current actions deny sensitive submissions. execute_js, uploads, arbitrary browser downloads and authenticated state reuse remain deferred. Research output is captured source text with provenance, not verified claims or a generated final report.

## Next steps

1. On a Docker-enabled machine, run docker compose --profile engine config, build and up; test migrations and health.
2. Exercise search, browser and research jobs against the live stack; interrupt workers to validate retries and cancellation.
3. Pass the full Chromium/Stagehand shared-session compatibility matrix with model credentials and extension support.
4. Add semantic observation/extraction and the bounded browser agent only after that gate passes.
5. Implement approval handling, artifact retention, S3 and worker observability before production rollout.
