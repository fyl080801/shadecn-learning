# REQ-DEPLOY 构建与部署

## 1. 目标

一个镜像、一个端口、一个卷就能跑起来。**没有 nginx，没有反向代理，没有独立数据库服务** —— Node 进程自己吐静态资源（见 [REQ-SERVER](03-server-runtime.md)）。

## 2. 构建需求

### 2.1 命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 开发（Node/Hono + Vite 中间件，watch 模式），http://127.0.0.1:3000 |
| `pnpm build` | `build:client` + `build:server`，产物全部落在 `output/` |
| `pnpm build:client` | `vue-tsc -b` 类型检查 → `vite build` 输出 `output/public`（`apps/web`；不再顺带检查后端） |
| `pnpm build:server` | `tsc --noEmit` 类型检查 → esbuild 打包出 `output/server/index.js`（`apps/server`） |
| `pnpm start` | 本地生产模式启动（`NODE_ENV=production node --import ./apps/server/scripts/local-start.mjs output/server/index.js`）。`--import` 是兜底：产物从自己所在位置往上找 `node_modules`，而运行时依赖只声明在 `apps/server`，仓库根没有；钩子只对「找不到的裸包名」以 `apps/server/package.json` 为起点再解析一次。容器里产物旁有自己的 `node_modules`，用不到它 |
| `pnpm test:shared` / `pnpm typecheck:shared` | 共享包 `packages/shared` 的测试 / 类型检查 |

所有根命令都是 `pnpm --filter <包>` 的委托，命令名与拆 monorepo 之前一致。
| `pnpm preview` | `build` + `start` |

### 2.2 依赖划分

monorepo 之后依赖分散在各个包里（`apps/web`、`apps/server`、`packages/shared`、仓库根），其中**生产运行时依赖只声明在 `apps/server/package.json`**，这一份的两组依赖有严格含义：

| 组 | 含义 | 内容 |
|---|---|---|
| `dependencies` | **生产运行时**真正要装的 | `hono` / `@hono/node-server`、`yjs`、`@hocuspocus/server` / `crossws`、`@mikro-orm/core` + 两个驱动（`@mikro-orm/sqlite` 连带 better-sqlite3、`@mikro-orm/postgresql` 连带 pg，版本锁死 7.2.5） |
| `devDependencies` | 开发和构建期才要的 | 前端全家桶（vue、vue-router、three、tailwind、reka-ui、codemirror、vue-flow、`@hocuspocus/provider`、y-protocols…）+ 工具链（vite、esbuild、tsx、vue-tsc、eslint、vitest…） |

其余三处：`apps/web` **只有 `devDependencies`**（整包被 `vite build` 打进 `output/public`）；`@shadecn/shared` 在 web 和 server 里都是 `workspace:*` 的 devDependency（被各自的 bundle 内联，产物运行时不需要装）；仓库根只放全仓工具（eslint 全家、typescript、vitest、coverage、jsdom）。

**前端库为什么算 dev**：它们全都被 `vite build` 打进了 `output/public`，运行时一个都不用装。
同理 `tsx` 也降级成 dev —— 生产跑的是打包后的 `server/index.js`，不再解释执行 `.ts`。

这条约定由构建脚本兜底：`apps/server/scripts/build-server.mjs` 会拿 esbuild 反推出来的运行时依赖去比对 `apps/server/package.json` 的
`dependencies`，只要有一个落在 `devDependencies` 里就**直接构建失败**，并提示把它挪过去。
`shadcn-vue` CLI 要在 `apps/web` 下跑，装的包进 web 的 `package.json`（只有 devDependencies），不会再混进运行时依赖。

### 2.3 产物布局

**前后端都构建，产物只有 `output/` 一个目录**（已 gitignore）。它必须是一个
**完整可运行的 app 目录**：拷到任何地方 `npm install --omit=dev && npm start` 就能跑，
`docker build ./output` 就能出镜像，**不依赖仓库里的任何源码**。

```
output/
  package.json        # 运行时依赖（版本锁死）+ start / db:push 脚本
  server/
    index.js          # 打包后的后端入口（ESM，node 22），带 .map
    db-sync.js        # 表结构同步入口（apps/server/db/sync-cli.ts），容器启动先跑它
    chunk-*.js        # 两个入口共用的模块（config、实体、ORM 工厂…）
    dev-*.js          # 动态 import 切出来的开发分支 chunk，生产不会加载
  public/             # 前端静态资源 = 后端的静态资源目录
    index.html
    assets/...
  Dockerfile          # 构建上下文就是 output/ 自己
  .dockerignore
  README.md           # 产物怎么跑 / 怎么打镜像
```

`package.json` 的 `dependencies` 不是照抄仓库那份，而是**从 esbuild 的 external 列表反推**
出来的实际运行时依赖（`@hono/node-server`、`hono`、`@mikro-orm/core`、`@mikro-orm/sqlite`、
`@mikro-orm/postgresql`、`yjs`、`@hocuspocus/*`、`ioredis`…），版本锁到构建当次实际装的那一个。
better-sqlite3 / pg 不在这份清单里 —— bundle 不直接 import 它们，它们是两个 `@mikro-orm/*` 驱动包
锁死版本的依赖，装驱动包时一起进来。`vite` 只出现在永不加载的 dev chunk 里，
不进这份清单。前端那一堆（vue / three / tailwind…）已经打进 `public/`，运行时一个都不需要。

> `node_modules` 不在产物里 —— better-sqlite3 是原生模块，要按目标平台装（它从 13 起把各平台的
> 预编译二进制打在包里，`npm install` 不再现场编译，但二进制仍然得是目标平台的那一个）。
> 产物里锁的是直接依赖的版本，间接依赖没有 lockfile 兜底。

**一个产物两种库**：实体定义和库无关，驱动在**运行时**按 `DB_PROVIDER` / `DATABASE_URL`
动态 import（`apps/server/db/orm.ts`）。构建时不用关心连哪种库，同一个 `pnpm build`、同一个镜像，
换库只改环境变量（Prisma 时代生成的 client 编译期绑死一种库、要按库分别构建，这一条随换 ORM 取消了，
见 [REQ-DATA §2.1](05-data-persistence.md)）。代价是 PG 部署的镜像里也带着 better-sqlite3 的二进制，几 MB。

- **前端静态资源直接构建进后端的静态资源目录**：`apps/web/vite.config.ts` 里 `build.outDir = output/public`，后端生产模式就吐这个目录（可用 `STATIC_DIR` 覆盖）。
- 后端由 `apps/server/scripts/build-server.mjs`（esbuild）打包，两个入口（`index.ts` → `server/index.js`、`db/sync-cli.ts` → `server/db-sync.js`）一次构建：仓库内的相对导入全部内联（实体定义、ORM 配置都在其中），`node_modules` 里的第三方包保持 external（运行时从产物旁的 `node_modules` 解析）。**workspace 包 `@shadecn/*` 例外，一律内联**：`apps/server/scripts/build-server.mjs` 里用 `externalizePackages` 插件代替了 `packages: 'external'` —— 判据相同（不以 `.` / `/` 开头的导入路径视为 external），只是放过 `@shadecn/`，否则 `@shadecn/shared` 会留成一句运行时 import，而产物里根本没装这个包。
- `splitting: true` 是硬要求：`frontend/index.ts` 里的 `await import('./dev.ts')` 必须留成真正的动态 import，否则 `vite` 会被提升成顶层静态依赖 —— 而 `vite` 是 devDependency，生产环境根本不会装，一启动就崩。
- 打包时 define 了 `__APP_BUNDLE__`，`apps/server/runtime.ts` 靠它区分「源码运行」和「产物运行」：产物运行时应用根目录取进程 cwd（容器里就是 `/app`），静态资源取产物自己旁边的 `public/`。
- 运行产物**不再需要 `tsx`**；表结构同步也是打包好的 `server/db-sync.js`，不需要任何 CLI 工具。
- 产物里的 `Dockerfile` / `.dockerignore` / `README.md` 是从 `apps/server/scripts/output-image/` 原样拷进去的 —— 要改这几个文件改模板，别改产物。

### 2.4 直接基于产物打镜像（推荐）

```bash
pnpm build
docker build -t shadecn-learning ./output
```

`output/Dockerfile` 两个阶段（CI 构建服务端镜像用的就是这一份，见 §4.2；两个阶段开头都比对 `TARGETARCH`，见 §2.5.1）：

1. **deps** —— 只 `COPY package.json` 再 `npm install --omit=dev`，装的就是那十来个运行时依赖；
   **不再装 `python3 make g++`**：better-sqlite3 13（`@mikro-orm/sqlite` 的依赖）自带 `linuxmusl-x64` /
   `linuxmusl-arm64` 的预编译二进制，并声明了 `gypfile: false`，npm 不会现场编译；
2. **运行时** —— 拷 deps 阶段的 `node_modules` + 产物本身，`ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data`，
   建好 `/app/data` 并声明为 `VOLUME`，`EXPOSE 3000`，启动命令是
   **`node server/db-sync.js && exec node server/index.js`**：先把表结构对齐到实体定义（不带 `--force`：
   有损变更宁可启动失败，也不静默丢数据），再用 `exec` 让 node 替掉 sh 成为 1 号进程 —— 这样 k8s 的
   SIGTERM 直接送到 node 手上，退出前的落库（`SHUTDOWN_FLUSH_TIMEOUT`）才有机会跑。

镜像里没有源码、没有 pnpm、没有构建期依赖，`WORKDIR /app` 就是产物根目录 ——
服务端的「应用根目录」取进程 cwd，正好也是 `/app`，`db-sync.js` 和 `index.js` 用的是同一份 config，看到的是同一个库。

### 2.5 从源码一把梭（仓库根 `Dockerfile`）

想一条命令从源码出镜像就用它（`docker build .`），三个阶段，外加一个只给 CI 用的 `artifacts` 阶段：

1. **build** —— 全量 `pnpm install --frozen-lockfile` → `pnpm build`，产出 `/app/output`（没有生成步骤，也不需要编译工具链 ——
   根 `package.json` 的 `pnpm.neverBuiltDependencies` 让 pnpm 不去跑 better-sqlite3 的 `node-gyp rebuild`，见下）；
   install 之前**按包逐个 `COPY` `package.json`**（根的 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`，加 `apps/web`、`packages/shared`、`apps/server` 各自的 `package.json`），
   这样改源码不会让依赖层失效；**以后新增 workspace 包要在 Dockerfile 里补一行 `COPY`**。
   `.dockerignore` 必须写 `**/node_modules`（只写 `node_modules` 只排得掉根目录那一个）：每个包的 `node_modules` 是指进宿主机 `.pnpm` 的符号链接，
   漏进构建上下文，`COPY . .` 会把镜像里刚装好的依赖盖掉。
   **为什么要 `neverBuiltDependencies`**：pnpm 9 看到包根目录有 `binding.gyp`、又没有 install 脚本时，会**无视
   `gypfile: false`** 自作主张跑 `node-gyp rebuild`（npm 会尊重这个声明），没有 node-gyp 的机器上 install 直接失败。
   better-sqlite3 13 的二进制是预编译好打在包里的，根本不需要这一步；
   `output/agent-sandbox/`（agent 沙箱镜像的构建上下文）在这一阶段末尾挪到 `/app/agent-sandbox`，不进应用镜像；
2. **deps** —— 和 `output/Dockerfile` 的 deps 阶段一样，只从 `/app/output/package.json` 装生产依赖；
3. **运行时** —— `COPY --from=build /app/output ./`，其余同上。

**`artifacts`**（`FROM scratch`，只有 `/output` 和 `/agent-sandbox`）：CI 用 `buildah bud --target artifacts --output type=local,dest=<目录>`
把 build 阶段的产物原样导出，再分别用 `<目录>/output/Dockerfile` 打服务端镜像、`<目录>/agent-sandbox/Dockerfile` 打沙箱镜像（§4.2）——
最重的 `pnpm install` + `pnpm build` 只跑一次，两个镜像出自同一次构建。`docker build .` 默认构建最后一个阶段，用不到它。

> ⚠️ 跨架构构建：build 阶段带了 `--platform=$BUILDPLATFORM`（构建产物与架构无关，随构建机跑最快）；
> deps 阶段**故意不带**，跑在目标平台上 —— better-sqlite3 按运行时的平台 + 架构挑预编译二进制，基础镜像架构对了，加载的就是对的那一个。
> 在 amd64 上构 arm64 镜像需要 QEMU/binfmt 支持。

#### 2.5.1 三道架构护栏，全都是事故留下的

线上出过这么一档事：`/api/health` 一路 200、Pod `1/1 Available`，但每个真实请求都 500 ——

```
Invalid prisma.session.findUnique() invocation:   ← 当时还是 Prisma
Error relocating /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node:
unsupported relocation type 1026
```

`1026` 是 `R_AARCH64_JUMP_SLOT`：musl 的 **x86_64** 动态链接器在加载一个 **aarch64** 的 `.node`。
一个 amd64 的镜像里装着 arm64 编译的原生模块。

**怎么来的**：Harbor 的 `library` 项目里那个 `node:22-alpine` 是**只有 arm64 的单架构镜像**
（手动推上去的，不是代理缓存），而 build / deps 阶段当时正是从它拉的。
`buildah bud --platform linux/amd64` 遇到没有 amd64 manifest 的 tag，只能退而拉 arm64；
构建机装了 QEMU binfmt，于是 **`RUN` 全都跑得起来、一步不报错** —— 那一轮容器里
`uname -m` 其实是 `aarch64`，装出来的 `.node` 自然也是 aarch64 的，最后被打进标着 amd64
的镜像。运行时阶段当时用的是另一个引用（`docker.io` 代理，多架构正常），所以最终镜像是
「x86_64 的系统层 + aarch64 的原生模块」这种嵌合体。

**别只靠「构建成功」判断架构对不对** —— 装了 binfmt 的机器上，拉错架构是完全静默的。
所以有三道互相独立的护栏，缺一不可：

| 护栏 | 位置 | 挡住的是 |
|---|---|---|
| 所有阶段同一个**多架构**引用（构建参数 `NODE_IMAGE`；CI 传模板的 `baseImage`） | `FROM` 行 | 不同阶段拉到不同架构，拼成嵌合体 |
| `ARG TARGETARCH` + 比对 `process.arch`（deps、运行时各一处；沙箱镜像的每个 node 阶段各一处） | 每个阶段开头 | 基础镜像的 tag 没有目标架构，被 QEMU 静默糊弄过去 |
| `require('better-sqlite3')` 真开一个 `:memory:` 库 + 其余 `*.node` 逐个 `process.dlopen` | 运行时阶段末尾 | 前两道漏掉的任何组合 —— 最终镜像里的原生模块能不能真的加载 |

三道都在仓库根 `Dockerfile` 和 `apps/server/scripts/output-image/Dockerfile`（= `output/Dockerfile`，CI 打服务端镜像用它）里，
沙箱镜像的 Dockerfile 有前两道（它没有原生模块）；`apps/server/test/scripts/dockerfiles.test.ts` 钉住它们（output-image 那份曾经漏过第二道）。

第三道现在分两步：better-sqlite3 13 的 `prebuilds/` 里**躺着全平台的 `.node`**（darwin、win32、glibc…），
照原来那样挨个 dlopen 必然失败，所以那个目录不进遍历，改由 `require` 按它自己的挑选规则
（`prebuilds/<平台>-<架构>.node`）加载并真的执行一句 SQL；其余原生模块（以后新增的）照旧逐个 dlopen。
（以前不 `require('better-sqlite3')` 是因为 PostgreSQL 产物里没有这个包；换 MikroORM 之后每个产物都带着它。）
**换基础镜像的 tag 或仓库之前先验一遍**：在 amd64 节点上跑一次 `uname -m`，必须是 `x86_64`。

## 3. Kubernetes 部署需求

`k8s/` 下有 Deployment、Service、Ingress，以及画布 agent 的 `k8s` 沙箱在 `dev` 里的配套 `agent-sandbox.yaml`（服务端的 ServiceAccount、Role / RoleBinding、
只选沙箱 Pod 的 NetworkPolicy），都由 ArgoCD 同步。沙箱 Pod 和别的服务共用 `dev`，`dev` 没有 Pod Security，所以另有一份**集群级**的
ValidatingAdmissionPolicy（`k8s/variants/agent-sandbox-vap.yaml`，不进 ArgoCD、管理员 apply）限死服务端能建什么样的 Pod；没 apply 时 agent 自检不过、不启用。
更强的独立命名空间形态在 `k8s/variants/agent-sandbox.yaml`。细节见 [REQ-AGENT-SANDBOX §7.5](22-agent-sandbox.md#75-k8s-驱动四期)。

**只用 arm64 节点**：CI 只构建 `linux/arm64`（§4.2），所以服务端 Deployment 带 `nodeSelector: kubernetes.io/arch: arm64`，沙箱 Pod 也一样
（`AGENT_SANDBOX_K8S_NODE_SELECTOR=kubernetes.io/arch=arm64`）。镜像是只含 arm64 的 manifest list，调度到 amd64 节点会拉不到。

### 3.1 硬约束

- **默认形态（`k8s/deployment.yaml`）是 `replicas: 1` + `strategy: Recreate`**。
  原因有两条，任一条都足够：SQLite 是单文件（ReadWriteOnce 的卷不允许两个 Pod 同时挂载）；
  Yjs 文档全在进程内存里（多副本之间无法同步，两个 Pod 会各写各的 `ydoc`，后写覆盖先写）。
  滚动更新会短暂存在两个 Pod，因此必须用 `Recreate`。
- **要多副本用 `k8s/variants/deployment.cluster.yaml`**（与上面那份是同一个 Deployment 的两种形态，
  它放在 `variants/` 而不是 `k8s/` 下是必须的，理由见 [§4.4](#44-argocd-application)）：`CLUSTER_MODE=redis` +
  PostgreSQL，两条原因都解掉了，于是 `replicas: 3` + `RollingUpdate`，不再有发布中断。
  镜像是同一个 —— 副本模式和数据库种类都只由环境变量决定，没有任何东西绑构建。
  Service 不需要 `sessionAffinity`，Ingress 也不需要 sticky session：任意实例都能服务任意房间。
  详见 [REQ-CLUSTER](14-clustering.md)。

### 3.2 存储

- 1Gi PVC，`ReadWriteOnce`，挂到 `/app/data`。
- `DATA_DIR=/app/data`，库文件即 `/app/data/app.db`。
- 换成 PostgreSQL 时 PVC 和 `DATA_DIR` 都可以去掉：镜像里没有任何要落盘的东西。

### 3.3 配置

明文环境变量（在 Deployment 里）：`NODE_ENV`、`HOST`、`PORT`、`DATA_DIR`、`APP_ORIGIN`、`KEYCLOAK_ISSUER`、`KEYCLOAK_CLIENT_ID`；挂多个对外域名时再加 `APP_ORIGINS`；
agent 沙箱那一组（`AGENT_SANDBOX=k8s`、`POD_IP`、`AGENT_SANDBOX_K8S_*`、`AGENT_SANDBOX_IMAGE`，[REQ-AGENT-SANDBOX §7.5](22-agent-sandbox.md#75-k8s-驱动四期)）。
agent 的模型配置**不在 Deployment 里**：来自带外的 `shadecn-learning-agent`（ConfigMap + Secret，见下文），不配 = agent 未启用，别的功能不受影响。

密钥走 Secret（`envFrom.secretRef`）：`KEYCLOAK_CLIENT_SECRET`、`SESSION_SECRET`，PG 部署再加一个 `DATABASE_URL`（连接串里有密码，**不能**写进 Deployment 的明文 env）。

```bash
kubectl -n dev create secret generic shadecn-learning-auth \
  --from-literal=KEYCLOAK_CLIENT_SECRET=xxx \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32)
```

**要开 GitHub 登录**（[REQ-AUTH §3.2.2](02-auth-keycloak.md)）就往同一个 Secret 里再塞两个键：

```bash
  --from-literal=GITHUB_CLIENT_ID=xxx \
  --from-literal=GITHUB_CLIENT_SECRET=xxx
```

`envFrom` 是**整份 Secret 注入**，所以键加进去就生效，**Deployment 清单不用动**。
GitHub OAuth App 的 Authorization callback URL 填 `$APP_ORIGIN/api/auth/callback` ——
和 Keycloak 共用同一个回调地址，不要另建。

**画布 agent 的模型配置**和**画布资源上传（S3）**各是一对带外资源（非密钥在 ConfigMap、密钥在 Secret；和 `shadecn-learning-auth` 一样不在 git 里、不归 ArgoCD，
都带 `app=shadecn-learning` 标签），Deployment 用 `envFrom` 整份注入、都是 `optional: true`（被删了也不挡 Pod 启动，对应功能只是关着）。都是先建好、值留空，由人手动填：

| 资源 | key | 说明 |
|---|---|---|
| ConfigMap `dev/shadecn-learning-agent` | `AGENT_PROVIDER`、`AGENT_MODEL`、`AGENT_BASE_URL`、`AGENT_API`、`AGENT_IMAGE_INPUT` | 非密钥的模型配置 |
| Secret `dev/shadecn-learning-agent` | `AGENT_API_KEY`、`AGENT_TOKEN_SECRET` | 模型 key、签 run 短令牌的密钥 |
| ConfigMap `dev/shadecn-learning-s3` | `S3_ENDPOINT`、`S3_INTERNAL_ENDPOINT`、`S3_REGION`、`S3_BUCKET` | 画布资源（图片 / 视频）上传的对象存储（[13-flow-canvas-management.md](13-flow-canvas-management.md)「资源上传」） |
| Secret `dev/shadecn-learning-s3` | `S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` | 对象存储的凭据 |

- **空值 = 不配**：每一项都按「没设这个变量」处理（`AGENT_PROVIDER` / `AGENT_MODEL` 落回默认的 anthropic 模型、`AGENT_IMAGE_INPUT` 按模型元数据、
  `AGENT_TOKEN_SECRET` 由 `SESSION_SECRET` 派生）。全部为空时没有任何 key，agent 显示为未启用（`GET …/agent` 的 `enabled: false`），别的功能不受影响。
- **Deployment 的 `env` 里不写这几项**：`env` 优先于 `envFrom`，写一个就把这几份资源里的值盖掉了（清单测试钉住；`env` 里的 S3 只有 `S3_MAX_UPLOAD_MB`）。
  `envFrom` 里同名的键以后面的为准（`shadecn-learning-auth` → agent 的 ConfigMap → agent 的 Secret → S3 的 ConfigMap → S3 的 Secret）。
- **改完要重启才生效**：`envFrom` 只在容器启动时读一次 —— `kubectl -n dev rollout restart deploy/shadecn-learning`（`Recreate`，有短暂中断）。
- 例：用集群里 `dev` 命名空间的 ollama（不要 key，`AGENT_API_KEY` 留空即可）：

  ```bash
  kubectl -n dev patch configmap shadecn-learning-agent --type merge -p '{"data":{
    "AGENT_PROVIDER":"ollama",
    "AGENT_MODEL":"<ollama list 里的模型名>",
    "AGENT_BASE_URL":"http://ollama.dev.svc.cluster.local/v1"}}'
  kubectl -n dev rollout restart deploy/shadecn-learning
  ```

  走 ollama 的是服务端（网关的模型代理），不是沙箱 —— 沙箱的 NetworkPolicy 只放行到服务端，它直接连不到 ollama。
  用别的提供方时 key 放进 Secret：`kubectl -n dev edit secret shadecn-learning-agent`（`data` 里是 base64），或从一份本地文件生成
  `kubectl -n dev create secret generic shadecn-learning-agent --from-env-file=<本地文件> --dry-run=client -o yaml | kubectl apply -f -`（会去掉 `app` 标签，记得补回）；值不进 git。
- **S3**：
  - `S3_ENDPOINT` 是**公开地址**：上传后节点的 `data.src` 存的是原始地址 `<endpoint>/<bucket>/<key>`，浏览器直接去那里取，不经后端转发；
    agent 看图时服务端也是按它把 `data.src` 反解成对象键。所以必须填**浏览器访问得到**的地址，不能填集群内的 `*.svc`；
    留空 = 默认 `https://s3.fyl080801.uk`。改它之前存进节点的地址不会跟着变（还指着旧地址）。
  - `S3_INTERNAL_ENDPOINT` **只影响服务端 → S3 的请求**（上传、分片、读字节给 agent 看图）：留空 = 和 `S3_ENDPOINT` 一样（服务端绕公网访问）；
    k8s 里填 `http://minio.minio.svc.cluster.local:9000`，走集群内网。公网的 `s3.fyl080801.uk` 解析到集群外的机器、TLS 在那里终结，
    集群内的 MinIO ingress 没有 TLS，所以不能靠 hostAliases 把公网名字指回集群（证书对不上）。浏览器读的、存进节点的仍是 `S3_ENDPOINT`；
    两个地址必须是同一个 MinIO、同一个桶。服务端 Pod 出站到 `minio` 命名空间的 9000 不受任何 NetworkPolicy 限制（`dev` 里只有选中沙箱 Pod 的那一条）。
  - `S3_REGION` 留空 = `us-east-1`；`S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` **缺一个 = 上传关闭**（上传接口 503，别的功能照常）。
  - **桶要对匿名开放读**（`s3:GetObject`），否则画布上的图都是裂的。
  - `S3_KEY_PREFIX` **刻意不放进这份 Secret**：不配是 `canvas`，而空串的意思是「桶根」—— 一个空值的 key 会把对象键改到桶根下。真要改就在 Deployment 的 `env` 里显式写。

**真值不得提交进仓库** —— 仓库里的 Secret 清单只是占位模板。

部署前必须按实际环境改：`APP_ORIGIN`、`KEYCLOAK_ISSUER`、镜像地址。`APP_ORIGIN` 必须与 Keycloak client 里配的 redirect URI 一致，否则登录回调失败。

同一套服务挂在多个域名下时，把每个对外域名都写进 `APP_ORIGINS`（逗号分隔，`APP_ORIGIN` 自动在内），并且**每个域名的 `/api/auth/callback` 都要加进 Keycloak client 的 *Valid redirect URIs***。不配的话，从名单外的域名进来一律回落到 `APP_ORIGIN` —— 登录会跳到另一个域名上完成，cookie 种在那边，人回来还是未登录。详见 [REQ-AUTH §3.2.0](02-auth-keycloak.md)。

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

### 3.6 表结构变更：有损变更会被拦下，容器就起不来

这个项目**没有迁移文件**（理由见 [REQ-DATA §3.4](05-data-persistence.md)），表结构靠容器启动时的
一句同步对齐：

```dockerfile
CMD ["sh", "-c", "node server/db-sync.js && exec node server/index.js"]
```

三处都**故意不带** `--force`：仓库根 `Dockerfile`、`apps/server/scripts/output-image/Dockerfile`、
以及产物 `package.json` 里的 `db:push`。（仓库根的 `pnpm db:push:force` 带它，但那是**开发期专用**的
单独命令，既不在镜像里，也不挂在 `pnpm dev` 上 —— 见 [REQ-DATA §3.4](05-data-persistence.md)。）于是遇到有损变更时，
`db-sync.js` 把语句打出来、以 1 退出，`&&` 断掉，`node server/index.js` 根本不执行 ——
**不是启动慢，是启动失败**，k8s 上表现为 CrashLoopBackOff，探针的宽限期救不了。多副本下每个 Pod 启动都跑一次，三个一起失败。

**会被拦下的变更**（守卫按将要执行的 SQL 逐句判，见 [REQ-DATA §3.4.1](05-data-persistence.md)）：

| 变更 | 真的会丢数据吗 |
|---|---|
| 删列 / 删表 / 改列类型 | **会** |
| SQLite 上的任何「改列」（改类型、改可空、改默认值） | 不一定。MikroORM 走整表重建（`__temp_alter`），列一变就可能搬丢，一律拦 |
| 列改名 | 不一定。MikroORM 按启发式判「删一列 + 加一列」是不是改名，判错了数据挪到别的列上，一律拦 |

**不会**被拦的：建表、加列、建 / 删索引、加唯一约束、PG 上改可空 / 默认值。其中加唯一约束、
加无默认值的非空列在表里已有数据时会**执行失败**（同样以非 0 退出），但不会悄悄丢东西。

**改完实体、上线之前，先看一眼会执行什么**：对着一份和线上同结构的库跑 `pnpm db:push`
（或者产物里 `node server/db-sync.js`）—— 有损的会被拒绝并逐句打出，放行的会打出执行了哪几句。

**被拦下之后怎么上线**，按保守程度排序：

1. **手工执行那几条 DDL**（推荐）。不给任何工具「允许丢数据」的权限；执行完之后正常的
   同步会发现无差异、直接放行，容器照常启动。
2. 在能连到目标库的地方跑一次 `node server/db-sync.js --force`（产物里 `npm run db:push:force`）。一条命令解决，
   但那一刻会把实体与库的**全部**差异一并放行 —— 包括删掉库里实体之外的表。
3. 用一次性的 k8s Job / initContainer 做迁移。更工程化，但为一次变更引入一套机制。

**不要图省事给镜像的 CMD 加上 `--force`。** 没有迁移文件，这次同步就是表结构变更的唯一通道，
那句拒绝是唯一的守门人；加上之后，以后每一次 rename / drop / retype 都会在生产库上静默执行。
用一个长期护栏换一次性的方便，不划算。

## 4. CI/CD 需求：Argo Workflows 构建 + ArgoCD 部署

集群里跑的是两段式 GitOps，**分界线是「谁改 `k8s/deployment.yaml` 里的 image tag」**：Argo
Workflows 负责构建镜像并把新 tag 写回 git，ArgoCD 负责把 git 里的清单变成集群里的状态。
两边不直接通信，git 就是它们之间唯一的接口。

```
本地 commit → push gitea master → Gitea Actions 起 Argo Workflow（.gitea/workflows/cicd.yaml，钉在 arm64 节点）
  → clone → buildah：pnpm build 一次 → 服务端 + agent 沙箱两个 arm64 镜像推 Harbor
  → sed 改两行 tag（服务端 image、AGENT_SANDBOX_IMAGE）、提交、push 回同一分支
  → ArgoCD 轮询发现 diff（≤3min）→ Deployment 更新（Recreate，单副本，有短暂中断）
```

触发那一环是后加的（原来必须手动 `kubectl create -f ci/run.yaml`），见 [§4.3](#43-自动触发push-master-由-gitea-actions-起构建)。
手动那条路**没有废弃**，它仍然是 Actions 或 runner 出问题时的兜底入口。

### 4.1 CI 只认 gitea

仓库有两个 remote，参与 CI/CD 的只有 gitea 那个：

| remote | 地址 | 谁在用 |
|---|---|---|
| `origin` | `github.com:fyl080801/shadecn-learning.git` | 只是备份，集群完全不看 |
| `gitea` | `ssh://git@git.fyl080801.uk:30222/admin/shadecn-learning.git` | Workflow clone 它并 push 回它；ArgoCD 从集群内 `gitea.dev.svc:3000` 同步它 |

**只 push origin 等于什么都没做。**

### 4.2 流水线定义在仓库里，但不由 ArgoCD 纳管

`ci/workflow-template.yaml` 是 `WorkflowTemplate dev/shadecn-learning-cicd` 的清单，
`ci/run.yaml` 是提交一次运行用的 `Workflow`，`ci/gitea-actions-runner.yaml` 是跑
Gitea Actions 的 act_runner（[§4.3](#43-自动触发push-master-由-gitea-actions-起构建)）。

它们**故意不放在 `k8s/` 下**：ArgoCD 的 Application 只同步 `k8s/` 且开了 `prune`，流水线定义
进去就会被纳管，以后误删文件会连集群里的模板一起删掉。代价是这份清单**要手动 apply**，
改完不 apply 就会和集群不一致（集群里那份才生效）：

```bash
kubectl apply -f ci/workflow-template.yaml
```

三步串行，镜像 tag 一律取 clone 出来的提交短 hash：

1. `git-clone` —— 用 `gitea-deploy-key` clone，checkout `gitRevision`（默认 `master`），输出短/全 hash；整个工作区作为 artifact（走 minio）传给后两步
2. `buildah-build-push` —— 构建 **`platforms` 参数里的架构（默认只有 `linux/arm64`）**，推两个镜像到 Harbor（走集群内地址 `harbor-core.harbor.svc`）：
   服务端 `apps/shadecn-learning:<short-sha>` 和 agent 沙箱 `apps/shadecn-agent-sandbox:<short-sha>`（模板参数 `sandboxImageName`）。分三段：
   根 `Dockerfile` 的 `artifacts` 阶段导出 `pnpm build` 的产物（最重的一段，只跑一次，§2.5）→ 每个 platform 用产物里的 `output/Dockerfile` 打服务端镜像、
   `agent-sandbox/Dockerfile` 打沙箱镜像 → 两个 manifest 都核对过架构（必须恰好是 `platforms` 里那几个）再推。
   Workflow 由 `nodeSelector: kubernetes.io/arch: arm64` 钉在 arm64 节点上，原生构建、不靠 QEMU（以前双架构 + QEMU 约 45 分钟，
   还在内存吃紧的 amd64 节点上被 OOM 杀过 —— 这一步现在带 `resources`：requests 2 核 / 4Gi / 20Gi ephemeral-storage，limits 6 核 / 12Gi / 60Gi）。
   每次 `bud` 都带 **`--pull=always --no-cache --layers=false`**：几轮共用一个本地存储，
   这几个开关保证每轮都按各自的 platform 重新拉基础镜像、不复用别的轮次的层。
   推之前会 `buildah manifest inspect` 打一遍每个条目的 `architecture`，日志里能直接对。
   **但架构错乱的真凶不在这里，在基础镜像的 tag 上，见 [§2.5.1](#251-三道架构护栏全都是事故留下的)** ——
   日志里那句 `native modules ok: N on <arch>` 才是每轮真实跑在什么架构上的证据，
   `linux/amd64` 那轮打出 `aarch64` 就是出事了
3. `git-update-image-tag` —— `sed` 改 `k8s/deployment.yaml` 里的两行 tag（服务端容器的 `image:`、沙箱的 `AGENT_SANDBOX_IMAGE` 那行 `value:`），
   暂存区里只要多出这两种行以外的改动就失败、不提交；提交 `ci: update image tag to <sha>`，push 回同一分支。到这里 CI 就结束了，部署是 ArgoCD 的事。
   **push 被拒会 fetch + rebase 重试**（最多 5 次）：clone 停在构建开始那个提交，而构建要 45 分钟，
   这期间分支上有了新提交，这一 push 就是 non-fast-forward —— 镜像明明已经在 Harbor 里，
   只差一行 tag 没写回，却要整轮重来。自动触发上线后这个窗口撞得更频繁（每次 push 都起一轮），
   所以补了重试。**冲突不硬盖**（不用 `-X ours`）：那意味着有人手工改过 image 行（比如回滚），
   悄悄盖掉比失败糟得多，让它红在这一步由人来看

流水线依赖的资源都在集群里带外维护，**缺一个就跑不起来**：Secret `gitea-deploy-key`
（必须是**有写权限**的 deploy key，最后一步要 push）、`harbor-auth`、`harbor-ca-cert`，
以及 optional 的 ConfigMap `workflow-proxy-config`（构建要拉墙外的包，没有它多半超时）。

### 4.3 自动触发：push master 由 Gitea Actions 起构建

`.gitea/workflows/cicd.yaml`，触发条件是 `push` 到 `master`（外加一个可手动触发的
`workflow_dispatch`，能指定任意分支）。它**不自己构建** —— 只起一条 Argo Workflow（内容等价于
`ci/run.yaml`，`gitRevision` 换成这次 push 的分支），然后守着它跑完，所以 Gitea 里这个 job 的
红/绿就是构建的红/绿，失败时还会把出错那步的 Pod 日志打进 job 日志。

**为什么不干脆把构建搬进 Actions**：那条 buildah 流水线里全是事故换来的东西 —— 多架构
manifest、两处 `TARGETARCH` 校验、运行时 dlopen 自检（[§2.5.1](#251-三道架构护栏全都是事故留下的)）、
基础镜像的自建多架构副本、单 platform 级别的重试、Harbor 自签 CA、出网代理。重写一遍等于
把这些护栏重新踩一次，而现在缺的只有「谁按下开始」这一下。

选 argo-events 的替代路线也是同一个判断：Actions 已经在 Gitea 里（1.21+ 默认开启），
不用装 CRD、不用配 Sensor，还顺带白拿了日志、重跑按钮和 job 历史。

#### 防自触发循环：两道独立护栏

流水线最后一步会把新 tag **push 回 master**，这个提交自己又是一次 push 事件。两道护栏
必须同时失效才会打转：

1. **`paths-ignore`（主力）** —— 写回的提交只动 `k8s/deployment.yaml`，命中即整轮跳过。
   这份名单遵循一条规则：**不进镜像的东西不触发构建**（一轮 45 分钟），所以是
   `k8s/**`、`docs/**`、`**.md`，加上 CI 自己的定义 `.gitea/**` 和 `ci/**`。
   `k8s/**` 不只是为了盖住写回提交：改副本数、探针、Ingress 都不需要新镜像，
   ArgoCD 会直接同步清单；`ci/` 下的那两份更是本来就要人工 apply 才生效。
   只要提交里还有一个文件不在名单里，构建照起；
   要强制构建就用手动触发。顺带一个好处：**引入这个 workflow 的那次 push 自己不会触发构建**，
   可以先用一次 `workflow_dispatch` + `dryRun` 验通链路，再决定什么时候真起一轮。
2. **job 级 `if`** —— 认提交标题前缀 `ci: update image tag`。它依赖 push payload 里有
   `head_commit`，所以是备份而不是主力。

**并发**靠 runner 的 `capacity: 1`：Gitea 1.23 还不支持 workflow 级 `concurrency`，两次 push
撞在一起时后一条排队，而不是并发起两轮 45 分钟的构建。

#### runner 是带外资源，而且必须有

Gitea 自己不执行任何 job。集群里原本**一个 runner 都没有**（`action_runner` 表 0 行），
workflow 文件单独存在只会永远停在「等待 runner」。清单是 `ci/gitea-actions-runner.yaml`，
和 `ci/workflow-template.yaml` 一样人工 apply（同样是为了躲开 ArgoCD 的 prune）：

```bash
# 注册令牌：Gitea → 站点管理 → Actions → Runners → 创建注册令牌
kubectl -n dev create secret generic gitea-act-runner --from-literal=token='<注册令牌>'
kubectl apply -f ci/gitea-actions-runner.yaml
kubectl -n dev logs deploy/gitea-act-runner --tail=20   # 看到 runner 注册成功
```

令牌只在首次注册时用，注册结果落在 PVC 上的 `/data/.runner`，重启不会重复注册。

**host 模式，不是 docker/dind**，理由是省掉三样东西：job 步骤直接跑在 runner 容器里，于是能
直接用 Pod 的 ServiceAccount 调 k8s API（dind 里的工作容器拿不到 Pod 的 SA token，就得把
kubeconfig 塞进 Gitea 的 secret）；不需要 privileged 的 dind sidecar；不用在 dind 里再配一遍
Harbor 的自签 CA。代价是**镜像里没有的工具得自己备** —— act_runner 镜像只有 sh/bash/git，
没有 kubectl，**也没有 node**，所以 initContainer 从 `alpine/k8s` 拷一个 kubectl 到
`/opt/ci-tools`，而 workflow 里一个 JS action 都不能用（`actions/checkout` 也不行）。
这不碍事：那个 job 只需要提交一条 Workflow，源码是 Argo 那边 clone 的，压根不用 checkout。

runner 的 ServiceAccount `gitea-ci-runner` 权限就三样：`workflows` 的
get/list/watch/create/delete、`workflowtemplates` 的 get/list、`pods` + `pods/log` 的 get/list。
它**碰不到 Deployment 和 Secret** —— 部署是 ArgoCD 的事，runner 只负责按下开始。

SA 本身住在 `dev`（runner Pod 和 gitea 一起在那儿），但这三样权限发在 `devops` ——
流水线模板和构建 Pod 都搬过去了。靠 `ci/gitea-actions-runner.yaml` 里那条
RoleBinding 的跨命名空间 subject（`namespace: dev` 的 SA + `namespace: devops`
的 Role）接起来。应用本身没动，仍旧部署在 `dev`。

#### 手动入口仍然保留

Actions 或 runner 出问题时（也包括构建别的分支）：

```bash
kubectl -n devops create -f ci/run.yaml   # 改 gitRevision 可构建任意分支
kubectl -n devops get wf -l workflows.argoproj.io/workflow-template=shadecn-learning-cicd \
  --sort-by=.metadata.creationTimestamp
```

不管从哪个入口起，都要带 `nodeSelector: kubernetes.io/arch=arm64`（`ci/run.yaml` 和
`cicd.yaml` 里都写好了）—— 默认只构建 arm64，要在 arm64 节点上原生跑。改其中一处记得看另一处；
改模板的 `platforms` 时，`k8s/deployment.yaml` 里服务端和沙箱的 nodeSelector 也要跟着想清楚（清单测试把这几处钉在一起）。

### 4.4 ArgoCD Application

`argo/shadecn-learning`，project `dev`，source 是 gitea 仓库 `master` 分支的 `k8s/` 目录，
destination 是本集群 `dev` 命名空间，`syncPolicy.automated` 开了 **`prune` 和 `selfHeal`**，
轮询周期是 ArgoCD 的默认值（3 分钟）。AppProject `dev` 的 `namespaceResourceWhitelist` / `clusterResourceWhitelist` 都是 `*/*`、destination 只有 `dev`，
所以 `k8s/agent-sandbox.yaml` 里的 ServiceAccount / Role / RoleBinding / NetworkPolicy 会和 Deployment 一起同步（同一次 sync 里 SA 先建）。
集群级的 VAP 刻意不放进来（`k8s/variants/`），由管理员 apply。不想等就手动催一下：

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

#### 同一目录里不能有两份同名资源

ArgoCD 同步的是**目录**（`path: k8s`，没开 `recurse`，所以只读这一层的文件），不是「你 apply 了哪一份」。
所以 `k8s/deployment.yaml` 和多副本变体一度同时躺在 `k8s/` 下时，同一个资源身份出现了两次，
Application 上挂着：

```
RepeatedResourceWarning: Resource apps/Deployment/dev/shadecn-learning appeared 2 times among application resources.
```

**哪一份生效没有保证**。实测一直是单副本那份赢（`kubectl get rs` 的 revision 历史是干净的单调序列，
从没出现过 3 副本），所以没造成事故；但真翻过去就是 `replicas: 3` + 无 PVC + 一个几个月前的旧 tag
（CI 的 `sed` 只改 `k8s/deployment.yaml`，从不碰变体），SQLite 的卷会跟着掉。

修法是把变体挪出同步目录：`k8s/variants/deployment.cluster.yaml`。**不要靠 `exclude`** —— 理由同上一段。

顺带纠正一句本文档早先的说法：「两份清单，apply 哪一份来选形态」对 Deployment 是**不成立**的。
它由 ArgoCD 纳管且开了 `selfHeal`，带外 apply 几十秒就被刷回去（和 `kubectl set image` 改不动线上
是同一件事）。切形态只能走 git：把变体的内容覆盖到 `k8s/deployment.yaml` 再提交。

### 4.5 流水线用到的镜像**全部**走 Harbor 代理，包括 Argo 自己的 executor

集群到 `quay.io` 的直连不稳（`failed to do request: Head https://quay.io/v2/…: EOF`），
而 argo 的 controller configmap 里 executor 是 **`imagePullPolicy: Always`** ——
节点上缓存过也没用，quay.io 一不通，**每个步骤的 Pod 都卡在 `Init:ImagePullBackOff`**，
流水线一步都跑不动。注意 `workflow-proxy-config` 救不了这个：它是注入到容器里的
env，而拉镜像的是 kubelet。

所以模板里三类镜像都指到 Harbor 的代理缓存：

| 镜像 | 写法 |
|---|---|
| 步骤容器（git / buildah） | `192.168.68.95:31443/docker.io/alpine/git`、`192.168.68.95:31443/quay.io/buildah/stable` |
| **argo executor**（每个 Pod 的 `init` + `wait` 容器） | `spec.podSpecPatch` 覆盖成 `192.168.68.95:31443/quay.io/argoproj/argoexec:<版本>` |

executor 的 tag **必须和集群里 argo 的版本对上**（`kubectl -n argo get deploy` 看
workflow-controller 的 tag），argo 升级之后要跟着改这里 —— 这是把它写进 Workflow 而不是
改 argo 全局 configmap 的代价，换来的是改动留在仓库里、只影响这条流水线。

## 5. 验收标准

- [ ] `pnpm build` 后 `output/` 里同时有 `server/index.js` 和 `public/index.html`，`pnpm start` 能直接起服务。
- [ ] 把 `output/` 单独拷到别处（拿不到仓库的 `node_modules`），`npm install --omit=dev && npm run db:push && npm start` 能跑起来，页面、`/api/*`、登录跳转都正常。
- [ ] `docker build ./output` 与仓库根 `docker build .` 都能出可运行镜像，运行时阶段的 better-sqlite3 加载自检通过。
- [ ] 把任意一个运行时依赖挪进 `devDependencies`，`pnpm build:server` 必须失败并指名道姓。
- [ ] 容器首次启动时自动建库、跑完表结构同步再对外服务。
- [ ] 删除 Pod 重建后，`/app/data` 中的数据仍在（用户和会话不丢）。
- [ ] 通过 Ingress 完整走通 Keycloak 登录回跳。
- [ ] 通过 Ingress 能建立 `/ws/collaboration` WebSocket 连接。
- [ ] **一个登录方式都没配齐**（Keycloak 与 GitHub 的必填项都缺）时容器启动失败并给出明确报错（不能静默放行）；
      只配了其中一个能正常启动，只配了半个（如有 `KEYCLOAK_ISSUER` 无 `KEYCLOAK_CLIENT_ID`）也要报错。
- [ ] `/api/health` 返回 200，探针不误杀。
- [ ] 同一份产物 / 同一个镜像，只改 `DB_PROVIDER` + `DATABASE_URL` 就能分别连 SQLite 和 PostgreSQL，`/api/health/ready` 都是 200。
- [ ] 实体上有删列 / 改类型时，容器启动在 `db-sync.js` 那一步失败并打出具体语句，`index.js` 没有被执行。
- [ ] `kubectl create -f ci/run.yaml` 跑完之后：Harbor 里有 `apps/shadecn-learning:<short-sha>` 和 `apps/shadecn-agent-sandbox:<short-sha>` 两个 manifest（各自恰好包含 `platforms` 里的架构，默认只有 arm64），gitea 上多出一条只改了这两行 tag 的 `ci: update image tag to <short-sha>`，且 ArgoCD 在 3 分钟内把 Application 同步回 `Synced` / `Healthy`。
- [ ] 构建步骤的 Pod 落在 arm64 节点上；日志里每一轮 `base image arch ok: arm64 (aarch64)`。
- [ ] 服务端启动日志里有「k8s 沙箱：Kubernetes v…，命名空间 dev」，没有「k8s 沙箱不可用」（VAP 已 apply）；VAP 的反例样例全部被拒。
- [ ] `ci/workflow-template.yaml` 与集群里那份一致：`kubectl diff -f ci/workflow-template.yaml` 无输出。
- [ ] `git push gitea master` 之后无需任何手工操作：Gitea 的 Actions 页出现一条 `cicd` 运行，`devops` 命名空间里多出一条 `shadecn-learning-cicd-*`，job 一直守到构建结束（成功则绿、失败则红且日志里有出错那步的 Pod 日志）。
- [ ] 流水线写回的 `ci: update image tag to <sha>` 提交**不会**再触发一轮构建（Actions 页没有新运行）。
- [ ] 只改 `k8s/**`、`docs/**`、`*.md`、`.gitea/**`、`ci/**` 的提交同样不触发构建（但 `k8s/**` 的改动仍会被 ArgoCD 同步上去）；用 `workflow_dispatch` 仍能强制构建任意分支。
- [ ] 构建进行中往同一分支再推一个提交，最后一步仍能写回（日志里出现「fetch + rebase 后重试」），不会因为 non-fast-forward 让整轮 45 分钟白跑。
- [ ] runner 的 SA 越权检查：`kubectl -n devops auth can-i --as=system:serviceaccount:dev:gitea-ci-runner delete deployments` 与 `… get secrets` 都是 `no`。
- [ ] 手动 `kubectl -n dev set image deploy/shadecn-learning …` 后，ArgoCD 的 `selfHeal` 把它刷回仓库里的 tag。
- [ ] `ci/` 下的文件改动不会让 ArgoCD 变成 `OutOfSync`（它只看 `k8s/`）。

## 6. 本期不做

- **argo-events / WorkflowEventBinding** —— 自动触发这件事由 Gitea Actions 做了（§4.3），
  不再为它单独装一套 CRD。
- **构建别的分支自动触发** —— 只有 `master` 会自动起构建；其余分支走 `workflow_dispatch`
  或手动那条命令。（分支多起来时再谈按 PR 触发。）
- 蓝绿 / 金丝雀发布（单副本形态是 `Recreate`，每次发布都有几十秒中断；多副本形态是
  `RollingUpdate`，没有中断，但也没做金丝雀）。
- 流水线里的自动化测试门禁（`pnpm test` 目前不在 CI 里跑）。
- 数据库备份与灾备。
- HPA、PDB；服务端自己的 NetworkPolicy（只有 agent 沙箱 Pod 有，见 [REQ-AGENT-SANDBOX §7.5](22-agent-sandbox.md#75-k8s-驱动四期)）。

## 7. 待确认事项

- ~~要不要给 gitea 配 webhook + argo-events，让 push 直接触发构建~~ —— 已落地，但走的是
  Gitea Actions 而不是 argo-events，见 §4.3。
- Actions 里要不要加测试门禁（`pnpm test` / `pnpm lint`）。加了就是 45 分钟之外再排一段，
  而且得先解决 runner 是 host 模式、镜像里没有 node 这件事（要么给 runner 加一个
  `node:22:docker://…` 的 label 走容器模式，要么把 node 也拷进 `/opt/ci-tools`）。
- ~~构建 45 分钟太久：是给 buildah 加缓存，还是干脆只构一种架构~~ —— 已改成只构 arm64、在 arm64 节点上原生跑，产物只构建一次（§4.2）。
  amd64 节点要用时把 `platforms` 加上 `linux/amd64`（靠 QEMU 跑 npm install / apk add，不重跑 pnpm build）并放开 nodeSelector。
- ~~需要多副本时的演进路线~~ —— 已落地，见 [REQ-CLUSTER](14-clustering.md)：
  `@hocuspocus/extension-redis` + 一层共享状态抽象，由 `CLUSTER_MODE` 切换。
  Redis 本身怎么部署（集群里现成的还是自己起一套）还没定。
- k8s 清单现在是两份（SQLite 单副本 / PG 多副本），靠 apply 哪一份来选。要不要收成 kustomize
  的 base + overlay，等第三种形态出现时再说。
- 是否需要为静态资源单独配 CDN / 缓存策略。
