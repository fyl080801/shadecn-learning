---
paths:
  - "apps/server/test/**"
  - "apps/web/src/test/**"
  - "packages/*/test/**"
  - "**/vitest.config.ts"
---

# Tests (Vitest)

## Projects

- One config per package plus a root aggregator: `apps/server/vitest.config.ts` (`server`, node, `apps/server/test/**/*.test.ts`), `apps/web/vitest.config.ts` (`client`, jsdom + `vue` plugin + `@/`, `apps/web/src/test/**/*.test.ts`), `packages/shared/vitest.config.ts` (`shared`, node, the pure contract), plus `agent`. The root `vitest.config.ts` only lists `projects` and holds coverage.
- **Hermetic**: server and client setup files replace `globalThis.fetch` with a stub that *rejects* — a test needing the network must `vi.stubGlobal('fetch', …)`.

## Backend

- `test/global-setup.ts` wipes `data/test/` and runs the real `tsx db/sync-cli.ts` (cwd `apps/server`) **in a child process** (reading the repo `.env` in Vitest's main process would leak real Keycloak/GitHub config into workers). `fileParallelism: false` protects the shared DB.
- `TEST_DATABASE_URL` = a PostgreSQL URL runs the suite there (`test/paths.ts` derives the provider; it finds the repo root **three levels up**). The PG branch passes `--reset` (drops every table), so it must be a dedicated test database.
- Env comes only from `test.env` in the vitest config; `apps/server/env.ts` is aliased to `test/stubs/env.ts`.
- **`TEST_*` is the exception**: `paths.ts` is imported before Vitest loads `.env`, so `loadTestEnv()` calls `process.loadEnvFile()` itself and **deletes every non-`TEST_` key it introduced**. A command-line value wins. With `TEST_DATABASE_URL` in `.env`, run SQLite as `TEST_DATABASE_URL= pnpm test:server`.
- **GitHub is deliberately not in the global `test.env`** (keeps "the login page has one button" meaningful). `test/routes/auth-github.test.ts` builds a GitHub-enabled app per test with `vi.stubEnv` + `vi.resetModules()` + dynamic `import`; the "not configured" case must call `vi.resetModules()` too.
- Helpers: `helpers/db.ts` (`db` / `orm`, `resetDb` — children first, `createUser` — no `UserIdentity`, i.e. the legacy shape), `helpers/session.ts` (`signIn` → `sid` cookie), `helpers/github.ts` (fake GitHub), `helpers/project.ts` (`actor()` with bound `request`/`json`, `createProject` / `createFlow` / `joinViaInvite`), `helpers/oidc.ts` (fake Keycloak with a real RSA keypair). Routes go through `app.request()` — the full middleware stack.
- **Module-level caches** (`config.ts`, `oidc.ts`'s 10-min discovery/JWKS cache, `lib/auth.ts`'s session singleton) freeze at import: use `vi.resetModules()` + dynamic `import()` (`freshApp()` in `test/routes/auth.test.ts`).

## Frontend

- `apps/web/src/test/` mirrors `src/`. Notable invariants pinned there: the `prompt-input` editor (one `<div data-block-path>` per line, the `FEFF`+`<br>` zero-width invariant, `repairLeafPlaceholders`), the real router guard with `/api/auth/me` stubbed, and `stores/flow` (a second `Y.Doc` as a peer proves per-field merge, undo skips the peer, viewport stays out of the doc). `test/lib/sharedYjs.test.ts` and `apps/server/test/collab/shared-yjs.test.ts` pin the single-yjs `instanceof`.
- **Component tests** (`test/views/`, `@vue/test-utils` + jsdom) mount the real view with only `@/lib/api` stubbed — shadcn-vue and reka-ui run for real.
- **Confirm dialogs: `AlertDialogAction` closes the dialog *before* the forwarded `@click` runs**, so use two refs — one for `open`, one for "which item" — or the handler reads a cleared target and sends nothing. **`@click.prevent` doesn't help** (`DialogClose` ignores `defaultPrevented`). **A confirm that must stay open (multi-step) can't use `AlertDialogAction`** — use a plain `Button` and close from code (e.g. `ModelConfig.vue`'s two-stage delete, whose 409 names who still references the item; pinned by `GalStoryModelConfig.test.ts` / `GalStoryProgressDialog.test.ts`).
- jsdom: menus/dialogs teleport into `document.body`; `DropdownMenuTrigger` opens on `click`, `TabsTrigger` switches on `mousedown`; stub `PointerEvent` + pointer capture.
