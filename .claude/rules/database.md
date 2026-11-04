---
paths:
  - "packages/data-access/**"
  - "packages/*/src/stores.ts"
  - "packages/*/src/entities.ts"
  - "packages/canvas/src/flow-doc.store.ts"
  - "packages/collab/src/flow-persistence.ts"
  - "packages/collab/src/flow-writer.ts"
  - "apps/platform/src/app.module.ts"
  - "packages/config/**"
---

# Database — MikroORM 7, SQLite *or* PostgreSQL (`docs/05-data-persistence.md`)

## Entities (each owner's `entities.ts`)

- **Where:** `User` → `@learning/data-access` (every module's FK target); auth tables → `packages/session`; canvas → `packages/canvas`; `FlowAsset` → `packages/storage`; `AppTask` → `packages/apps`; agent → `packages/agent-service`. Each registers its own (below). Column helpers (`idColumn`, `newId`, `containsIgnoreCase`, …) and the two-DB rules live in `packages/data-access/src/columns.ts`; modules inject `DataAccess`. **`em()` forks per call: one per operation (or per group sharing a transaction)**; `allowGlobalContext` is off and there's no RequestContext middleware, so stores work outside requests.

- Auth: `User` (unique `(issuer, subject)` — the primary identity's copy; roles as a JSON string), `UserIdentity` (unique `(provider, subject)`; `email` is display-only), `Session` (`provider` = who renews; `id` = the cookie token's HMAC, **set by the caller**), `AuthRequest` (`provider` dispatches the callback, `linkUserId` turns it into linking), `PendingLink` (`user` unique, a retry replaces it).
- Canvas: `Project`, `ProjectMember` (unique `(project, user)`; the creator's admin row is written, never inferred from `createdBy`), `ProjectInvite` (`project` unique; token in the clear — it *is* the credential; `expiresAt` is the only gate — semantics: `docs/13` §3.3), `Flow` (`ydoc` = Yjs bytes, **source of truth**; `graph` = derived JSON projection; both **lazy** — say `populate: ['ydoc']` / `fields: [...]`; `revision` = the server's CAS counter, not a client lock), `FlowUserState` (unique `(flow, user, key)`, JSON-string value; a new partition is a new key, not a schema change), `FlowAsset` (upload record: unique `key` → `flow` + server-observed `contentType`; written by the upload routes (`packages/storage`'s `AssetsController` via `FlowAssets`) **before** the upload responds — a failed write fails the upload, or the asset can never be proven to belong to that canvas; no URL stored, it is derived from the key).
- Agent (`packages/agent-service/src/entities.ts`, REQ-AGENT): `AgentConversation` (FKs to `flow` and `user` with cascade; `messages` / `llmMessages` are lazy JSON strings), audit log `AgentRun` (id = SSE runId; usage columns nullable — null = not recorded, written only by `finishRun`; cost is **integer micro-USD** `costMicroUsd`, rounded once on the run total — there is no decimal type, and PG `int` is 32-bit, so values are clamped, see `stores.ts` `usageColumns`) + `AgentToolCall` (`args` = `digestArgs` output: ids and string *lengths*, never content). Their `conversationId` / `flowId` / `userId` / `runId` / `grantId` are **plain text with no FK on purpose** — the audit trail outlives what it describes. Same for the delegation grant `AgentGrant` (issue-time project / owner snapshot, `expiresAt`, `revokedAt` + `revokeReason` — every revoke writes only where `revokedAt` is null, so the first reason sticks) and `AgentGrantScope` (`onRevoke` holds four values, only `stop` is implemented; `docs/22`).
- Naming: MikroORM's `UnderscoreNamingStrategy`. **Foreign keys are relation properties** (`user`, `project`, `flow`, `createdBy`, `personalOwner` → `user_id`): filter `{ user: userId }`, read `row.user.id`, `populate` for the other side's fields. **Only the owning side is defined** — no inverse collections (`defineEntity` inference degrades to `any`); queries start from the FK table ("my projects" = a `ProjectMember` query). `Flow.createdById`, `ProjectInvite.createdById`, `ProjectMember.invitedById`, `AuthRequest.linkUserId` are plain text, no FK.
- Connection: `PLATFORM_DATABASE_URL` from the working directory's `.env` (wins, for URLs with a password), else `database.url` in `config.yaml`. The default is `<dataDir>/platform.db`; a relative `file:` resolves against the repo root, not cwd; the parent dir is `mkdir -p`'d first. Each service owns its database, because this process syncs the schema of whatever it's pointed at.

## Two databases, one entity definition, one artifact

- Provider = the URL's scheme (`file:` = SQLite). `orm.ts`'s `openOrm` **dynamically imports** only the chosen driver and knows no config. A Prisma-style `?schema=public` is stripped and passed as MikroORM's `schema`.
- **Entity rules** (header of `columns.ts`; each is a measured cross-DB difference):
  - Strings are always `p.text()`, never `p.string()` (`varchar(255)` on PG).
  - Only five types: text / integer / boolean / datetime / blob. No json / enum / array / `columnType`; JSON stays a string.
  - Nullable scalars use `strictNullable()`; `em.create` doesn't fill unset nullable props, so **write `null` explicitly** when the entity goes straight into a response.
  - Timestamp defaults are app-side (`onCreate` / `onUpdate`), never a DB default.
  - Ids are app-generated UUID text (`idColumn()` / `newId()`).
- **Prisma habits that are now bugs**:
  - `nativeUpdate` / `em.insert` / `em.upsert` **skip `onCreate` / `onUpdate`** — every content-changing `nativeUpdate` writes `updatedAt: new Date()` itself (the CAS in `packages/canvas/src/flow-doc.store.ts` matters most). Every `upsert` passes its own `id` + `createdAt` and restricts `onConflictMergeFields`.
  - CAS = `nativeUpdate(Flow, { id, revision: read }, { revision: read + 1, … })`; it returns the affected-row count.
  - Nested writes / `$transaction([...])` → `em.transactional(async (em) => …)`.
  - Unique conflicts throw `UniqueConstraintViolationException` — catch **only** that in "lost the race, re-read" branches.
  - Missing rows: `nativeUpdate` / `nativeDelete` return 0 (no P2025). The OAuth one-shot consume means "the request whose `nativeDelete` returned 1".
- **Case-insensitive search** goes through `columns.ts`'s `containsIgnoreCase(column, keyword)` (`lower(col) like lower(?) escape '\'` via `raw()`, works in nested relation filters, escapes `%` `_` `\`). Never `$like` / `$ilike` inline (`$ilike` is a syntax error on SQLite). It takes the **column** name, not the property.

## Schema sync — no migration files (`packages/data-access/src/schema-sync.ts`)

- **There is no separate step: the sync runs in the process, during startup** (`docs/05` §3.4.2): `getUpdateSchemaSQL()` → classify each statement → `schema.execute()` that exact text.
- **`schema.update({ safe: true })` is not a guard** (SQLite rebuilds via `__temp_alter`; PG lets `alter column … type` through). Our guard refuses drop table / drop column / `alter column … type` / any `__temp_alter` rebuild / renames / truncate-delete, prints each with its category and throws `SchemaDataLossError` without executing. Create table, add column, index changes, add constraint, PG nullability/default changes pass.
- **There is deliberately no `force`**: the start path never lets a lossy change through. **Assess whether an entity change is lossy before shipping**: no history, no rollback, and on SQLite even making a column nullable is a rebuild, so the service won't start.
- `test/schema-sync.test.ts` covers the matcher against SQL MikroORM 7.2.5 actually emitted on both databases, and pins that **a freshly synced database produces an empty diff** (an unstable entity would trip the guard on every start). Upgrading MikroORM means re-sampling that SQL.

## `@learning/data-access` inside Nest's startup

- **Entities are registered, not listed**: a module writes `{ provide: DATA_ACCESS_ENTITIES, useValue: [...] }` in its own `providers` and the ORM factory walks `ModulesContainer` (`entity-registry.ts`). Measured on Nest 12.3.2: the scanner finishes the whole module graph before any instance is built, so the factory sees every module regardless of `imports` order, and a `useValue` is already on the wrapper. **Only `useValue`**: a factory or class provider may not be built yet, so the result would depend on instantiation order and a missing table would only show at the first query; the factory refuses to start instead. Lazily loaded modules can't register (they load after the factory). No module-level registry: the set must come from what this process imports, so a process without a module creates none of its tables. `DATA_ACCESS_ENTITY_OVERRIDE` (internal, not exported) replaces the whole set for tests.
- **A table left out of the entity set must stay untouched, and `dropTables: false` doesn't do that** (measured on PG, MikroORM 7.2.5): those tables count as removed, and the diff still emits `drop constraint` for foreign keys pointing at them (`orphanedForeignKeys`), which the guard passes and nobody notices. `planSchemaSync` first finds them from a `dropTables: true` diff, then excludes them through `schemaGenerator.skipTables` for the real one. `skipTables` matches by bare name on both sides, so a managed table's name is never added (a same-named table in another schema would otherwise stop the real one being created). SQLite emits nothing here, so only `PLATFORM_TEST_DATABASE_URL` runs catch a regression.
- **The sync lives in the ORM provider's async factory, not in `onModuleInit`.** Measured on Nest 12.3.2: global modules' hooks run in registration order, so a global business module imported first runs before a hook-based sync; and every provider factory runs before any `onModuleInit`, so a factory that queries meets missing tables. As a dependency of `DataAccess`, the factory holds for every consumer wherever it sits in `imports` (`test/data-access.test.ts` pins this; moving the sync to a hook fails it).
- **A throwing factory never reaches `main.ts`'s `await`**: it runs inside `NestFactory.create`, where the default `abortOnError` logs and calls `process.exit(1)`. So the factory closes the ORM first and logs for itself.
- **An unreachable database fails the start**, with `schemaSync: off` too: `MikroORM.init()` doesn't connect and the shallow probe doesn't touch the database, so the first request would be the first to know. `off` does `orm.connect()` + `checkConnection()` (`select 1`) and no DDL; `orm.checkConnection()` alone says "Connection not established" on a healthy database.
- **`database.schemaSync: off` doesn't look at the schema at all** (missing tables or lossy differences don't refuse the start; those belong to the `apply` process), and a typo must refuse the start: a misspelt `off` read as the default would have a replica running DDL.
- **The ORM closes in `onApplicationShutdown`**, the last phase: `onModuleDestroy` and requests still draining use the database. A *global* module imported before `DataAccessModule` gets its `onApplicationShutdown` after the close (hooks run in reverse order).
- `PLATFORM_TEST_DATABASE_URL` turns on the PostgreSQL suite. It drops the `public` schema between tests, so the fixture refuses a database whose name doesn't contain both `platform` and `test`.

## `@learning/canvas` — the canvas tables

- `parseGraph` accepts only the current `GRAPH_SCHEMA_VERSION`: this service has no old rows. `FlowDocStore.read`'s `legacy` only reads the `graph` of a canvas that has no `ydoc` yet.

## `@learning/storage` — `FlowAsset`

- **`FlowAssets.record` decides on the `key` unique constraint, never read-then-write**: `complete` can replay, and the loser re-reads (same flow = done, another flow = the error stands, ownership never moves). Don't turn it into an upsert: that would let a member reassign a key to another canvas.

## `@learning/apps` — `AppTask`

- `active_key`, unique and nullable, is set while a task is active (`docs/30` §8). Both databases allow any number of NULLs under a unique constraint, which is what makes it work without a partial index.

## `@learning/agent` — the agent tables

- `AgentConversation` has real FKs with cascade to `@learning/canvas`'s `Flow` and `@learning/data-access`'s `User`; `AgentRun`, `AgentToolCall`, `AgentGrant` and `AgentGrantScope` keep plain-text ids so the audit trail outlives what it describes, as described above. `AGENT_ENTITIES` in `entities.ts` is the `useValue` the module registers, so a process without `AgentModule` has none of these tables.
- **Every write on a conversation, and every read that returns the model context, has `flow` and `user` in the `where`**: someone else's conversation and a missing one are the same result (0 rows). The display reads (`list`, `get`) use `flow` alone on purpose, because members may read each other's conversations.
- `AgentGrants` has no `revokeAllForUser` (`docs/31` §4.4).
