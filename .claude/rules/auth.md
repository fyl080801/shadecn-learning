---
paths:
  - "packages/mod-auth/**"
  - "packages/server-kit/src/session.ts"
  - "packages/server-kit/src/oauth/**"
  - "packages/session/**"
  - "apps/web/src/lib/auth.ts"
  - "apps/web/src/components/settings/**"
  - "apps/web/src/login/**"
---

# Auth — Keycloak OIDC + GitHub OAuth2, BFF style (`docs/02-auth-keycloak.md`)

> Login is the **`@shadecn/mod-auth`** module (`docs/28` §3.1): every path below is relative to `packages/mod-auth/src/` (`auth/x.ts` = `x.ts`, `store/identities.ts` = `identities.ts`, `routes/*` = `routes/*`, `avatar/` = `avatar/`). It **provides the platform's `auth`** (`AUTH_SERVICE`): the core pipeline's session parsing, login gate and page guard, and every module's `ctx.platform.auth.userId` / `identify` / `deriveSecret`, forward to `module.ts`'s provider. Its settings are the `modules.auth` config section (`config.ts`: parse + `assertAuthSettings` — production without a provider or `MODULES_AUTH_SESSION_SECRET` fails at parse), handed over in `setup` (`configureAuthSettings`) and read through `settings.ts`'s **live-binding exports** (`authConfig`, `authEnabled`, …) — **read them at call time, never at import time** (they aren't configured yet; that's why `session.ts` has `sessionSecret()` and the providers' `enabled` are getters). Origins come from `platform().origins`. The `User` entity is the platform's (`@shadecn/server-kit/identity`).

The browser never sees a token: the code exchange is server-side, tokens live in the database, the client holds only an httpOnly `sid` cookie. Frontend auth / re-login is in `web-shell.md`.

## Providers

- **`auth/providers/` keeps everything else provider-blind.** `types.ts` declares `authorizationUrl` / `exchange` / `refresh`; `index.ts`'s `REGISTRY` order is the login-page button order. **Adding a login method = one file + one array entry.** `refresh: null` is legitimate (GitHub OAuth App tokens never expire; a github session's `expiresAt` = `MODULES_AUTH_SESSION_TTL`, the session-age cap ends it). `Session.provider` says who renews.
- **One callback path** (`/api/auth/callback`) for all providers; `AuthRequest.provider` dispatches.
- **The protocol code lives in `@shadecn/server-kit/oauth`** (`createOidcClient`, `createGithubClient`, `pickOrigin`, `OidcError`): no config, entities or global state, config comes through a getter read at call time and caches live on the client instance. `auth/oidc.ts` and `auth/providers/*` only wire `settings.ts` into it. The first-login identity branches are in `login-identity.ts`'s `resolveLoginIdentity(em, { provider, profile, ownsRoles })`.
- **`@learning/session` has its own copy of all of it** (`src/oauth/`, `src/login-identity.ts`, `src/login-done-page.ts`, `src/session-token.ts`), so the two products no longer share security code: **a protocol or identity fix goes into both.** The login-done constants can't be imported from `@shadecn/shared` any more; `test/login-done-page.test.ts` reads `packages/shared/src/auth.ts` and compares, because a wrong value only leaves the login window open with no error.
- `oauth/oidc.ts` — cached `.well-known` discovery (never hard-code endpoints), PKCE `S256`, `exchangeCode` / `refreshTokens` / `revokeRefreshToken`, `buildLogoutUrl`, `verifyIdToken` (JWKS, kid miss → one refetch, `crypto.createPublicKey({format:'jwk'})` for RS/PS/ES, then `iss`/`aud`/`azp`/`exp`/`iat`/`nonce`). No `jose` / `openid-client`. `OidcError` (`code` + `retryable`) is shared with GitHub so retry logic has one judgement.
- **`oauth/github.ts` — GitHub is not OIDC**: endpoints hard-coded; no `id_token` (identity = `/user`, plus `/user/emails` only when `/user` has no address — unreachable means no email, not a failure); **the token endpoint returns HTTP 200 on failure** (check the body's `error`); no PKCE (replay protection = one-shot `AuthRequest`). Roles are always `[]`.

## Callback origin (multi-domain)

- **The callback host follows the domain the browser used** — `settings.ts`'s `originOf(c)` (= `platform().origins.of(c)`), gated by `SERVER_ORIGINS`. With one fixed origin, logging in on domain B finishes on A and B stays anonymous, with no error anywhere. `redirect_uri`, the CORS echo, the WebSocket `Origin` check, invite links and the cookie `Secure` flag all use it.
- **Never follow `Host` blindly** (attacker-controllable behind a proxy → the code is mailed elsewhere). Take the first of `X-Forwarded-Proto`+`X-Forwarded-Host` → `Host` → `Origin` that is **on the whitelist**, else `SERVER_ORIGIN`. `SERVER_ORIGIN` is always a member; comparison is normalized (lowercase, no trailing slash, default port dropped, http/https only); **no wildcards** (each domain's callback must be registered in Keycloak anyway).
- **`AuthRequest.origin` is stored** — the token exchange's `redirect_uri` must match the authorization step exactly; never recompute it.
- **`Secure` is per-request** (`secureCookieFor`) — on http the browser silently discards a Secure cookie ("logged in but still logged out", clean logs).

## Sessions — `auth/session.ts`

- The cookie holds a 32-byte random token; the row id is `HMAC-SHA256(MODULES_AUTH_SESSION_SECRET, token)`, so a DB dump can't forge a cookie. **These functions and `toSessionUser` / `SessionUser` live in `@shadecn/server-kit/session`** (no entities, no global state, the secret is an argument); `session.ts` re-exports the last two. Changing the digest logs everyone out, so the expected value is a hard-coded literal in `apps/server/test/auth/session.test.ts` (and `packages/session/test/session-token.test.ts` for that package's copy).
- `loadSession()` refreshes an access token within 30s of expiry (concurrent refreshes deduped per session) — **traffic keeps the session alive**; it expires once the refresh token passes Keycloak's SSO Session Idle. `loadSession(token, { refresh: false })` is the read-only variant for non-user traffic (collab revalidation): never renews, never deletes.
- **A failed refresh is not uniformly fatal**: only a 4xx (`invalid_grant`) destroys the session. Network errors, timeouts, 5xx, local DB failures keep it and retry next request, with a 15s per-session cooldown. Every outbound OIDC request has an 8s timeout. `sweepExpired()` drops expired sessions and unused auth requests.
- **`@learning/session` (Nest, `packages/session`) has the same renewal semantics as `loadSession`**: same rows, same HMAC, 30s window, only a 4xx deletes, 15s cooldown, `expiresAt` of a GitHub session = the session TTL. `SessionGuard` puts only a `SessionUser` on the request, never the session entity (it carries the tokens). Three differences, each on purpose: the dedupe is an in-process promise map, not a shared lock (**a second replica would race the rotating refresh token into `invalid_grant` and delete the session**, so it needs `sharedLock`'s equivalent first); `renew` re-reads the row after winning (a request that read the old row just before another renewal committed would otherwise spend the rotated refresh token); and a session whose provider is no longer configured can't renew, so it dies at `expiresAt`. `sweepExpired` must not delete on `expiresAt`: that is the access token, and the refresh token may still be good.
- **`apps/platform` gates every page and `/api` route even with no provider** (no mod-auth-style "no IdP = open"; only an explicit `web.auth: false` opens the pages, never `/api`). `ApiSessionGuard` must not decide on `request.url` alone: Fastify decodes before routing, so `/%61pi/secret` hits `/api/secret` with a url that doesn't start with `/api`. It checks the matched route pattern and the decoded path. Non-`/api` passes because the page fallback is a Nest controller too; pages belong to `@learning/web`'s gate. With no provider, `/api/auth/config` says `enabled: false` (no way to log in) while `/api/auth/me` still says `enabled: true` (the gate is on): the SPA needs the latter for its 401 dialog, the login page the former for its "unavailable" notice. `safeRedirect` also exists in `@learning/web` and `@learning/session` (they can't share code) and additionally rejects control characters: `/<TAB>/evil.com` becomes `//evil.com` in browsers. mod-auth's still lacks that check.
- `auth/middleware.ts` — `withSession` (the platform's `auth.session`, run by the core pipeline on `*` — the page gate needs it), `requireAuth` (401, the platform's `auth.requireUser`), `requireRole(...)` (403). Realm roles land in `User.roles` as-is, client roles as `clientId:role`. `packages/mod-collab/src/authorize.ts` does the same check for WebSocket handshakes (through the platform's `auth.identify` = this module's provider); `auth/redirect.ts`'s `safeRedirect()` is the shared in-site check for every `?redirect=` (`//evil.com`, `/\evil.com` → `/`).

## `SessionIdentityModule` / `LoginModule` in `@learning/session`

- **The refresh client sits in the identity module** (`token-refresher.ts`, config `auth.oidc` only), not with the login providers: `SessionService.load` renews, and a process with only the identity module has no login flow. `AuthProviders` reuses that client, so discovery and JWKS caches aren't duplicated.
- **Before a second process shares the database with an identity module, two things are bugs** (`apps/platform` is one process today): it must have the same `auth.oidc`, or it can't renew and `load` deletes the session at `expiresAt`; and it needs a shared lock around `renew` first (the in-process dedupe above).
- **The sweep belongs to `LoginModule`** (`session-sweeper.ts`): one process per database is enough, and it also owns `AuthRequest`. Without it `SessionService` still bounds its cooldown map, pruning expired entries when it adds one.
- **Each module registers its own tables** (`DATA_ACCESS_ENTITIES`, `.claude/rules/database.md`): identity `Session`; login `UserIdentity`, `PendingLink`, `AuthRequest`. Their definitions are `apps/server`'s tables column for column (even the `keycloak` defaults): on SQLite any column change is a rebuild, so the start refuses.

## Login in `@learning/session` (`auth.controller.ts`, `login.service.ts`, `auth-options.ts`)

- **Secrets and half configs fail the start, in dev too** (unlike mod-auth, where dev only warns): a `clientSecret` in `config.yaml` would otherwise be ignored and the OIDC client silently become public. Provider ids are `oidc` and `github`; `ownsRoles` (only `oidc`) decides who writes `User.roles`.
- **Origins**: `server.origins` is the whitelist and its first entry the fallback; production with a provider and no list refuses to boot, because the callback would silently point at `localhost`. **`Secure` comes from the `pickOrigin` result, never `request.protocol`**: without `trustProxy` Fastify can't see `X-Forwarded-Proto`, so behind TLS it says `http` and the cookies would lose the flag. The session cookie uses the stored `AuthRequest.origin`.
- **`/auth/login-done` is not a backend route here.** Vite answers everything outside `/api` in `onRequest`, and in `static` the path is the gated HTML fallback, so `afterLogin` rewrites that exact redirect to `/api/auth/login-done`. Other redirects pass through `safeRedirect`, which also percent-encodes non-ASCII (a raw one throws `ERR_INVALID_CHAR` when set as `Location`).
- **Log and `?error=` text never carries a raw error from outside the protocol layer** (`errors.ts`): MikroORM's exception message holds the full SQL with values, which for a failed `Session` insert is the access token. Only `OidcError` has a message worth keeping, and a retryable one is replaced for the browser (it names the internal IdP URL).
- Changing `auth.oidc.issuer` keeps old rows: identity is `(provider, subject)`, so a new IdP that reuses a `sub` lands on the old account. Clear `UserIdentity` for `oidc` when switching IdPs.

## Routes — `routes/auth.ts`

- `GET /api/auth/{config,me,login,link/:provider,callback,identities,logout}` + `DELETE /api/auth/identities/:id`. `/me` always answers 200 (`{enabled, authenticated, user}`). `state` / `nonce` / `code_verifier` live in `AuthRequest`, keyed by a short-lived `oidc_tx` cookie, consumed exactly once.
- **`/api/auth` is in `PUBLIC_API`**, so the logged-in-only endpoints check `c.get('user')` themselves.
- **Logout only ends the local session** — don't add token revocation or RP-initiated logout (`docs/02` §3.2.3).
- No IdP configured (`MODULES_AUTH_KEYCLOAK_ISSUER` + `MODULES_AUTH_KEYCLOAK_CLIENT_ID`, or `MODULES_AUTH_GITHUB_CLIENT_ID` + `MODULES_AUTH_GITHUB_CLIENT_SECRET`) → `authEnabled = false`: dev warns and lets everything through, production refuses to boot. Half a provider is reported as a missing variable.

## Account linking

- **Login and linking are the same flow**; `AuthRequest.linkUserId` makes the callback stash a pending link instead of minting a session. The callback **reads the `AuthRequest` before looking at `?error=`** (a cancelled link must return to `/settings`), and re-checks `c.get('user')?.id === linkUserId`.
- **A link is never written until the user confirms which account it is** (`PendingLink` + `POST /api/auth/link/confirm`). The browser may be signed into someone else's GitHub, an authorized OAuth App skips consent, and GitHub has no account chooser — so we ask. The callback only pre-checks (`identities.checkLink`, read-only) and stashes; confirm re-runs the real check. **One pending row per user** (a retry replaces it); **no access token stored** for it; pending state rides **`GET /api/auth/identities`, not the URL**; confirm is **POST**.
- Linking is a **full-page navigation** to `/api/auth/link/:provider`; the confirm dialog opens from `pending` on `GET /api/auth/identities`, never from URL state; `?link_error=` is read once and stripped from the URL (UI: `docs/02` §3.9).

## Identities — `store/identities.ts`

- Each binding is a `UserIdentity`; `unique(provider, subject)` *is* the conflict check. The **primary identity** has no flag column — it's the row whose `(issuer, subject)` equals `User.issuer` / `User.subject`.
- Every login refreshes *that identity's* display fields; **`User` profile fields follow only the primary identity**; **`User.roles` is written only on a Keycloak login** (GitHub reports `[]`).
- Unbinding the last identity → 409 (no recovery path). Unbinding the primary promotes another row, rewrites the two columns, leaves name/avatar alone. Legacy users get their primary row **backfilled on use** (login adopts, `listFor` writes on read).
- **Identity is `(provider, subject)`, never email** — no "same email = same person", not even verified. Email changes and gets reassigned, Apple relays differ per app, and auto-merge is the classic takeover path (we can't re-check another IdP's `email_verified`). Merging only happens via 关联 from a signed-in session (`docs/02` §3.9.1, §3.9.3).

## Profile hooks and avatars

- **`auth/profile.ts` keeps post-login defaults out of the login path.** `registerProfileHook({name, fill})` adds a rule; `completeUserProfile(user)` runs them in the callback and in `auth/current-user.ts`'s dev-user path. Hooks answer "what's missing", merged into **one** update; a throwing hook is logged and skipped. Runs on every login — that is the backfill. New rule = one file + one `registerProfileHook`.
- **`avatar/`** — no avatar → identicon (minidenticons). Keycloak's `picture` wins. **No image stored**: the DB holds `/api/avatars/<seed>.svg`, `routes/avatars.ts` renders it (no DB read, `immutable` for a year). Seed = `sha256(issuer + "\n" + subject)` truncated to 16 hex. The route module installs the hook, so mounting it in `app.ts` is the one line. **Put a round background under any displayed avatar** (`bg-muted` / `bg-sidebar-accent`) — the identicon is transparent.
