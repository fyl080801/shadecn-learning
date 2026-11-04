---
paths:
  - "apps/platform/test/**"
  - "apps/collab/test/**"
  - "apps/agent-runner/test/**"
  - "apps/web/src/test/**"
  - "packages/*/test/**"
  - "**/vitest.config.ts"
---

# Tests (Vitest)

## Projects

- One config per package plus a root aggregator: `apps/web/vitest.config.ts` (`client`, jsdom + `vue` plugin + `@/`, `apps/web/src/test/**/*.test.ts`), `packages/shared/vitest.config.ts` (`shared`, node, the pure contract), and one node project per `@learning/*` package and Nest app. The root `vitest.config.ts` only lists `projects` and holds coverage; a new package needs an entry there and in coverage's `include`.
- **Nest projects transpile through swc** (`unplugin-swc`): the root vite's esbuild drops `emitDecoratorMetadata` and DI gets `undefined`. Packages without decorators (`llm`, `contracts`, `agent-core`, `agent-runner`) don't need it.
- **Their aliases point `@learning/*` at source, so tests need no build.** `@learning/x/testing` must be listed before `@learning/x`, or it is taken as a subpath of the main entry. A package's tests that run real output say so and build it themselves (`packages/data-access/test/dist.test.ts`, `packages/agent-core/test/runner-process.test.ts`).
- **The frontend is hermetic**: `apps/web/src/test/setup.ts` replaces `globalThis.fetch` with a stub that *rejects*; a test needing the network must `vi.stubGlobal('fetch', …)`. The Nest projects have no such setup file.

## Backend (`@learning/*`)

- **Each package has a `test/package.test.ts`-style boundary test where it matters** (what it may import, what its closure may reach); a failure there is a real dependency problem, not a list to widen.
- **Configuration comes from `@learning/config/testing`'s `testConfigModule(values, options)`**, never a developer's `data/config.yaml` or `.env`. Whole-app tests write a real `$DATA_DIR/config.yaml` and `vi.stubEnv` the secrets (`apps/platform/test/login.test.ts`).
- **Real wiring, real HTTP pipeline**: `Test.createTestingModule` + `FastifyAdapter`, with `test/helpers.ts` per package. Tokens like `S3_CLIENT` are swapped with `overrideProvider`.
- **SQLite temp files by default** (`fileParallelism: false` in the packages touching the database). `PLATFORM_TEST_DATABASE_URL` runs PostgreSQL; it drops the `public` schema between tests, so the fixture refuses a database whose name doesn't contain both `platform` and `test`. `PLATFORM_TEST_REDIS_URL` turns on the shared layer and cross-replica cases, `PLATFORM_TEST_S3_URL` the real-S3 suites (the root `vitest.config.ts` header lists which package reads which). **An ordinary run proves nothing about these**: anything measured only on one of them (SQL differences, Redis timing) has to be run there.
- **`@learning/session/testing`**: `startFakeIdp()` is a real HTTP server (discovery, PKCE-checking token endpoint, JWKS, RSA-signed `id_token`, a fake GitHub) and `FakeBrowser` keeps cookies the way a browser does (drops `Secure` on http, honours `Path`). GitHub's endpoints are hard-coded, so `vi.stubGlobal('fetch', idp.fetch)` is the injection point; it also rejects anything not on loopback.
- Agent tests: `agent.md`.

## Frontend

- `apps/web/src/test/` mirrors `src/`. Notable invariants pinned there: the `prompt-input` editor (one `<div data-block-path>` per line, the `FEFF`+`<br>` zero-width invariant, `repairLeafPlaceholders`), the real router guard with `/api/auth/me` stubbed, and `stores/flow` (a second `Y.Doc` as a peer proves per-field merge, undo skips the peer, viewport stays out of the doc). `test/lib/sharedYjs.test.ts` and `packages/collab/test/shared-yjs.test.ts` pin the single-yjs `instanceof`.
- **Component tests** (`test/views/`, `@vue/test-utils` + jsdom) mount the real view with only `@/lib/api` stubbed — shadcn-vue and reka-ui run for real.
- **Confirm dialogs: `AlertDialogAction` closes the dialog *before* the forwarded `@click` runs**, so use two refs — one for `open`, one for "which item" — or the handler reads a cleared target and sends nothing. **`@click.prevent` doesn't help** (`DialogClose` ignores `defaultPrevented`). **A confirm that must stay open (multi-step) can't use `AlertDialogAction`** — use a plain `Button` and close from code.
- jsdom: menus/dialogs teleport into `document.body`; `DropdownMenuTrigger` opens on `click`, `TabsTrigger` switches on `mousedown`; stub `PointerEvent` + pointer capture.
