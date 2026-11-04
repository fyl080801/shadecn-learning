---
paths:
  - "packages/collab/**"
  - "apps/collab/**"
  - "apps/web/src/composables/flow/sync/**"
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

- `useFlowSync(flowId, mode)` owns the doc and its transport, `sync/collab.ts`: a `HocuspocusProvider` (room `flow:<flowId>` passed as `name`, not in the URL; identity is the httpOnly `sid` cookie, gated in `packages/collab/src/collab-auth.ts`). It hands out a `session` that changes on reconnect / route change; the store takes its `doc`, presence takes its `awareness`.
- **Stateless messages are routed by `type`, nothing more**: `collab.ts` handles the store-state notice itself and hands every other payload to `sync/stateless.ts`; consumers subscribe with `sync.onStateless(type, handler)` (one table per `useFlowSync`, survives transport rebuilds) and parse their own payload. Each handler is try/catch'd — a throw would kill the provider's message loop.
- The doc also carries a **`y-indexeddb`** cache (db name = room name), so offline / closed-tab edits re-send on reconnect. Loading waits for *server-synced **or** local cache has content*; the offline banner ORs in `navigator.onLine` (the provider needs tens of seconds to notice a dead link). Teardown order: provider → indexeddb → doc.
- **`apps/web/vite.config.ts` must keep `resolve.dedupe: ['yjs', 'y-protocols']`** — two yjs copies make `instanceof Y.Map` false and the canvas blank.
- Dependency order is a straight line, `selection`/`sync` → `presence` → `canvas`; `useFlowCanvas` is the only thing that knows all three. `useFlowPresence` imports neither selection nor Vue Flow — it offers "publish" and "read others", so a new feedback signal costs one setter + one computed.

## Server — `packages/collab/src/` (`@learning/collab`)

- **State lives in providers** (`CollabServer`, `FlowPersistence`, `CollabQuota`, `AwarenessClaims`, `ExclusiveConnections`); `test/package.test.ts` refuses top-level `let` and mutable containers. Two apps in one process (tests) don't see each other.
- **`CollabModule` has no entry, `CollabGatewayModule` owns the socket.** A process importing only `CollabModule` (the platform in the split shape) is **headless**: no WebSocket, everything else (persistence, quota, revalidation, the revocation subscription, the flush handler) unchanged, because rooms opened there by direct connection must still persist. Never call Hocuspocus's `listen()` (second port). `CollabGateway` holds crossws on the Nest HTTP server's `upgrade` event. The room name travels in the message, so the wire protocol is not y-websocket's: the frontend must use `@hocuspocus/provider`.
- **`CollabServer` hands `CollabGateway` the close order** (`useSocketCloser`), because it has to live in one place: `onModuleDestroy` stops timers, the revocation subscription and new upgrades → `beforeApplicationShutdown` closes connections and sockets, stores each room directly, drains (20s cap), then force-closes whoever didn't answer → Nest closes HTTP → `onApplicationShutdown` closes ORM and Redis. An upgraded socket still counts against `server.close()`, so a socket left open means `app.close()` never returns (measured). The hook runs before the ORM closes; moving it to `onApplicationShutdown` loses the last debounce window.
- **Hocuspocus stores by itself on last leave, so "all clients gone" tests can't see whether the shutdown flush works.** Only a room held open by a direct connection can (`test/shutdown.test.ts`).
- **Keep the `upgrade` listener while stopping**; answer 503. Without a listener Node hands the upgrade to Fastify as a normal request and it lands on the page fallback. Other paths: leave them if `listenerCount('upgrade') > 1` (Vite HMR), destroy otherwise.
- Anonymous handshakes are refused in `onConnect` through `CollabAuth.authorize`.
- **Timings are constants, all derived from one fact: the server sends no heartbeat.** `timeout` is "time since last message". The client's awareness replay every `outdatedTimeout / 2` = **15s** (the server echoes it back) keeps both directions and a 60s proxy idle timeout alive. `timeout: 30_000` = two missed beats, matching the provider's `messageReconnectTimeout`, and under the proxy's 60s so *we* run `onDisconnect` (freeing the exclusive slot and ghost cursor). `REAUTH_INTERVAL: 20_000` is the backstop sweep.
- **Flushing a live room for another process goes over the bus**: `CollabServer` handles canvas's `CANVAS_FLUSH_CONTENT` (`@learning/canvas`), `FlowDocStore` asks *every* instance (scatter-gather) and never throws: timeout / failure / no collab instance all fall back to what's in the database.
- `GET /api/collab/rooms` — live rooms/connections. `GET /api/collab/health` — persistence health (REQ-RESILIENCE §4.5): **the HTTP status (200/503) is the verdict**, judged by what is owed now (`owed`, stale with a non-empty write queue, shared layer). Cumulative `failed` stays in the body but doesn't drive the 503. **Store stats count where the write happens** (`FlowPersistence.storeStats()`), not "started − completed" around the hook chain (`docs/30` §5): that difference reads a redlock skip as a failure. Both sit behind the session guard.

## Data layer — persistence (`flow-persistence.ts`)

- `onLoadDocument` loads `Flow.ydoc` for the first joiner; stores are debounced by the framework (2s, 10s ceiling) and skipped when the state vector is unchanged.
- **`beforeUnloadDocument` is the `graph` projection's backstop**: `onStoreDocument` writes it only when `clientsCount === 0`, and Hocuspocus only re-stores on last-leave if a debounce is pending, so "edit, wait two seconds, close the page" never gets there.
- **SIGTERM** (order above): a direct per-room store (`flushRooms`, **not** `flushPendingStores()`, whose store reaches our queue a microtask chain too late) + drain our write queue.
- **A store is read → merge → CAS write.** A plain `encodeStateAsUpdate` write is a full overwrite, unsafe once two replicas fork. CAS alone doesn't help (it proves nobody interleaved, not that you're a superset). So each store re-reads `ydoc`, `Y.applyUpdate`s it under the `'persistence'` origin (never `local` — no undo stacks), then CAS-writes; `count === 0` retries up to `MAX_STORE_ATTEMPTS`, then throws. Idempotent and free on a single replica. Redlock (`lockTimeout: 10_000`) is only an optimization.
- **A failed store MUST propagate — never swallow it with a `catch`.** Both Hocuspocus data-loss protections trigger on the hook throwing: `onStoreDocument` throwing keeps the doc in memory, `beforeUnloadDocument` throwing skips `documents.delete()`/`destroy()` (`docs/19` §4.1). Nothing retries by itself, so failures go into `failedStores` and `CollabServer.retryFailedStores()` sweeps every 30s (`/health`'s `owed` = its size).
- **The shared layer fails open**: `sameAsStored` (read) and `rememberStoredVersion` (write) are cache ops — worst case one redundant write.
- **Store-failure notice**: `onStoreStateChange` → `broadcastStateless` → client `onStateless` → `saveFailed`. Broadcast **only on flip** (good↔bad), **re-send to a joining connection** (`connected` reads `isStoreFailing`). It's not a `fatal` — this one heals.
- No y-leveldb, no `@hocuspocus/extension-database`: persistence writes the app's own `flow` table. **A canvas that only has `graph` is migrated on load** (`load` → `stateFromRow`: `ydoc` NULL → pour the `graph` JSON in). **The store merge reads raw `ydoc` (`legacy: false`)**: a graph migrated on the fly gets fresh clientIDs and would duplicate content if merged into a live doc. `Flow.graph` is a read-only projection (list counts, thumbnails); the editor never reads it. No per-update audit log, no history/rollback; `Flow.ydoc` is a converging snapshot.
- **Quota** (`quota.ts`; limits and tiers: `docs/04` §4.2) is measured in `onChange`, enforced in `beforeHandleMessage`, and **can only refuse before applying**. Refusal **never throws** (a throw closes the connection and the provider resends forever) — it flips the connection `readOnly`. The soft tier must keep accepting writes (deletes are the only way back under); only the hard ceiling locks the room until unload.
- **Doc limit ≥ projection limit** (`COLLAB_LIMITS.document` 20MB vs `GRAPH_LIMITS.bytes` 2MB, never reversed). Between them, `FlowDocStore` skips the projection and keeps the previous one (stale counts, content intact).
- `onStoreDocument` prunes dangling edges under a `'gc'` origin (out of undo stacks).
- **Every graph mutation goes through the store.** Vue Flow defaults bypass it (`deleteKeyCode` under `applyDefault: true`), so `FlowCanvas` passes `:delete-key-code="null"` and `canvas.deleteSelection()` is the single delete path.

## Feedback layer — awareness

- `apps/web/src/lib/presence.ts` is the pure half (color hashing, defensive peer-state parsing, occupancy arbitration); elements are keyed `node:<id>` / `edge:<id>`.
- **The server rewrites identity in every awareness update** (`beforeHandleAwareness` → `enforceIdentity`): `user.id` / `name` / `avatarUrl` come from what `onConnect` authenticated. Entries are bound to the socket that first published their `clientID` (`dropForeignClients`; claims released on disconnect). For a personal room `beforeHandleAwareness` empties every frame, and `CollabAuth.authorize` lets only `personalOwner` in.
- Membership + session are **re-validated every `REAUTH_INTERVAL`** (`revalidateConnections`) with `{ refresh: false }` — read the session, never renew it.
- **`revalidateConnections` must not reuse a round already in flight**: it may have read the database before the revocation, and the route's 204 promises the person is gone. Callers join the one round queued behind it.
- **Occupancy arbitration is tested but not wired** (`docs/04` §4.0.1). If you wire it: feed `presence.lockedKeys` into `draggable` / `selectable` / `updatable` in `useFlowCanvas`, writing the flags **explicitly as `true` and `false`** (`Object.assign` keeps a stale `false`).

## One user, one canvas, one connection (`exclusive.ts`)

- The newest window wins, per *room × user* (personal canvases too); the old window **stops reconnecting** (wording: `docs/04` §4.3, `docs/16` §4.6).
- **The holder registry is in the shared layer** (`SharedMap`) — the two windows are likely on different replicas. `connected` handles the local half; a 3s sweep converges cross-instance and renews the TTL.
- **Kicking must close the socket**, not just the connection — `connection.close()` leaves the socket open and the next heartbeat re-authenticates as a fresh connection, resurrecting the old window. Send the CLOSE message *and* a real close frame (`4409` / `session-superseded`); the client accepts either.
- **The client stops itself** (`onClose` → `provider.disconnect()`), or its retry kicks the tab the user is in. `disconnect()` keeps doc and awareness, so the canvas stays on screen, unsynced.
- A UX rule, not an access gate: a failing shared layer **fails open**.

## Terminal refusals (§4.4)

- Codes/reasons live in `@shadecn/shared/collab` (`CLOSE_SUPERSEDED` / `CLOSE_UNAUTHORIZED` / `CLOSE_REVOKED` / `CLOSE_QUOTA_LOCKED`, `CloseReason`, plus `COLLAB_PATH`, `FLOW_ROOM_PREFIX`, `STORE_STATE_MESSAGE`, `FLOW_STATE_VECTOR_HEADER`; the backend reads `@learning/contracts/collab`); `packages/collab/src/close.ts` holds the server helpers; the client's `classifyClose` is in `sync/collab.ts`.
  - `4409` `session-superseded`, `4401` `Unauthorized`, `4403` `permission-revoked`, `4413` `quota-exceeded` (→ `too-large`, shared with the solo REST path). What each dialog says, whether it can be dismissed and where it lands: `docs/04` §4.4.
  - `4401` → app-wide `SessionExpiredDialog`, then reconnect in place. **Never navigate to `/login`** (unsynced edits stay on screen); a watch reconnects once actually authenticated (dismissing also clears `sessionExpired`).
  - `4403` copy must not distinguish "removed" from "canvas deleted" (the server deliberately doesn't); personal vs project copy switches on `mode`, never `projectId` (`flow-editor.md`).
- `CollabAuth.authorize` returns a `CollabDenialReason`; never collapse `unauthorized` and `forbidden` (an idled-out viewer would be told they were removed), and never lump any of them in with "offline" (the provider retries forever, `maxAttempts: 0`, and new edits strand in IndexedDB).
- **The deleter is kicked too** (the route revokes before 204): `remove()` calls `sync.leave()` *before* the request and `sync.stay()` if it fails.
- **Two server paths, the client must handle both.** ① Closing an established connection = CLOSE message + close frame (above). ② **A refused handshake (`onConnect` throws) has no close at all** — Hocuspocus sends `PermissionDenied` with `error.reason ?? 'permission-denied'`, surfacing as `onAuthenticationFailed({reason})`; `onClose` never fires. So the server throws an error carrying `reason` (`denialError`) and the client `disconnect()`s in `onAuthenticationFailed`. **`reason` is the discriminator, not `code`**; both paths funnel into one `endConnection()`. Path ② is the common one.

## Revocation and the write gate

- **Revoking access kicks the live connection immediately** (the signal is `@learning/canvas`'s `AccessRevocation`, §4.2.1: routes call `await revoke()` on remove-member / delete-project / delete-canvas; `CollabServer` subscribes with `onRevoked(() => revalidateConnections())`, and its watcher turns another instance's announcement into `notify()` here). Canvas never imports collab for this. Remaining members cannot undo a removed member's writes (`trackedOrigins` only tracks their own) and there is no restore path. The writing instance revalidates at once; cross-instance uses **one shared key** with a fresh token per revocation, polled every `REVOCATION_POLL_INTERVAL_MS` (3s), triggering a full revalidation. **The poll primes in `onModuleInit`, not on the first tick**: the watcher's first read only records, so priming on the first tick would miss a revocation in the first 3s. The route **awaits** it, so a 204 means the person is off. Broadcast failures degrade to the `REAUTH_INTERVAL` sweep. The sweep fans out across documents with a re-entry guard. Both paths fire every `onRevoked` subscriber (collab's revalidation, the agent's and apps' `reconcileLive`) — the hook carries no payload and the collab layer never imports agent code.
- **The write gate (`write-gate.ts`, on `beforeSync`) refuses frames** that arrive between a bad verdict and the socket actually closing (Hocuspocus never checks whether a connection is still attached).
  - **`beforeSync`, not `beforeHandleMessage`** — only sync messages pay; gate SyncStep2 + Update, **never SyncStep1** (reconnect's handshake). It runs before Hocuspocus's `readOnly` check, so setting `readOnly` NACKs the frame in flight. **Never throw.**
  - **Refusing is half — also close the connection**: the provider never resends NACKed edits; only a reconnect's sync carries them up (via `classifyClose` → `SessionExpiredDialog` → re-login → rebuilt provider).
  - **Cache the verdict as a Promise (also in-flight dedup); never delay frames** — one serial message queue per connection, so awaiting a timer starves the heartbeat. TTL 10s; `revalidateConnections` clears the table first, so a revoked member's next write re-queries. `prime()` on `connected`, `forget()` on `onDisconnect`; **an authorize that throws means allow**.
  - **What it checks is injected and mandatory** (`createWriteGate({ authorize })`): `CollabAuth.authorize` with `{ refresh: false }`, which for personal rooms checks owner. No `if (personal)` inside the gate.
- **WebSocket `Origin` is checked by hand** (`isAllowedCollabOrigin` in `collab-auth.ts`, from `CollabGateway`'s upgrade handler; CSWSH). Allow: **no `Origin`** (non-browser), **on `server.origins`**, or **`Origin` host = request `Host`**.

## Shutdown and multi-replica details

- **The shutdown close is 1012 `server-restarting`**, not a `CLOSE_*`: `classifyClose` must not recognise it, so the provider reconnects.
- **Per-update side effects skip `isRelayedUpdate(origin)`; the quota check does not**: each replica holds a full doc and must measure it.
- **The Redis extension comes through `COLLAB_EXTENSIONS`, an async factory**, so `new Hocuspocus` gets it in the constructor and `single` never loads the package or ioredis (the factory holds the only dynamic import, `test/package.test.ts`). Calling `configure()` a second time also works but re-fires `onConfigure` on the inline hooks.
- **Redlock is only an optimization, and it can skip a store.** A lost lock throws `SkipFurtherHooksError`, so the inline `onStoreDocument` doesn't run and nothing is counted. Nothing retries that skip: durability comes from `beforeUnloadDocument`, the flush paths and CAS, none of which take the lock. Don't add the lock to them, and don't treat a skip as a failure.
- **A failed store must release the lock itself.** A throw ends the hook chain, so the extension's `afterStoreDocument` never runs and the lock sits for its full 10s, turning every replica's stores into skips (measured: new content stayed out of the database and nothing was owed). The inline `onStoreDocument` runs that hook in its `catch`, then rethrows.
- **`FailOpenRedis` doesn't take the lock unless `pub` is `ready`.** Upstream's `onStoreDocument` waits out ioredis's retries (measured about 50s) and redlock then reports the outage as a failed quorum, indistinguishable from a lost lock: stores stop, nothing is owed, and edits sit in memory for the whole outage.
- **Relayed updates don't schedule a store on the receiving replica** (`shouldSkipStoreHooks`): the replica that took the edit stores it. Quota and side effects are what still run on `onChange`.
- **Per-replica cleanup stays per-replica**: `AwarenessClaims.forgetRoom`, `CollabQuota.forget` and `ExclusiveConnections.forgetRoom` clear only local state when a room unloads here, because the room may be open on another replica. Deleting shared claims lets anyone take over that replica's clientIDs. Own claims are already gone by then: `onDisconnect` runs before the unload.
- **The shutdown waits for empty rooms before closing the extension** (`roomsSettled`, capped): disconnect hooks release claims in the shared layer, and leaving before they finish means a reconnecting client's cursor is dropped as impersonation until the claim's TTL. The extension holds unloads for 1s (`disconnectDelay`), so a replica takes at least that long to exit once it had a room.
- **`POST /doc` needs a Fastify content-type parser** (else 415), registered in `onModuleInit`, before routes. It parses before routing: an oversized body gets Fastify's 413 ahead of the guards, in Nest's default error shape.
