---
paths:
  - "apps/server/db/**"
  - "apps/server/db.ts"
  - "apps/server/store/**"
  - "apps/server/collab/persistence.ts"
  - "apps/server/collab/flow-writer.ts"
---

# Database — MikroORM 7, SQLite *or* PostgreSQL (`docs/05-data-persistence.md`)

## Entities (`db/entities/*.ts`)

- Auth: `User` (unique `(issuer, subject)` — the primary identity's copy; roles as a JSON string), `UserIdentity` (unique `(provider, subject)`; `email` is display-only), `Session` (`provider` = who renews; `id` = the cookie token's HMAC, **set by the caller**), `AuthRequest` (`provider` dispatches the callback, `linkUserId` turns it into linking), `PendingLink` (`user` unique, a retry replaces it).
- Canvas: `Project`, `ProjectMember` (unique `(project, user)`; the creator's admin row is written, never inferred from `createdBy`), `ProjectInvite` (`project` unique; token in the clear — it *is* the credential; `expiresAt` is the only gate — semantics: `docs/13` §3.3), `Flow` (`ydoc` = Yjs bytes, **source of truth**; `graph` = derived JSON projection; both **lazy** — say `populate: ['ydoc']` / `fields: [...]`; `revision` = the server's CAS counter, not a client lock), `FlowUserState` (unique `(flow, user, key)`, JSON-string value; a new partition is a new key, not a schema change), `FlowAsset` (upload record: unique `key` → `flow` + server-observed `contentType`; written by `routes/assets.ts` **before** the upload responds — a failed write fails the upload, or the asset can never be proven to belong to that canvas; no URL stored, it is derived from the key).
- Agent (`entities/agent.ts`, REQ-AGENT): `AgentConversation` (FKs to `flow` and `user` with cascade; `messages` / `llmMessages` are lazy JSON strings), audit log `AgentRun` (id = SSE runId) + `AgentToolCall` (`args` = `digestArgs` output: ids and string *lengths*, never content). Their `conversationId` / `flowId` / `userId` / `runId` / `grantId` are **plain text with no FK on purpose** — the audit trail outlives what it describes. Same for the delegation grant `AgentGrant` (issue-time project / owner snapshot, `expiresAt`, `revokedAt` + `revokeReason` — every revoke writes only where `revokedAt` is null, so the first reason sticks) and `AgentGrantScope` (`onRevoke` holds four values, only `stop` is implemented; `docs/22`).
- Naming: MikroORM's `UnderscoreNamingStrategy`. **Foreign keys are relation properties** (`user`, `project`, `flow`, `createdBy`, `personalOwner` → `user_id`): filter `{ user: userId }`, read `row.user.id`, `populate` for the other side's fields. **Only the owning side is defined** — no inverse collections (`defineEntity` inference degrades to `any`); queries start from the FK table ("my projects" = a `ProjectMember` query). `Flow.createdById`, `ProjectInvite.createdById`, `ProjectMember.invitedById`, `AuthRequest.linkUserId` are plain text, no FK.
- SQLite file: `$DATA_DIR/app.db` (`DATA_DIR` defaults to `<repo>/data`); `DATABASE_URL` overrides; relative `file:` paths resolve against the repo root; the parent dir is `mkdir -p`'d first.

## Two databases, one entity definition, one artifact

- Provider = `DB_PROVIDER` (`sqlite` | `postgresql`), else `DATABASE_URL`'s scheme, else sqlite. Contradictory / unknown / `postgresql` without a URL **throws at startup**. Resolved **once** in `config.ts` (`dbProvider` / `databaseUrl`), read by both server and sync CLI. `db/orm.ts` **dynamically imports** only the chosen driver. A Prisma-style `?schema=public` is stripped and passed as MikroORM's `schema`.
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
- **Case-insensitive search** goes through `db/query.ts`'s `containsIgnoreCase(column, keyword)` (`lower(col) like lower(?) escape '\'` via `raw()`, works in nested relation filters, escapes `%` `_` `\`). Never `$like` / `$ilike` inline (`$ilike` is a syntax error on SQLite). It takes the **column** name, not the property.

## Schema sync — no migration files (`db/schema-sync.ts`)

- `pnpm db:push`, the container's `node server/db-sync.js` and the test global-setup all run the same code: `getUpdateSchemaSQL()` → classify each statement → `schema.execute()` that exact text.
- **`schema.update({ safe: true })` is not a guard** (SQLite rebuilds via `__temp_alter`; PG lets `alter column … type` through). Our guard refuses drop table / drop column / `alter column … type` / any `__temp_alter` rebuild / renames / truncate-delete, prints each with its category and exits 1 without executing. Create table, add column, index changes, add constraint, PG nullability/default changes pass.
- `--force` (`pnpm db:push:force`) lets everything through and also drops non-entity tables (normal mode ignores them with a warning, e.g. old Prisma tables).
- **Costs**: no history, no rollback; both Dockerfiles and the artifact's `db:push` omit `--force` (a failed start beats silent data loss). **Assess whether an entity change is lossy before shipping** — on SQLite even making a column nullable is a rebuild. `db:push:force` stays a separate command so a human sees the refusal.
- Tests (`apps/server/test/db/schema-sync.test.ts`) cover the matcher against SQL MikroORM 7.2.5 actually emitted on both DBs, and pin that **a freshly synced DB produces an empty diff** (an unstable entity would trip the guard on every start).
