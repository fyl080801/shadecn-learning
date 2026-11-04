---
paths:
  - ".dockerignore"
  - "apps/agent-runner/**"
  - "k8s/**"
  - "ci/**"
  - ".gitea/**"
---

# Deploy (`docs/12-deployment.md`)

**`k8s/`, `ci/` and `.gitea/` still describe the deleted old service and its image** (and `docs/12` with them): nothing in them builds or runs what's in this repo now. There is no root `Dockerfile` and no image for `apps/platform` or `apps/collab`. The only image is the runner below.

## Runner image (`apps/agent-runner/`, `docs/31` §3.3)

- **Its context is `apps/agent-runner/dist/`**, cleared first by `scripts/build-sandbox.mjs`, so a failed build leaves no context rather than an old runner: the runner as one file in `runner/`, a `package.json` with **only its external packages** pinned to the installed versions, the Dockerfile. Never copy a server dependency list into it: the sandbox must not carry the DB drivers or Nest. `pnpm build` doesn't build it and no CI ships it.
- Built by `scripts/build-image.mjs` (`CONTAINER_CLI`, else podman first, then docker; extra args go to `build`). **The base image ARG defaults to the upstream `docker.io/library/node:22-alpine`**: a mirror / proxy is passed with `--build-arg NODE_IMAGE=…` at build time and never committed. The `TARGETARCH` check runs in every stage that uses the base.
- **The last stage is `FROM scratch` + `COPY --from=rootfs / /`** so the image config holds only `ENV PATH`: the node image's `NODE_VERSION` / `YARN_VERSION` would otherwise show up in every sandbox's environment (`docs/22` §10 acceptance 1 counts env names). Don't turn it back into `FROM ${NODE_IMAGE}`, and don't add an `ENV`.
- The self-check expects the runner to exit **2** without env (all imports resolved); 1 means a missing package. npm / yarn / corepack are deleted; deps install with `--ignore-scripts`.
- **Never put `shadecn.agent/instance` on the image**: a container inherits image labels unless the driver overrides them (`agent.md`).
- `apps/agent-runner/test/dockerfile.test.ts` pins all of the above.

## When the next image is written

- **`.dockerignore` says `**/node_modules`**: each workspace package has a `node_modules` of symlinks into the host's `.pnpm`, and a leaked one would overwrite installed deps at `COPY . .`. Each package's `dist` and each app's `test` are listed one by one (`apps/collab/test/package.test.ts` and `dockerfile.test.ts` pin theirs), so a new package adds its lines.
- **Probes have opposite failure modes**: liveness / startup → `/api/health` (shallow, touches nothing), readiness → `/api/health/ready` (database + shared layer, `apps/platform/src/start.ts`). Restarting fixes no database outage and kills unstored Y.Doc content, so liveness stays shallow.
- **pnpm 9 ignores `better-sqlite3`'s `gypfile: false`** and runs `node-gyp rebuild`, hence the root `pnpm.neverBuiltDependencies: ["better-sqlite3"]`. It ships prebuilds (incl. `linuxmusl-x64/arm64`), so no toolchain is needed.

## Native-module architecture checks

- A wrong-arch native module doesn't stop boot (dlopen happens on first `require`; `/api/health` never touches the database), so the service reports healthy while real requests 500 (`Error relocating …/better_sqlite3.node: unsupported relocation type 1026`). Cause seen in practice: **a single-arch base-image tag + QEMU binfmt makes pulling the wrong arch silent.** Never read "build succeeded" as "arch is right"; verify a new base tag with `uname -m` on a node of the other arch.
- An image carrying `better-sqlite3` needs three guards: one **multi-arch** base reference for all stages; `ARG TARGETARCH` checked against `process.arch` in every stage using the base (the runner's Dockerfile has this form); a load check: `require('better-sqlite3')` opens `:memory:` and queries (its `prebuilds/` is excluded from the loop), then every other `*.node` is `process.dlopen`ed. Details: `docs/12` §2.5.1.
