---
paths:
  - "apps/server/test/**"
  - "apps/agent-sandbox/test/**"
  - "apps/agent-runner/test/**"
  - "apps/web/src/test/**"
  - "packages/*/test/**"
  - "**/vitest.config.ts"
---

# Tests (Vitest)

## Projects

- One config per package plus a root aggregator: `apps/server/vitest.config.ts` (`server`, node, `apps/server/test/**/*.test.ts`), `apps/web/vitest.config.ts` (`client`, jsdom + `vue` plugin + `@/`, `apps/web/src/test/**/*.test.ts`), `packages/shared/vitest.config.ts` (`shared`, node, the pure contract), plus `agent`, `agent-sandbox` (`apps/agent-sandbox`, the build scripts + a real in-memory esbuild of the runner), `agent-runner` (the same for `apps/agent-runner`), `server-kit` and one per `packages/mod-*` (node, no DB). The root `vitest.config.ts` only lists `projects` and holds coverage; a new package needs an entry there.
- **Hermetic**: server and client setup files replace `globalThis.fetch` with a stub that *rejects* — a test needing the network must `vi.stubGlobal('fetch', …)`.

## Backend

- `test/global-setup.ts` wipes `data/test/` and runs the real `tsx db-sync.ts` (cwd `apps/server`) **in a child process** (reading the repo `.env` in Vitest's main process would leak real Keycloak/GitHub config into workers). `fileParallelism: false` protects the shared DB.
- `TEST_DATABASE_URL` = a PostgreSQL URL runs the suite there (`test/paths.ts` derives the provider; it finds the repo root **three levels up**). The PG branch passes `--reset` (drops every table), so it must be a dedicated test database.
- Env comes only from `test.env` in the vitest config; the core's `./env.ts` import (in `@shadecn/server-core`'s `config-source.ts`) is aliased to `test/stubs/env.ts`.
- **`test/setup.ts` assembles the real platform per file** (`prepare(modules)` + `assemble`, all roles, no listen): module routes exist only after that. Anything that needs a different env re-assembles a **fresh module graph** — `helpers/fresh-app.ts` `importFreshApp()` (whole app; swaps the `globalThis` ORM cache so `helpers/db.ts` keeps its own), `helpers/auth.ts` `freshAuth()` (re-parse + hand the login settings to a fresh mod-auth), `helpers/config.ts` `loadServerConfig()` (core + module config sections, the old flat shape), `helpers/routes.ts` (the product's route table).
- **`TEST_*` is the exception**: `paths.ts` is imported before Vitest loads `.env`, so `loadTestEnv()` calls `process.loadEnvFile()` itself and **deletes every non-`TEST_` key it introduced**. A command-line value wins. With `TEST_DATABASE_URL` in `.env`, run SQLite as `TEST_DATABASE_URL= pnpm test:server`.
- **GitHub is deliberately not in the global `test.env`** (keeps "the login page has one button" meaningful). `test/routes/auth-github.test.ts` builds a GitHub-enabled app per test with `vi.stubEnv` + `importFreshApp()`; the "not configured" case must build a fresh app too.
- Helpers: `helpers/db.ts` (`db` / `orm`, `resetDb` — children first, `createUser` — no `UserIdentity`, i.e. the legacy shape), `helpers/session.ts` (`signIn` → `sid` cookie), `helpers/github.ts` (fake GitHub), `helpers/project.ts` (`actor()` with bound `request`/`json`, `createProject` / `createFlow` / `joinViaInvite`), `helpers/oidc.ts` (fake Keycloak with a real RSA keypair). Routes go through `app.request()` — the full middleware stack.
- **`@learning/session/testing`** (`apps/platform`, `packages/session`): `startFakeIdp()` is a real HTTP server (discovery, PKCE-checking token endpoint, JWKS, RSA-signed `id_token`, a fake GitHub) and `FakeBrowser` keeps cookies the way a browser does (drops `Secure` on http, honours `Path`). GitHub's endpoints are hard-coded, so `vi.stubGlobal('fetch', idp.fetch)` is the injection point; it also rejects anything not on loopback.
- **Module-level caches** (`config.ts`, `oidc.ts`'s 10-min discovery/JWKS cache, `lib/auth.ts`'s session singleton) freeze at import: use the fresh helpers above (a bare `vi.resetModules()` + `import` gives a module whose settings were never handed over).

## Frontend

- `apps/web/src/test/` mirrors `src/`. Notable invariants pinned there: the `prompt-input` editor (one `<div data-block-path>` per line, the `FEFF`+`<br>` zero-width invariant, `repairLeafPlaceholders`), the real router guard with `/api/auth/me` stubbed, and `stores/flow` (a second `Y.Doc` as a peer proves per-field merge, undo skips the peer, viewport stays out of the doc). `test/lib/sharedYjs.test.ts` and `apps/server/test/collab/shared-yjs.test.ts` pin the single-yjs `instanceof`.
- **Component tests** (`test/views/`, `@vue/test-utils` + jsdom) mount the real view with only `@/lib/api` stubbed — shadcn-vue and reka-ui run for real.
- **Confirm dialogs: `AlertDialogAction` closes the dialog *before* the forwarded `@click` runs**, so use two refs — one for `open`, one for "which item" — or the handler reads a cleared target and sends nothing. **`@click.prevent` doesn't help** (`DialogClose` ignores `defaultPrevented`). **A confirm that must stay open (multi-step) can't use `AlertDialogAction`** — use a plain `Button` and close from code.
- jsdom: menus/dialogs teleport into `document.body`; `DropdownMenuTrigger` opens on `click`, `TabsTrigger` switches on `mousedown`; stub `PointerEvent` + pointer capture.
