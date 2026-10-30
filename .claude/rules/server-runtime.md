---
paths:
  - "apps/server/*.ts"
  - "apps/server/logger/**"
  - "apps/server/frontend/**"
  - "apps/server/routes/**"
  - "apps/server/scripts/**"
  - "apps/server/auth/project.ts"
  - "apps/web/vite.config.ts"
  - "apps/web/index.html"
  - "apps/web/login.html"
---

# Backend runtime (`apps/server/`)

Node + Hono + `@hono/node-server`, run through `tsx` in dev. One process serves the API, the Yjs WebSocket and the frontend.

## File map

- `index.ts` — entry: load `.env`, `assertAuthConfig()`, `createAdaptorServer` (no `listen` yet), attach collab + frontend, start the hourly session sweep, the agent reconciler and `startAgentSandboxReaper()` (oci / k8s: self-check + orphans, non-blocking; a failed k8s self-check disables the agent), listen. SIGINT/SIGTERM cleanup; `shutdown()` has a re-entry guard.
  - **Dev orphan watch**: `pnpm dev` is several process layers and only the innermost listens; stopping from an IDE or closing a terminal tab often reaches only the top, leaving the listener holding the port (next `pnpm dev` → `EADDRINUSE`, and they accumulate). `watchForOrphan()` samples `process.ppid` every 2s and runs the normal `shutdown()` when it changes (so the Y.Doc still flushes). The timer is `unref()`'d; dev-only.
- `env.ts` — side effect: `process.loadEnvFile()` on the repo-root `.env` (real env wins). Imported first by `config.ts` and `index.ts`.
- `runtime.ts` — `isBundle` / `moduleDir` / `appRoot`. `__APP_BUNDLE__` (esbuild `define`) → app root = `process.cwd()`; from source = `apps/server/`'s grandparent.
- `config.ts` — every env-derived constant (paths, `isDev`, port/host, `isApiPath()`, DB provider/URL, origins + `isAllowedOrigin()` / `resolveOrigin()` / `callbackUriFor()` / `secureCookieFor()`, auth config, cluster config + asserts). `staticDir` defaults to `output/public`, `STATIC_DIR` overrides.
- `app.ts` — `Hono<{ Bindings: HttpBindings; Variables: AuthVariables }>` (frontend middleware needs raw `req`/`res` via `c.env`). Logger + CORS, `withSession`, `requireAuth` on `/api/*` except `PUBLIC_API` (`/api/health`, `/api/auth`, `/api/agent-gateway`), routes, 404/error handlers. Exports `AppType` for `hc<AppType>()`.
  - **`/api/agent-gateway/*` (`routes/agent-gateway.ts`) is deliberately outside the session gate**: the agent's sandboxed runner has no cookie, only a run token, and the gateway (`@shadecn/agent/gateway`) authenticates every call itself. Never put it behind `requireAuth`, and never let it read `c.get('user')` — a browser cookie must buy nothing there (`agent.md`). The mount passes the raw `Request` through; nothing before it may consume the body.
- `db.ts` — MikroORM singleton (top-level `await createOrm()`, cached on `globalThis` for `tsx watch`) and `db()` = `orm.em.fork()`. **Fork once per operation** (or per group sharing a transaction); `allowGlobalContext` is off and there's no RequestContext middleware, so stores work outside requests. `init` connects on first query, so a dead DB doesn't block boot.
- `db/` — entities, `orm.ts`, `query.ts`, `schema-sync.ts`, `sync-cli.ts` (see `database.md`).
- `routes/` — one Hono sub-app per resource under `/api/*`, **chained** (`new Hono().get(...).post(...)`) so `AppType` stays inferable.
- `store/` — the data layer; **routes never touch the ORM**. `notes.ts` is an in-memory sample; `projects.ts` / `flows.ts` are DB-backed.
- `auth/project.ts` — `requireProjectMember` / `requireProjectAdmin` / `requireFlowMember`. **Non-members get 404, not 403**; a member lacking the role gets 403. `currentUserId()` mints a fixed dev user when auth is disabled.
- `auth/`, `collab/`, `cluster/`, `logger/`, `frontend/` — see `auth.md`, `collab.md`, `cluster.md`, below.
- `tsconfig.json` — separate TS project (Node types, no DOM). Imports inside `apps/server/` use explicit `.ts` extensions.

## Logging (`logger/`) — keep writing `console.*`

- **There is no `logger.info()` in business code; don't add one.** Write `console.warn('[collab] …')` like every existing call site — `console.ts` intercepts `console.*`, parses `[prefix]` into `module`, attaches request context, and hands it to winston (third-party output like ioredis is caught too).
- Four mount points:
  - `index.ts` imports `./logger/install.ts` **second, right after `./env.ts`** — a side-effect import, because ESM hoisting would run a body call after everything else has logged.
  - `app.ts` uses `httpLogger()` instead of `hono/logger` (also opens the `AsyncLocalStorage` giving every log a `requestId`).
  - `db/orm.ts` passes `loggerFactory: ormLoggerFactory` (`logger/db.ts`). **SQL text only, never parameter values**: `query-params` stays off (so MikroORM hands over `?`-placeholder SQL) and `logQuery` reads only `query` / `took` / `results` / `affected`. The ORM's own `debug` / `slowQueryThreshold` stay unused; `LOG_SLOW_QUERY_MS` is the one threshold.
  - `collab/hocuspocus.ts` adds `collabLogging()` to the extensions. A `priority`-tagged extension brackets the business hooks, so `onStoreDocument` (start) vs `afterStoreDocument` (whole chain succeeded) gives **`started − completed` = failed persists** by observation (REQ-RESILIENCE §4.5).
- Noise rules: per-update / per-frame events are **counted** and summarised once a minute, never printed; `LOG_HTTP` defaults to `api`; **nothing in a hook may throw** (the chain is serial); never call `Y.encodeStateAsUpdate()` just to log a size. The agent runner's per-batch uploads (`/api/agent-gateway/events`) are the same kind of noise — `logger/http.ts`'s `QUIET_API_PATHS` skips them on success; server-side model calls (`/api/agent-gateway/model/*`) are exempt from the slow-request warning (that latency is the upstream model's).
- Config: `LOG_LEVEL` / `LOG_FORMAT` / `LOG_DIR` / `LOG_HTTP` / `LOG_SLOW_MS` / `LOG_SLOW_QUERY_MS`. Silent under `NODE_ENV=test`; tests never import `index.ts`, so interception never touches them.

## Frontend hosting (`frontend/`)

- `attachFrontend(app, server)` registers a catch-all **after** `/api`, so API routes win.
- **`frontend/guard.ts` guards "you can't *see* the UI", not "you can't fetch the bytes".** Mounted right after `/api`. An anonymous **document request** (`Sec-Fetch-Mode: navigate` or `Accept: text/html`) for anything but `/login`, `/favicon.ico`, `/vite.svg` → 302 `/login?redirect=<path>`. **Every non-navigation request passes** (`/assets/*`, dev's `/src/**`, `/@vite/*`) because the login page is itself a bundle entry; booting the SPA needs `index.html`, which is already gated. `GET /login` 302s the logged-in away (`safeRedirect`), else `next()`.
- **The login page is the frontend's second Vite entry**: `login.html` + `apps/web/src/login/` in `rollupOptions.input`. It can't be a SPA route (anonymous browsers never get `index.html`). It reads providers from `GET /api/auth/config` and `?redirect=` / `?error=` from `location.search`; `?redirect=` is passed straight to `/api/auth/login` where `safeRedirect` validates it — **don't reimplement the check client-side**. Served by a one-line branch in `frontend/dev.ts` (through `transformIndexHtml`) and `frontend/static.ts`.
- **`login.html` carries the same inline theme script as `index.html`** (reads `app:theme` before first paint); change both together.
- `frontend/dev.ts` (dev only, dynamically imported so Vite never loads in prod) — `createServer({ root, appType: 'custom', server: { middlewareMode: true, hmr: { server } } })`; runs Vite's connect chain against `c.env.incoming/outgoing` and returns `RESPONSE_ALREADY_SENT`; on `next()` it renders `index.html` via `transformIndexHtml`. **`hmr.server` keeps HMR on the same port** (otherwise Vite opens 24678).
- `frontend/static.ts` (prod) — `serveStatic({ root: <staticDir relative to cwd> })` + `index.html` fallback.
- `vite.config.ts` is the config of record for both `vite build` and middleware mode; `build.outDir` is `output/public`; no `server.proxy`.

## Build (`scripts/build-server.mjs`) — `output/` is self-contained

- `pnpm build` fills `output/` with `public/` (vite), `server/index.js` (esbuild, ESM/node22), `server/db-sync.js` (`db/sync-cli.ts`, a second entry sharing chunks), `server/agent-runner.js` (`packages/agent/src/runner/main.ts`, the sandboxed agent runner the `process` driver spawns — a third entry; it must only pull in `packages/agent` / `packages/shared` modules, never `apps/server` ones), `server/agents/*.md` (copied from `packages/agent/agents/` — agent definitions, read next to `index.js` via `config.ts`'s `agentDefinitionsDir`; never bundled, never in the sandbox context), `server/skills/` (text skills: `*.md` copied from `packages/agent/skills/` keeping subdirs — `<name>/SKILL.md` —, skipped if the source dir is missing; read via `agentTextSkillsDir`, same rules as `agents/`), and — copied from `scripts/output-image/` — `Dockerfile`, `.dockerignore`, `README.md`. `npm install --omit=dev && npm run db:push && npm start` runs it anywhere; `docker build ./output` images it.
- `output/agent-sandbox/` is the `oci` sandbox image's build context (`pnpm build:sandbox-image`): `writeSandboxContext` walks the metafile from the runner's output through non-external imports, copies just those files to `runner/`, and writes a `package.json` with **only that closure's external packages** (pinned like the main one). Never copy all of `output/server/` or the server's dependency list into it — the sandbox must not carry the DB drivers or hono. It is excluded from the main image by `output/.dockerignore`.
- The runner is spawned with `agent/runner-command.ts`: from source `node --import <tsx loader> …/runner/main.ts`; from the bundle `node <moduleDir>/agent-runner.js` plus this process's `--import` flags made absolute (so local `pnpm start`'s `local-start.mjs` resolve hook reaches the runner too — its cwd is its own workdir).
- `output/package.json` is generated: `dependencies` = esbuild's external list (metafile) read against `apps/server/package.json`, pinned to installed versions. Both `@mikro-orm/sqlite` and `@mikro-orm/postgresql` are included; `vite` is filtered (`DEV_ONLY`). Scripts: `start`, `db:push`, `db:push:force`. `node_modules` is not shipped (better-sqlite3 is native).
- Relative imports and `@shadecn/*` are inlined (`externalizePackages`); no `tsx` at runtime.
- **One artifact serves both databases** — the build ignores `DB_PROVIDER`; never reintroduce a per-provider build.
- Two non-negotiables: `splitting: true` (keeps `frontend/index.ts`'s `await import('./dev.ts')` dynamic, so `vite` is never a static import) and `define: { __APP_BUNDLE__: true }`.
