---
name: verify
description: How to build, launch, and drive this app to verify a change end-to-end in a real browser.
---

# Verifying changes in this repo

Vue 3 SPA served by a Node/Hono server (pnpm monorepo: `apps/web`, `apps/server`, `packages/shared`).
Unit tests: `pnpm test` (projects `server` / `client` / `shared`). End-to-end verification =
drive the page in headless Chromium.

## Launch

```bash
cp -n .env.example .env   # first run only
pnpm dev                  # ONE process, ONE port: Hono + Vite as middleware, watch mode
```

The port is `PORT` from the repo-root `.env` (default 3000), e.g. http://127.0.0.1:3000 —
there is no separate Vite dev server (no 5173) and no proxy. With no Keycloak/GitHub configured,
auth is off in dev and every page is reachable; otherwise log in via `/login` first.
`pnpm dev` runs `db:push` first (SQLite under the repo-root `data/`).

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

- The page is not in the sidebar menu — navigate to `/3d-viewport` directly.
- It is only a viewport (no panels, toolbar or timeline): a `<canvas>` with three
  shapes (立方体1 / 球体1 / 圆锥1) and a wireframe-only camera frustum (机位1),
  a 16:9 aspect-ratio overlay, a view helper at top-right and a transform
  button column below it. Nothing is persisted; every load is the same scene.
- Needs WebGL (`--enable-unsafe-swiftshader`); collect `pageerror` + console
  errors and check that revisiting the page still shows the gizmo on click.
