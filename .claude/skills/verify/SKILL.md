---
name: verify
description: How to build, launch, and drive this app to verify a change end-to-end in a real browser.
---

# Verifying changes in this repo

Vue 3 SPA served by a NestJS service (pnpm monorepo: `apps/web`, `apps/platform`, `packages/*`).
Unit tests: `pnpm test` (projects in the root `vitest.config.ts`, one per package). End-to-end verification =
drive the page in headless Chromium.

## Launch

```bash
cp -n apps/platform/.env.example apps/platform/.env                 # first run only: secrets, all optional in dev
mkdir -p data && cp -n apps/platform/config.example.yaml data/config.yaml  # first run only: everything else
pnpm dev                                                            # ONE process, ONE port: Nest + Vite as middleware, watch mode
```

`pnpm dev` first builds every `@learning/*` package the platform runs; its watch doesn't pick up changes in them at runtime, so rebuild and restart after changing one.
The port is `server.port` in `data/config.yaml` (default 3001), e.g. http://127.0.0.1:3001.
There is no separate Vite dev server (no 5173) and no proxy. The schema syncs during startup (SQLite at `data/platform.db`).

**Every page and `/api` route needs a session, in dev too** (`.claude/rules/auth.md`); with no provider configured nobody can log in. To verify without a real IdP, start the fake one and point `auth.oidc` at it (it answers `/authorize` with a code for its current `user`, no login form):

```bash
# from packages/session, after pnpm dev built it
node --input-type=module -e "import { startFakeIdp } from '@learning/session/testing'; const idp = await startFakeIdp({ port: 4999 }); console.log(idp.issuer, idp.clientId)"
```

```yaml
# data/config.yaml
auth:
  oidc:
    issuer: http://127.0.0.1:4999
    clientId: platform-client
```

Then open `/login` in the driven browser and click the button, or go straight to `/api/auth/login?provider=oidc&redirect=/`. Its keys and codes live in memory: after restarting it, log in again.

## Drive (Python Playwright)

Python playwright is on PATH but its pinned browser build may be missing —
point it at an installed cache build instead of downloading:

```python
p.chromium.launch(
    executable_path="/Users/fyl/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    args=["--enable-unsafe-swiftshader"],  # WebGL for three.js views
)
```

Collect `pageerror` + console errors; screenshot for evidence.

## Gotchas (3D 视口, /3d-viewport)

- The page is not in the sidebar menu — navigate to `/3d-viewport` directly (after logging in).
- It is only a viewport (no panels, toolbar or timeline): a `<canvas>` with three
  shapes (立方体1 / 球体1 / 圆锥1) and a wireframe-only camera frustum (机位1),
  a 16:9 aspect-ratio overlay, a view helper at top-right and a transform
  button column below it. Nothing is persisted; every load is the same scene.
- Needs WebGL (`--enable-unsafe-swiftshader`); collect `pageerror` + console
  errors and check that revisiting the page still shows the gizmo on click.
