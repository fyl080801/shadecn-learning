---
paths:
  - "apps/server/auth/**"
  - "apps/server/routes/auth.ts"
  - "apps/server/routes/avatars.ts"
  - "apps/server/store/identities.ts"
  - "apps/server/avatar/**"
  - "apps/web/src/lib/auth.ts"
  - "apps/web/src/components/settings/**"
  - "apps/web/src/login/**"
---

# Auth — Keycloak OIDC + GitHub OAuth2, BFF style (`docs/02-auth-keycloak.md`)

The browser never sees a token: the code exchange is server-side, tokens live in the database, the client holds only an httpOnly `sid` cookie. Frontend auth / re-login is in `web-shell.md`.

## Providers

- **`auth/providers/` keeps everything else provider-blind.** `types.ts` declares `authorizationUrl` / `exchange` / `refresh`; `index.ts`'s `REGISTRY` order is the login-page button order. **Adding a login method = one file + one array entry.** `refresh: null` is legitimate (GitHub OAuth App tokens never expire; a github session's `expiresAt` = `SESSION_TTL`, the session-age cap ends it). `Session.provider` says who renews.
- **One callback path** (`/api/auth/callback`) for all providers; `AuthRequest.provider` dispatches.
- `auth/oidc.ts` — cached `.well-known` discovery (never hard-code endpoints), PKCE `S256`, `exchangeCode` / `refreshTokens` / `revokeRefreshToken`, `buildLogoutUrl`, `verifyIdToken` (JWKS, kid miss → one refetch, `crypto.createPublicKey({format:'jwk'})` for RS/PS/ES, then `iss`/`aud`/`azp`/`exp`/`iat`/`nonce`). No `jose` / `openid-client`. `OidcError` (`code` + `retryable`) is shared with GitHub so retry logic has one judgement.
- **`auth/providers/github.ts` — GitHub is not OIDC**: endpoints hard-coded; no `id_token` (identity = `/user`, plus `/user/emails` only when `/user` has no address — unreachable means no email, not a failure); **the token endpoint returns HTTP 200 on failure** (check the body's `error`); no PKCE (replay protection = one-shot `AuthRequest`). Roles are always `[]`.

## Callback origin (multi-domain)

- **The callback host follows the domain the browser used** — `auth/origin.ts`'s `originOf(c)`, gated by `APP_ORIGINS`. With one fixed origin, logging in on domain B finishes on A and B stays anonymous, with no error anywhere. `redirect_uri`, the CORS echo, the WebSocket `Origin` check, invite links and the cookie `Secure` flag all use it.
- **Never follow `Host` blindly** (attacker-controllable behind a proxy → the code is mailed elsewhere). Take the first of `X-Forwarded-Proto`+`X-Forwarded-Host` → `Host` → `Origin` that is **on the whitelist**, else `APP_ORIGIN`. `APP_ORIGIN` is always a member; comparison is normalized (lowercase, no trailing slash, default port dropped, http/https only); **no wildcards** (each domain's callback must be registered in Keycloak anyway).
- **`AuthRequest.origin` is stored** — the token exchange's `redirect_uri` must match the authorization step exactly; never recompute it.
- **`Secure` is per-request** (`secureCookieFor`) — on http the browser silently discards a Secure cookie ("logged in but still logged out", clean logs).

## Sessions — `auth/session.ts`

- The cookie holds a 32-byte random token; the row id is `HMAC-SHA256(SESSION_SECRET, token)`, so a DB dump can't forge a cookie.
- `loadSession()` refreshes an access token within 30s of expiry (concurrent refreshes deduped per session) — **traffic keeps the session alive**; it expires once the refresh token passes Keycloak's SSO Session Idle. `loadSession(token, { refresh: false })` is the read-only variant for non-user traffic (collab revalidation): never renews, never deletes.
- **A failed refresh is not uniformly fatal**: only a 4xx (`invalid_grant`) destroys the session. Network errors, timeouts, 5xx, local DB failures keep it and retry next request, with a 15s per-session cooldown. Every outbound OIDC request has an 8s timeout. `sweepExpired()` drops expired sessions and unused auth requests.
- `auth/middleware.ts` — `withSession` (mounted on `*`, the page gate needs it), `requireAuth` (401), `requireRole(...)` (403). Realm roles land in `User.roles` as-is, client roles as `clientId:role`. `auth/ws.ts` does the same check for WebSocket handshakes; `auth/redirect.ts`'s `safeRedirect()` is the shared in-site check for every `?redirect=` (`//evil.com`, `/\evil.com` → `/`).

## Routes — `routes/auth.ts`

- `GET /api/auth/{config,me,login,link/:provider,callback,identities,logout}` + `DELETE /api/auth/identities/:id`. `/me` always answers 200 (`{enabled, authenticated, user}`). `state` / `nonce` / `code_verifier` live in `AuthRequest`, keyed by a short-lived `oidc_tx` cookie, consumed exactly once.
- **`/api/auth` is in `PUBLIC_API`**, so the logged-in-only endpoints check `c.get('user')` themselves.
- **Logout only ends the local session** — no token revocation, no RP-initiated logout (signing out here must not sign the user out of other SSO apps). Accepted cost: Keycloak's SSO cookie survives, so logging in again is silent.
- No IdP configured (`KEYCLOAK_ISSUER` + `KEYCLOAK_CLIENT_ID`, or `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`) → `authEnabled = false`: dev warns and lets everything through, production refuses to boot. Half a provider is reported as a missing variable.

## Account linking

- **Login and linking are the same flow**; `AuthRequest.linkUserId` makes the callback stash a pending link instead of minting a session. The callback **reads the `AuthRequest` before looking at `?error=`** (a cancelled link must return to `/settings`), and re-checks `c.get('user')?.id === linkUserId`.
- **A link is never written until the user confirms which account it is** (`PendingLink` + `POST /api/auth/link/confirm`). The browser may be signed into someone else's GitHub, an authorized OAuth App skips consent, and GitHub has no account chooser — so we ask. The callback only pre-checks (`identities.checkLink`, read-only) and stashes; confirm re-runs the real check. **One pending row per user** (a retry replaces it); **no access token stored** for it; pending state rides **`GET /api/auth/identities`, not the URL**; confirm is **POST**.
- UI: `components/settings/LinkedAccounts.vue` lists `UserIdentity` rows, offers 关联 for unbound providers, 解绑 behind an `AlertDialog` (disabled at the last row). Linking is a **full-page navigation** to `/api/auth/link/:provider`; coming back it opens the confirm dialog on `pending`. Failures arrive as `?link_error=` — toast once, then strip it from the URL. Dismissing the dialog means "later" (the pending row lives server-side, expires in ten minutes).

## Identities — `store/identities.ts`

- Each binding is a `UserIdentity`; `unique(provider, subject)` *is* the conflict check. The **primary identity** has no flag column — it's the row whose `(issuer, subject)` equals `User.issuer` / `User.subject`.
- Every login refreshes *that identity's* display fields; **`User` profile fields follow only the primary identity**; **`User.roles` is written only on a Keycloak login** (GitHub reports `[]`).
- Unbinding the last identity → 409 (no recovery path). Unbinding the primary promotes another row, rewrites the two columns, leaves name/avatar alone. Legacy users get their primary row **backfilled on use** (login adopts, `listFor` writes on read).
- **Identity is `(provider, subject)`, never email** — no "same email = same person", not even verified. Email changes and gets reassigned, Apple relays differ per app, and auto-merge is the classic takeover path (we can't re-check another IdP's `email_verified`). Merging only happens via 关联 from a signed-in session. Accepted cost: Keycloak-then-GitHub sign-in creates two accounts; the supported path is sign in with the main account, then link. Merging existing accounts is not implemented.

## Profile hooks and avatars

- **`auth/profile.ts` keeps post-login defaults out of the login path.** `registerProfileHook({name, fill})` adds a rule; `completeUserProfile(user)` runs them in the callback and in `auth/project.ts`'s dev-user path. Hooks answer "what's missing", merged into **one** update; a throwing hook is logged and skipped. Runs on every login — that is the backfill. New rule = one file + one `registerProfileHook`.
- **`apps/server/avatar/`** — no avatar → identicon (minidenticons). Keycloak's `picture` wins. **No image stored**: the DB holds `/api/avatars/<seed>.svg`, `routes/avatars.ts` renders it (no DB read, `immutable` for a year). Seed = `sha256(issuer + "\n" + subject)` truncated to 16 hex. The route module installs the hook, so mounting it in `app.ts` is the one line. **Put a round background under any displayed avatar** (`bg-muted` / `bg-sidebar-accent`) — the identicon is transparent.
