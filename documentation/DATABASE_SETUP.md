# PostgreSQL and Prisma setup

PostgreSQL 17 is defined in `docker-compose.yml` with a persistent volume, health check and loopback-only port. Prisma models users/accounts and the existing run, search, browser action, artifact, evidence and approval tables. Research services still use their current pg repositories; this change establishes schema and migration ownership without changing API behavior.

## Fresh local database

Preserve an existing `.env`. For a new checkout, copy `.env.example` and replace password/secret/token placeholders. Keep host `DATABASE_URL` and container `DOCKER_DATABASE_URL` pointed at the same intended database using their respective hostnames.

```sh
npm ci
npm run prisma:validate
npm run build
docker compose --profile engine up --build -d
```

The `migrate` service uses the dedicated `migration` Docker build target, which includes the pinned Prisma CLI, config and migrations. It applies identity and run-domain migrations once before the API and workers start. Application runtime images do not need the Prisma CLI. `prisma generate` generates code; it does not create database tables.

For host execution against an empty PostgreSQL database:

```sh
npm run db:migrate:prisma
```

Use Prisma migrations for all future schema changes. `npm run db:migrate` now delegates to Prisma deployment. The old SQL runner is available only as `npm run db:migrate:legacy` for historical compatibility and is no longer the Compose deployment command. Do not alternate migration owners or run the legacy runner after schema evolution.

## Existing databases: explicit onboarding

The new `20261022000000_add_run_domain` migration deliberately uses ordinary CREATE statements and fails rather than silently accepting an existing or mismatched table. Do not start the new migration job blindly against an existing unbaselined database.

1. Back up the database and verify restoration into a disposable clone.
2. Inventory `_prisma_migrations`, `schema_migrations`, users/accounts and all seven run-domain tables. Check defaults, constraints, indexes, foreign-key actions, timestamp precision and row counts.
3. Verify identity history matches the two existing committed migrations. If identity tables are missing, apply those migrations on the clone before onboarding the run baseline. A temporary migration directory containing only the existing identity history can establish this boundary; do not edit the committed history or let an unrestricted deploy reach the run baseline prematurely.
4. If the run-domain tables already exist, compare their catalog to the new migration's DDL. The expected legacy history is `schema_migrations` with version `001`. Reconcile differences explicitly; do not infer parity from table names alone.
5. Only after exact parity is established, mark this specific migration applied against that verified environment:

   ```sh
   npx prisma migrate resolve --config prisma7.config.ts --applied 20261022000000_add_run_domain
   npm run db:migrate:prisma
   ```

6. Verify data counts/constraints and run the API/worker smoke tests. Repeat the tested onboarding on the intended environment during a controlled deployment.

If identity tables exist without matching Prisma history, or any table is drifted, establish reviewed matching history/forward repair before resolve/deploy. Do not reset, drop tables, rewrite applied migrations, or mark a mismatched baseline applied. Existing identity migration checks for missing/duplicate global emails and IDs must be resolved rather than bypassed.

## Schema rules

- Run kinds/statuses remain text with SQL CHECK constraints; Prisma model generation does not replace those constraints.
- Existing run timestamps, application-generated UUIDs, nullable JSON and no-action foreign keys are preserved.
- User/Account IDs remain text; configured run actors do not automatically become User foreign keys.
- Features such as task graphs, model usage, claims and reports remain separate future migrations in the [database plan](POSTGRES_PRISMA_SCHEMA_PLAN.md).
