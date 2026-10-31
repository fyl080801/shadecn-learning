---
paths:
  - "apps/server/kernel/**"
  - "apps/server/dev.ts"
  - "apps/server/index.ts"
  - "server.config.ts"
  - "server.config.*.ts"
  - "packages/mod-*/**"
---

# Server modules & roles (REQ-MODULES, `docs/28-server-modules.md`)

> Draft — written before the implementation. Each line below is an invariant the obvious change would break; fill in file names as the steps in `docs/28` §7 land, and delete anything that turns out not to hold.

- **A module never imports another module's internal files.** It reaches a peer only through `ctx.service('<name>')` (declared in the peer's `provides`) and the bus. The reason the split is possible at all is that the only coupling left is the shared layer; a direct import silently reintroduces "same process" as a requirement and the role deployment breaks without a type error.
- **Modules don't read `process.env`.** Config comes in through `setup(ctx)` already validated. Same rule as `@shadecn/agent` (`agent.md`); an env read inside a module can't be overridden per role and escapes the `server.config.ts` schema.
- **`entities` are registered regardless of `enabled` / role.** A disabled module whose tables vanish from the entity list makes `db:push` see a destructive change and refuse to boot (`deploy.md`, `docs/12` §3.6).
- **`index.ts` must not reference `frontend/dev.ts`, statically or dynamically.** Only `dev.ts` (the `tsx watch` entry) may. `build-server.mjs` asserts the metafile contains neither `frontend/dev` nor `vite`; if you need Vite in a new place, it goes in `dev.ts`.
- **`CLUSTER_MODE=single` + a role set that isn't "all roles" is refused at boot.** Two processes without Redis each hold their own Y.Doc — the data-loss case of `docs/14` §2.
- **Cross-role calls are bus events or bus request/reply with a timeout and a fallback — never HTTP between roles.** `SharedChannel` doesn't guarantee delivery (`cluster.md`); a reply that never comes must degrade (e.g. `flush` → read the DB), not hang.
- **The agent queue has no fast path.** Even in a single all-roles process, `POST /messages` enqueues to `SharedLog` and the in-process consumer claims it. A "start directly when local" branch is a second code path that only runs in dev and masks queue bugs until production.
- **Only the claiming agent replica signs the Grant** — "the initiator can enter this canvas right now" is judged at execution time, not at enqueue time (`docs/22` §5).
