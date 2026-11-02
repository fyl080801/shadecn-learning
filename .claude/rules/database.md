---
paths:
  - "packages/server-core/src/db/**"
  - "packages/server-core/src/db.ts"
  - "apps/server/db-sync.ts"
  - "packages/*/src/stores.ts"
  - "packages/mod-collab/src/persistence.ts"
  - "packages/mod-canvas/src/flow-docs.ts"
  - "packages/*/src/entities.ts"
  - "packages/server-kit/src/db.ts"
  - "packages/server-kit/src/identity.ts"
  - "packages/server-kit/src/orm.ts"
  - "packages/server-kit/src/schema-sync.ts"
  - "packages/data-access/**"
  - "apps/platform/src/app.module.ts"
  - "packages/config/**"
  - "packages/mod-collab/src/flow-writer.ts"
---

# Database — MikroORM 7, SQLite *or* PostgreSQL (`docs/05-data-persistence.md`)

## Entities (each owner's `entities`, `docs/28` §3.1)

- **Where:** `User` → `@shadecn/server-kit/identity` (every module's FK target); auth tables → `mod-auth`'s `entities.ts`; canvas → `packages/mod-canvas/src/entities.ts`; `FlowAsset` → `mod-storage`; agent → `mod-agent`. `@shadecn/server-core`'s `serverEntities(modules)` concatenates `User` + every listed module's `entities` (regardless of switches/roles). Column helpers (`idColumn`, `newId`, …) and the two-DB rules live in `@shadecn/server-kit/db`; modules get an EntityManager from its `db()`.

- Auth: `User` (unique `(issuer, subject)` — the primary identity's copy; roles as a JSON string), `UserIdentity` (unique `(provider, subject)`; `email` is display-only), `Session` (`provider` = who renews; `id` = the cookie token's HMAC, **set by the caller**), `AuthRequest` (`provider` dispatches the callback, `linkUserId` turns it into linking), `PendingLink` (`user` unique, a retry replaces it).
- Canvas: `Project`, `ProjectMember` (unique `(project, user)`; the creator's admin row is written, never inferred from `createdBy`), `ProjectInvite` (`project` unique; token in the clear — it *is* the credential; `expiresAt` is the only gate — semantics: `docs/13` §3.3), `Flow` (`ydoc` = Yjs bytes, **source of truth**; `graph` = derived JSON projection; both **lazy** — say `populate: ['ydoc']` / `fields: [...]`; `revision` = the server's CAS counter, not a client lock), `FlowUserState` (unique `(flow, user, key)`, JSON-string value; a new partition is a new key, not a schema change), `FlowAsset` (upload record: unique `key` → `flow` + server-observed `contentType`; written by the upload routes (`mod-storage`'s `routes.ts`, via its `assets.ts`) **before** the upload responds — a failed write fails the upload, or the asset can never be proven to belong to that canvas; no URL stored, it is derived from the key).
- Agent (`mod-agent`'s `entities.ts`, REQ-AGENT): `AgentConversation` (FKs to `flow` and `user` with cascade; `messages` / `llmMessages` are lazy JSON strings), audit log `AgentRun` (id = SSE runId; usage columns nullable — null = not recorded, written only by `finishRun`; cost is **integer micro-USD** `costMicroUsd`, rounded once on the run total — there is no decimal type, and PG `int` is 32-bit, so values are clamped, see `mod-agent`'s `stores.ts` `usageColumns`) + `AgentToolCall` (`args` = `digestArgs` output: ids and string *lengths*, never content). Their `conversationId` / `flowId` / `userId` / `runId` / `grantId` are **plain text with no FK on purpose** — the audit trail outlives what it describes. Same for the delegation grant `AgentGrant` (issue-time project / owner snapshot, `expiresAt`, `revokedAt` + `revokeReason` — every revoke writes only where `revokedAt` is null, so the first reason sticks) and `AgentGrantScope` (`onRevoke` holds four values, only `stop` is implemented; `docs/22`).
- Naming: MikroORM's `UnderscoreNamingStrategy`. **Foreign keys are relation properties** (`user`, `project`, `flow`, `createdBy`, `personalOwner` → `user_id`): filter `{ user: userId }`, read `row.user.id`, `populate` for the other side's fields. **Only the owning side is defined** — no inverse collections (`defineEntity` inference degrades to `any`); queries start from the FK table ("my projects" = a `ProjectMember` query). `Flow.createdById`, `ProjectInvite.createdById`, `ProjectMember.invitedById`, `AuthRequest.linkUserId` are plain text, no FK.
- SQLite file: `$DATA_DIR/app.db` (`DATA_DIR` defaults to `<repo>/data`); `DATABASE_URL` overrides; relative `file:` paths resolve against the repo root; the parent dir is `mkdir -p`'d first.

## Two databases, one entity definition, one artifact

- Provider = `DATABASE_PROVIDER` (`sqlite` | `postgresql`), else `DATABASE_URL`'s scheme, else sqlite. Contradictory / unknown / `postgresql` without a URL **throws at startup**. Resolved **once** in `config.ts` (`dbProvider` / `databaseUrl`), read by both server and sync CLI. `@shadecn/server-kit/orm`'s `openOrm` **dynamically imports** only the chosen driver and knows no config (`server-core`'s `db/orm.ts` reads config, adds the logger and calls it). A Prisma-style `?schema=public` is stripped and passed as MikroORM's `schema`.
- **Entity rules** (header of `entities/columns.ts`; each is a measured cross-DB difference):
  - Strings are always `p.text()`, never `p.string()` (`varchar(255)` on PG).
  - Only five types: text / integer / boolean / datetime / blob. No json / enum / array / `columnType`; JSON stays a string.
  - Nullable scalars use `strictNullable()`; `em.create` doesn't fill unset nullable props, so **write `null` explicitly** when the entity goes straight into a response.
  - Timestamp defaults are app-side (`onCreate` / `onUpdate`), never a DB default.
  - Ids are app-generated UUID text (`idColumn()` / `newId()`).
- **Prisma habits that are now bugs**:
  - `nativeUpdate` / `em.insert` / `em.upsert` **skip `onCreate` / `onUpdate`** — every content-changing `nativeUpdate` writes `updatedAt: new Date()` itself (the CAS writes in `collab/persistence.ts` and `collab/flow-writer.ts` matter most). Every `upsert` passes its own `id` + `createdAt` and restricts `onConflictMergeFields`.
  - CAS = `nativeUpdate(Flow, { id, revision: read }, { revision: read + 1, … })`; it returns the affected-row count.
  - Nested writes / `$transaction([...])` → `em.transactional(async (em) => …)`.
  - Unique conflicts throw `UniqueConstraintViolationException` — catch **only** that in "lost the race, re-read" branches.
  - Missing rows: `nativeUpdate` / `nativeDelete` return 0 (no P2025). The OAuth one-shot consume means "the request whose `nativeDelete` returned 1".
- **Case-insensitive search** goes through `@shadecn/server-kit/db`'s `containsIgnoreCase(column, keyword)` (`lower(col) like lower(?) escape '\'` via `raw()`, works in nested relation filters, escapes `%` `_` `\`). Never `$like` / `$ilike` inline (`$ilike` is a syntax error on SQLite). It takes the **column** name, not the property.

## Schema sync — no migration files (`@shadecn/server-kit/schema-sync`)

- `pnpm db:push`, the container's `node server/db-sync.js` and the test global-setup all run the same code: `getUpdateSchemaSQL()` → classify each statement → `schema.execute()` that exact text.
- **`schema.update({ safe: true })` is not a guard** (SQLite rebuilds via `__temp_alter`; PG lets `alter column … type` through). Our guard refuses drop table / drop column / `alter column … type` / any `__temp_alter` rebuild / renames / truncate-delete, prints each with its category and exits 1 without executing. Create table, add column, index changes, add constraint, PG nullability/default changes pass.
- `--force` (`pnpm db:push:force`) lets everything through and also drops non-entity tables (normal mode ignores them with a warning, e.g. old Prisma tables).
- **Costs**: no history, no rollback; both Dockerfiles and the artifact's `db:push` omit `--force` (a failed start beats silent data loss). **Assess whether an entity change is lossy before shipping** — on SQLite even making a column nullable is a rebuild. `db:push:force` stays a separate command so a human sees the refusal.
- Tests (`apps/server/test/db/schema-sync.test.ts`) cover the matcher against SQL MikroORM 7.2.5 actually emitted on both DBs, and pin that **a freshly synced DB produces an empty diff** (an unstable entity would trip the guard on every start).

## `@learning/data-access` — the same rules, inside Nest's startup

- **It has its own copy of the guard, `openOrm` and the column helpers** (`src/schema-sync.ts`, `orm.ts`, `columns.ts`), independent of `@shadecn/server-kit`: a fix to the matcher goes into both, and upgrading MikroORM means re-sampling the SQL in both `test/schema-sync.test.ts` and `apps/server/test/db/schema-sync.test.ts`. The entity rules above apply unchanged.
- **`@shadecn/server` syncs in a separate step before the server starts; `apps/platform` has no such step, so the sync runs in the process** (`docs/05` §3.4.2). There is deliberately no `force` (the option doesn't exist in this copy): the start path never lets a lossy change through, and `SchemaDataLossError` means the service doesn't start.
- **Entities are registered, not listed**: a module writes `{ provide: DATA_ACCESS_ENTITIES, useValue: [...] }` in its own `providers` and the ORM factory walks `ModulesContainer` (`entity-registry.ts`). Measured on Nest 12.3.2: the scanner finishes the whole module graph before any instance is built, so the factory sees every module regardless of `imports` order, and a `useValue` is already on the wrapper. **Only `useValue`**: a factory or class provider may not be built yet, so the result would depend on instantiation order and a missing table would only show at the first query; the factory refuses to start instead. Lazily loaded modules can't register (they load after the factory). No module-level registry: the set must come from what this process imports, so a process without a module creates none of its tables. `DATA_ACCESS_ENTITY_OVERRIDE` (internal, not exported) replaces the whole set for tests.
- **A table left out of the entity set must stay untouched, and `dropTables: false` doesn't do that** (measured on PG, MikroORM 7.2.5): those tables count as removed, and the diff still emits `drop constraint` for foreign keys pointing at them (`orphanedForeignKeys`), which the guard passes and nobody notices. `planSchemaSync` first finds them from a `dropTables: true` diff, then excludes them through `schemaGenerator.skipTables` for the real one. `skipTables` matches by bare name on both sides, so a managed table's name is never added (a same-named table in another schema would otherwise stop the real one being created). SQLite emits nothing here, so only `PLATFORM_TEST_DATABASE_URL` runs catch a regression.
- **The sync lives in the ORM provider's async factory, not in `onModuleInit`.** Measured on Nest 12.3.2: global modules' hooks run in registration order, so a global business module imported first runs before a hook-based sync; and every provider factory runs before any `onModuleInit`, so a factory that queries meets missing tables. As a dependency of `DataAccess`, the factory holds for every consumer wherever it sits in `imports` (`test/data-access.test.ts` pins this; moving the sync to a hook fails it).
- **A throwing factory never reaches `main.ts`'s `await`**: it runs inside `NestFactory.create`, where the default `abortOnError` logs and calls `process.exit(1)`. So the factory closes the ORM first and logs for itself.
- **Unlike `createOrm`, an unreachable database fails the start** (the sync needs a connection).
- **The ORM closes in `onApplicationShutdown`**, the last phase: `onModuleDestroy` and requests still draining use the database. A *global* module imported before `DataAccessModule` gets its `onApplicationShutdown` after the close (hooks run in reverse order).
- **`PLATFORM_DATABASE_URL` from the working directory's `.env` (wins, for URLs with a password), else `database.url` in `config.yaml` (`@learning/config`), never `DATABASE_URL`**: the root `.env`'s value is `@shadecn/server`'s database, and this process would sync it. Each service owns its database. The default is `<dataDir>/platform.db`; a relative `file:` resolves against the repo root, not cwd.
- `PLATFORM_TEST_DATABASE_URL` turns on the PostgreSQL suite. It drops the `public` schema between tests, so the fixture refuses a database whose name doesn't contain both `platform` and `test`.
