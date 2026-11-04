---
paths:
  - "packages/session/**"
  - "apps/platform/src/page-auth.module.ts"
  - "apps/web/src/lib/auth.ts"
  - "apps/web/src/components/settings/**"
  - "apps/web/src/login/**"
---

# Auth — OIDC + GitHub OAuth2, BFF style (`docs/02-auth-keycloak.md`)

Login is `@learning/session` (`packages/session/src/`, every path below is relative to it), in two modules: `SessionIdentityModule` (sessions, guards, renewal) and `LoginModule` (the login flow, linking, avatars, the sweep). Settings are its `session` and `auth` sections plus `server.origins`, secrets only from `.env` (`PLATFORM_SESSION_SECRET`, `PLATFORM_OIDC_CLIENT_SECRET`, `PLATFORM_GITHUB_CLIENT_SECRET`). The `User` entity is `@learning/data-access`'s.

The browser never sees a token: the code exchange is server-side, tokens live in the database, the client holds only an httpOnly session cookie (`session.cookieName`, default `sid`). Frontend auth / re-login is in `web-shell.md`.

## Providers

- **`auth-providers.ts` keeps everything else provider-blind.** `LoginProvider` declares `authorizationUrl` / `exchange`; the array order is the login-page button order and the first entry is the default when there's no `?provider=`. Renewal is separate (`token-refresher.ts`, below): a provider with no refresh is legitimate (GitHub OAuth App tokens never expire; a github session's `expiresAt` = `session.ttlSeconds`, the session-age cap ends it). `Session.provider` says who renews.
- **One callback path** (`/api/auth/callback`) for all providers; `AuthRequest.provider` dispatches.
- **The protocol code lives in `oauth/`** (`createOidcClient`, `createGithubClient`, `pickOrigin`, `OidcError`): no config, entities or global state, config comes through a getter read at call time and caches live on the client instance. The first-login identity branches are in `login-identity.ts`'s `resolveLoginIdentity`.
- **The login-done constants can't be imported from `@shadecn/shared`**; `test/login-done-page.test.ts` reads `packages/shared/src/auth.ts` and compares, because a wrong value only leaves the login window open with no error.
- `oauth/oidc.ts` — cached `.well-known` discovery (never hard-code endpoints), PKCE `S256`, id-token verification (JWKS, kid miss → one refetch, `crypto.createPublicKey({format:'jwk'})` for RS/PS/ES, then `iss`/`aud`/`azp`/`exp`/`iat`/`nonce`). No `jose` / `openid-client`. `OidcError` (`code` + `retryable`) is shared with GitHub so retry logic has one judgement. Realm roles land in `User.roles` as-is, client roles as `clientId:role`.
- **`oauth/github.ts` — GitHub is not OIDC**: endpoints hard-coded; no `id_token` (identity = `/user`, plus `/user/emails` only when `/user` has no address — unreachable means no email, not a failure); **the token endpoint returns HTTP 200 on failure** (check the body's `error`); no PKCE (replay protection = one-shot `AuthRequest`). Roles are always `[]`.
- **Provider ids differ from the contract**: `@learning/contracts`'s `ProviderId` says `keycloak | github` (a byte copy, it can't change alone) and this package says `oidc | github`, so its views widen `provider` to `string`. The frontend falls back to a default icon.

## Callback origin (multi-domain)

- **The callback host follows the domain the browser used**, gated by `server.origins` (`RequestOrigins`, `oauth/origin.ts`). With one fixed origin, logging in on domain B finishes on A and B stays anonymous, with no error anywhere. `redirect_uri`, the WebSocket `Origin` check, invite links and the cookie `Secure` flag all use it.
- **Never follow `Host` blindly** (attacker-controllable behind a proxy → the code is mailed elsewhere). `pickOrigin` takes the first of `X-Forwarded-Proto`+`X-Forwarded-Host` → `Host` → `Origin` that is **on the whitelist**, else the list's first entry. Comparison is normalized (lowercase, no trailing slash, default port dropped, http/https only); **no wildcards** (each domain's callback must be registered at the provider anyway). Production with a provider and no list refuses to boot, because the callback would silently point at `localhost`.
- **`AuthRequest.origin` is stored** — the token exchange's `redirect_uri` must match the authorization step exactly; never recompute it. The session cookie uses it too.
- **`Secure` comes from the `pickOrigin` result, never `request.protocol`**: without `trustProxy` Fastify can't see `X-Forwarded-Proto`, so behind TLS it says `http` and the cookies would lose the flag. On http the browser silently discards a Secure cookie ("logged in but still logged out", clean logs).

## Sessions — `session.service.ts`

- The cookie holds a 32-byte random token; the row id is `HMAC-SHA256(session secret, token)` (`session-token.ts`), so a DB dump can't forge a cookie. Changing the digest logs everyone out, so the expected value is a hard-coded literal in `test/session-token.test.ts`.
- `load()` refreshes an access token within 30s of expiry (concurrent refreshes deduped per session) — **traffic keeps the session alive**; it expires once the refresh token passes the IdP's SSO Session Idle. `SessionGuard` puts only a `SessionUser` on the request, never the session entity (it carries the tokens).
- **A failed refresh is not uniformly fatal**: only a 4xx (`invalid_grant`) destroys the session. Network errors, timeouts, 5xx, local DB failures keep it and retry next request, with a 15s per-session, per-process cooldown. Every outbound OIDC request has an 8s timeout.
- **`sweepExpired` (`session-sweeper.ts`) must not delete on `expiresAt`**: that is the access token, and the refresh token may still be good. It goes by the session TTL.
- **`SessionService.renew` runs under `@learning/cluster`'s `SharedLock`** (`session-renew`, keyed by session id), because a second process spending a rotated refresh token gets `invalid_grant` and deletes the session. Each of these is a bug if undone:
  - **Re-read inside the lock.** A peer may have renewed and released between this process's read and its `SET NX`; the stale row's token would then be spent again.
  - **`fallback` never refreshes**: it has no lock. It takes the peer's new row if there is one, returns null if the row is gone, else keeps the old session and enters the cooldown so the next request competes for the lock.
  - **`SharedLockUnavailableError` (Redis down) keeps the old session and enters the cooldown.** Neither refreshing unlocked nor logging the user out is justified. Any other error from the task still propagates: a database failure isn't "not logged in".
  - **`RENEW_LOCK_TTL_MS` must exceed two `HTTP_TIMEOUT`s plus the write** (discovery cache expiry + token endpoint), pinned in `test/renew-lock.test.ts`. A waiter also waits up to it, so it is one request's worst-case latency when a holder crashes: don't raise it casually.
  - **Deletes are conditional on the refresh token this process saw** (`deleteUnlessRenewed`): a late `invalid_grant` may be caused by a peer's rotation; that peer's row wins.
  - The in-process `renewing` map stays: without it, requests in one process would poll Redis waiting for each other.
- **`load(token, { refresh: false })` is strictly read-only**: no renewal, no lock, no cooldown, no write, and it doesn't join a running renewal. It returns null for a session past the TTL **without deleting the row**. Revalidation and the write gate must pass it, or an idle open tab keeps renewing itself; the WebSocket handshake doesn't.
- **`apps/platform` gates every page and `/api` route even with no provider** (only an explicit `web.auth: false` opens the pages, never `/api`). `ApiSessionGuard` must not decide on `request.url` alone: Fastify decodes before routing, so `/%61pi/secret` hits `/api/secret` with a url that doesn't start with `/api`. It checks the matched route pattern and the decoded path. Non-`/api` passes because the page fallback is a Nest controller too; pages belong to `@learning/web`'s gate. With no provider, `/api/auth/config` says `enabled: false` (no way to log in) while `/api/auth/me` still says `enabled: true` (the gate is on): the SPA needs the latter for its 401 dialog, the login page the former for its "unavailable" notice.
- **`safeRedirect` is the in-site check for every `?redirect=`** (`//evil.com`, `/\evil.com` → `/`). It exists in both `@learning/web` and here (they can't share code) and also rejects control characters: `/<TAB>/evil.com` becomes `//evil.com` in browsers.
- `CollabAuth` (`@learning/collab`) does the login check for WebSocket handshakes through `SessionService.load`.

## `SessionIdentityModule` / `LoginModule`

- **The refresh client sits in the identity module** (`token-refresher.ts`, config `auth.oidc` only), not with the login providers: `SessionService.load` renews, and a process with only the identity module has no login flow. `AuthProviders` reuses that client, so discovery and JWKS caches aren't duplicated.
- **A process without `auth.oidc` must not delete OIDC sessions**: another replica may still renew them. With a usable refresh token but no client here, `renew` returns null (not logged in for this request), keeps the row and warns at most every 5 minutes. **`/api/auth/me` therefore checks `sessions.exists(token)` before clearing the cookie**: clearing it would lose the session just the same. No refresh token (GitHub) or an expired one still deletes at `expiresAt`. These rows can't pile up: `load` and `SessionSweeper` both go by the session TTL.
- **`RequestOrigins` is in the identity module**, so something outside the login flow can ask "which of `server.origins` is this request on" (invite URLs). `resolveOrigins(config, false)`: a missing list is only an error for a process with login providers, and that check stays in `LoginModule`.
- A second process sharing the database needs `cluster.mode: redis` (the lock above) and should have the same `auth.oidc`.
- **The sweep belongs to `LoginModule`** (`session-sweeper.ts`): one process per database is enough, and it also owns `AuthRequest`. Without it `SessionService` still bounds its cooldown map, pruning expired entries when it adds one.
- **Each module registers its own tables** (`DATA_ACCESS_ENTITIES`, `database.md`): identity `Session`; login `UserIdentity`, `PendingLink`, `AuthRequest`. Column defaults like `keycloak` on `provider` stay as they are: on SQLite any column change is a rebuild, so the start refuses.
- **The identity module must not read `UserIdentity` / `PendingLink`**: a collab replica doesn't have them in its entity set. Anything a replica needs about a user travels through a `User` column.

## Login (`auth.controller.ts`, `login.service.ts`, `auth-options.ts`, `errors.ts`)

- **Secrets and half configs fail the start, in dev too**: a `clientSecret` in `config.yaml` would otherwise be ignored and the OIDC client silently become public. Provider ids are `oidc` and `github`; `ownsRoles` (only `oidc`) decides who writes `User.roles`.
- **`/auth/login-done` is not a backend route.** Vite answers everything outside `/api` in `onRequest`, and in `static` the path is the gated HTML fallback, so `afterLogin` rewrites that exact redirect to `/api/auth/login-done`. Other redirects pass through `safeRedirect`, which also percent-encodes non-ASCII (a raw one throws `ERR_INVALID_CHAR` when set as `Location`).
- **Log and `?error=` text never carries a raw error from outside the protocol layer** (`errors.ts`): MikroORM's exception message holds the full SQL with values, which for a failed `Session` insert is the access token. Only `OidcError` has a message worth keeping, and a retryable one is replaced for the browser (it names the internal IdP URL).
- Changing `auth.oidc.issuer` keeps old rows: identity is `(provider, subject)`, so a new IdP that reuses a `sub` lands on the old account. Clear `UserIdentity` for `oidc` when switching IdPs.
- Routes: `/api/auth/{config,me,login,link/:provider,callback,login-done,identities,logout}`, `POST /api/auth/link/confirm`, `DELETE /api/auth/link/pending`, `DELETE /api/auth/identities/:id`. `/me` always answers 200 (`{enabled, authenticated, user}`). `state` / `nonce` / `code_verifier` live in `AuthRequest`, keyed by a short-lived `oidc_tx` cookie, consumed exactly once.
- **The JSON routes and `link/:provider` have no `@Public()`** and rely on the root's `APP_GUARD = ApiSessionGuard`, like canvas: without it they are a 500 (`@CurrentUser()`), never anonymous.
- **Logout only ends the local session** — don't add token revocation or RP-initiated logout (`docs/02` §3.2.3).

## Account linking

- **Login and linking are the same flow**; `AuthRequest.linkUserId` makes the callback stash a pending link instead of minting a session. The callback **reads the `AuthRequest` before looking at `?error=`** (a cancelled link must return to `/settings`), and **re-checks the session against `linkUserId` before the token exchange**, not after: the result would be thrown away, and the provider's code is single-use.
- **A link is never written until the user confirms which account it is** (`PendingLink` + `POST /api/auth/link/confirm`). The browser may be signed into someone else's GitHub, an authorized OAuth App skips consent, and GitHub has no account chooser — so we ask. The callback only pre-checks (`identities.checkLink`, read-only) and stashes; confirm re-runs the real check. **One pending row per user** (a retry replaces it); **no access token stored** for it; pending state rides **`GET /api/auth/identities`, not the URL**; confirm is **POST**.
- Linking is a **full-page navigation** to `/api/auth/link/:provider`; the confirm dialog opens from `pending` on `GET /api/auth/identities`, never from URL state; `?link_error=` is read once and stripped from the URL (UI: `docs/02` §3.9).
- **Confirm consumes by delete count** (two confirms: one wins, the other 404). **`link`, `unlink` and the backfill lock the `User` row first** (`select … for update`, a no-op clause on SQLite whose transactions already hold the connection): without it two tabs unlinking the only two rows both see "two left" and delete both, leaving an account nobody can log into.
- The unique-violation catch sits **outside** the transaction: on PostgreSQL a violation aborts it, so nothing inside can recover.

## Identities — `identities.service.ts`, `login-identity.ts`

- Each binding is a `UserIdentity`; `unique(provider, subject)` *is* the conflict check. The **primary identity** has no flag column — it's the row whose `(issuer, subject)` equals `User.issuer` / `User.subject`.
- Every login refreshes *that identity's* display fields; **`User` profile fields follow only the primary identity**; **`User.roles` is written only on a provider with `ownsRoles`** (GitHub reports `[]`).
- Unbinding the last identity → 409 (no recovery path). Unbinding the primary promotes another row, rewrites the two columns, leaves name/avatar alone. Legacy users get their primary row **backfilled on use** (login adopts, `listFor` writes on read).
- **Identity is `(provider, subject)`, never email** — no "same email = same person", not even verified. Email changes and gets reassigned, Apple relays differ per app, and auto-merge is the classic takeover path (we can't re-check another IdP's `email_verified`). Merging only happens via 关联 from a signed-in session (`docs/02` §3.9.1, §3.9.3).

## Profile and avatars

- **`UserProfileCompleter` (`user-profile.ts`, a provider in `LoginModule`) holds post-login defaults**; `LoginService.complete` calls it before creating the session. It must not block login: a failed write is logged and retried next login. **The value is decided once at login and stored; never derive it on read.** A replica has no `LoginModule` and reads `user.avatarUrl` through `CollabAuth`, so storing before the session exists is what makes platform and replicas agree. A read-side `avatarUrl ?? identiconUrl(issuer, subject)` would change the image after a primary promotion (those two columns are rewritten) and would disagree across processes if it lived only in `LoginModule`. The seed is the primary identity's only at the moment of the first fill; `test/identities.test.ts` pins "promote, log in with the promoted identity, same image".
- **`identicon.ts`** — no avatar → identicon (minidenticons). The provider's `picture` wins. **No image stored**: the DB holds `/api/avatars/<seed>.svg`, `avatars.controller.ts` renders it (no DB read, `immutable` for a year). Seed = `sha256(issuer + "\n" + subject)` truncated to 16 hex (pinned in `test/identicon.test.ts`). **Put a round background under any displayed avatar** (`bg-muted` / `bg-sidebar-accent`) — the identicon is transparent.
- `/api/avatars` lives in `LoginModule`, needs a session (not `@Public()`) and belongs to the platform in `apps/collab/scripts/front-proxy.mjs`'s split.
