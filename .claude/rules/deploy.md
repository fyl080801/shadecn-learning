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
- **CI ships `output/Dockerfile`, not the root runtime stage** (`ci/workflow-template.yaml`, `docs/12` §4.2): it runs the root Dockerfile's `artifacts` stage once (`--target artifacts --output type=local`), then builds the app from `<out>/output/Dockerfile` and the sandbox from `<out>/agent-sandbox/Dockerfile` — one `pnpm build`, so server and runner share a build id. Hence the build stage **moves** `output/agent-sandbox` to `/app/agent-sandbox` (the runtime stage copies only `output/`); don't turn it back into `rm`, and don't put the sandbox context into `output/` for the root runtime stage to pick up.
- Runtime image: `NODE_ENV=production`, `HOST=0.0.0.0`, port 3000; no source, pnpm or tsx; Node serves `public/` itself.
- **pnpm 9 ignores `gypfile: false`** and runs `node-gyp rebuild`, hence the root `pnpm.neverBuiltDependencies: ["better-sqlite3"]`.

## Agent sandbox image (`apps/server/scripts/agent-sandbox/`, `docs/22` §7.2)

- Built from `output/agent-sandbox/` by `build-image.mjs` (podman first, then docker; extra args go to `build`). **Its base image ARG defaults to the upstream `docker.io/library/node:22-alpine`**, unlike the two app Dockerfiles: a mirror / proxy is passed with `--build-arg NODE_IMAGE=…` at build time and never committed. The same `TARGETARCH` check runs in every stage that uses the base.
- **The last stage is `FROM scratch` + `COPY --from=rootfs / /`** so the image config holds only `ENV PATH`: the node image's `NODE_VERSION` / `YARN_VERSION` would otherwise show up in every sandbox's environment (acceptance 1 counts env names). Don't turn it back into `FROM ${NODE_IMAGE}`.
- The self-check expects the runner to exit **2** without env (all imports resolved); 1 means a missing package. npm / yarn / corepack are deleted; deps install with `--ignore-scripts`.

## Native-module architecture checks — keep all three

- A wrong-arch native module doesn't stop boot (dlopen happens on first `require`; `/api/health` never touches the DB), so the Pod reports Available while real requests 500 (`Error relocating …/better_sqlite3.node: unsupported relocation type 1026`). Cause seen in practice: **a single-arch base-image tag + QEMU binfmt makes pulling the wrong arch silent.** Never read "build succeeded" as "arch is right"; verify a new base tag with `uname -m` on an amd64 node.
- Guards in both Dockerfiles: one **multi-arch** base reference for all stages (`192.168.68.95:31443/docker.io/library/node:22-alpine`, *not* `harbor-core.harbor.svc/library/node`); `ARG TARGETARCH` checked against `process.arch` in deps and runtime; a load check — `require('better-sqlite3')` opens `:memory:` and queries (its `prebuilds/` is excluded from the loop), then every other `*.node` is `process.dlopen`ed. Details: `docs/12` §2.5.1. The output-image one once lacked the `TARGETARCH` check; `apps/server/test/scripts/dockerfiles.test.ts` now pins all three Dockerfiles.

## k8s

- SQLite on a volume at `/app/data` (`DATA_DIR=/app/data`); `k8s/deployment.yaml` = PVC + auth Secret, port 3000, `replicas: 1`, `strategy: Recreate`.
- **Two probes, opposite failure modes**: liveness/startup → `/api/health` (shallow, touches nothing — a test pins it); readiness → `/api/health/ready` (DB + shared layer). Restarting fixes no DB outage and kills unstored Y.Doc content, so liveness stays shallow.
- `terminationGracePeriodSeconds: 60` + `preStop: sleep 5` (endpoint removal and SIGTERM happen in parallel), matched by `SHUTDOWN_FLUSH_TIMEOUT` (20s) around the flush.
- PostgreSQL = same image with `DB_PROVIDER=postgresql` + `DATABASE_URL` (in the Secret, no PVC). More than one replica also needs `CLUSTER_MODE=redis` + `REDIS_URL` — see `cluster.md`.
- **Architecture is pinned in places that must agree** (`k8s-manifests.test.ts` ties them): the template's `platforms` (default `linux/arm64`), the Workflow `nodeSelector` in `ci/run.yaml` **and** the `cicd.yaml` heredoc, the server Pod's `nodeSelector`, and `AGENT_SANDBOX_K8S_NODE_SELECTOR`. The images are single-arch manifest lists: a Pod on another arch can't pull.
- **The tag write-back edits exactly two lines** of `k8s/deployment.yaml` — the server `image: <imageName>:` and the sandbox `value: <sandboxImageName>:` — and refuses to commit if anything else is staged. Never write either pattern in a comment there (the unanchored `sed` would rewrite it and the step fails).
- **Agent `k8s` sandbox, current form = shared `dev` + a ValidatingAdmissionPolicy** (`docs/22` §7.5). `k8s/agent-sandbox.yaml` (SA, Role / RoleBinding in `dev`, a NetworkPolicy selecting only `shadecn.agent/managed=true`) is **synced with the Deployment on purpose**: ArgoCD creates the SA before the Deployment in the same sync, whereas a `serviceAccountName` whose SA doesn't exist stops the ReplicaSet from creating Pods. The VAP (`k8s/variants/agent-sandbox-vap.yaml`) is cluster-scoped and admin-applied — never move it into `k8s/`.
  - **`dev` has no Pod Security: the VAP is what keeps the server's `pods create` from becoming node root or mounting other services' Secrets / SA tokens.** Keep `matchConditions` to the server SA's username and `matchConstraints` to `dev`: with `failurePolicy: Fail`, a policy error under a broad match would block every Pod in the cluster. Each rule's message starts with `[rule]` and has a TS twin in `k8s-manifests.test.ts` — add or change both. A CEL field typo doesn't fail `apply`, it silently turns the rule into a no-op: check `status.typeChecking` and run the deny samples. The driver's self-check dry-runs a privileged counter-probe and refuses to enable when it is admitted — don't drop it.
  - The agent's model config comes **only** from the out-of-band ConfigMap + Secret `dev/shadecn-learning-agent` via `envFrom` (`optional: true`, `docs/12` §3.3). Never add `AGENT_PROVIDER` / `_MODEL` / `_BASE_URL` / `_API` / `_IMAGE_INPUT` / `_API_KEY` / `_TOKEN_SECRET` to the Deployment's `env`: `env` beats `envFrom` and would silently shadow what the admin set. The sandbox-driver vars (`AGENT_SANDBOX*`, `POD_IP`) stay in `env`. Same for S3: everything but `S3_MAX_UPLOAD_MB` comes from the out-of-band ConfigMap + Secret `dev/shadecn-learning-s3` (credentials only in the Secret); never put `S3_KEY_PREFIX` there with an empty value (empty = bucket root, unset = `canvas`). `S3_ENDPOINT` is the **public** address (stored in `data.src`, read by browsers, used to reverse URLs to keys); the server's own requests go to `S3_INTERNAL_ENDPOINT` when set — never derive a browser-facing URL from the internal one.
  - Don't add a ResourceQuota / LimitRange or any NetworkPolicy selecting non-sandbox Pods in `dev`: a quota forces requests / limits on gitea & co., an ingress policy on the server Pods cuts off ingress-nginx.
  - The stronger form is `k8s/variants/agent-sandbox.yaml` (own namespace): there the **Pod Security `restricted` label** is the guard — keep it; keep **only the image-pull Secret** in that namespace, and its `pods get` to the server and admins (the bootstrap token is in the Pod env).
  - The sandbox NetworkPolicy allows egress only to the server Pods' port and **no DNS** (the gateway URL is an IP); it is silently ignored where nothing enforces NetworkPolicy (k3s does, via its embedded kube-router controller).
