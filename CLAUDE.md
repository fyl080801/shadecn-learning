# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Vue 3 learning/experimentation sandbox that combines shadcn-vue UI components, Three.js 3D scenes, and canvas-based mini-games. It serves as a playground for exploring different Vue and web technologies within a single app.

## Commands

- `pnpm dev` — Start the whole app (Node/Hono + Vite as middleware, watch mode) on http://127.0.0.1:3000
- `pnpm build` — Type-check with `vue-tsc` then build with Vite into `dist/`
- `pnpm start` — Run the production server (`NODE_ENV=production`, serves `dist/`)
- `pnpm preview` — `pnpm build && pnpm start`
- `pnpm typecheck:server` — Type-check the `server/` project
- `pnpm lint` / `pnpm lint:fix` — ESLint

One process, one port: the Node server is the only entry point in both dev and prod — there is no separate Vite dev server and no proxy. No test runner is configured.

## Architecture

**Stack:** Vue 3 + TypeScript + Vite + Tailwind CSS v4 + shadcn-vue (new-york style)

**Path alias:** `@/` maps to `src/` (configured in both `vite.config.ts` and `tsconfig.app.json`)

**Routing:** `src/router/index.ts` — flat route structure with vue-router 5 (history mode). Each view is a standalone demo page.

**Layout:** `App.vue` renders `AppHeader` (navigation bar using shadcn NavigationMenu) + `<RouterView>`. The app fills the viewport height (`h-screen`).

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

**3D:** Three.js is a dependency with types (`@types/three`). The `Cube3D.vue` component is pure CSS 3D transforms (not Three.js). The Three.js views (`Canvas3D`, `LightScene`) are placeholders.

**Backend (`server/`) — the single entry point:** Node + [Hono](https://hono.dev) + `@hono/node-server`, run through `tsx` (no build step). It serves the API, the Yjs WebSocket, *and* the frontend. Layout:
- `server/index.ts` — entry. Builds the http server with `createAdaptorServer` (no `listen` yet), attaches collab + frontend, then listens. Handles SIGINT/SIGTERM cleanup
- `server/config.ts` — `rootDir` / `distDir` / `isDev` / `port` / `host` / `isApiPath()`. `isDev` is `NODE_ENV !== 'production'`
- `server/app.ts` — Hono app typed as `Hono<{ Bindings: HttpBindings }>` (the frontend middleware needs node's raw `req`/`res` via `c.env`). Logger + CORS, route mounting, 404/error handlers. Exports `AppType` for optional `hc<AppType>()` RPC typing on the frontend
- `server/frontend/` — how the UI gets served (see below)
- `server/routes/` — one Hono sub-app per resource, mounted under `/api/*`. Routes are chained (`new Hono().get(...).post(...)`) so `AppType` stays inferable
- `server/store/` — data layer. Currently an in-memory `Map` (`store/notes.ts`); swap this module to add persistence without touching routes
- `server/collab/` — Yjs collaboration over WebSocket (see below)
- `server/tsconfig.json` — separate TS project (Node types, no DOM), referenced from the root `tsconfig.json`. Imports inside `server/` use explicit `.ts` extensions

**Frontend hosting (`server/frontend/`):** `attachFrontend(app, server)` registers a catch-all *after* the `/api` routes, so API routes always win and everything else falls through to the UI.
- `frontend/dev.ts` (dev only, dynamically imported so Vite never loads in prod) — `createServer({ root, appType: 'custom', server: { middlewareMode: true, hmr: { server } } })`. Vite's connect middleware chain is run against `c.env.incoming/outgoing` and the handler returns `RESPONSE_ALREADY_SENT`; if the chain calls `next()`, the SPA fallback renders `index.html` through `vite.transformIndexHtml`. `hmr.server` is what makes HMR ride the same port — with only `middlewareMode: {server}` Vite would still open port 24678
- `frontend/static.ts` (prod) — `serveStatic({ root: <relative dist> })` + `index.html` fallback for unknown paths
- `vite.config.ts` is still the config of record (plugins, `@/` alias) — it's read both by `vite build` and by the middleware-mode `createServer`. It has no `server.proxy` anymore because there is nothing to proxy to

**Yjs / y-websocket (`server/collab/`):** the same HTTP server also serves a Yjs sync endpoint at `ws://host:3000/ws/<room>`; one room = one `Y.Doc`, held in memory only.
- `collab/setupWSConnection.ts` — a port of y-websocket's `bin/utils.js`. Deliberately **not** the upstream `@y/websocket-server` package: it statically imports `y-leveldb` → `leveldown`, a native module with no prebuild for node 22/arm64, so importing it throws. The version that dropped that dep (0.1.5) requires the yjs 14 beta, which the stable `y-websocket@3` client can't talk to. The wire protocol here is unchanged, so standard clients work as-is.
- `collab/index.ts` — `attachCollabServer(server, { destroyUnmatchedUpgrades })`: a `ws` server in `noServer` mode; only `/ws/*` upgrades are accepted, room name comes from the path. In dev `destroyUnmatchedUpgrades` is `false` — Vite's HMR socket rides the same `upgrade` event (protocol `vite-hmr`, path `/`) and killing unmatched sockets would break hot reload
- Env: `YWS_PING_TIMEOUT` (30s), `YWS_GC` (`false`/`0` disables Yjs gc — required if you use snapshots), `YWS_STATS_INTERVAL` (30s, `0` disables the stats log)
- `GET /api/collab/rooms` reports live rooms/connections
- Frontend: `new WebsocketProvider('/ws' as absolute ws:// URL, room, doc)` — docs stay in memory, so a server restart drops all content

Frontend, `/api/*` and `/ws/*` are same-origin in every mode, so frontend code should always use relative paths.

**Deploy:** the Dockerfile is a two-stage node build (`vite build` → `pnpm prune --prod` → runtime image running `npx tsx server/index.ts` with `NODE_ENV=production`, `HOST=0.0.0.0`, port 3000). nginx is gone — the Node server serves `dist/` itself. `k8s/` targets container port 3000 and probes `/api/health`.

**Key dependencies:** `reka-ui` (headless UI primitives behind shadcn-vue), `@vueuse/core`, `class-variance-authority`, `vue-router` 5, `hono` + `@hono/node-server` (backend), `yjs` + `y-protocols` + `ws` (collab server), `y-websocket` (client), `tsx` (runtime TS runner — a *dependency*, not a devDependency, because prod runs `server/*.ts` directly), `vite` (dev middleware + build).

## Conventions

- TypeScript strict mode with `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`
- All Vue components use `<script setup lang="ts">`
- Package manager: pnpm