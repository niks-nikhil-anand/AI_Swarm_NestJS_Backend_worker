# PostgreSQL, Prisma and AI Swarm schema plan

Status: proposed implementation. Prepared 22 October 2026 against current repository source. This document specifies database architecture, schema, migration ownership and delivery gates; it does not apply migrations or change `schema.prisma`.

## Implementation follow-up

Parity model definitions and an append-only run-domain migration have now been added, together with the Compose migration image/job and startup dependencies. Existing pg services are preserved; full repository conversion and live onboarding verification remain separate gates. See [database setup](DATABASE_SETUP.md).

## 1. Architecture and decisions

```text
NestJS API / search worker / browser worker / future reasoning workers
  -> Domain repositories (trusted tenant/project scope)
  -> PrismaService + PostgreSQL adapter
  -> PostgreSQL 17
       identity & memberships | runs & dispatch | search & browser
       evidence & claims      | tasks & models | reports & approvals

Temporal: durable orchestration and activity scheduling
Object storage: screenshots, captures and report binaries
PostgreSQL: ownership, metadata, relationships, budgets and audit history
```

Use the existing PostgreSQL database and pinned Prisma 7 packages initially. Keep `prisma7.config.ts`, explicit generated-client output and current CommonJS compatibility until runtime tests justify changing them. This is a repository-specific plan, not an assertion about the latest available dependency versions.

Use one repository and database initially, with one dedicated migration job. API/workers must not independently apply DDL. Temporal workflows import serializable contracts only, never Prisma, Nest providers or database clients. Network/browser/model work runs outside database transactions.

Keep unified `Run` records for `search`, `browser` and `research`. Specialist tasks belong to a run; do not introduce three competing root-run tables. Store large binaries in object storage with database metadata and authorized access.

## 2. Current baseline

| Area | Existing implementation | Target |
| --- | --- | --- |
| Database | PostgreSQL 17 Compose service and persistent volume | Same engine with measured capacity, backups, restore and production configuration |
| Research persistence | `pg` through DatabaseService, RunRepository and SQL in execution/artifact/health services | Prisma-backed domain repositories with behavior parity |
| Identity persistence | Prisma User/Account models, migrations and CRUD | Preserve global identities; add scoped memberships separately |
| Migrations | Legacy SQL runner for seven domain tables plus `schema_migrations`; Prisma history for users/accounts | A single Prisma migration history after reviewed onboarding |
| Runtime | Separate pg and Prisma pools, each configured up to 10 connections when instantiated | One intended adapter pool per process after cutover, explicit total connection budget |
| Storage | Local artifact files and metadata | Storage interface supporting local development and S3-compatible deployment |

Source references: [legacy schema](../src/persistence/migrations/001_initial.sql), [Prisma schema](../prisma/schema.prisma), [Prisma history](../prisma/migrations/), [SQL runner](../src/persistence/migrate.ts), [database provider](../src/persistence/database.service.ts), [Prisma provider](../src/persistence/prisma.service.ts).

Important: existing User IDs and Account IDs are PostgreSQL `TEXT`; run-domain IDs are `UUID`. Do not silently convert identity IDs to UUID or add a foreign key from `runs.user_id` before configured principal identities have been reconciled. The existing `users` capability authorizes global administration, not tenant membership.

## 3. Schema layer A — exact parity first

Add the following models to the existing Prisma schema without changing physical domain behavior. Retain User, Account and AccountProvider as implemented. Field names below are application names; use `@map`/`@@map` for existing snake_case names. Determine physical constraint names and FK actions from an actual PostgreSQL catalog before finalizing mappings.

| Model / physical table | Fields and types | Keys, relationships and parity requirements |
| --- | --- | --- |
| Run / `runs` | id UUID; tenantId/projectId/userId TEXT; kind/status TEXT; input JSONB; inputHash TEXT; output nullable JSONB; idempotencyKey/dispatchState TEXT; createdAt/updatedAt TIMESTAMPTZ(6) | PK id; unique tenantId+projectId+kind+idempotencyKey; index tenantId+projectId+createdAt; preserve existing kind/status CHECKs and QUEUED/PENDING defaults |
| SearchQuery / `search_queries` | runId UUID; queryIndex INT; query/status TEXT; warningCodes JSONB | Composite PK runId+queryIndex; Run FK; preserve warningCodes default `[]` |
| SearchResult / `search_results` | id UUID; runId UUID; queryIndex INT; canonicalUrl TEXT; data JSONB | PK id; unique runId+queryIndex+canonicalUrl; direct Run FK and composite SearchQuery FK |
| BrowserAction / `browser_actions` | id/runId UUID; sequence INT; kind/status TEXT; data JSONB; createdAt TIMESTAMPTZ(6) | PK id; unique runId+sequence; Run FK |
| Artifact / `artifacts` | id/runId UUID; objectKey/mimeType/checksum TEXT; size BIGINT; createdAt TIMESTAMPTZ(6) | PK id; unique objectKey; Run FK; convert BigInt at API boundary |
| Evidence / `evidence` | id/runId UUID; sourceResultId nullable UUID; url TEXT; data JSONB; createdAt TIMESTAMPTZ(6) | PK id; unique runId+url; Run FK and nullable SearchResult FK |
| Approval / `approvals` | id/runId UUID; payloadHash/status TEXT; expiresAt TIMESTAMPTZ(6); decisionBy nullable TEXT | PK id; Run FK; preserve PENDING default |
| LegacySchemaMigration / `schema_migrations` | version TEXT; appliedAt TIMESTAMPTZ(6) | PK version; preserve history; no domain callers should mutate it |

Rules for parity:

- Use `String @db.Uuid`, `String @db.Text`, `Json @db.JsonB`, `BigInt`, and `DateTime @db.Timestamptz(6)` as appropriate.
- Preserve application UUID generation and existing nullability/defaults. Do not add `@updatedAt` to Run during parity; existing code controls timestamp writes. Keep existing User/Account `@updatedAt` behavior.
- Keep run kinds/statuses as TEXT initially. Preserve CHECK constraints through reviewed SQL; do not infer Prisma enums from plan diagrams.
- Preserve no-action/default FK behavior of existing run-domain tables. Do not add cascading deletion during ORM conversion. Account-to-User cascading deletion is existing identity behavior and must remain intact.
- Validate overlapping SearchResult runId relations against generated client inputs while preserving the composite query FK in PostgreSQL.
- Preserve absent output versus JSON null versus SQL NULL, scoped 404s, numeric ranking from JSON and 409 idempotency conflicts.
- Do not add future feature columns/tables in the parity migration.

Parity acceptance: schema catalog and representative data snapshots are unchanged, except migration metadata; all current API and activity contracts remain stable.

## 4. Schema layer B — identity and project ownership

Add only after deciding how external/configured principals map to persisted membership. Keep global User and OAuth accounts; authorization belongs in tenant/project membership tables.

| Proposed model | Key fields | Constraints and behavior |
| --- | --- | --- |
| Tenant | id TEXT, name, status, createdAt, updatedAt | Preserve current tenant identifiers rather than inventing new UUID mappings |
| Project | id TEXT, tenantId TEXT, name, status, timestamps | Composite PK tenantId+id supports current project IDs that may repeat across tenants |
| TenantMember | tenantId, userId TEXT, role, status, timestamps | PK tenantId+userId; Tenant/User FKs |
| ProjectMember | tenantId, projectId, userId TEXT, role, status, timestamps | PK tenantId+projectId+userId; Project and TenantMember composite FKs |
| PrincipalBinding | issuer, subject, userId TEXT, status, timestamps | Unique issuer+subject; verified identity-provider mapping to User |

Backfill Tenant/Project from current run ownership and reconciled principal configuration. Inventory orphan `user_id` values, service principals and historical actors; explicitly map or preserve them before adding identity FKs. Keep historical runs when a user is disabled/deleted. Define soft deletion and any restriction on global user deletion before introducing restrictive membership/run relations.

Add `Run -> Project(tenantId,id)` only after the backfill and validation pass. If service principals need separate persistence, define an Actor model and migration explicitly rather than forcing them into fake user accounts.

Gate: cross-tenant membership cannot be created; existing authorized principals retain intended access; administrative user CRUD remains explicitly privileged.

## 5. Schema layer C — research reasoning and swarm features

These are proposed feature migrations after parity. Add a table together with its service behavior, retention rules and tests.

| Model | Core fields | Required relationships and uniqueness |
| --- | --- | --- |
| SearchCandidate | id, runId, sourceResultId, score, rationale, selectionVersion, selected, createdAt | Unique runId+selectionVersion+sourceResultId; source result must belong to the same run |
| AgentTask | id, runId, logicalKey, role, status, input/output JSONB, attempt, maxAttempts, startedAt, finishedAt | Unique runId+logicalKey; all tasks inherit run ownership |
| TaskDependency | runId, taskId, dependsOnTaskId | PK taskId+dependsOnTaskId; same-run composite FKs; no self-edge CHECK; service validates acyclic graph and depth |
| AgentStep | id, runId, taskId, sequence, kind, status, decision JSONB, errorCode, createdAt | Unique taskId+sequence; same-run task FK; never persist live browser handles |
| ModelCall | id, runId, taskId?, stepId?, logicalCallKey, attempt, provider/model, promptVersion/schemaVersion, status, token counts, estimated/actual cost, duration, timestamps | Unique runId+logicalCallKey+attempt; same-run links; cost in explicit currency minor units using BIGINT, not floating point |
| RunBudget | runId, currency, limit/reserved/spent cost, tokenLimit/reserved/used, actionLimit/used, deadlineAt, version | PK runId; nonnegative CHECKs; atomic guarded reservations and settlement |
| Claim | id, runId, claimKey, version, text, supportStatus, createdAt | Unique runId+claimKey+version; support status is not a subjective model confidence score |
| ClaimEvidence | runId, claimId, evidenceId, relation, excerpt, location JSONB | Same-run FKs; stable link key or unique claimId+evidenceId+location digest; relation supports support/contradiction/context |
| Verification | id, runId, claimId, verifierTaskId, verdict, rationale, evidenceSetHash, createdAt | Same-run FKs; retains independent verification history |
| ResearchReport | id, runId, version, status, content JSONB, summary, createdAt | Unique runId+version; versioned report output |
| ReportClaim | runId, reportId, claimId, ordinal | PK reportId+claimId; same-run FKs; unique reportId+ordinal |
| EvidenceArtifact | runId, evidenceId, artifactId, purpose | Composite PK evidenceId+artifactId+purpose; same-run FKs; prevents retention from deleting referenced captures |
| RunEvent | id, runId, sequence, type, payload JSONB, createdAt | Unique runId+sequence; durable progress cursor and redacted payload |
| RunCommand | id, runId, kind, dedupeKey, payload JSONB, status, attempts, nextAttemptAt, deliveredAt | Unique runId+dedupeKey; durable cancellation/signal delivery and reconciliation |
| AuditEvent | id, tenantId, projectId?, runId?, actorRef, eventType, targetRef, outcome, requestId, createdAt | Append-only through runtime permissions; indexed by scope/time; sanitize payloads |

Evidence currently upserts by run+URL. Before report generation, add immutable EvidenceSnapshot records (id, runId, evidenceId, captureVersion, contentHash, retrievedAt, content/object reference) or make evidence captures immutable through a reviewed contract change. Claims and report citations must reference the exact snapshot they were verified against; a later recapture must not silently change published report support.

Expand Approval separately with action type, destination, payload/policy hash, requester/decider references, decisionAt, expiresAt, consumedAt and status. Store no reusable browser handles. Consume an approved action atomically, reject expiry/replay, and revalidate policy after browser recreation. Schema alone does not enable execution.

## 6. Integrity and access rules

1. Resolve every request using trusted tenant/project context. Find child records through the owning run or enforce equivalent predicates; a UUID lookup alone is not authorization.
2. Add composite unique `(run_id,id)` keys to referenced feature tables where needed, then composite child FKs `(run_id,parent_id)` to prevent cross-run linkage. This is a feature-hardening migration, not parity.
3. Restrict database writes for audit history and use explicit retention procedures. Do not cascade-delete evidence supporting retained reports.
4. Use transactions for query/results writes, task transitions, usage reservations and approval consumption. Never hold a transaction across model calls or browser navigation.
5. Use compare-and-set updates and uniqueness constraints for idempotency, terminal-state protection and concurrent task claims. Bound retries for serialization/deadlock failures.
6. PostgreSQL row-level security can be added as defense in depth after membership design. If adopted, set tenant scope with transaction-local settings on the same connection, test pool reuse, and prevent runtime roles from bypassing policies. Do not claim RLS exists today.
7. Store secrets outside routine JSON payloads/logs. Existing Account token columns need a deliberate encryption/key-rotation and retention policy before production OAuth use.

## 7. Migration strategy — preserve the existing Prisma history

Do not rewrite or rename existing committed User/Account migrations. In particular, a new historical `0_init` baseline must not be inserted blindly ahead of migrations that may already have been applied.

Recommended route: append a reviewed run-domain baseline migration **after the two existing identity migrations**. It creates the exact legacy domain tables and legacy history table on a fresh database. For a populated legacy domain, prove catalog parity and explicitly mark that new baseline applied during onboarding. Use a migration name chosen at implementation time; record it in the runbook and use that exact name for any resolve operation.

| Environment | Required procedure |
| --- | --- |
| Empty database | Deploy existing User/Account migrations, then new run-domain baseline and later feature migrations in order |
| Legacy domain exists; identity migrations already recorded | Validate domain parity, mark only the new run-domain baseline applied, then deploy later migrations |
| Legacy domain exists; identity tables absent | Deploy identity migrations with an explicit boundary before the domain baseline, validate domain parity, mark domain baseline applied, then deploy later changes; test this exact onboarding sequence on a clone |
| Identity tables exist without matching Prisma history | Reconstruct and verify actual identity state first; establish reviewed history for matching migrations only, then onboard the domain baseline |
| Drift or partially failed migration | Stop onboarding; reconcile against a restored clone and document forward repair; never mark mismatched SQL as applied |

Before starting: inspect `_prisma_migrations`, `schema_migrations`, actual catalogs, row counts, nullable values, orphan relations and identity conflicts. Back up and restore a clone. Existing identity migration SQL deliberately rejects missing emails or duplicate global IDs/emails; preflight these rather than bypassing the check.

Do not use reset, `db push`, table drops or generic “ignore already exists” SQL to onboard production data. Freeze the legacy runner at ownership transfer. Disable its deployment command before permitting new Prisma feature migrations. Keep old SQL/history for audit and rollback reference.

## 8. Phase-wise implementation checklist

| Database phase | Deliverable and exact scope | Acceptance gate |
| --- | --- | --- |
| DB0 — inventory | Capture schema/history, data invariants, current pool usage and restore proof | Empty and populated clones available; baseline compatibility decision recorded |
| DB1 — schema parity | Extend `prisma/schema.prisma` with layer A; retain current identities/config; validate/generate | No unintended table/column/constraint changes; compiled client usable by API/workers/tests |
| DB2 — migration ownership | Append run baseline; implement clone-tested onboarding paths; dedicated migration image/job | Empty setup, populated onboarding, repeated deploy and intentional drift rejection pass |
| DB3 — repository conversion | RunRepository → search repository → browser repository → artifact repository → readiness | API behavior, numeric ordering, JSON/null, concurrency, ownership and duplicate-delivery cases pass on PostgreSQL |
| DB4 — deployment cutover | Generate client in images; one-shot migration before database consumers; remove legacy runtime path after verification | API and three workers start/recover/shut down; database connection budget respected |
| DB5 — ownership | Tenant/project/member/principal models and reviewed backfill | No orphan or cross-tenant memberships; configured principal continuity; deletion semantics verified |
| DB6 — agent/evidence/report | Candidate, step/model/budget, immutable evidence snapshots, claims and reports | Budget reservations, exact citations and retry-safe outputs verified |
| DB7 — swarm/product | Tasks/dependencies, events, commands, approvals and audit | Bounded DAG, durable cancel/signal delivery, event replay and approval expiry/replay tests pass |
| DB8 — production | Index tuning, roles/TLS, backups, retention, observability and optional RLS | Restore, load, isolation and least-privilege checks meet release targets |

Current completion:

- [x] PostgreSQL local service and legacy domain schema exist.
- [x] Prisma User/Account schema, provider, migrations and CRUD exist.
- [x] Generated-client build hook and Prisma migration scripts exist.
- [ ] DB0–DB4 acceptance gates for full domain adoption remain open.
- [ ] DB5–DB8 schema and service features remain pending.

## 9. Repository change map

| Path | Planned change |
| --- | --- |
| `prisma/schema.prisma` | Add parity models first; feature models in later migrations |
| `prisma/migrations/` | Preserve existing identity history; append baseline and separately scoped feature migrations |
| `prisma7.config.ts` | Retain explicit schema/migration paths and CLI database URL loading |
| `src/persistence/prisma.service.ts` | Shared bounded adapter lifecycle; transaction-scoped repository usage |
| `src/persistence/run.repository.ts` | Preserve public contract while replacing pg implementation |
| `src/search/`, `src/browser/`, `src/artifacts/` | Extract SQL into domain repositories; business execution depends on repository interfaces |
| `src/health/health.controller.ts` | Bounded readiness through selected provider; worker readiness remains separate |
| `src/persistence/migrate.ts` | Retire from active deployment only after cutover acceptance |
| `Dockerfile`, worker Dockerfiles, `docker-compose.yml` | Add dedicated Prisma migration target/job, schema assets and startup ordering |
| `package.json` | Keep generation/validation; document deploy/onboarding entrypoints; add dev/status commands only after checking pinned CLI behavior |
| `tests/persistence/`, `test/` | Real PostgreSQL migration/repository/concurrency cases plus compatible API provider overrides |
| `documentation/IMPLEMENTATION_STATUS.md` | Record exact applied migration boundary and verification evidence |

## 10. PostgreSQL operation and performance plan

- Keep separate host and container URLs. Validate the configured PostgreSQL schema consistently across pg, Prisma CLI and runtime; do not accidentally migrate one schema and serve another.
- Use runtime DML credentials and dedicated migration DDL credentials. Production connections require the deployment's TLS settings; do not log URLs or credentials.
- Calculate the connection ceiling as the sum of replicas × instantiated pool maxima plus migration/operations headroom. Existing API can instantiate both pools; keep coexistence explicit and eliminate the extra run-domain pool after cutover.
- Start with existing indexes. Use query plans before adding dispatch-state/time, status/time, foreign-key, event cursor and task scheduling indexes. Large-table index changes need deployment-specific lock/time budgets.
- Prefer keyset pagination for new events/tasks/reports. Preserve current user/search API pagination until a versioned contract change.
- Monitor connection saturation, lock waits, slow queries, migration duration, database/storage growth and backup health. Set statement/lock/idle-transaction timeouts per workload.
- Treat JSONB as versioned bounded payloads. Promote fields required for joins/filtering/ranking into typed columns through separate backfilled migrations; avoid blanket GIN indexes.
- Define backup cadence and RPO/RTO from product requirements, then prove a database-and-object-store restore. A persistent Docker volume is not a backup.

## 11. Required validation matrix

- [ ] Client generation, build, TypeScript and deterministic workflow bundling with no Prisma runtime in workflow bundles.
- [ ] Exact parity against PostgreSQL catalogs, including CHECKs, composite FKs, defaults and deletion actions.
- [ ] Fresh database, each populated onboarding path, repeated migration deployment and deliberate drift rejection.
- [ ] Concurrent same-key create yields one run; different payload returns 409.
- [ ] Cancel/complete races cannot regress terminal state; durable commands retry after dependency outage.
- [ ] Duplicate activities, atomic query/results rollback, numeric ranks, JSON-null and BigInt boundaries remain correct.
- [ ] Cross-run/project source, evidence, task, report and artifact linkage is rejected.
- [ ] Concurrent budget reservation cannot overspend; cancelled reservations settle/release once.
- [ ] Recapture cannot change existing report support; approval consumption is atomic and replay-safe.
- [ ] Account cascade deletion remains correct while new memberships/historical ownership follow their documented deletion policy.
- [ ] Every application image starts from a clean database and from a migrated clone; workers do not run migrations themselves.
- [ ] Backup restoration, resource limits, pool shutdown and unavailable-database readiness are demonstrated.

PGlite and mocked providers remain useful unit tools, but real PostgreSQL is required for adapter, migration, concurrency and production acceptance. No commands or gates above have been run as part of writing this plan.
