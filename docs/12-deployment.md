# REQ-DEPLOY 构建与部署

## 1. 目标

一个镜像、一个端口、一个卷就能跑起来。**没有 nginx，没有反向代理，没有独立数据库服务** —— Node 进程自己吐静态资源（见 [REQ-SERVER](03-server-runtime.md)）。

## 2. 构建需求

### 2.1 命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 开发（Node/Hono + Vite 中间件，watch 模式），http://127.0.0.1:3000 |
| `pnpm build` | `build:client` + `build:server`，产物全部落在 `output/` |
| `pnpm build:client` | `vue-tsc -b` 类型检查 → `vite build` 输出 `output/public` |
| `pnpm build:server` | `tsc --noEmit` 类型检查 → esbuild 打包出 `output/server/index.js` |
| `pnpm start` | 生产模式启动（`NODE_ENV=production node output/server/index.js`） |
| `pnpm preview` | `build` + `start` |

### 2.2 依赖划分

仓库根 `package.json` 的两组依赖是有严格含义的：

| 组 | 含义 | 内容 |
|---|---|---|
| `dependencies` | **生产运行时**真正要装的 | `hono` / `@hono/node-server`、`yjs` / `y-protocols` / `lib0` / `ws`、`@prisma/client` + 两个 driver adapter（`@prisma/adapter-better-sqlite3` / `@prisma/adapter-pg`）、`prisma`（启动时跑 db push） |
| `devDependencies` | 开发和构建期才要的 | 前端全家桶（vue、vue-router、three、tailwind、reka-ui、codemirror、vue-flow、y-websocket…）+ 工具链（vite、esbuild、tsx、vue-tsc、eslint、vitest…） |

**前端库为什么算 dev**：它们全都被 `vite build` 打进了 `output/public`，运行时一个都不用装。
同理 `tsx` 也降级成 dev —— 生产跑的是打包后的 `server/index.js`，不再解释执行 `.ts`。

这条约定由构建脚本兜底：`scripts/build-server.mjs` 会拿 esbuild 反推出来的运行时依赖去比对根
`dependencies`，只要有一个落在 `devDependencies` 里就**直接构建失败**，并提示把它挪过去。
用 `shadcn-vue` 之类的 CLI 装完新包记得检查一下装到哪组了。

### 2.3 产物布局

**前后端都构建，产物只有 `output/` 一个目录**（已 gitignore）。它必须是一个
**完整可运行的 app 目录**：拷到任何地方 `npm install --omit=dev && npm start` 就能跑，
`docker build ./output` 就能出镜像，**不依赖仓库里的任何源码**。

```
output/
  package.json        # 运行时依赖（版本锁死）+ start / db:push 脚本
  server/
    index.js          # 打包后的后端入口（ESM，node 22），带 .map
    dev-*.js          # 动态 import 切出来的开发分支 chunk，生产不会加载
  public/             # 前端静态资源 = 后端的静态资源目录
    index.html
    assets/...
  prisma/             # schema.prisma + models/（没有 migrations），给启动时的 db push 用
  prisma.config.js    # 产物自带的 prisma CLI 配置
  Dockerfile          # 构建上下文就是 output/ 自己
  .dockerignore
  README.md           # 产物怎么跑 / 怎么打镜像
```

`package.json` 的 `dependencies` 不是照抄仓库那份，而是**从 esbuild 的 external 列表反推**
出来的实际运行时依赖（`@hono/node-server`、`hono`、`@prisma/client`、当次 provider 对应的那个
driver adapter、`yjs`、`y-protocols`、`lib0`、`ws`，外加跑 db push 用的
`prisma`），版本锁到构建当次实际装的那一个。`vite` 只出现在永不加载的 dev chunk 里，
不进这份清单。前端那一堆（vue / three / tailwind…）已经打进 `public/`，运行时一个都不需要。

> `node_modules` 不在产物里 —— better-sqlite3 是原生模块，必须在目标平台上装。
> 产物里锁的是直接依赖的版本，间接依赖没有 lockfile 兜底。

**产物是绑定 provider 的**：Prisma 生成的 client 在编译期就把 sqlite 或 postgres 的查询编译器
打了进去，换不了。所以构建时的 `DB_PROVIDER` / `DATABASE_URL` 决定了这份产物连哪种库：

```bash
pnpm db:generate && pnpm build                                   # SQLite 产物
DB_PROVIDER=postgresql DATABASE_URL=postgresql://… \
  pnpm db:generate && DB_PROVIDER=postgresql pnpm build          # PostgreSQL 产物
```

`build:server` 会核对生成的 client 和构建目标是不是同一种库，对不上直接失败。产物里
`prisma/` 只放当次 provider 的 schema（铺平成 `prisma/schema.prisma` + `prisma/models/`，
目录形状不随 provider 变；没有迁移文件，见 [REQ-DATA §3.3.1](05-data-persistence.md)），用不上的那个 driver adapter 也不会进
`dependencies` —— PG 部署因此不必为 better-sqlite3 装一套编译工具链。

- **前端静态资源直接构建进后端的静态资源目录**：`vite.config.ts` 里 `build.outDir = output/public`，后端生产模式就吐这个目录（可用 `STATIC_DIR` 覆盖）。
- 后端由 `scripts/build-server.mjs`（esbuild）打包：仓库内的相对导入全部内联（含 `server/generated/prisma` 那份生成的 client），`node_modules` 里的包保持 external，运行时从应用根目录的 `node_modules` 解析。
- `splitting: true` 是硬要求：`frontend/index.ts` 里的 `await import('./dev.ts')` 必须留成真正的动态 import，否则 `vite` 会被提升成顶层静态依赖 —— 而 `vite` 是 devDependency，生产环境根本不会装，一启动就崩。
- 打包时 define 了 `__APP_BUNDLE__`，`server/runtime.ts` 靠它区分「源码运行」和「产物运行」：产物运行时应用根目录取进程 cwd（容器里就是 `/app`），静态资源取产物自己旁边的 `public/`。
- 运行产物**不再需要 `tsx`**；`prisma` 进产物的 `dependencies`，因为容器启动时要跑 `prisma db push`。
- 产物里的 `prisma.config.js` / `Dockerfile` / `.dockerignore` / `README.md` 是从 `scripts/output-image/` 原样拷进去的 —— 要改这几个文件改模板，别改产物。

### 2.4 直接基于产物打镜像（推荐）

```bash
pnpm build
docker build -t shadecn-learning ./output
```

`output/Dockerfile` 两个阶段：

1. **deps** —— 只 `COPY package.json` 再 `npm install --omit=dev`，装的就是那 9 个运行时依赖；
   装 `python3 make g++`，**better-sqlite3 在 musl 上没有预编译包，必须现场编译**
   （PG 产物里没有 better-sqlite3，这套工具链是白装的；Dockerfile 是两种产物共用的模板，不为此分叉）；
2. **运行时** —— 拷 deps 阶段的 `node_modules` + 产物本身，`ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data`，
   建好 `/app/data` 并声明为 `VOLUME`，`EXPOSE 3000`，启动命令是
   **先 `npx prisma db push`，再 `node server/index.js`**（不带 `--accept-data-loss`：破坏性变更宁可启动失败，也不静默丢数据）。

镜像里没有源码、没有 pnpm、没有构建期依赖，`WORKDIR /app` 就是产物根目录 ——
服务端的「应用根目录」取进程 cwd，正好也是 `/app`，和 `prisma.config.js` 看到的是同一个库。

### 2.5 从源码一把梭（仓库根 `Dockerfile`）

CI 里想一条命令从源码出镜像就用它，三个阶段：

1. **build** —— 全量 `pnpm install --frozen-lockfile` → `prisma generate` → `pnpm build`，产出 `/app/output`；
   install 之前必须先把 **`prisma/`**（连同 `prisma.config.ts`）拷进去 —— `postinstall` 是
   `prisma generate || true`，而 generate 要顺着 `prisma.config.ts` → `prisma/db-provider.mjs`
   → `prisma/<provider>/` 这条链去找 schema 目录。少拷不会让构建失败（`|| true` 兜住），
   但这一步的 generate 会白跑（`COPY . .` 之后那句显式的 `npx prisma generate` 是为此留的保险）。
   `prisma/<provider>/models` 是符号链接，docker 的 `COPY` 会原样保留，不用特殊处理；
2. **deps** —— 和 `output/Dockerfile` 的 deps 阶段一样，只从 `/app/output/package.json` 装生产依赖；
3. **运行时** —— `COPY --from=build /app/output ./`，其余同上。

> ⚠️ 跨架构构建：build 阶段带了 `--platform=$BUILDPLATFORM`（构建产物与架构无关，随构建机跑最快）；
> deps 阶段**故意不带**，跑在目标平台上，这样 better-sqlite3 编译出来的才是目标架构的 `.node`。
> 在 amd64 上构 arm64 镜像需要 QEMU/binfmt 支持。
> 三个阶段的基础镜像要写成**同一个引用**（都是 `harbor-core.harbor.svc/library/node:22-alpine`）：
> 名字不同在 buildah 的本地存储里就是两条独立记录，多架构构建两轮之间更容易串。

> ⚠️ **运行时阶段最后那句 `find … -name '*.node'` + `process.dlopen` 是事故留下的护栏，别删。**
> 原生模块的架构错了，容器**照样能起**：Node 只在第一次 `require` 那个 `.node` 时才 dlopen，
> 而 `/api/health` 不查库，于是 readiness 一路 200，Pod 显示 Healthy，
> 只有真实请求会 500：`Invalid prisma.session.findUnique() invocation: Error relocating
> /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node: unsupported relocation type 1026`
> （`1026` = `R_AARCH64_JUMP_SLOT`，即 musl 的 x86_64 动态链接器在加载一个 **aarch64** 的 `.node`）。
> 这一行让这种镜像在构建期就失败。逐个 dlopen 而不是 `require('better-sqlite3')`，
> 是因为 postgresql 构建的产物里没有这个包（provider 绑构建，见 §1）。

## 3. Kubernetes 部署需求

`k8s/` 下有 Deployment、Service、Ingress。

### 3.1 硬约束

- **默认形态（`k8s/deployment.yaml`）是 `replicas: 1` + `strategy: Recreate`**。
  原因有两条，任一条都足够：SQLite 是单文件（ReadWriteOnce 的卷不允许两个 Pod 同时挂载）；
  Yjs 文档全在进程内存里（多副本之间无法同步，两个 Pod 会各写各的 `ydoc`，后写覆盖先写）。
  滚动更新会短暂存在两个 Pod，因此必须用 `Recreate`。
- **要多副本用 `k8s/deployment.cluster.yaml`**（与上面那份二选一）：`CLUSTER_MODE=redis` +
  PostgreSQL，两条原因都解掉了，于是 `replicas: 3` + `RollingUpdate`，不再有发布中断。
  镜像是同一个 —— 副本模式只由环境变量决定，**唯一绑构建的仍是数据库 provider**。
  Service 不需要 `sessionAffinity`，Ingress 也不需要 sticky session：任意实例都能服务任意房间。
  详见 [REQ-CLUSTER](14-clustering.md)。

### 3.2 存储

- 1Gi PVC，`ReadWriteOnce`，挂到 `/app/data`。
- `DATA_DIR=/app/data`，库文件即 `/app/data/app.db`。
- 换成 PostgreSQL 时 PVC 和 `DATA_DIR` 都可以去掉：镜像里没有任何要落盘的东西。

### 3.3 配置

明文环境变量（在 Deployment 里）：`NODE_ENV`、`HOST`、`PORT`、`DATA_DIR`、`APP_ORIGIN`、`KEYCLOAK_ISSUER`、`KEYCLOAK_CLIENT_ID`。

密钥走 Secret（`envFrom.secretRef`）：`KEYCLOAK_CLIENT_SECRET`、`SESSION_SECRET`，PG 部署再加一个 `DATABASE_URL`（连接串里有密码，**不能**写进 Deployment 的明文 env）。

```bash
kubectl -n dev create secret generic shadecn-learning-auth \
  --from-literal=KEYCLOAK_CLIENT_SECRET=xxx \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32)
```

**真值不得提交进仓库** —— 仓库里的 Secret 清单只是占位模板。

部署前必须按实际环境改：`APP_ORIGIN`、`KEYCLOAK_ISSUER`、镜像地址。`APP_ORIGIN` 必须与 Keycloak client 里配的 redirect URI 一致，否则登录回调失败。

### 3.4 探针与资源

- liveness / readiness 都探 `GET /api/health`（该端点免登录）。
- liveness：initialDelay 5s / period 30s；readiness：initialDelay 3s / period 10s。
- requests `100m / 128Mi`，limits `500m / 512Mi`。
- **`/api/health` 不碰数据库，所以「Pod 是 Healthy」证明不了「应用能用」。** 一个连不上库
  （或者原生模块架构错了，见 §2.5）的镜像照样一路 200、Deployment 一路 `1/1 Available`，
  只有真实请求 500。判断一次发布成不成，看的是浏览器/接口的返回，不是 Pod 状态。

### 3.5 Ingress

- 需要支持 **WebSocket** 透传（`/ws/collaboration`）。
- 建议启用 TLS；生产环境的会话 Cookie 依赖 HTTPS。

### 3.6 schema 变更：`db push` 会拦下破坏性变更，容器就起不来

这个项目**没有迁移文件**（理由见 [REQ-DATA §3](05-data-persistence.md)），表结构靠容器启动时的
一句 `prisma db push` 对齐：

```dockerfile
CMD ["sh", "-c", "npx prisma db push && node server/index.js"]
```

三处都**故意不带** `--accept-data-loss`：仓库根 `Dockerfile`、`scripts/output-image/Dockerfile`、
以及产物 `package.json` 里的 `db:push`。于是遇到它认为有风险的变更时，`db push` 直接以非 0 退出，
`&&` 断掉，`node server/index.js` 根本不执行 —— **不是启动慢，是启动失败**，k8s 上表现为
CrashLoopBackOff，探针的宽限期救不了。多副本下每个 Pod 启动都跑一次，三个一起失败。

**会被拦下的变更**（不限于破坏性的那些）：

| 变更 | 真的会丢数据吗 |
|---|---|
| 删列 / 改列类型 / 重命名 | **会**。SQLite 尤其危险：它不能 ALTER/DROP 列，一次「删 5 列加 1 列」是整表重建 |
| 新增 `@unique` 约束 | 不会（若现有数据无重复）。Prisma 无法预判，所以一律拦 |
| 新增无默认值的 `NOT NULL` 列 | 表非空时会失败 |

后两类是「明明安全却被拦」的常客 —— REQ-SOLO 给 `Project` 加 `personalOwnerId @unique`
就是这么一次（[docs/16 §4.10](16-personal-flow.md) 记了那次的完整 DDL）。

**改完模型、上线之前，先把 DDL 打出来看一眼**：

```bash
pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/postgresql --script
```

只有 `ADD COLUMN` / `CREATE INDEX` / `ADD CONSTRAINT` 就是安全的；出现 `DROP` 或
`ALTER ... TYPE` 才是真需要停下来想的变更。

**被拦下之后怎么上线**，按保守程度排序：

1. **手工执行那几条 DDL**（推荐）。不给任何工具「允许丢数据」的权限；执行完之后正常的
   `db push` 会发现无差异、直接放行，容器照常启动。
2. 在能连到目标库的地方跑一次 `npx prisma db push --accept-data-loss`。一条命令解决，
   但那一刻会把 schema 的**全部**差异一并放行 —— 库里若还有没意识到的漂移，也一起执行了。
3. 用一次性的 k8s Job / initContainer 做迁移。更工程化，但为一次变更引入一套机制。

**不要图省事给镜像的 CMD 加上这个 flag。** 没有迁移文件，`db push` 就是 schema 变更的唯一通道，
那句拒绝是唯一的守门人；加上之后，以后每一次 rename / drop / retype 都会在生产库上静默执行。
用一个长期护栏换一次性的方便，不划算。（旁证：Prisma 7 对 AI agent 执行这个 flag 内置了拦截，
必须先拿到人的明确同意 —— 上游同样认为这该由人拍板。）

## 4. CI/CD 需求：Argo Workflows 构建 + ArgoCD 部署

集群里跑的是两段式 GitOps，**分界线是「谁改 `k8s/deployment.yaml` 里的 image tag」**：Argo
Workflows 负责构建镜像并把新 tag 写回 git，ArgoCD 负责把 git 里的清单变成集群里的状态。
两边不直接通信，git 就是它们之间唯一的接口。

```
本地 commit → push gitea → 手动提交 Argo Workflow
  → clone → buildah 构建 amd64+arm64 推 Harbor → sed 改 tag、提交、push 回同一分支
  → ArgoCD 轮询发现 diff（≤3min）→ Deployment 更新（Recreate，单副本，有短暂中断）
```

### 4.1 CI 只认 gitea

仓库有两个 remote，参与 CI/CD 的只有 gitea 那个：

| remote | 地址 | 谁在用 |
|---|---|---|
| `origin` | `github.com:fyl080801/shadecn-learning.git` | 只是备份，集群完全不看 |
| `gitea` | `ssh://git@git.fyl080801.uk:30222/admin/shadecn-learning.git` | Workflow clone 它并 push 回它；ArgoCD 从集群内 `gitea.dev.svc:3000` 同步它 |

**只 push origin 等于什么都没做。**

### 4.2 流水线定义在仓库里，但不由 ArgoCD 纳管

`ci/workflow-template.yaml` 是 `WorkflowTemplate dev/shadecn-learning-cicd` 的清单，
`ci/run.yaml` 是提交一次运行用的 `Workflow`。

它们**故意不放在 `k8s/` 下**：ArgoCD 的 Application 只同步 `k8s/` 且开了 `prune`，流水线定义
进去就会被纳管，以后误删文件会连集群里的模板一起删掉。代价是这份清单**要手动 apply**，
改完不 apply 就会和集群不一致（集群里那份才生效）：

```bash
kubectl apply -f ci/workflow-template.yaml
```

三步串行，镜像 tag 一律取 clone 出来的提交短 hash：

1. `git-clone` —— 用 `gitea-deploy-key` clone，checkout `gitRevision`（默认 `master`），输出短/全 hash；整个工作区作为 artifact（走 minio）传给后两步
2. `buildah-build-push` —— 用仓库根 `Dockerfile` 构建 **amd64 + arm64 manifest**，推到 Harbor 的 `apps/shadecn-learning:<short-sha>`（走集群内地址 `harbor-core.harbor.svc`）。**整条流水线的时间几乎全在这里，约 45 分钟** —— 两个架构各跑一遍完整构建，其中一个还靠 QEMU 模拟。
   两轮 `bud` 都带 **`--pull=always --no-cache --layers=false`**，这是修过的事故：两轮共用同一个
   本地存储，而 buildah 碰到**同名**的本地镜像会直接拿来用，platform 不匹配最多给个 warning ——
   于是 amd64 那份镜像里混进了 arm64 那轮装出来的 `node_modules`（aarch64 的
   `better_sqlite3.node`），推上线之后每个查库请求 500，见 §2 的护栏说明。
   构建完会 `buildah manifest inspect` 打一遍每个条目的 `architecture`，日志里能直接对
3. `git-update-image-tag` —— `sed` 改 `k8s/deployment.yaml` 的 tag，提交 `ci: update image tag to <sha>`，push 回同一分支。到这里 CI 就结束了，部署是 ArgoCD 的事

流水线依赖的资源都在集群里带外维护，**缺一个就跑不起来**：Secret `gitea-deploy-key`
（必须是**有写权限**的 deploy key，最后一步要 push）、`harbor-auth`、`harbor-ca-cert`，
以及 optional 的 ConfigMap `workflow-proxy-config`（构建要拉墙外的包，没有它多半超时）。

### 4.3 没有自动触发

集群里没装 argo-events（没有 Sensor CRD），也没有 CronWorkflow 或 WorkflowEventBinding。
**push 之后必须手动起一次 Workflow**，之后的部署才是自动的：

```bash
git push gitea master
kubectl -n dev create -f ci/run.yaml   # 改 gitRevision 可构建任意分支
kubectl -n dev get wf -l workflows.argoproj.io/workflow-template=shadecn-learning-cicd \
  --sort-by=.metadata.creationTimestamp
```

提交时要带 `nodeSelector: kubernetes.io/arch=amd64`（`ci/run.yaml` 里已经写好）——
arm64 那半是 QEMU 模拟出来的，反过来跑不动。

### 4.4 ArgoCD Application

`argo/shadecn-learning`，project `dev`，source 是 gitea 仓库 `master` 分支的 `k8s/` 目录，
destination 是本集群 `dev` 命名空间，`syncPolicy.automated` 开了 **`prune` 和 `selfHeal`**，
轮询周期是 ArgoCD 的默认值（3 分钟）。不想等就手动催一下：

```bash
argocd app sync shadecn-learning
argocd app get shadecn-learning
```

`selfHeal` 带来两条硬约束：

- **`kubectl edit` / `kubectl set image` 改不动线上**，几十秒内会被刷回仓库里的值。要改集群只能改 `k8s/*.yaml` 再 push 到 gitea。临时脱管：`argocd app set shadecn-learning --sync-policy none`。
- **`shadecn-learning-auth` 这个 Secret 绝不能提交进 `k8s/`**（§3.3）。它是带外 `kubectl create` 的，不带 ArgoCD 的 tracking label 所以不会被 prune；但仓库里一旦出现同名清单，占位值就会被同步上去把真值刷掉。

Application 的 `source.directory.exclude` 还留着一条 `argo-workflow.yaml` —— 那是流水线定义
早先放在 `k8s/` 里时的遗留，该文件如今已不存在（现在在 `ci/`，天然在 ArgoCD 的视野之外）。
留着无害，但**别拿这条 exclude 当护栏**：想在 `k8s/` 下放不该被同步的东西，靠的是它精确匹配
文件名，一改名就失效。

## 5. 验收标准

- [ ] `pnpm build` 后 `output/` 里同时有 `server/index.js` 和 `public/index.html`，`pnpm start` 能直接起服务。
- [ ] 把 `output/` 单独拷到别处（拿不到仓库的 `node_modules`），`npm install --omit=dev && npm run db:push && npm start` 能跑起来，页面、`/api/*`、登录跳转都正常。
- [ ] `docker build ./output` 与仓库根 `docker build .` 都能出可运行镜像，better-sqlite3 编译通过。
- [ ] 把任意一个运行时依赖挪进 `devDependencies`，`pnpm build:server` 必须失败并指名道姓。
- [ ] 容器首次启动时自动建库、跑完迁移再对外服务。
- [ ] 删除 Pod 重建后，`/app/data` 中的数据仍在（用户和会话不丢）。
- [ ] 通过 Ingress 完整走通 Keycloak 登录回跳。
- [ ] 通过 Ingress 能建立 `/ws/collaboration` WebSocket 连接。
- [ ] 缺少 `KEYCLOAK_ISSUER` 时容器启动失败并给出明确报错（不能静默放行）。
- [ ] `/api/health` 返回 200，探针不误杀。
- [ ] `DB_PROVIDER=postgresql` 构建出的产物里没有 `@prisma/adapter-better-sqlite3`，`prisma/schema.prisma` 是 PG 那份。
- [ ] client 和构建目标 provider 不一致时，`pnpm build:server` 失败并指出该跑哪条命令。
- [ ] `kubectl create -f ci/run.yaml` 跑完之后：Harbor 里有 `apps/shadecn-learning:<short-sha>` 的**双架构** manifest，gitea 上多出一条 `ci: update image tag to <short-sha>`，且 ArgoCD 在 3 分钟内把 Application 同步回 `Synced` / `Healthy`。
- [ ] `ci/workflow-template.yaml` 与集群里那份一致：`kubectl diff -f ci/workflow-template.yaml` 无输出。
- [ ] 手动 `kubectl -n dev set image deploy/shadecn-learning …` 后，ArgoCD 的 `selfHeal` 把它刷回仓库里的 tag。
- [ ] `ci/` 下的文件改动不会让 ArgoCD 变成 `OutOfSync`（它只看 `k8s/`）。

## 6. 本期不做

- **自动触发流水线**（argo-events / webhook）—— 构建要手动起，见 §4.3。
- 蓝绿 / 金丝雀发布（单副本形态是 `Recreate`，每次发布都有几十秒中断；多副本形态是
  `RollingUpdate`，没有中断，但也没做金丝雀）。
- 流水线里的自动化测试门禁（`pnpm test` 目前不在 CI 里跑）。
- 数据库备份与灾备。
- HPA、PDB、NetworkPolicy。

## 7. 待确认事项

- 要不要给 gitea 配 webhook + argo-events，让 push 直接触发构建。
- 构建 45 分钟太久：是给 buildah 加缓存（`--layers` + Harbor 上的 cache 镜像），还是干脆只构 amd64。
- ~~需要多副本时的演进路线~~ —— 已落地，见 [REQ-CLUSTER](14-clustering.md)：
  `@hocuspocus/extension-redis` + 一层共享状态抽象，由 `CLUSTER_MODE` 切换。
  Redis 本身怎么部署（集群里现成的还是自己起一套）还没定。
- k8s 清单现在是两份（SQLite 单副本 / PG 多副本），靠 apply 哪一份来选。要不要收成 kustomize
  的 base + overlay，等第三种形态出现时再说。
- 是否需要为静态资源单独配 CDN / 缓存策略。
