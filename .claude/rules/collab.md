---
paths:
  - "apps/server/collab/**"
  - "apps/server/auth/ws.ts"
  - "apps/web/src/composables/flow/sync/**"
  - "apps/web/src/composables/flow/useFlowSync.ts"
  - "apps/web/src/composables/flow/useFlowPresence.ts"
  - "apps/web/src/lib/presence.ts"
  - "apps/web/src/components/flow/FlowConnectionEndedDialog.vue"
  - "packages/shared/src/collab.ts"
  - "packages/shared/src/flow-doc.ts"
---

# Realtime collaboration (`docs/04-realtime-collab.md`)

## Two layers

**The deciding question: should it still be there after a refresh?** Yes → **data layer** (a Yjs shared type: CRDT merge, undo, persistence). No → **feedback layer** (an awareness field: ephemeral, dropped frames fine).

## Client transport

- `useFlowSync(flowId, mode)` owns the doc and its transport, `sync/collab.ts`: a `HocuspocusProvider` (room `flow:<flowId>` passed as `name`, not in the URL; identity is the httpOnly `sid` cookie, gated in `apps/server/auth/ws.ts`). It hands out a `session` that changes on reconnect / route change; the store takes its `doc`, presence takes its `awareness`.
- The doc also carries a **`y-indexeddb`** cache (db name = room name), so offline / closed-tab edits re-send on reconnect. Loading waits for *server-synced **or** local cache has content*; the offline banner ORs in `navigator.onLine` (the provider needs tens of seconds to notice a dead link). Teardown order: provider → indexeddb → doc.
- **`vite.config.ts` must keep `resolve.dedupe: ['yjs', 'y-protocols']`** — two yjs copies make `instanceof Y.Map` false and the canvas blank.
- Dependency order is a straight line, `selection`/`sync` → `presence` → `canvas`; `useFlowCanvas` is the only thing that knows all three. `useFlowPresence` imports neither selection nor Vue Flow — it offers "publish" and "read others", so a new feedback signal costs one setter + one computed.

## Server — `apps/server/collab/`

- `hocuspocus.ts` mounts Hocuspocus on our own HTTP server. Never call `listen()` (second port). We own the `upgrade` listener, take **only `/ws/collaboration`** and hand it to crossws → `handleConnection()`; everything else (Vite HMR, protocol `vite-hmr`, path `/`) is left untouched for Node's other `upgrade` listeners. The room name travels in the message, so the wire protocol is not y-websocket's — the frontend must use `@hocuspocus/provider`.
- `index.ts` — `attachCollabServer(server, { destroyUnmatchedUpgrades, authorize })`; `destroyUnmatchedUpgrades` is `false` in dev (HMR). `authorize` (`auth/ws.ts`) answers `401` + destroy for anonymous handshakes.
- **Timings are constants, all derived from one fact: the server sends no heartbeat.** `timeout` is "time since last message". The client's awareness replay every `outdatedTimeout / 2` = **15s** (the server echoes it back) keeps both directions and a 60s proxy idle timeout alive. `timeout: 30_000` = two missed beats, matching the provider's `messageReconnectTimeout`, and under the proxy's 60s so *we* run `onDisconnect` (freeing the exclusive slot and ghost cursor). `REAUTH_INTERVAL: 20_000` is the backstop sweep.
- `GET /api/collab/rooms` — live rooms/connections. `GET /api/collab/health` — persistence health (REQ-RESILIENCE §4.5): failed-store count, time since last successful store, write-queue depth, shared-layer status; **the HTTP status (200/503) is the verdict**. `failed` is observed (started − completed, see logging in `server-runtime.md`); "no store for a while" is unhealthy **only with a non-empty write queue**. Both sit behind the auth gate.

## Data layer — persistence (`collab/persistence.ts`)

- `onLoadDocument` loads `Flow.ydoc` for the first joiner; stores are debounced by the framework (2s, 10s ceiling) and skipped when the state vector is unchanged.
- **The `graph` projection is written only in `beforeUnloadDocument`**, not under `onStoreDocument`'s `clientsCount === 0` (Hocuspocus only re-stores on last-leave if a debounce is pending).
- **SIGTERM**: `closeConnections()` + a direct per-room store (`flushAllRoomsToDatabase`, **not** `flushPendingStores()`, whose store reaches our queue a microtask chain too late) + drain our write queue.
- **A store is read → merge → CAS write.** A plain `encodeStateAsUpdate` write is a full overwrite, unsafe once two replicas fork. CAS alone doesn't help (it proves nobody interleaved, not that you're a superset). So each store re-reads `ydoc`, `Y.applyUpdate`s it under the `'persistence'` origin (never `local` — no undo stacks), then CAS-writes; `count === 0` retries up to `MAX_STORE_ATTEMPTS`, then throws. Idempotent and free on a single replica. Redlock (`lockTimeout: 10_000`) is only an optimization.
- **A failed store MUST propagate — never swallow it with a `catch`.** Both Hocuspocus data-loss protections trigger on the hook throwing: `onStoreDocument` throwing keeps the doc in memory, `beforeUnloadDocument` throwing skips `documents.delete()`/`destroy()` (`docs/19` §4.1). Nothing retries by itself, so failures go into `failedStores` and `retryFailedStores()` sweeps every 30s, serially (`/health`'s `owed` = its size).
- **The shared layer fails open**: `sameAsStored` (read) and `rememberStoredVersion` (write) are cache ops — worst case one redundant write. `rememberStoredVersion` must stay `async` (the lazy proxy throws synchronously when Redis is down, which would bypass `.catch()`).
- **Store-failure notice**: `onStoreStateChange` → `broadcastStateless` → client `onStateless` → `saveFailed`. Broadcast **only on flip** (good↔bad), **re-send to a joining connection** (`connected` reads `isStoreFailing`). It's not a `fatal` — this one heals.
- No y-leveldb, no `@hocuspocus/extension-database`: persistence writes the app's own `flow` table. **Legacy migration is `onLoadDocument` itself** — `ydoc` NULL → pour the old `graph` JSON in. `Flow.graph` is a read-only projection (list counts, thumbnails); the editor never reads it. No per-update audit log, no history/rollback; `Flow.ydoc` is a converging snapshot.
- **Quota** (`collab/quota.ts`, bytes only: 1MB/message, 20MB/doc; no node/edge count limits) is measured in `onChange`, enforced in `beforeHandleMessage`, and **can only refuse before applying**. Refusal **never throws** (a throw closes the connection and the provider resends forever) — it flips the connection `readOnly`. Two tiers: over *soft* marks the room but accepts writes (deletes must work; the mark clears at the next re-measure, ≤1s); the *hard* ceiling (soft × 1.25) locks the room read-only until unload.
- **Doc limit ≥ projection limit** (`COLLAB_LIMITS.document` 20MB vs `GRAPH_LIMITS.bytes` 2MB, never reversed). Between them, `deriveProjection` returns null and keeps the previous projection (stale counts, content intact).
- `onStoreDocument` prunes dangling edges under a `'gc'` origin (out of undo stacks).
- **Every graph mutation goes through the store.** Vue Flow defaults bypass it (`deleteKeyCode` under `applyDefault: true`), so `FlowCanvas` passes `:delete-key-code="null"` and `canvas.deleteSelection()` is the single delete path.

## Feedback layer — awareness

- `apps/web/src/lib/presence.ts` is the pure half (color hashing, defensive peer-state parsing, occupancy arbitration); elements are keyed `node:<id>` / `edge:<id>`.
- **The server rewrites identity in every awareness update** (`beforeHandleAwareness` → `enforceIdentity`): `user.id` / `name` / `avatarUrl` come from what `onConnect` authenticated. Entries are bound to the socket that first published their `clientID` (`dropForeignClients`; claims released on disconnect). For a personal room `beforeHandleAwareness` empties every frame, and `authorizeCollab` lets only `personalOwner` in.
- Membership + session are **re-validated every minute** (`revalidateConnections`) with `{ refresh: false }` — read the session, never renew it.
- **Occupancy arbitration is tested but deliberately not wired** — anyone edits anything; labels only *show* who else is there. To reinstate: feed `presence.lockedKeys` into `draggable` / `selectable` / `updatable` in `useFlowCanvas`, writing the flags **explicitly as `true` and `false`** (`Object.assign` keeps a stale `false`). See §4.0.1.

## One user, one canvas, one connection (`collab/exclusive.ts`)

- The newest window wins, per *room × user* (personal canvases too). The old window gets a non-dismissible 「协作会话已过期，请刷新页面」 (personal: 「这张画布已在另一个窗口打开」) and **stops reconnecting**.
- **The holder registry is in the shared layer** (`SharedMap`) — the two windows are likely on different replicas. `connected` handles the local half; a 3s sweep converges cross-instance and renews the TTL.
- **Kicking must close the socket**, not just the connection — `connection.close()` leaves the socket open and the next heartbeat re-authenticates as a fresh connection, resurrecting the old window. Send the CLOSE message *and* a real close frame (`4409` / `session-superseded`); the client accepts either.
- **The client stops itself** (`onClose` → `provider.disconnect()`), or its retry kicks the tab the user is in. `disconnect()` keeps doc and awareness, so the canvas stays on screen, unsynced.
- A UX rule, not an access gate: a failing shared layer **fails open**; with login disabled exclusivity is off.

## Terminal refusals (§4.4)

- Codes/reasons live in `@shadecn/shared/collab` (`CLOSE_SUPERSEDED` / `CLOSE_UNAUTHORIZED` / `CLOSE_REVOKED` / `CLOSE_QUOTA_LOCKED`, `CloseReason`, plus `COLLAB_PATH`, `FLOW_ROOM_PREFIX`, `STORE_STATE_MESSAGE`, `FLOW_STATE_VECTOR_HEADER`); `collab/close.ts` re-exports them with server helpers; the client's `classifyClose` is in `sync/collab.ts`.
  - `4409` `session-superseded` — newer window took over → refresh.
  - `4401` `Unauthorized` — session gone → app-wide `SessionExpiredDialog`, then reconnect in place. **Never navigate to `/login`** (unsynced edits stay on screen); a watch reconnects once actually authenticated (dismissing also clears `sessionExpired`).
  - `4403` `permission-revoked` — not a member or canvas deleted → leave. One sentence covers both (the server doesn't distinguish) and lands on `/projects`; **on a personal canvas** it means "canvas gone" and lands on `/canvas`.
  - `4413` `quota-exceeded` — hard ceiling hit; everyone in the room gets it; maps to `too-large`. `FlowConnectionEndedDialog` is non-dismissible **except for `too-large`** (fixing it means deleting on this page).
- `authorizeCollab` returns a `CollabDenialReason`; never collapse `unauthorized` and `forbidden` (an idled-out viewer would be told they were removed), and never lump any of them in with "offline" (the provider retries forever, `maxAttempts: 0`, and new edits strand in IndexedDB).
- **The deleter is kicked too** (the route revokes before 204): `remove()` calls `sync.leave()` *before* the request and `sync.stay()` if it fails.
- **Two server paths, the client must handle both.** ① Closing an established connection = CLOSE message + close frame (above). ② **A refused handshake (`onConnect` throws) has no close at all** — Hocuspocus sends `PermissionDenied` with `error.reason ?? 'permission-denied'`, surfacing as `onAuthenticationFailed({reason})`; `onClose` never fires. So the server throws an error carrying `reason` (`denialError`) and the client `disconnect()`s in `onAuthenticationFailed`. **`reason` is the discriminator, not `code`**; both paths funnel into one `endConnection()`. Path ② is the common one.

## Revocation and the write gate

- **Revoking access kicks the live connection immediately** (`collab/revocation.ts` + `revokeCollabAccess()`, called by remove-member / delete-project / delete-canvas; §4.2.1). Remaining members cannot undo a removed member's writes (`trackedOrigins` only tracks their own) and there is no restore path. The writing instance revalidates at once; cross-instance uses **one shared key** with a fresh token per revocation, polled every `REVOCATION_POLL_INTERVAL` (3s), triggering a full revalidation. The route **awaits** it, so a 204 means the person is off. Broadcast failures degrade to the `REAUTH_INTERVAL` sweep. The sweep fans out across documents with a re-entry guard.
- **The write gate (`collab/write-gate.ts`, on `beforeSync`) refuses frames** that arrive between a bad verdict and the socket actually closing (Hocuspocus never checks whether a connection is still attached).
  - **`beforeSync`, not `beforeHandleMessage`** — only sync messages pay; gate SyncStep2 + Update, **never SyncStep1** (reconnect's handshake). It runs before Hocuspocus's `readOnly` check, so setting `readOnly` NACKs the frame in flight. **Never throw.**
  - **Refusing is half — also close the connection**: the provider never resends NACKed edits; only a reconnect's sync carries them up (via `classifyClose` → `SessionExpiredDialog` → re-login → rebuilt provider).
  - **Cache the verdict as a Promise (also in-flight dedup); never delay frames** — one serial message queue per connection, so awaiting a timer starves the heartbeat. TTL 10s; `revalidateConnections` clears the table first, so a revoked member's next write re-queries. `prime()` on `connected`, `forget()` on `onDisconnect`; **an authorize that throws means allow**.
  - **What it checks is injected and mandatory** (`createWriteGate({ authorize })`): both canvas kinds use `collabWriteAuthorize` (`authorizeCollab`, which for personal rooms checks owner). `sessionWriteAuthorize` has no caller. No `if (personal)` inside the gate.
- **WebSocket `Origin` is checked by hand** (`isAllowedCollabOrigin` in `auth/ws.ts`, from the `upgrade` listener — Hono's `cors` never sees it; CSWSH). Allow: **no `Origin`** (non-browser), **on `APP_ORIGINS`**, or **`Origin` host = request `Host`**.
