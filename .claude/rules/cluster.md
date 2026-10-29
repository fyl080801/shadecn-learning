---
paths:
  - "apps/server/cluster/**"
  - "apps/server/scripts/dev-cluster.mjs"
  - "k8s/**"
---

# Single vs multi-replica (`apps/server/cluster/`, `docs/14-clustering.md`)

- `CLUSTER_MODE` (`single` | `redis`): explicit value, else inferred from `REDIS_URL`, else `single`. **Database and Redis are configured independently.** `assertClusterConfig()` rejects `redis` without `REDIS_URL`; `redis` + SQLite only warns in dev (a legit way to exercise Redis locally) and is refused in production.
- Shared state is three abstract classes in `cluster/shared.ts`: `SharedMap<V>` (`get`/`set`/`claim`/`entries`, TTL), `SharedCounter` (`next(key, seed)`), `SharedLock` (`run(key, task, {fallback})`). `memory.ts` and `redis.ts` (`SET NX` / `INCR` / lock + Lua release) pass the same contract suite (`apps/server/test/cluster/shared.test.ts`; Redis when `TEST_REDIS_URL` is set). `health()` / `clusterHealth()` is **synchronous with no network call** (reads ioredis `status`; only `ready` is usable — otherwise commands pile into the offline queue).
- **Every method is async, even in memory**, so call sites never change.
- **Factories return lazy proxies**: tables are declared at module top level, the backend is picked later in `initCluster()`; the proxy resolves on first use, and swapping bumps a generation counter.
- `redis.ts` is dynamically imported (single-replica never loads ioredis); both ioredis and `@hocuspocus/extension-redis` stay in the artifact.
- Multi-replica collab = `@hocuspocus/extension-redis` (pub/sub for updates + awareness, redlock around `onStoreDocument`, `afterLoadDocument` waits for a peer's state). **socketId gets an `instanceId:` prefix** (Hocuspocus's is only per-process unique; a collision drops the real owner's awareness as impersonation). No sticky sessions.
- **The same update fires `onChange` on every instance holding the room.** Any per-update side effect (webhooks, notifications, metrics) must skip `transactionOrigin` with `source === 'redis'`, or it fires once per replica (and the copy carries no author `context`). Unknown origin shapes count as "act".
- **Quota is eventually consistent**: `quotaLocked()` runs synchronously per message on a local `Map`; the verdict is pushed to the shared layer fire-and-forget and pulled back on the 1–5s re-measure tick.
- Local: start Redis/PostgreSQL yourself (commands in `.env.example`), then `pnpm dev` or `pnpm dev:cluster` (`scripts/dev-cluster.mjs`: one `tsx watch` per `DEV_CLUSTER_PORTS` port, overriding only `PORT` / `INSTANCE_ID` — all other config from `.env`).
- k8s: `k8s/deployment.yaml` (single, PVC, `Recreate`) or `k8s/variants/deployment.cluster.yaml` (`replicas: 3`, `RollingUpdate`, no PVC). **The variant lives outside `k8s/`** because ArgoCD syncs that directory non-recursively (two manifests for one resource = `RepeatedResourceWarning`). Switching = copy the variant over `k8s/deployment.yaml` and commit; manual `apply` is reverted by `selfHeal`.
