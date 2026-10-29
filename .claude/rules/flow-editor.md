---
paths:
  - "apps/web/src/components/flow/**"
  - "apps/web/src/components/canvas/**"
  - "apps/web/src/composables/flow/**"
  - "apps/web/src/composables/useProjectNav.ts"
  - "apps/web/src/stores/flow/**"
  - "apps/web/src/lib/flow-*.ts"
  - "apps/web/src/lib/api.ts"
  - "apps/web/src/views/canvas/**"
  - "apps/web/src/styles/vue-flow.css"
  - "packages/shared/src/flow-*.ts"
  - "packages/shared/src/canvas.ts"
  - "apps/server/store/flow-types.ts"
  - "apps/server/store/flows.ts"
  - "apps/server/store/projects.ts"
---

# Canvas editor (REQ-CANVAS `docs/13`, REQ-SOLO `docs/16`, REQ-NODEKIT `docs/21`)

Collaboration (sync transport, persistence, presence, close codes) is in `collab.md`.

## Projects, pages, workspace

- A **project** owns canvases and is the permission boundary. The only way in is its share link — one per project, unlimited uses; `GET /api/projects/:id/invite` creates it on read.
- Views in `apps/web/src/views/canvas/`: `PersonalFlows.vue` (`/personal`), `ProjectHome.vue` (`/projects/:projectId`, Tabs 画布 / 成员 that never touch the URL), `InviteAccept.vue` (`/invite/:token`, preview-then-confirm), `FlowEditor.vue` (`/flows/:flowId`, the one `BlankLayout` route). `/projects` only redirects to `/personal`.
- The first two share `components/canvas/CanvasWorkspace.vue`: an in-page `w-56` sidebar — 「个人画布」, then a 「项目」 group with a `+` (new project) and a hover `Trash2` per row (admins only, `AlertDialog` with two refs). The app sidebar has one 「画布」 entry, highlighted under `/personal` and `/projects/*` via `NavItem.activePaths`.
- The project list is a **module-level cache**, `composables/useProjectNav.ts` (`projects / loading / error / refresh()`, `resetProjectNav()` for tests), because the shell remounts on every route switch; create / delete / rename call `refresh()`. Deleting a project is only offered from the sidebar row; deleting the open one goes to `/personal`.

## Editor structure

- **Hooks layer + component layer; the view only builds the context and places components.** `provideFlowEditor(props)` (`composables/flow/`) creates the context once; children call `useFlowEditor()` — no prop drilling, a new panel touches no existing file. The context bundles `store` + `sync` (`useFlowSync`) + `useFlowDocument` (load / rename / duplicate / delete / save-state text / `flushBeforeLeave`), `useFlowCanvas` (Vue Flow glue: bindings, drag→`node.move`, connect→`edge.add`, viewport sync, cursor-anchored ctrl-wheel zoom, `addNode`), `useFlowSelection` (`selectedNodeId` + `select` / `clearSelection`). `useFlowShortcuts(ctx)` adds keybindings and the two don't-lose-work guards.
- `useVueFlow()` is called inside `useFlowCanvas` at the *root* setup, so `<VueFlow>` adopts that instance and out-of-canvas components (toolbar, capsule) can use `screenToFlowCoordinate`.
- Components in `components/flow/`, each owning one region and reading the context directly: `FlowCanvas.vue` (Vue Flow + background + minimap + `<slot/>` for overlays), `FlowViewControls.vue` (zoom/fit/lock + undo/redo, top-right), `FlowTitleCapsule.vue` (top-left: home + inline-editable name + save state + menu, owns its delete confirm), `FlowToolbar.vue` (bottom), `FlowSelectionToolbar.vue` (above a **multi-node** selection via `NodeToolbar` with an id array; holds 打组), `node-kit/NodeHost.vue` (the one node component; its `toolbar` slot shows only for the single selected node, so it and the selection toolbar are never on screen together), `TextBody.vue` / `GenericBody.vue`, `FlowNodeHandles.vue`, `composer/PromptComposer.vue`, `FlowSnapGuides.vue`, `FlowConnectionEndedDialog.vue`.
- **There is no property panel.** Clicking a node only selects it; editing lives on the node (double-click to rename, toolbar for duplicate/delete).
- `apps/web/src/lib/api.ts` wraps every endpoint over `apiFetch` and throws `ApiError` (carries `status`).

## Node types — `components/flow/node-types.ts`

- A registry: `defineNodeType(type, {label, icon, view, features?, parts?, modes?})`. The render half is `view` (`body` component, `shell: 'card' | 'frame'`, size `class`, `selectedClass` / `idleClass`, `style(ctx)`, `fallbackLabel`) and `features` *by name* (default `STANDARD_NODE_FEATURES` = rename / duplicate / delete / connectable / status). The data half — default `data`, default layout, **port declarations** (`inputs` / `outputs: PortDef[]`) — lives in `@shadecn/shared/flow-node-types`, shared with the agent.
- **No per-type component**: `flowNodeComponents` maps every type to `node-kit/NodeHost.vue`. `useFlowCanvas.addNode(type)` builds from the registry (`buildFlowNode`). **Adding a type = this file + the shared entry**, nothing else. Port-carrying sample types use `genericType()` (`GenericBody.vue` + `output-preview`; generators add `runnable`).
- The toolbar has a single `+` creating `NEW_NODE_TYPE` (`text`, edited in place via `edit-body`; `data.text` is its own key). `FALLBACK_NODE_TYPE` (`process`) is what an unknown `type` renders as — the **same constant** `fromYNode` falls back to, defined in `@shadecn/shared/flow-graph` and re-exported from `node-constants.ts`, so old canvases can't change shape.
- **Ports are declared, never rendered as extra handles**: a type with no ports keeps one unnamed in/out handle pair; one with no inputs loses its left handle.
- **`group` — every difference is in its declaration, none in the host**: `shell: 'frame'`, fixed size, `zIndex: -1`, `pointer-events-none` in `view.class` (so it doesn't swallow rubber-band selection), background from `data.background` via `view.style`, features `rename` / `status` / `ungroup` / `resizable` / `drag-strip` (no `connectable` / `duplicate` / `delete`).
  - Resizing is `@vue-flow/node-resizer`. Its stylesheet is imported in `styles/vue-flow.css`, which must also give `.vue-flow__resize-control` its `pointer-events` back (it inherits `none` from the body otherwise). Commit to the doc only on `resize-end`.
  - Chrome matches every other node: name outside above the top-left corner, toolbar top-center. Its one button is **ungroup** (`Ungroup` icon, plain ghost, not destructive red — nothing is lost and undo restores it).
  - `NodeToolbar` teleports, so pressing the label never reaches d3-drag: the group keeps a full-width 24px **`drag-strip`** inside its top edge (invisible until hover; a rubber band can't start there).
  - Removing a group **detaches its children** (`store.removeElements` clears `parentNode` / `extent` and converts positions back to canvas coordinates — a dangling `parentNode` snaps the whole group to the origin). Auto-reparent on drag-in is not wired.

## Node-kit — `components/flow/node-kit/` (`docs/21`)

- Node UI is flat registrations: **parts** (component in a slot), **actions** (icon + label + `run` + `when`/`enabled` + optional `shortcut`), **modes** (edit states that `reveal` / `conceal` slots), **event handlers** — bundled into **features** (`node-kit/features/`) that a type enables by name.
- **Slots are a closed set owned by the host** (`label` `toolbar` `badge` `header` `body` `footer` `composer` `side` `overlay` `handles`). Placement and when a slot may show is `NodeHost`'s call; a part's `when` can only narrow it. Matching is static per type (`match: {types, features, not}`), so `kit.partsFor(type, slot)` is cached; `replaces` / `hides` name what they displace — no implicit priority. **A slot with nothing registered doesn't exist on that node** (no `NodeToolbar` mounted) — e.g. only `image-config` has a composer, registered through its declaration's `parts` / `modes`.
- Rules that are bugs to break:
  - **Features never import each other**; they cooperate through events and the shared context (composer emits `composer:submit`, `runnable` turns it into `node:run`).
  - **`protocol.ts` is a type-only leaf; only `install.ts` lists features** (it imports node components, so nothing a node imports may import it — same cycle rule as `editor-context.ts`).
  - **The host knows no concrete type or feature** (no `if (type === 'group')`, no `has('runnable')`).
  - Parts take **no props** — they call `useNodePart()` (`id` / `type` / `node` = `useFlowNode` / `label` / `editor` / `selected` / `mode` / `slots` / `emit`), because half are teleported.
- Events: a typed editor-level bus (`FlowNodeEventMap`, extended by module augmentation in each feature's file). Synchronous broadcast, each handler try/catch'd, depth-capped; **never a write channel** — handlers write via `ctx.node.write` / `store.mutate`.
- **Only one node in the canvas is editable at a time** (`node-kit/modes.ts`, one editor-level value). Entering a mode or selecting another node preempts; `'preempted'` commits the draft (like blur), only `'cancel'` (Esc) drops it. A part whose overlay unmounts mid-edit must commit on unmount.
- Actions run through one runner (`node-kit/actions.ts`, `useAsyncAction` keyed by node × action, emitting `action:invoke` / `action:done`) for buttons and keyboard alike. `useFlowShortcuts` handles global keys first, then the **single-selected** node's visible actions (`Mod` = Meta or Ctrl, exact modifier match; a disabled match is swallowed).
- Presence avatars are built into the host; no type can turn them off.
- The registry is not a singleton: `createNodeKit()` / `createNodeKitRuntime()` for tests; `apps/web/src/test/components/node-kit/with-kit.ts` provides the default kit for mounting `NodeHost`.

## Selection, groups, snapping

- **Rubber band = full containment** (`:selection-mode="SelectionMode.Full"`, written out because it's a product rule). Edges touching a hit node count as selected, but Vue Flow's own pass is unreliable (its edge-id cache isn't cleared by `removeSelectedElements()`, so a second identical box selection misses the edge). `useFlowCanvas` re-asserts it with `getConnectedEdges` → `addSelectedElements([...nodes, ...edges])`, **only while the band is active** (outside it, clicking an edge would get deselected). Selected-edge styling is in `styles/vue-flow.css`.
- **No toolbar during the drag**: `canvas.boxSelecting` (`userSelectionActive`) hides both per-node chrome and the selection toolbar until release.
- **Groups are created by grouping a selection** (`canvas.groupSelection()` from `FlowSelectionToolbar`), never from the toolbar. Box = `getRectOfNodes` + padding; nodes already in a group, and groups, are excluded.
  - **Group + children in one transaction** (`store.groupNodes`, `extent: 'parent'` included) — split it and children briefly point at a missing parent (`NODE_MISSING_PARENT`, nodes jump to origin, undo leaves half a group).
  - **Withhold `extent: 'parent'` from Vue Flow until the parent is measured** — `extentReady()` in `useFlowCanvas`'s `nodes` adapter sends `extent: undefined` (explicitly — an omitted key keeps its old value via `Object.assign`) while `findNode(parentNode).dimensions.width` is 0; otherwise every child is clamped outside the box. **The gate belongs in the adapter, not the write path**: peers read `extent` from the doc before the group renders on their side. The doc itself is always correct, which is why a reload "fixes" it.
- **Snapping (`useFlowSnapping` + `lib/flow-snap.ts`) applies to dragging only, never to placed nodes.** Grid + alignment guides are **always on — no toggle, no persisted state**. Grid = `FLOW_GRID_SIZE`, the same constant as `<Background :gap>`. Guide tolerance is **6 screen px ÷ zoom**.
  - **Vue Flow's `:snap-to-grid` is deliberately unused**: it also rounds positions at mount, a view-only shift that makes peers see different canvases.
  - One delta from both snaps (guides win over grid); multi-select snaps by the bounding box. The correction runs in `onNodeDrag` after Vue Flow writes the raw position and recomputes from the pointer each event (so it never accumulates). **Snap first, then `publishDrag`.** Guides render in the `#zoom-pane` slot next to presence cursors.
- **Canvas behaviour is Vue Flow's job, not CSS's.** Anything on the canvas — external labels, per-node toolbars, resize handles, zoom-following overlays — uses the official packages (`@vue-flow/node-toolbar`, `@vue-flow/node-resizer`, `<Panel>`, `<Handle>`, `<NodeToolbar>`; see [guide](https://vueflow.dev/guide/) / [examples](https://vueflow.dev/examples/)). Placement comes from component props (`position` / `align` / `offset`); Tailwind is for appearance only. Never hand-roll `absolute` + `transform` / viewport math. Missing package → add it as a `devDependency`. Reference case: `NodeHost.vue`'s label is `<NodeToolbar :is-visible="true" :position="Position.Top" align="start">`.

## State — `stores/flow/` is a projection of a Y.Doc

- The canvas content **is** the Yjs doc (shape in `@shadecn/shared/flow-doc`, shared by browser and server). The frontend's incremental projection (`changedTopLevelKeys` / `projectMap` / `createNodeProjector` / `readFallbackViewport`) is `lib/flow-projection.ts`; server-side `apps/server/collab/flow-doc.ts` keeps only `readGraphFromDoc` and `pruneDanglingEdges`.
- `nodes` / `edges` are `Y.Map<id, Y.Map>` because Y.Map merges **per key** — a node as one JSON blob would let the later write clobber the earlier wholesale.
- **Node = five groups (schema v3): `type` / `layout` / `metadata` / `data` / `runtime`, plus derived, never-stored `inputs`** (`docs/13` §3.7).
  - `layout` (position, size, zIndex, parentNode, extent, handle positions) is **flat on the node's top level** (drag hot path, Vue Flow's shape). `metadata` (label, description, icon, createdAt, createdBy, ui), `data`, `runtime` (status, error, taskId, `outputs.<portId>` flat keys) are nested `Y.Map`s.
  - **Business fields sit flat on `data`, never in a `config` object; `data` has no reserved keys** (a single `config` key would let two people's edits to different fields clobber each other).
  - A node's business type **is** its top-level `type` = the registry key.
- **Edges are the only source of truth for wiring; ports live on `edge.data`, not on handles.** At most one unnamed handle per side; `sourceHandle` / `targetHandle` are always `null`; `edge.data.sourcePort` / `targetPort` / `index` say which pair is wired (multi-input `index` = max + 1 on connect, never renumbered; port-less edges carry none). The pair is chosen by shared's `resolveConnection` — first type-compatible, non-full, not-already-wired (output × input) pair in declaration order, source-major, else refused. `is-valid-connection`, `onConnect`, grow-a-node and the agent's `connect` all call it.
- **Writes go by group: `store.writeNode(id, 'metadata' | 'data' | 'runtime', {set, remove})`** (via `useFlowNode(id)`); layout has its own write paths.
- **Collections (3D objects, timeline tracks, resource lists) go one element per key — `<prefix>.<id>`, flat, plain JSON** (`lib/flow-collection.ts`; write + delete in one `writeNode(id, 'data', {set, remove})`). Never one `data.scene` blob (everyone in the batch clobbers each other) and never a nested `Y.Map` (structure in the CRDT can't be versioned: old and new clients write *different types* to the same key, clientID picks a random winner, the loser's subtree vanishes and its code throws). Shared has two write doors — `toYNode`/`toYEdge` (editor-created elements) and `writeNode`/`writeEdge`/`applyGraphToDoc` (server legacy migration); `toYEdge` writes `null` for an absent handle, `writeEdge` writes nothing, and a test pins that they read back identically. Rules:
  - **A key's type is fixed from its first write and never changes.** A brand-new `Y.Text` key is fine; upgrading an existing plain key destroys data.
  - **Ids are stable, never array indices** — mint with `createId()` if the source has none.
  - **Prefixes must not nest** (`dc.obj` + `dc.obj.pose` collide; convention only).
  - Two people editing *the same* element still loses one side — deliberately left open, as for every canvas element (§4.0.1). Narrow it with soft warnings or commit-time conflict checks, not read-only locks.
- **v1/v2 data is never migrated, but reading it must never throw.** The Y.Doc reader and `parseGraph` both go through shared's `nodeRecordFromParts`, which only falls back (missing `metadata`/`runtime` → empty label / `idle`; old `label`/`status`/`kind`/`config` stay in `data`; no valid `position` → skipped). **`parseGraph` must keep accepting v1/v2 rows** (layout fields flat on the node) — `readGraph()` is the only path old canvases take into Yjs.
- **Never write back from the read side** — a projection that writes creates a transaction that enters everyone's undo stack and broadcasts.
- **The projection is incremental**: `observeDeep` events name changed top-level keys; only those re-parse, the rest keep object identity (Vue Flow relies on it). `changedTopLevelKeys` returning `null` = redo everything. `createNodeProjector` gives a node a new object only if its record, its incoming-edge bucket (by edge identity), or an upstream's `runtime.outputs` (by value) changed. `toVueFlowNode` is WeakMap-cached, flattens layout writing every key explicitly, and puts the other four groups in Vue Flow's `data`.
- **Every content change goes through `store.mutate()`** (a Y transaction tagged `LOCAL_ORIGIN`). Components never touch a Y.Map directly. Undo is `Y.UndoManager` with `trackedOrigins: [LOCAL_ORIGIN]` — that is what makes Ctrl+Z skip collaborators' edits; `separateUndo()` (`stopCapturing`) splits operations inside the 400ms capture window.
- **No save, revision, 409 or dirty state** — edits are live. The one exception is a *notice*: when the server's write queue fails it broadcasts a stateless message and the status line reads 「服务器暂时无法保存」 (server rules in `collab.md`). Client side: **clear `saveFailed` when the transport is replaced**, and **parse stateless payloads defensively** (a throw kills the message loop).
- **Drag intermediates stay out of the doc**; only `onNodeDragStop` commits; in-flight motion rides awareness.
- **Never rebuild the `:nodes` array while the local user drags.** Vue Flow re-syncs on a new array reference via `Object.assign(existing, incoming)`, and `incoming.position` is the pre-drag one, so the node snaps back. `useFlowCanvas` keeps a `localDragging` flag and returns the `computed`'s `previous` array while set. Mapping is only safe when a *remote* peer drags.

## Per-user view state (viewport)

- **Pan/zoom is not canvas data**: `setViewport()` → `setUserState(key, value)`, never the doc, never undo. `meta.viewport` in the doc is only the first-open fallback; each viewer has their own row.
- **`setUserState` only buffers.** `noteLocalEdit()` (called by `mutate` / `undo` / `redo`) flushes to `PATCH /api/flows/:id/user-state` as **leading send + debounced tail** (`useDebounceFn`, `USER_STATE_FLUSH_DELAY`, `maxWait` `USER_STATE_FLUSH_MAX_WAIT` 10s). The tail skips itself if nothing happened after the leading send. Viewing only = zero requests.
- **The window always sends, even if the view never moved** — that PATCH is the session heartbeat (content rides the WebSocket, and collab revalidation never renews the session). Editing keeps the session alive; looking lets it idle out. Pan-without-edit is flushed by `saveNow()` / `reset()` on leave.
- To persist another per-user thing: add a field to `FlowUserState` (`@shadecn/shared/flow-graph`), a parser to the server's `FLOW_USER_STATE_PARSERS` (a mapped type, so a missing parser is a compile error), and call `setUserState`.

## Continuously-changing values (`docs/13` §3.7.2)

- One shape: **a local draft owns the screen, the draft is throttled onto awareness if peers should see it, the doc is written once when the gesture ends, bracketed by `separateUndo()`.** One undo item comes from committing once, not from `captureTimeout`.
- **No-release kind (rename, body text) = `useDraftField`** (`composables/flow/useDraftField.ts`): `{current, commit, normalize?, equals?, focus?}` → `{editing, draft, start, commit, cancel}`. It owns the draft, `editing`, both `separateUndo()` calls, and drops no-ops (unchanged value, `normalize` → `null`, the double submit from Enter + blur). Consumers: `TextBody.vue`, `node-kit/features/RenameTitle.vue`, `composer/PromptComposer.vue`, via `useFlowNode(id).draft(group, key, …)`.
- **With-release kind** is hand-written — copy `onNodeDragStart/Drag/DragStop` in `useFlowCanvas.ts`. Awareness publishing isn't in the composable (needs a new field; add `watch(draft, useThrottleFn(publish, throttleMs))` when there's a consumer).
- **Don't throttle doc writes instead** — the cost is broadcast + persistence, a half-dragged value mustn't survive refresh or be undoable, and the doc is the wrong channel for droppable data.
- Awareness rules: a *new* field, not `transform` (typed `PresencePoint`); send only changed numbers, never the whole element (shrink the packet before lowering the frame rate); clear it when the gesture ends (y-protocols replays local state every 15s); keep **both** throttle edges (`useThrottleFn(fn, ms, trailing, leading)` — dropping the last packet is a bug).
- The window is adaptive: `ms` is a getter, `feedbackThrottle(roomSize)` in `lib/presence.ts` — `FEEDBACK_THROTTLE` (60ms, one window/buffer for every feedback field via `useFlowPresence`'s `publish()`) up to `FEEDBACK_THROTTLE_ROOM` people, then widening stepwise to `FEEDBACK_THROTTLE_MAX`. The curve is a judgement, not a measurement.
- Text: short/atomic commits on blur; long-form wants a debounced commit (>400ms debounce = finer undo). Character-level co-editing needs `Y.Text` as a brand-new key **and** a fix to `duplicateNode` (its projection → `structuredClone` → `toYNode` path flattens `Y.Text` to a string).
- While dragging locally, a panel reads its own draft, never the projection.

## Personal canvases (REQ-SOLO)

- A personal space is a `Project` with `kind='personal'` and a unique `personalOwner` (created on read by `GET /api/projects/personal`); its canvases have `mode: 'solo'`, **derived from the project, never stored on `Flow`**. Content, doc, projection and **transport are identical** — `composables/flow/sync/` has exactly one transport, `collab.ts`. (`GET/POST /api/flows/:id/doc` and `flow-writer.ts`'s `applyFlowUpdate()` remain server-side with no frontend caller.)
- **`mode` only says what the canvas is**: where leaving lands (`/personal`), wording of terminal dialogs and status line (nothing on a personal canvas mentions 协作 / 协作者), and whether presence runs (`useFlowPresence(sync, mode)`, off for `solo`).
- **The doc and its IndexedDB cache are created immediately; the transport waits for metadata** (`context.ts` computes `mode` only when `store.meta.id === flowId`), or an unopenable canvas reports its failure twice.
- Server side the room is owner-only and presence-free (see `collab.md`). The client must still *send* awareness: reset local state to `{}`, **never `null`** — the 15s replay is the only client→server heartbeat.
- All collab rules apply, including one-window-per-user: a second tab knocks the first offline, worded 「这张画布已在另一个窗口打开」.
- Personal spaces reject invites / member changes / delete / rename with **403**, are filtered from `GET /api/projects`, and ignore `PROJECT_LIMITS.flows`.
- **Personal and project are separate routes, not two Tabs** — they share no header, empty state or action, and separate routes let both own their URL query (`syncQuery`). Both lists are the same `FlowList` (it only needs a `projectId`).
- **Wherever the UI leaves a canvas, key the destination on `mode`, never `projectId`** — `useFlowDocument`'s `backPath()` sends solo (and collab without a `projectId`) to `/personal`; icon/label follow the same check. `ProjectHome.vue` `replace`s to `/personal` for `kind === 'personal'`.

## Types

Graph types, `GRAPH_SCHEMA_VERSION`, `nodeRecordFromParts` and `inputs` derivation are in `@shadecn/shared/flow-graph`; ports and `resolveConnection` in `@shadecn/shared/flow-node-types`; project/canvas API shapes in `@shadecn/shared/canvas`. `apps/server/store/flow-types.ts` keeps only server-only code (it uses `Buffer`): `parseGraph` / `parseTransactions` / `parseUserStatePatch`, `GRAPH_LIMITS`, Op types. `metadata.createdAt` is validated with `isTimestamp` everywhere.
