---
paths:
  - "Dockerfile"
  - ".dockerignore"
  - "apps/server/scripts/output-image/**"
  - "apps/server/scripts/agent-sandbox/**"
  - "k8s/**"
  - "ci/**"
  - ".gitea/**"
---

# Deploy (`docs/12-deployment.md`)

## Images

- Two paths, one image. `pnpm build && docker build ./output` uses the Dockerfile copied into `output/`: deps stage `npm install --omit=dev` (no toolchain — better-sqlite3 13 ships prebuilds incl. `linuxmusl-x64/arm64`, `gypfile: false`); runtime stage `WORKDIR /app`, `CMD sh -c "node server/db-sync.js && exec node server/index.js"` (`exec` makes node PID 1 so SIGTERM reaches the shutdown flush).
- The repo-root `Dockerfile` is the from-source variant: build stage copies each package's `package.json` (**one `COPY` per workspace package**), `pnpm install --frozen-lockfile`, `COPY . .`, `pnpm build`, then the same deps + runtime stages. **Edit `apps/server/scripts/output-image/Dockerfile`, not `output/`**, and keep the two in sync.
- Runtime image: `NODE_ENV=production`, `HOST=0.0.0.0`, port 3000; no source, pnpm or tsx; Node serves `public/` itself.
- **pnpm 9 ignores `gypfile: false`** and runs `node-gyp rebuild`, hence the root `pnpm.neverBuiltDependencies: ["better-sqlite3"]`.

## Agent sandbox image (`apps/server/scripts/agent-sandbox/`, `docs/22` §7.2)

- Built from `output/agent-sandbox/` by `build-image.mjs` (podman first, then docker; extra args go to `build`). **Its base image ARG defaults to the upstream `docker.io/library/node:22-alpine`**, unlike the two app Dockerfiles: a mirror / proxy is passed with `--build-arg NODE_IMAGE=…` at build time and never committed. The same `TARGETARCH` check runs in every stage that uses the base.
- **The last stage is `FROM scratch` + `COPY --from=rootfs / /`** so the image config holds only `ENV PATH`: the node image's `NODE_VERSION` / `YARN_VERSION` would otherwise show up in every sandbox's environment (acceptance 1 counts env names). Don't turn it back into `FROM ${NODE_IMAGE}`.
- The self-check expects the runner to exit **2** without env (all imports resolved); 1 means a missing package. npm / yarn / corepack are deleted; deps install with `--ignore-scripts`.

## Native-module architecture checks — keep all three

- A wrong-arch native module doesn't stop boot (dlopen happens on first `require`; `/api/health` never touches the DB), so the Pod reports Available while real requests 500 (`Error relocating …/better_sqlite3.node: unsupported relocation type 1026`). Cause seen in practice: **a single-arch base-image tag + QEMU binfmt makes pulling the wrong arch silent.** Never read "build succeeded" as "arch is right"; verify a new base tag with `uname -m` on an amd64 node.
- Guards in both Dockerfiles: one **multi-arch** base reference for all stages (`192.168.68.95:31443/docker.io/library/node:22-alpine`, *not* `harbor-core.harbor.svc/library/node`); `ARG TARGETARCH` checked against `process.arch` in deps and runtime; a load check — `require('better-sqlite3')` opens `:memory:` and queries (its `prebuilds/` is excluded from the loop), then every other `*.node` is `process.dlopen`ed. Details: `docs/12` §2.5.1.

## k8s

- SQLite on a volume at `/app/data` (`DATA_DIR=/app/data`); `k8s/deployment.yaml` = PVC + auth Secret, port 3000, `replicas: 1`, `strategy: Recreate`.
- **Two probes, opposite failure modes**: liveness/startup → `/api/health` (shallow, touches nothing — a test pins it); readiness → `/api/health/ready` (DB + shared layer). Restarting fixes no DB outage and kills unstored Y.Doc content, so liveness stays shallow.
- `terminationGracePeriodSeconds: 60` + `preStop: sleep 5` (endpoint removal and SIGTERM happen in parallel), matched by `SHUTDOWN_FLUSH_TIMEOUT` (20s) around the flush.
- PostgreSQL = same image with `DB_PROVIDER=postgresql` + `DATABASE_URL` (in the Secret, no PVC). More than one replica also needs `CLUSTER_MODE=redis` + `REDIS_URL` — see `cluster.md`.
