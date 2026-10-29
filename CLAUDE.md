# CLAUDE.md

## Language

**Always reply in Chinese (中文).** All user-facing output — answers, explanations, plans, summaries, questions — is written in Chinese. Keep technical terms in their original English form (Vite, MikroORM, OIDC, Hono, …).

Code identifiers, types and commit messages stay English. **Source comments in `apps/server/`, `apps/web/src/` and `packages/`, log/error messages shown to a developer or user, and test names are written in Chinese**, matching every existing file. `docs/` is Chinese too.

## Project

A Vue 3 learning sandbox: shadcn-vue UI, Three.js scenes, canvas mini-games, and one real feature — collaborative flow canvases (projects, Yjs, an agent). Requirements live in `docs/`, one file per requirement (index: `docs/README.md`); `docs/` says *what*, this file and `.claude/rules/` say *how*.

### Where a fact goes — `docs/` vs `.claude/rules/`

- **`docs/`** — product behaviour: features, interactions, what is on screen and where, which types / options exist, acceptance criteria, what is deferred. **A requirement change updates `docs/` only.**
- **`.claude/rules/`** — only constraints a reader of the code would get wrong by following intuition: the one write path, forbidden shortcuts, cross-module invariants, cycle rules, and *why* each holds. Don't restate behaviour; point at it (`docs/13` §3.7).
- **Test:** if a line would only change because a requirement changed, it belongs in `docs/`, not in a rule. Don't add component inventories, UI layouts, type lists or "not wired yet" notes to a rule.

## Monorepo layout

pnpm workspace. Every root command is a `pnpm --filter <pkg>` delegation.

- **`apps/web` (`@shadecn/web`)** — frontend (`src/` = `@/`, `vite.config.ts`, `index.html`, `login.html`, `components.json`). `devDependencies` only: it is bundled into `output/public`.
- **`apps/server` (`@shadecn/server`)** — backend, data layer (`db.ts`, `db/`) and `scripts/`. Its `dependencies` is the production runtime set.
- **`packages/shared` (`@shadecn/shared`)** — source-only TS both sides import: `flow-graph`, `flow-node-types`, `flow-doc`, `canvas`, `auth`, `collab`, `agent`, `id`. Change a contract here, once.
- **`packages/agent` (`@shadecn/agent`)** — the canvas agent, source-only, server-only (`.claude/rules/agent.md`).
- **Root**: `docs/`, `k8s/`, `ci/`, `.gitea/`, `Dockerfile`, `.env`, `data/`, `output/`, `eslint.config.ts`, a `vitest.config.ts` that only aggregates `projects`, and repo-wide tooling devDependencies.
- **Two base directories.** `rootDir` / `appRoot` (`apps/server/config.ts`, `runtime.ts`) is the **repo root** — home of `.env`, `data/`, `output/`. `webRoot` and `serverDir` are each package's own dir. From source, `runtime.ts` derives the app root as `apps/server/`'s **grandparent**; in the bundle it is `process.cwd()`. Mixing them reads the wrong `.env` or puts the DB in `apps/server/data`.

### Invariants — each is a bug if undone

- **`tsx watch` carries `--exclude '../web/node_modules/.vite-temp/**'`** in `dev` and `dev-cluster`. Vite's temp config file sits outside tsx's default ignore and causes an endless restart loop.
- **The schema-sync CLI (`apps/server/db/sync-cli.ts`) loads env through `apps/server/env.ts` + `config.ts`**, never its own `.env` read (cwd is `apps/server`, so a bare `loadEnvFile()` finds nothing and silently uses the default SQLite file).
- **Local `pnpm start` goes through `node --import ./apps/server/scripts/local-start.mjs`.** Runtime deps are declared only in `apps/server`, so the hook re-resolves "bare package not found" from `apps/server/package.json`. In a container the artifact has its own `node_modules`.
- **Root `Dockerfile`: copy each package's `package.json` one by one → `pnpm install --frozen-lockfile` → `COPY . .`** (cacheable install layer; a new workspace package needs one more `COPY` line). `.dockerignore` says `**/node_modules` — a leaked symlink dir would overwrite installed deps.
- **Tailwind's source scan is rooted at `apps/web`**; class names outside it are not detected.
- **esbuild uses the `externalizePackages` plugin, not `packages: 'external'`**: bare imports stay external except `@shadecn/*`, which is inlined (it's installed nowhere in the artifact). Shared's own third-party imports (yjs) stay external and enter the runtime dependency list.
- **`@shadecn/shared` is a `workspace:*` devDependency of web and server, and peer-depends on `yjs`.** Exactly one yjs copy per bundle, or `instanceof Y.Map` is always `false` and canvases go blank. Guaranteed by pnpm linking + the frontend's `resolve.dedupe`; pinned by `apps/server/test/collab/shared-yjs.test.ts` and `apps/web/src/test/lib/sharedYjs.test.ts`.
- **Writing `packages/shared`**: relative imports carry `.ts`; no DOM or Node API (`lib: ["ES2020"]`, `types: []` — both consumers recompile it under their own config). Tests use `tsconfig.test.json` so vitest's Node types don't switch the guard-rail off.
- **Lockfile ranges were kept identical to the pre-monorepo ones** (a fresh resolve drifts `reka-ui` to 2.10.1). Don't `pnpm update` casually; read the lockfile diff of any install.

## Commands

- `pnpm dev` — whole app (Hono + Vite middleware, watch) on http://127.0.0.1:3000. One process, one port, no proxy, in dev and prod.
- `pnpm build` — `build:client` (`vue-tsc -b` + `vite build` → `output/public`) then `build:server` (`typecheck` + esbuild → `output/server`).
- `pnpm start` — run `output/` locally; `pnpm preview` = build + start.
- `pnpm typecheck:server` / `typecheck:shared` / `typecheck:agent` (frontend is checked by `vue-tsc -b` in `build:client`).
- `pnpm test` (`test:watch`, `test:coverage`) and `pnpm test:server` / `test:client` / `test:shared` / `test:agent`.
- `pnpm lint` / `pnpm lint:fix`.
- `pnpm db:push` — sync tables to entities; additive only, lossy changes are refused with the statements printed. `pnpm dev` runs it first. **No migration files.** No `db:studio` — use `sqlite3` / `psql`.
- `pnpm db:push:force` — same with `--force`; **dev only, deliberately separate** (`dev`, `dev:cluster` and both Dockerfiles keep the bare sync).

Copy `.env.example` → `.env` (repo root) before the first run.

## Architecture

**Stack:** Vue 3 + TypeScript + Vite + Tailwind CSS v4 + shadcn-vue (new-york). `@/` → `apps/web/src/`; shared code is imported as `@shadecn/shared/<subpath>`, never through `@/`. Frontend, `/api/*` and `/ws/collaboration` are same-origin in every mode — use relative paths.

Details live in `.claude/rules/`, one file per area, each loaded when you touch a path it lists. **Read the matching file before changing code in that area** — each is a set of invariants where the obvious change is a known bug:

- **Canvas editor** — `flow-editor.md`: views and workspace, editor context, node-type registry and node-kit, selection / groups / snapping, the store as a *projection of a Y.Doc* (`store.mutate()` is the only write path), five-group node schema, collection keys, drafts, viewport state, personal canvases.
- **Collaboration** — `collab.md`: data vs feedback layer, Hocuspocus mount and timings, persistence (read → merge → CAS; **a failed store must propagate**), quota, awareness, one-window-per-user, terminal close codes, revocation, write gate, WebSocket `Origin`.
- **Frontend shell** — `web-shell.md`: router + layouts, frontend auth and popup re-login, shadcn-vue (`Button.vue` is hand-edited), `@lucide/vue` only, theme gotchas, views.
- **Backend runtime** — `server-runtime.md`: `apps/server/` file map, logging (keep writing `console.*` with a `[prefix]`), frontend hosting and the login entry, the build.
- **Auth** — `auth.md`: OIDC + GitHub BFF, provider registry, per-request callback origin, sessions, confirmed account linking, identity is `(provider, subject)` never email, profile hooks, avatars.
- **Database** — `database.md`: entities, SQLite *or* PostgreSQL, entity rules, Prisma habits that are now bugs, schema-sync guard, `containsIgnoreCase()`.
- **Clustering** — `cluster.md` · **Deploy** — `deploy.md` · **Tests** — `testing.md` · **Agent** — `agent.md`.

When a fact goes stale, fix it where it lives — each fact has one home. If a stale fact sits in a rule but is really a requirement, move it to `docs/` instead of rewriting it in place.

## Dependencies

Each package declares only what it needs; **the runtime set is `apps/server/package.json`'s `dependencies`**, everything else is `devDependencies`.

- A package the **server** imports → `apps/server` `dependencies` (`pnpm --filter @shadecn/server add -P`). `build-server.mjs` fails the build if the bundle imports something only in `devDependencies` or missing.
- A **frontend** package → `apps/web` `devDependencies` (`pnpm --filter @shadecn/web add -D`; the shadcn-vue CLI, run from `apps/web`, writes there).
- Never hoist to the root unless it's repo-wide tooling (eslint, typescript, vitest + coverage, jsdom). The root also holds `pnpm.neverBuiltDependencies: ["better-sqlite3"]` (see `deploy.md`).
- `@mikro-orm/*` is pinned to exactly `7.2.5`; both DB drivers and both cluster packages (`ioredis`, `@hocuspocus/extension-redis`) stay in every artifact — DB and mode are runtime choices.

## Conventions

- TypeScript strict with `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`. All Vue components use `<script setup lang="ts">`.
- Tests live in `apps/server/test/`, `apps/web/src/test/`, `packages/*/test/`, mirroring what they cover. Imports in `apps/server/` (tests included) keep explicit `.ts` extensions. Import `describe` / `it` / `expect` / `vi` from `vitest` (no globals). Name tests by the behaviour constrained ("未登录 → 401").
- **Time is UTC everywhere except on screen.** The DB stores absolute instants; stores map rows out with `toISOString()`, so the wire format is always ISO with `Z`. **The frontend never formats a date inline** — use `apps/web/src/lib/format.ts` (`formatDateTime` / `formatDate` / `formatTime` / `formatWith(value, options)`; all render `-` for unparseable input).
  - The defaults come from `apps/web/src/lib/preferences.ts` (browser-local `app:display-preferences`; each field defaults to `AUTO` = follow the browser). `format.ts` reads the reactive `resolvedDisplayPreferences`, so changes re-render live. A **caller-supplied option always wins**, and stored values are **validated on read** (a bad `dateStyle` makes `Intl` throw).
- **On the canvas path, time is a number** — UTC epoch ms (`FlowNodeData.createdAt`, `FlowEdgeData.createdAt`). Stamped by each browser's own clock, so never order across clients by it.
- **One click, one request — every write-side interaction goes through `apps/web/src/composables/useAsyncAction.ts`.** `const { run, pending } = useAsyncAction(fn, { errorMessage })`; `run()` marks pending **synchronously**, so a same-tick second click is dropped (`:disabled` lands a render too late, and Enter / `@select` / blur / `AlertDialogAction` have no button). Bind `<Button :loading="pending">`. `run` never rejects and toasts errors (`onError` overrides), so action bodies carry no `try/catch`. Lists pass `key: (item) => item.id`. **Write `@click="submit()"`, not `@click="submit"`** (the latter passes the MouseEvent). Reads are out of scope.
- **Client-generated ids go through `apps/web/src/lib/id.ts`'s `createId(prefix)`** (`<prefix>_<base36 time>_<random>`); the random tail keeps two clients from minting the same id in one millisecond.
