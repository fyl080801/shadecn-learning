---
paths:
  - "apps/server/kernel/**"
  - "apps/server/modules/**"
  - "apps/server/boot.ts"
  - "apps/server/dev.ts"
  - "apps/server/index.ts"
  - "apps/server/routes/features.ts"
  - "server.config.ts"
  - "server.config.*.ts"
  - "packages/mod-*/**"
---

# Server modules & roles (REQ-MODULES, `docs/28-server-modules.md`)

> Phase 1 of `docs/28` §7 is in (`kernel/`, `modules/`, `boot.ts`, `dev.ts`); phases 2–6 are not. Lines marked *(later)* describe code that doesn't exist yet — keep them as the target, fill in file names as each phase lands, delete anything that turns out not to hold.

- **A module is wired only through `kernel/module.ts`'s contract.** `setup(ctx)` returns a `ModuleHandle`; the kernel orders `setup` by `dependsOn` / `optional` (`resolve.ts`) and runs `shutdown` in reverse under each handle's `shutdownTimeoutMs` (`lifecycle.ts`). Don't hand-wire an order in `boot.ts` / `index.ts` again — `agent` shutting down before `collab` flushes is *derived* from `agent.dependsOn: ['collab']`, so a new module that must stop before collab declares the dependency rather than editing boot.
- **`modules/frontend-dev.ts` is imported by `dev.ts` only.** `index.ts` is the single esbuild entry; `assertNoDevCode` in `build-server.mjs` fails the build if `dev.ts`, `frontend/dev.ts`, `modules/frontend-dev.ts` or the `vite` package reach the metafile.
- **`assertRolesSupported` refuses every role set except "all" until phase 4** (routes are still mounted statically in `app.ts`, modules still call each other directly). Lift that guard only together with the role-gated route mounting, never on its own.

- *(later)* **A module never imports another module's internal files.** It reaches a peer only through `ctx.service('<name>')` (declared in the peer's `provides`) and the bus. The reason the split is possible at all is that the only coupling left is the shared layer; a direct import silently reintroduces "same process" as a requirement and the role deployment breaks without a type error.
- *(later — phase 1 modules still read `config.ts`)* **Modules don't read `process.env`.** Config comes in through `setup(ctx)` already validated. Same rule as `@shadecn/agent` (`agent.md`); an env read inside a module can't be overridden per role and escapes the `server.config.ts` schema.
- **`entities` are registered regardless of `enabled` / role.** A disabled module whose tables vanish from the entity list makes `db:push` see a destructive change and refuse to boot (`deploy.md`, `docs/12` §3.6).
- **`CLUSTER_MODE=single` + a role set that isn't "all roles" is refused at boot** (`kernel/roles.ts`). Two processes without Redis each hold their own Y.Doc — the data-loss case of `docs/14` §2.
- *(later)* **Cross-role calls are bus events or bus request/reply with a timeout and a fallback — never HTTP between roles.** `SharedChannel` doesn't guarantee delivery (`cluster.md`); a reply that never comes must degrade (e.g. `flush` → read the DB), not hang.
- *(later)* **The agent queue has no fast path.** Even in a single all-roles process, `POST /messages` enqueues to `SharedLog` and the in-process consumer claims it. A "start directly when local" branch is a second code path that only runs in dev and masks queue bugs until production.
- *(later)* **Only the claiming agent replica signs the Grant** — "the initiator can enter this canvas right now" is judged at execution time, not at enqueue time (`docs/22` §5).
