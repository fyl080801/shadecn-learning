---
paths:
  - "packages/agent/**"
  - "apps/server/agent/**"
  - "apps/server/routes/agent.ts"
  - "apps/server/store/agent.ts"
  - "apps/web/src/components/flow/agent/**"
  - "packages/shared/src/agent.ts"
---

# Canvas agent — `packages/agent` (`@shadecn/agent`, REQ-AGENT, `docs/20-agent-canvas.md`)

Source-only, server-only (Node types + ES2023 tsconfig — the sandbox spawns processes and touches files). A `workspace:*` devDependency of `apps/server` only; the frontend's contract is `@shadecn/shared/agent`.

## Sub-paths

- `session` — run orchestrator over pi's `Agent`: several conversations per flow × user, **one run per flow at a time**. Conversations and the run / tool-call log persist through injected interfaces; only the "who is running" registry and each run's replay buffer are in process memory (not shared across replicas). **A run outlives the HTTP connection that started it**: a disconnect drops one subscriber; `subscribe()` / `GET …/runs/:runId/events` replays from RUN_STARTED and streams on, frame-for-frame identical.
- `store` — `AgentConversationStore` / `AgentRunLog` + in-memory implementations for the package's tests. The package never sees MikroORM; `apps/server/store/agent.ts` is the real one, and **`createAgentRuntime` has no default**, so a missing DB wiring can't silently become "lost on restart".
- `tools` — `read_canvas` / `add_node` / `update_node` / `connect` / `delete_elements`, one Y transaction per call. `add_node` validates `type` against shared's `CREATABLE_NODE_TYPES`, never a local list. Connection checks pass `docLookup(doc)` (`typeOf` + `dataOf`) to `resolveConnection` — the same context the editor builds, so the agent can't diverge from the editor's rules (`docs/13` §3.7); for `add_node` + `connectFrom`, check against the new node's final data (defaults merged with the given `data`).
- `canvas` — the `CanvasHandle` abstraction tools take (never Hocuspocus); `createDocCanvasHandle` wraps a bare `Y.Doc` for tests.
- `events` — **the only place** pi `AgentEvent`s become wire events (the AG-UI subset in `@shadecn/shared/agent`). Protocol changes happen here only.
- `model` — picks a pi `Model` from an **explicit options object; the package never reads `process.env`** (env parsing: `apps/server/config.ts` + `apps/server/agent/index.ts`).
- `sandbox` — `SandboxProvider` / `Sandbox` + `LocalSandboxProvider`, a child-process sandbox that is **not strong isolation** (empty env, command whitelist, timeout, output cap, workdir-only files). Production wants a docker / k8s gVisor implementation of the same interface.

## What stays in `apps/server`

The route (`routes/agent.ts`, SSE + auth), `agent/canvas-access.ts` (direct connection into the live room, **re-checks the initiator's access and the quota before every read/write**), and env/config.

## Dependencies

`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `yjs` are **peerDependencies** (plus devDependencies for tests); `apps/server` keeps the two pi packages in `dependencies`, because esbuild inlines `@shadecn/*` while their third-party imports stay external and are checked against `apps/server/package.json`.
