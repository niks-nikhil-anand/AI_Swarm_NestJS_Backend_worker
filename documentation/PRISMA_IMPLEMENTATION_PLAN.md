# Prisma adoption and database schema plan

> Historical plan. Use the [current PostgreSQL, Prisma and schema plan](POSTGRES_PRISMA_SCHEMA_PLAN.md) for adoption from the existing User/Account Prisma history. Its append-only run-domain baseline strategy supersedes the `0_init` onboarding proposal below; preserve existing committed migrations.

Status: proposed implementation plan. Prepared 1 October 2026 from the current repository. No Prisma packages, application code or database changes have been applied.

Adopt Prisma for typed PostgreSQL access and migration management while preserving existing tables, stored data, API responses and Temporal activity behavior. Deliver schema parity first, migrate database callers second, and add new research entities only as their features are implemented.

## Current database and application

The source schema is `src/persistence/migrations/001_initial.sql`. It defines seven domain tables. The custom migration runner also creates `schema_migrations`. `DatabaseService` wraps a pg pool with a maximum of 10 connections, a 5 second connection timeout and a 10 second statement timeout.

Database callers are `RunRepository`, `SearchExecutionService`, `BrowserExecutionService`, `ArtifactService` and the health controller. SQL semantics tests use PGlite; the HTTP search tests override `DatabaseService`. These tests must change when the provider changes.

Live database contents and drift have not been inspected. Treat every existing database as potentially populated until checked. The older architecture plan describes an earlier planning state; current source files are the implementation reference.

## Decisions and scope

1. Keep PostgreSQL and the existing unified run model. Search, browser and research remain run kinds, rather than three new tables.
2. Use camelCase Prisma fields with `@map` and PascalCase models with `@@map` to preserve physical names.
3. Preserve JSONB payloads and all existing unique keys, foreign keys, defaults and timestamp precision. Preserve application UUID generation in the initial adoption.
4. Keep text statuses initially. Existing run kind and status CHECK constraints remain in migration SQL. Converting them to PostgreSQL enums is a separate migration with data preflight and rollback analysis.
5. Preserve existing foreign key actions explicitly after introspection; do not introduce cascading deletes or nullable-link deletion behavior by accident.
6. Prisma repositories handle database access. Controllers, Temporal workflows and browser tools do not import the generated client. Workflows stay deterministic.
7. Use parameterized Prisma raw SQL for operations that need SQL semantics; avoid unsafe raw APIs. An ORM does not require eliminating every SQL expression.
8. Have one migration owner after cutover. The old SQL runner stops executing once Prisma migration ownership transfers.

Version selection is the first implementation gate. Official documentation currently contains Prisma 7 and materially different Prisma 8 tooling. Check registry release tags and Node compatibility before pinning exact packages. Proposed baseline: the supported stable Prisma 7 line with `prisma`, `@prisma/client`, `@prisma/adapter-pg` and `pg`, all Prisma 7 packages pinned compatibly. If that line is no longer suitable, revise the config, schema and commands for the supported stable release before coding; do not mix Prisma 8 commands with Prisma 7 configuration. Avoid prerelease dependencies by default.

## Initial schema specification

This table is the contract for the first `schema.prisma`, not a claim that a schema has been generated or validated.

| Prisma model | Existing table | Fields and database types | Keys and relations |
| --- | --- | --- | --- |
| Run | runs | id UUID; tenantId, projectId, userId, kind, status, inputHash, idempotencyKey, dispatchState TEXT; input JSONB; output nullable JSONB; createdAt and updatedAt TIMESTAMPTZ | PK id; unique tenantId/projectId/kind/idempotencyKey; index tenantId/projectId/createdAt; parent of queries, results, actions, artifacts, evidence and approvals |
| SearchQuery | search_queries | runId UUID; queryIndex INTEGER; query and status TEXT; warningCodes JSONB | Composite PK runId/queryIndex; FK runId to Run; parent of results |
| SearchResult | search_results | id UUID; runId UUID; queryIndex INTEGER; canonicalUrl TEXT; data JSONB | PK id; unique runId/queryIndex/canonicalUrl; direct Run FK plus composite SearchQuery FK; optional source of evidence |
| BrowserAction | browser_actions | id and runId UUID; sequence INTEGER; kind and status TEXT; data JSONB; createdAt TIMESTAMPTZ | PK id; unique runId/sequence; FK to Run |
| Artifact | artifacts | id and runId UUID; objectKey, mimeType and checksum TEXT; size BIGINT; createdAt TIMESTAMPTZ | PK id; unique objectKey; FK to Run |
| Evidence | evidence | id and runId UUID; sourceResultId nullable UUID; url TEXT; data JSONB; createdAt TIMESTAMPTZ | PK id; unique runId/url; FK to Run; nullable FK to SearchResult |
| Approval | approvals | id and runId UUID; payloadHash and status TEXT; expiresAt TIMESTAMPTZ; decisionBy nullable TEXT | PK id; FK to Run; default status PENDING |
| LegacySchemaMigration | schema_migrations | version TEXT; appliedAt TIMESTAMPTZ | PK version; preserve legacy history during transition |

Use `String @db.Uuid`, `Json @db.JsonB`, `BigInt` and `DateTime @db.Timestamptz(6)` where appropriate. Required/optional fields must match SQL exactly. Preserve defaults QUEUED, PENDING, warningCodes `[]`, and timestamp `now()`. Do not add `@updatedAt` in the parity phase: current code controls when updated_at changes, including writes during idempotent creation.

Explicitly name mapped database constraints and indexes from introspection to prevent unnecessary renames. The SearchResult model has overlapping direct and composite relations using runId; validate its generated client and relation inputs before committing the schema. Keep the composite database foreign key even if customized migration SQL is needed.

Do not create Tenant, Project or User tables yet: their identifiers currently come from configured principals. Do not create an evidence/artifact join table during parity: artifact references currently live in payloads. Approval schema presence does not enable the approval feature.

## Phase 1 Establish compatibility and schema parity

Deliver `prisma/schema.prisma`, `prisma.config.ts`, package pins and lockfile changes, and a documented package compatibility decision.

1. Check installed Node minor version and the selected Prisma release requirements. Review the current NodeNext configuration, CommonJS package behavior, Jest execution and Temporal bundling.
2. Use a disposable PostgreSQL 17 database, apply the existing SQL migration and introspect it. If a real existing database is available, compare its catalog separately without writing credentials to logs.
3. Rename generated model/field identifiers using mappings while retaining physical names and constraints. Capture unsupported database features in reviewed SQL.
4. For the proposed Prisma 7 route, use the `prisma-client` generator with an explicit output under `src/generated/prisma`; configure compatible generated module output. Prove compiled Nest entrypoints and Jest can import it. Do not switch the entire repository to ESM without testing all process entrypoints and workflow bundling.
5. Add explicit format, validate and generate scripts. Ignore generated output in Git and generate before compilation; ensure generated files are included in the actual build output.

Gate: schema validation, client generation, TypeScript compilation and a real PostgreSQL read pass. Schema comparison shows no domain changes. A PostgreSQL fixture is required; PGlite mocks alone cannot satisfy this gate.

## Phase 2 Transfer migration ownership

Deliver a reviewed baseline, a migration runbook and a dedicated migration deployment target.

1. Back up a populated database and verify restoration to a disposable instance. Inventory row counts, IDs, JSON payloads and catalog constraints before migration.
2. Create `prisma/migrations/0_init/migration.sql` that reproduces the full existing schema. Include the legacy history table and CHECK constraints; Prisma schema generation alone may omit database features.
3. For a fresh database, apply the baseline normally. For an existing database, verify its schema matches the baseline and then mark `0_init` applied; never mark a mismatched baseline applied.
4. For Prisma 7, the baseline command is `prisma migrate resolve --applied 0_init`; deployment uses `prisma migrate deploy`. Keep baseline marking as an explicit environment onboarding operation, not a command run blindly on every startup.
5. Disable the custom `src/persistence/migrate.ts` runner in deployment once ownership transfers. Preserve its historical SQL for reference, but make Prisma migrations the only source of future schema changes.
6. Use development migrations only against disposable development databases, with a separate shadow database where required. Use deployment migrations in CI/staging/production. Do not use `db push` or resets to onboard populated databases.

Gate: fresh deployment and populated legacy onboarding both succeed; repeating deployment is safe; data snapshots and constraints remain unchanged. A third fixture with intentional drift is rejected by preflight.

## Phase 3 Add the Nest Prisma provider

Deliver `src/persistence/prisma.service.ts` and wire it through `PersistenceModule`.

Create one client and one bounded adapter pool per process. Reuse validated runtime DATABASE_URL; load CLI environment configuration explicitly and preserve host versus Docker connection strings. For the proposed Prisma 7 route, configure the PostgreSQL adapter and retain the current connection/statement timeout behavior. Define who owns closing the pool and verify shutdown does not leak or close it twice.

Keep raw pg access temporarily for callers not yet migrated, with an explicit total connection budget while two pools coexist. Use transaction-scoped Prisma clients inside transactions; do not mix pg and Prisma calls in one logical transaction. Readiness must perform a bounded database query and redact connection errors. Do not import the runtime Nest configuration into CLI config if it requires unrelated API/browser secrets.

Gate: API and all workers start, connect and shut down correctly; unavailable PostgreSQL yields failed readiness without secret disclosure. Temporal workflow bundles contain no Prisma runtime dependencies.

## Phase 4 Migrate repositories and database callers

Convert callers in the following order, keeping current service method contracts and API output shapes stable:

| Step | Target | Behavior to preserve |
| --- | --- | --- |
| 1 | RunRepository | Scoped lookup, atomic idempotent create, payload hash comparison, guarded transitions, dispatch recovery and evidence upserts |
| 2 | SearchRepository extracted from SearchExecutionService | Completed-query recovery, atomic query/results writes, duplicate-safe upserts, warnings and numeric rank ordering |
| 3 | BrowserRepository extracted from BrowserExecutionService | Action sequence lookup and writes, existing evidence recovery and run-scoped capture |
| 4 | ArtifactRepository extracted from ArtifactService | Metadata insert, owner-scoped lookup through Run, storage cleanup after failed insert |
| 5 | Health controller | Readiness query through the new provider |

Concurrency and data rules:

- Create runs using an atomic unique-key operation. If Prisma upsert is not database-native for the chosen query, handle uniqueness races by fetching the existing row and comparing inputHash. Same key with different input remains HTTP 409.
- Transition runs with an atomic conditional UPDATE/updateMany including id, tenantId, projectId and nonterminal status. Never implement terminal-state protection as an unlocked read followed by an unconditional update.
- Preserve current output behavior: undefined output keeps the old value, while an explicit JSON null is distinct from SQL NULL. Use explicit Prisma JSON null handling and validate JSON payloads at application boundaries.
- Persist query outcomes and results in one transaction. Network requests and browser actions stay outside transactions. Retry serialization/deadlock failures only for bounded, replay-safe database operations.
- Preserve numeric search rank ordering from JSON. Use a reviewed parameterized SQL query or equivalent proven ordering; sorting rank as text changes candidate selection. A normalized rank column belongs in a later migration.
- Keep tenant/project predicates in repositories, including child reads through their owning run. A Prisma relation or UUID lookup is not authorization. Evidence source IDs must resolve to the same authorized run before writes.
- Map known database errors to existing typed service errors; unexpected errors are redacted. Keep 404 behavior for unauthorized/not-found resources.
- Convert artifact BigInt values deliberately at response boundaries. Current sizes are bounded to 10 MB; never return native BigInt in JSON responses.
- Translate Prisma camelCase objects back to current repository/API contracts where necessary; do not let a persistence refactor rename public fields.

Gate: the same requests produce equivalent run states, candidates, warnings, evidence and artifact access decisions with the Prisma-backed implementation.

## Phase 5 Build and deployment integration

Update `Dockerfile`, `infrastructure/docker/Dockerfile`, `infrastructure/chromium/Dockerfile`, `docker-compose.yml`, package scripts and CI together.

Generate the client before the Nest build in every application image. Copy schema/config/migrations to a dedicated migration image that includes the pinned CLI and any config runtime dependencies. Current production images omit devDependencies, so adding the CLI only to devDependencies does not make it available to the existing migration container.

Keep the migration job one-shot and require successful completion before database-dependent processes start. Review the orchestration worker's startup dependency as well. Do not run migrations independently inside every worker. Use a dedicated migration role for DDL where deployment supports it; application credentials need only runtime permissions.

Keep `db:migrate` as the documented deployment entrypoint after cutover, and add explicit `db:migrate:dev`, `prisma:generate`, `prisma:validate` and migration status scripts appropriate to the pinned version. Generation during builds must not require a live database or real deployment credentials.

Gate: clean image builds, fresh Compose startup and existing-database startup pass on a Docker-enabled host. All compiled API and worker paths remain correct.

## Phase 6 Verification and cutover

Update the HTTP provider overrides and repository tests to exercise Prisma. Keep PGlite tests where useful for isolated SQL semantics; use real PostgreSQL for the adapter, migration and concurrency suite. A CI PostgreSQL service can satisfy this requirement when Docker is unavailable locally.

Required acceptance cases:

1. Concurrent identical create requests yield one run; conflicting payloads with the same key yield 409.
2. A terminal run cannot regress when cancellation and a late worker completion race.
3. Duplicate activities preserve query/result/evidence uniqueness and restart warning recovery.
4. Failed search persistence rolls back both query and result writes.
5. Tenant/project isolation holds for runs, results, evidence and artifact downloads.
6. JSON null, absent output, timestamp updates, numeric rank ordering and BigInt boundaries match current contracts.
7. Evidence cannot be linked to a source result from another run/project.
8. Artifact metadata failure removes the uploaded local object as before.
9. Fresh migration, legacy baselining, repeated deployment, intentional drift rejection and backup restoration pass.
10. Build, type checking, unit/API tests, Temporal bundling, browser fixtures and real search/browser/research stack smoke tests pass.

After all callers move, remove DatabaseService and obsolete provider mocks. Retain pg if required by the selected Prisma adapter. Update README and IMPLEMENTATION_STATUS to identify Prisma as the active persistence/migration path and distinguish live verification from local fixture checks.

Rollback during this adoption is an application rollback against the unchanged physical schema. Preserve the baseline migration history; do not reverse it by dropping tables. If a later schema migration is introduced, document a forward repair or tested restore procedure separately.

## Later schema changes for the AI research swarm

These are separate feature migrations after Prisma adoption passes acceptance:

| Feature | Proposed schema change | Gate before adding |
| --- | --- | --- |
| Durable candidate selection | SearchCandidate with run/result linkage, score, rationale and selected state | Define stable selection/retry semantics |
| Agent execution | AgentStep and ModelCall with sequence, budgets, usage, failure state and sanitized inputs/outputs | Implement the bounded LLM loop and retention policy |
| Report synthesis | ResearchReport and Claim with versioned output | Define report and claim contracts |
| Claim provenance | ClaimEvidence linking claims to captured evidence and supported excerpts | Define verification and source coverage behavior |
| Artifact provenance | EvidenceArtifact relation and optional report artifact links | Define deletion and retention behavior |
| Approval handling | Expand Approval with decision timestamp, policy version and validated decision states | Implement authorization and execution flow |
| Identity persistence | Tenant/Project/User relationships | Select the identity provider and ownership lifecycle |

Do not bundle these entities into the baseline. Prisma adoption is complete when current behavior runs through Prisma with a reproducible schema and migration history; it does not complete the AI reasoning or report-generation features.

## Implementation milestones

| Milestone | Deliverable | Completion condition |
| --- | --- | --- |
| A | Version decision, mapped schema and client | Schema parity and runtime compatibility proven |
| B | Baseline and migration runbook | Fresh and populated databases validated |
| C | Nest provider and repository conversion | Behavioral and concurrency tests pass |
| D | Images, CI and rollout | Live stack passes and legacy runner is retired |

Execute A before B/C; execute D after B and C. Keep each milestone reviewable as a separate change. The first concrete implementation task is milestone A, including an actual validated schema against a disposable PostgreSQL instance.

## Reference documentation

- [Prisma 7 configuration and runtime changes](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7): generated client output, PostgreSQL adapter, CLI configuration and pool behavior.
- [Prisma 7 database baselining](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/baselining): preserving existing data while introducing migration history.
- [Prisma PostgreSQL version transition guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/postgresql): materially different Prisma 8 package/configuration conventions; confirm release suitability before installing.
