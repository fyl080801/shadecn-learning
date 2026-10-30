---
paths:
  - "apps/web/src/router/**"
  - "apps/web/src/layouts/**"
  - "apps/web/src/App.vue"
  - "apps/web/src/components/ui/**"
  - "apps/web/src/components/*.vue"
  - "apps/web/src/components/settings/**"
  - "apps/web/src/components/icons/**"
  - "apps/web/src/lib/auth.ts"
  - "apps/web/src/lib/theme.ts"
  - "apps/web/src/lib/preferences.ts"
  - "apps/web/src/styles/**"
  - "apps/web/src/style.css"
  - "apps/web/src/views/**"
  - "apps/web/src/login/**"
  - "apps/web/index.html"
  - "apps/web/login.html"
  - "apps/web/components.json"
---

# Frontend shell (`apps/web/src/`)

## Routing and layouts

- `router/index.ts` (vue-router 5, history mode) has exactly **two top-level records, one per layout**, both `path: "/"`; every page is a flat child of one (`projects/:projectId`). It is the only importer of `views/` and `layouts/`. There is no `meta.layout`.
- `App.vue` = `<RouterView />` + `Toaster` (vue-sonner) + `SessionExpiredDialog`; no layout branch. `layouts/SidebarLayout.vue` = `AppSidebar` + scrolling `<main>`, holds almost everything; `layouts/BlankLayout.vue` holds only `/flows/:flowId`. The app is `h-screen`.
- Every SPA route is logged-in; the login page is a separate Vite entry (`login.html`) — a bare layout is not an auth exception.

## Frontend auth

- The gate is server-side (`apps/server/frontend/guard.ts`): anonymous browsers never receive `index.html`. The router's `beforeEach` is the fallback for a session that dies mid-visit: `fetchSession()` (one cached `GET /api/auth/me`), then if anonymous `goToLoginPage()` (`location.replace('/login?redirect=…')`) on the **first** navigation (`from === START_LOCATION`), else `requestReLogin(to.fullPath)`.
- `lib/auth.ts`: `useAuth()` (`user` / `roles` / `isAuthenticated` / `authEnabled` / `sessionExpired` / `hasRole`) and `apiFetch()`. No token in the browser; login/logout are full-page navigations to `/api/auth/login` / `/api/auth/logout`.
- **An expired session is never a silent redirect** (it would destroy unsubmitted input). A 401 only calls `requestReLogin(redirect)` (clears the user, remembers the URL, flips `sessionExpired`); `SessionExpiredDialog.vue` owns every exit (choices: `docs/02` §3.7).
- **Re-login is a popup, not an iframe** (an iframe needs Keycloak to drop `X-Frame-Options` and loses its SSO cookie to third-party-cookie rules). `window.open()` may return `null` (popup blocker) — handle it without closing the dialog (`docs/02` §3.7).
- **Success has two legs** (the session cookie is httpOnly): `apps/server/frontend/login-done-page.ts` renders `/auth/login-done` (registered *after* `pageGuard`), `postMessage`s a same-origin `app-auth:login-done` to `window.opener` and closes. The dialog accepts it only when `event.origin === location.origin` **and** the marker matches, then `finishReLogin()` → `fetchSession(true)` and closes only if `/api/auth/me` says logged-in. A 3s poll is the second leg, and also notices `loginWindow.closed`. `LOGIN_DONE_PATH` / `LOGIN_DONE_SOURCE` / `LOGIN_DONE_MESSAGE` live in `@shadecn/shared/auth`.

## UI components (shadcn-vue)

- In `components/ui/`, added with `pnpm exec shadcn-vue add <name>` **from `apps/web`**; check that new packages landed in `devDependencies`.
- **Icons: `@lucide/vue` only.** Deprecated names (`Home`, `Loader2`, `MoreHorizontal`, `Grid3X3`) still resolve. v1 dropped all brand icons, so brands are inline SVG components like `components/icons/GithubMark.vue` (shared by settings and login) — never a new dependency.
- `cn()` in `lib/utils.ts` = `clsx` + `tailwind-merge`. **Registry items can import `cn` from the bare package `"cn"`**, and the CLI then installs an unrelated npm package `cn` into `apps/web` `dependencies` (happened with `@shadecn/attachment`): rewrite the import to `@/lib/utils` and `pnpm --filter @shadecn/web remove cn`.
- `ui/attachment` (`@shadecn/attachment`) is hand-fixed: `AttachmentTrigger` imports `Primitive`, `AttachmentAction` forwards `class` / `as` to `Button`; its `shimmer` / `scroll-fade-x` / `scrollbar-none` utilities live in `styles/tailwind.css`.
- **`button` is hand-edited**: extra `loading` prop (spinner + auto-`disabled`) and `size` variants `xs` / `icon-xs`. **The CLI rewrites `Button.vue` whenever it's pulled in as a dependency** (e.g. adding `command`) — `git diff apps/web/src/components/ui/button/` after any `add` and `git checkout` it back.
- **`command` is filter-it-yourself for large lists**: its built-in filter renders every item and hides misses with `v-if`. `TimeZonePicker.vue` drives its own keyword + matcher + hard cap and uses `Command` only for keyboard nav, feeding input via reka-ui's `ListboxFilter` (not `CommandInput`). `CommandItem` **must** be inside a `CommandGroup` (throws otherwise); `CommandEmpty` doesn't work in this mode — write the empty state by hand.

## Styling and theme

- Tailwind v4 via `@tailwindcss/vite`; oklch theme variables in `styles/tailwind.css` (`style.css` imports it, `vue-flow.css` and `vue-sonner/style.css`); `tw-animate-css`.
- **`lib/theme.ts` is the only thing that sets `.dark` on `<html>`** (`useColorMode`, key `app:theme`, default system).
- **The first frame is `index.html`'s inline script** (and `login.html`'s copy) — same key, same raw-string format as `theme.ts`.
- `tailwind.css`'s `@layer base` restores `cursor: pointer` for `button:not(:disabled), [role="button"]:not(:disabled)` (v4 Preflight dropped it).
- **Declare `color-scheme` in both blocks** (`light` on `:root`, `dark` on `.dark`) or scrollbars stay white.
- **vue-sonner ignores the class**: `App.vue` feeds its `theme` prop from `resolvedTheme`. **`style.css` must `@import "vue-sonner/style.css"`** — without it toasts render unstyled in the document flow.
- The `.dark` palette deviates from shadcn's default (values: `docs/01` §2.7); the login page's inline CSS carries the same numbers — change both together.

## Views — grouped by feature

- Views are grouped by feature directory (catalog: `docs/01` §2.4.2); `router/index.ts` is their only importer. `views/canvas/` → `flow-editor.md`.
- `components/settings/LinkedAccounts.vue` is the only settings card that writes to the server (rules in `auth.md`). It reads the route, so `Settings.test.ts` mounts through a memory router and stubs `@/lib/api`.
