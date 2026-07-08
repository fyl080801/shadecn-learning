---
name: verify
description: How to build, launch, and drive this app to verify a change end-to-end in a real browser.
---

# Verifying changes in this repo

Vue 3 + Vite SPA; no tests. Verification = drive the page in headless Chromium.

## Launch

```bash
pnpm dev   # Vite; picks next port if 5173 busy — read the port from stdout
```

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

## Gotchas (3D 导演台, /3d-scene)

- Right sidebar panels (scene/object/camera) all stay mounted via `v-show` —
  always scope locators with `:visible` (e.g. `input[inputmode=decimal]:visible`).
- Layout hooks: left panel `aside.w-56`, right panel `aside.w-72`.
- Toolbar buttons are icon-only; select by lucide class,
  e.g. `button:has(svg.lucide-camera)` (add 机位), `svg.lucide-user-plus` (add 图形).
- In the 添加图形 dropdown, first item "上传文件/本地上传" is a no-op without a
  file — to add geometry hover 几何模型, wait for
  `[data-slot=dropdown-menu-sub-content]`, click e.g. 立方体.
- Scene objects get numbered names (机位1, 立方体1); scene list rows are
  `span.truncate` inside `aside.w-56`.
- shadcn selects: trigger `[data-slot=select-trigger]:visible`, options via
  `get_by_role("option", name=...)`. Sliders: focus `[role=slider]` + ArrowRight.
- reka NumberField inputs commit on Enter/blur after `fill()`.
