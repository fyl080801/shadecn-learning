---
paths:
  - "packages/server-kit/**"
  - "apps/server/modules/**"
  - "apps/server/boot.ts"
  - "apps/server/dev.ts"
  - "apps/server/index.ts"
  - "apps/server/routes/features.ts"
  - "server.config.ts"
  - "server.config.*.ts"
  - "packages/mod-*/**"
  - "apps/server/package.json"
---

# Server modules & roles (REQ-MODULES, `docs/28-server-modules.md`)

> Phases 1–2 of `docs/28` §7 are in (`@shadecn/server-kit`, `@shadecn/mod-storage`, `@shadecn/mod-collab/contract`, `apps/server/modules/`, `boot.ts`, `dev.ts`); phases 3–6 are not. Lines marked *(later)* describe code that doesn't exist yet — keep them as the target, fill in file names as each phase lands, delete anything that turns out not to hold.

- **Capabilities live in `packages/mod-*`, never in `apps/server`** (`docs/28` §3.1.4). A `mod-*` package **never imports `apps/server`** (it would be a cycle, and it re-ties the capability to the one process) and never reads `process.env`; it gets the core from `@shadecn/server-kit` and from what the host passes to its factory (`createStorageModule({ s3 })`). The host's `apps/server/modules/<name>.ts` is only that call. Its third-party deps are `peerDependencies` (+ dev for its own tests); the runtime copy stays in `apps/server` `dependencies` (the build checks it). A new package needs a `COPY` line in the root `Dockerfile` and an entry in the root `vitest.config.ts`.
- **Cross-package calls go through a contract entry** (`@shadecn/mod-collab/contract`): bus tokens + thin wrappers, importing only `@shadecn/server-kit`, so a process without that capability can import it without dragging in its implementation.
- **The bus is scatter-gather with a mandatory fallback** (`@shadecn/server-kit/bus`): a request goes to every instance registered for the token and waits for all of them or the timeout; `missing` / `failures` are normal outcomes. Wrappers like `flushRoom()` never throw. No responders = immediate empty result. The local handler is called directly.
- **Access revocation is a core signal** (`@shadecn/server-kit/access`): routes `await revokeAccess()`; capabilities subscribe with `onAccessRevoked`. Don't route it through the bus (it already has a cross-instance path: epoch + collab's watcher).
- **A module is wired only through the kernel's contract** (`@shadecn/server-kit/kernel`). `setup(ctx)` returns a `ModuleHandle`; the kernel orders `setup` by `dependsOn` / `optional` and runs `shutdown` in reverse under each handle's `shutdownTimeoutMs`. `ServerModule<App>` / `ModuleContext<App>` are generic over the host's Hono app — the kit doesn't know the host's session variables; packages stay generic (`createStorageModule<App>`), the host instantiates them with `ServerApp`. Don't hand-wire an order in `boot.ts` / `index.ts` again — `agent` shutting down before `collab` flushes is *derived* from `agent.dependsOn: ['collab']`, so a new module that must stop before collab declares the dependency rather than editing boot.
- **`modules/frontend-dev.ts` is imported by `dev.ts` only.** `index.ts` is the single esbuild entry; `assertNoDevCode` in `build-server.mjs` fails the build if `dev.ts`, `frontend/dev.ts`, `modules/frontend-dev.ts` or the `vite` package reach the metafile.
- **`assertRolesSupported` refuses every role set except "all" until phase 4** (routes are still mounted statically in `app.ts`, modules still call each other directly). Lift that guard only together with the role-gated route mounting, never on its own.

- **A module never imports another module's internal files.** It reaches a peer only through the peer's contract entry, `ctx.service('<name>')` (declared in the peer's `provides`) and the bus. *(Still violated by code not yet moved: `apps/server/agent/*` imports `collab/*` directly, `routes/flows.ts` imports `collab/flow-writer.ts` — both go away in phase 4.)* The reason the split is possible at all is that the only coupling left is the shared layer; a direct import silently reintroduces "same process" as a requirement and the role deployment breaks without a type error.
- *(later — phase 1 modules still read `config.ts`)* **Modules don't read `process.env`.** Config comes in through `setup(ctx)` already validated. Same rule as `@shadecn/agent` (`agent.md`); an env read inside a module can't be overridden per role and escapes the `server.config.ts` schema.
- **`entities` are registered regardless of `enabled` / role.** A disabled module whose tables vanish from the entity list makes `db:push` see a destructive change and refuse to boot (`deploy.md`, `docs/12` §3.6).
- **`CLUSTER_MODE=single` + a role set that isn't "all roles" is refused at boot** (`@shadecn/server-kit/kernel` `assertRolesSupported`). Two processes without Redis each hold their own Y.Doc — the data-loss case of `docs/14` §2.
- **Cross-role calls are bus request/reply (or the access signal) — never HTTP between roles.** `SharedChannel` doesn't guarantee delivery (`cluster.md`); a reply that never comes must degrade (e.g. `flushRoom` → read the DB), not hang.
- *(later)* **The agent queue has no fast path.** Even in a single all-roles process, `POST /messages` enqueues to `SharedLog` and the in-process consumer claims it. A "start directly when local" branch is a second code path that only runs in dev and masks queue bugs until production.
- *(later)* **Only the claiming agent replica signs the Grant** — "the initiator can enter this canvas right now" is judged at execution time, not at enqueue time (`docs/22` §5).
