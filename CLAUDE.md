# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Vue 3 learning/experimentation sandbox that combines shadcn-vue UI components, Three.js 3D scenes, and canvas-based mini-games. It serves as a playground for exploring different Vue and web technologies within a single app.

Requirements live in `docs/`, one file per requirement — see `docs/README.md` for the index. This file describes *how the code is built*; `docs/` describes *what it is supposed to do*.

## Commands

- `pnpm dev` — Start the whole app (Node/Hono + Vite as middleware, watch mode) on http://127.0.0.1:3000
- `pnpm build` — Type-check with `vue-tsc` then build with Vite into `dist/`
- `pnpm start` — Run the production server (`NODE_ENV=production`, serves `dist/`)
- `pnpm preview` — `pnpm build && pnpm start`
- `pnpm typecheck:server` — Type-check the `server/` project
- `pnpm test` — Run both Vitest projects once; `pnpm test:watch` for watch mode
- `pnpm test:server` / `pnpm test:client` — Run only the backend / frontend project
- `pnpm test:coverage` — v8 coverage into `coverage/`
- `pnpm lint` / `pnpm lint:fix` — ESLint
- `pnpm db:generate` — Regenerate the Prisma client into `server/generated/prisma` (also runs on `postinstall`)
- `pnpm db:migrate` / `pnpm db:deploy` / `pnpm db:studio` — Prisma migrations (dev / prod) and the data browser

One process, one port: the Node server is the only entry point in both dev and prod — there is no separate Vite dev server and no proxy.

Copy `.env.example` → `.env` before the first run; `server/env.ts` loads it via `process.loadEnvFile()` (no dotenv dependency).

## Architecture

**Stack:** Vue 3 + TypeScript + Vite + Tailwind CSS v4 + shadcn-vue (new-york style)

**Path alias:** `@/` maps to `src/` (configured in both `vite.config.ts` and `tsconfig.app.json`)

**Routing:** `src/router/index.ts` — flat route structure with vue-router 5 (history mode). Each view is a standalone demo page.

**Layout:** `App.vue` renders `AppSidebar` + `<RouterView>`, unless the route sets `meta.layout === 'blank'` (currently only `/login`), in which case the `<RouterView>` is rendered bare. The app fills the viewport height (`h-screen`).

**Auth (frontend):** every route except `meta.public` ones requires a login. `src/router/index.ts` has a global `beforeEach` that calls `fetchSession()` (one `GET /api/auth/me`, cached) and redirects to `/login?redirect=<fullPath>` when anonymous. `src/lib/auth.ts` exposes `useAuth()` (`user` / `roles` / `isAuthenticated` / `authEnabled` / `hasRole`) and `apiFetch()`, which bounces to the login flow on a 401. There is no token in the browser — login/logout are full-page navigations to `/api/auth/login` and `/api/auth/logout`.

**UI Components (shadcn-vue):** Located in `src/components/ui/`. Added via the `shadcn-vue` CLI (configured in `components.json`). Current set: badge, button, card, navigation-menu, separator. Icon library is `lucide-vue-next`. The `cn()` utility in `src/lib/utils.ts` merges Tailwind classes via `clsx` + `tailwind-merge`.

**Styling:** Tailwind CSS v4 loaded via `@tailwindcss/vite` plugin. CSS variables for theming (light/dark) are defined in `src/style.css` using oklch colors. Uses `tw-animate-css` for animations.

**Views (demo pages):**
- `Home.vue` — Landing page with counter demo using shadcn components
- `About.vue` — (not yet implemented)
- `Example.vue` — Interactive draggable point with connecting lines
- `Emu3DView.vue` — CSS-based 3D cube (uses `Cube3D.vue` component)
- `Demo3.vue` — Canvas-based brick-breaker game
- `SnakeGame.vue` — Canvas-based snake game
- `Game2048.vue` — 2048 puzzle game (scoped CSS, no shadcn components)
- `Canvas3D.vue` / `LightScene.vue` — Three.js scenes (scaffolds, not yet implemented)
- `Login.vue` — the only public route (`/login`): a single "使用 Keycloak 登录" button, plus the `?error=` banner the OIDC callback redirects back with

**3D:** Three.js is a dependency with types (`@types/three`). The `Cube3D.vue` component is pure CSS 3D transforms (not Three.js). The Three.js views (`Canvas3D`, `LightScene`) are placeholders.

**Backend (`server/`) — the single entry point:** Node + [Hono](https://hono.dev) + `@hono/node-server`, run through `tsx` (no build step). It serves the API, the Yjs WebSocket, *and* the frontend. Layout:
- `server/index.ts` — entry. Loads `.env`, `assertAuthConfig()`, builds the http server with `createAdaptorServer` (no `listen` yet), attaches collab + frontend, starts the hourly expired-session sweep, then listens. Handles SIGINT/SIGTERM cleanup
- `server/env.ts` — side-effect module: `process.loadEnvFile()` on the repo-root `.env` (real env vars win). Imported first by `config.ts` and `index.ts`; no dotenv dependency
- `server/config.ts` — `rootDir` / `distDir` / `isDev` / `port` / `host` / `isApiPath()` / `dataDir` / `databaseUrl` / `ensureDatabaseDir()` / `appOrigin` / `authConfig` / `authEnabled` / `assertAuthConfig()`. `isDev` is `NODE_ENV !== 'production'`
- `server/app.ts` — Hono app typed as `Hono<{ Bindings: HttpBindings; Variables: AuthVariables }>` (the frontend middleware needs node's raw `req`/`res` via `c.env`; the auth middleware puts `session`/`user` in `Variables`). Logger + CORS, `withSession` then a `requireAuth` gate on everything under `/api/*` except `PUBLIC_API` (`/api/health`, `/api/auth`), route mounting, 404/error handlers. Exports `AppType` for optional `hc<AppType>()` RPC typing on the frontend
- `server/db.ts` — the `PrismaClient` singleton (better-sqlite3 driver adapter, cached on `globalThis` so `tsx watch` doesn't leak connections)
- `server/auth/` — the OIDC/session layer (see below)
- `server/frontend/` — how the UI gets served (see below)
- `server/routes/` — one Hono sub-app per resource, mounted under `/api/*`. Routes are chained (`new Hono().get(...).post(...)`) so `AppType` stays inferable
- `server/store/` — data layer. Currently an in-memory `Map` (`store/notes.ts`); swap this module to add persistence without touching routes
- `server/collab/` — Yjs collaboration over WebSocket (see below)
- `server/generated/prisma/` — generated Prisma client, gitignored; run `pnpm db:generate` after touching the schema
- `server/tsconfig.json` — separate TS project (Node types, no DOM), referenced from the root `tsconfig.json`. Imports inside `server/` use explicit `.ts` extensions

**Frontend hosting (`server/frontend/`):** `attachFrontend(app, server)` registers a catch-all *after* the `/api` routes, so API routes always win and everything else falls through to the UI.
- `frontend/dev.ts` (dev only, dynamically imported so Vite never loads in prod) — `createServer({ root, appType: 'custom', server: { middlewareMode: true, hmr: { server } } })`. Vite's connect middleware chain is run against `c.env.incoming/outgoing` and the handler returns `RESPONSE_ALREADY_SENT`; if the chain calls `next()`, the SPA fallback renders `index.html` through `vite.transformIndexHtml`. `hmr.server` is what makes HMR ride the same port — with only `middlewareMode: {server}` Vite would still open port 24678
- `frontend/static.ts` (prod) — `serveStatic({ root: <relative dist> })` + `index.html` fallback for unknown paths
- `vite.config.ts` is still the config of record (plugins, `@/` alias) — it's read both by `vite build` and by the middleware-mode `createServer`. It has no `server.proxy` anymore because there is nothing to proxy to

**Yjs / y-websocket (`server/collab/`):** the same HTTP server also serves a Yjs sync endpoint at `ws://host:3000/ws/<room>`; one room = one `Y.Doc`, held in memory only.
- `collab/setupWSConnection.ts` — a port of y-websocket's `bin/utils.js`. Deliberately **not** the upstream `@y/websocket-server` package: it statically imports `y-leveldb` → `leveldown`, a native module with no prebuild for node 22/arm64, so importing it throws. The version that dropped that dep (0.1.5) requires the yjs 14 beta, which the stable `y-websocket@3` client can't talk to. The wire protocol here is unchanged, so standard clients work as-is.
- `collab/index.ts` — `attachCollabServer(server, { destroyUnmatchedUpgrades, authorize })`: a `ws` server in `noServer` mode; only `/ws/*` upgrades are accepted, room name comes from the path. In dev `destroyUnmatchedUpgrades` is `false` — Vite's HMR socket rides the same `upgrade` event (protocol `vite-hmr`, path `/`) and killing unmatched sockets would break hot reload. `authorize` (wired to `auth/ws.ts`) checks the session cookie on the handshake and answers `401` + destroy when anonymous
- Env: `YWS_PING_TIMEOUT` (30s), `YWS_GC` (`false`/`0` disables Yjs gc — required if you use snapshots), `YWS_STATS_INTERVAL` (30s, `0` disables the stats log)
- `GET /api/collab/rooms` reports live rooms/connections
- Frontend: `new WebsocketProvider('/ws' as absolute ws:// URL, room, doc)` — docs stay in memory, so a server restart drops all content

Frontend, `/api/*` and `/ws/*` are same-origin in every mode, so frontend code should always use relative paths.

**Auth (`server/auth/`) — Keycloak OIDC, BFF style.** Full write-up in `docs/02-auth-keycloak.md`. The browser never sees a token: the authorization-code + PKCE exchange happens server-side, tokens live in SQLite, and the client only holds an httpOnly `sid` cookie.
- `auth/oidc.ts` — everything that talks to Keycloak: cached `.well-known/openid-configuration` discovery (endpoints are never hard-coded), PKCE `S256` helpers, `exchangeCode` / `refreshTokens` / `revokeRefreshToken`, RP-initiated `buildLogoutUrl`, and `verifyIdToken` — JWKS fetch (kid miss → one refetch) + `crypto.createPublicKey({format:'jwk'})` signature check for RS/PS/ES, then `iss` / `aud` / `azp` / `exp` / `iat` / `nonce`. No `jose`/`openid-client` dependency
- `auth/session.ts` — session lifecycle. The cookie holds a 32-byte random token; the DB row id is `HMAC-SHA256(SESSION_SECRET, token)`, so a database dump alone can't forge a cookie. `loadSession()` transparently refreshes an access token that is within 30s of expiry (concurrent refreshes for one session are deduped through an in-process promise map) and destroys the session when the refresh fails. `sweepExpired()` drops timed-out sessions and unused auth requests
- `auth/middleware.ts` — `withSession` (parse, refresh, expose `c.get('user')`, clear a stale cookie), `requireAuth` (401), `requireRole(...)` (403). Keycloak realm roles land in `User.roles` as-is, client roles as `clientId:role`
- `auth/ws.ts` — the same session check for WebSocket handshakes
- `routes/auth.ts` — `GET /api/auth/{config,me,login,callback,logout}`. `/me` always answers 200 (`{enabled, authenticated, user}`) so the router guard has no error branch. `state`/`nonce`/`code_verifier` live in the `AuthRequest` table keyed by a short-lived `oidc_tx` cookie and are consumed exactly once, so a replayed callback fails. `?redirect=` is restricted to in-site paths (`//evil.com` and `/\evil.com` fall back to `/`)
- When `KEYCLOAK_ISSUER`/`KEYCLOAK_CLIENT_ID` are unset, `authEnabled` is `false`: dev warns and lets everything through (so the demo pages still run without a Keycloak), production refuses to boot

**Database (`prisma/schema.prisma`, SQLite):** `User` (unique on `(issuer, subject)`, roles as a JSON string), `Session`, `AuthRequest`. Prisma 7 requires a driver adapter — `@prisma/adapter-better-sqlite3` — and the client is generated as TypeScript into `server/generated/prisma` (gitignored, `@ts-nocheck`'d, eslint-ignored) rather than into `node_modules`, so it survives `pnpm prune --prod` and rides into the image with `server/`. `prisma.config.ts` is the CLI config and mirrors `config.ts`'s path resolution so the CLI and the server always open the same file: the DB lives at `$DATA_DIR/app.db` (`DATA_DIR` defaults to `<repo>/data`, gitignored), `DATABASE_URL` overrides it outright, and relative paths in either resolve against the repo root — not the cwd. Both sides `mkdir -p` the parent directory, since better-sqlite3 won't create it.

**Deploy:** the Dockerfile is a two-stage node build (`prisma generate` → `vite build` → `pnpm prune --prod` → runtime image that runs `prisma migrate deploy` then `npx tsx server/index.ts`, with `NODE_ENV=production`, `HOST=0.0.0.0`, port 3000). nginx is gone — the Node server serves `dist/` itself. The build stage installs `python3 make g++` because better-sqlite3 has no musl prebuild. SQLite lives on a volume at `/app/data` (`DATA_DIR=/app/data`); `k8s/` adds a PVC + auth Secret, targets container port 3000, probes `/api/health`, and must stay at `replicas: 1` with `strategy: Recreate`.

**Tests (Vitest, `vitest.config.ts`):** two projects in one config — `server` (node env, `server/test/**/*.test.ts`) and `client` (jsdom env + the `vue` plugin and `@/` alias, `src/test/**/*.test.ts`). Both are hermetic: each setup file replaces `globalThis.fetch` with a stub that *rejects*, so any test needing the network must `vi.stubGlobal('fetch', …)` — nothing ever reaches a real Keycloak.
- **Backend.** `server/test/global-setup.ts` wipes `data/test/` and runs the real `prisma migrate deploy` against it once per run, so the test schema can never drift from the migrations; `fileParallelism: false` keeps the shared SQLite file safe. Environment comes entirely from `test.env` in `vitest.config.ts`, and `server/env.ts` is aliased to `server/test/stubs/env.ts` so the developer's own `.env` (real issuer, real client secret) can never leak into a test run. Helpers: `helpers/db.ts` (`resetDb`, `createUser`), `helpers/session.ts` (`signIn` → a ready-to-use `sid` cookie), `helpers/oidc.ts` (a fake Keycloak: discovery/JWKS/token/end_session over a stubbed `fetch`, plus a real RSA keypair so `verifyIdToken` is exercised for real). Routes are driven through `app.request()` — the full middleware stack, not mocked handlers.
- **Module-level caches.** `config.ts` (env → consts), `oidc.ts` (10-min discovery/JWKS cache) and `lib/auth.ts` (session singleton) all freeze state at import, so tests that need a different world use `vi.resetModules()` + a dynamic `import()`. `server/test/routes/auth.test.ts` has a `freshApp()` helper for exactly this.
- **Frontend.** `src/test/` covers `lib/utils`, `lib/auth` (the whole `fetchSession`/`apiFetch` contract), the `prompt-input` editor core (`serialize` round-trips + `operations` transforms/undo/batch), the real router guard (`@/router` with `/api/auth/me` stubbed), and a `Login.vue` component test via `@vue/test-utils`.

**Key dependencies:** `reka-ui` (headless UI primitives behind shadcn-vue), `@vueuse/core`, `class-variance-authority`, `vue-router` 5, `hono` + `@hono/node-server` (backend), `yjs` + `y-protocols` + `ws` (collab server), `y-websocket` (client), `prisma` + `@prisma/client` + `@prisma/adapter-better-sqlite3` (auth storage — the CLI is a *dependency* because the container runs `prisma migrate deploy` at startup), `tsx` (runtime TS runner — also a *dependency*, because prod runs `server/*.ts` directly), `vite` (dev middleware + build).

## Conventions

- TypeScript strict mode with `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`
- All Vue components use `<script setup lang="ts">`
- Package manager: pnpm
- Tests live in `server/test/` and `src/test/`, mirroring the directory they cover (`server/test/routes/auth.test.ts` ↔ `server/routes/auth.ts`). Imports inside `server/test/` keep the explicit `.ts` extension like the rest of `server/`.
- Vitest globals are **not** enabled — import `describe`/`it`/`expect`/`vi` from `vitest` explicitly.
- Test names are written as the behaviour being constrained ("未登录 → 401"), not as the function being called.