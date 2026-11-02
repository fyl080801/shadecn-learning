# REQ-MODULES 服务端模块化：底座 + 可开关能力，按角色独立部署

> 状态：**已实现**（第 1～10 期，见 §7）。按角色拆分的 k8s 清单在 `k8s/variants/roles/`，尚未切到线上（要先备好 Redis + PostgreSQL）。
>
> 前置：[REQ-SERVER](03-server-runtime.md)（单进程单端口 —— 本篇把它收窄为"**每个角色**单进程单端口"）、
> [REQ-CLUSTER](14-clustering.md)（共享层，跨角色通信全靠它）、[REQ-COLLAB](04-realtime-collab.md)、
> [REQ-AGENT](20-agent-canvas.md) §3.10.10（agent 多副本）、[REQ-DEPLOY](12-deployment.md)。

## 1. 目标

1. **`apps/server` 只是底座**：HTTP、鉴权与会话、数据库、共享层、日志、模块内核。多人协作、对象存储、agent 执行这些能力
   各自是一个独立的包，由配置开关。
2. **一份代码、一个镜像、多个角色**：同一个产物按 `SERVER_ROLES` 启动成不同的进程 —— `web`、`collab`、`agent`。
   协同按连接数独立扩容，web/API 一两个副本即可。什么都不配 = 全部角色一个进程，和现在一样。
3. **配置管理一处收口**：每个模块声明并校验自己那段配置，底座只认底座的；开关、角色、模块配置在同一份文件里。
4. **生产产物里没有 Vite 中间件**：不是"运行时不加载"，是"打包时不存在"。
5. 启停顺序由内核按模块依赖决定，不再手写在入口文件里。

## 2. 背景

### 2.1 多副本的地基已经有了

[REQ-CLUSTER](14-clustering.md) 的五个共享抽象（`SharedMap` / `SharedCounter` / `SharedLock` / `SharedLog` / `SharedChannel`）
有内存和 Redis 两套实现；协同层走 `@hocuspocus/extension-redis`，不需要 sticky session；agent 的任务登记、会话槽位、
补发日志、停止指令、节点占用都已经在共享层上（[REQ-AGENT §3.10.10](20-agent-canvas.md)）。
所以"拆成多个服务"要加的不是一套新的通信机制，而是把**进程内直接调用**的那几处改成走共享层。

### 2.2 阻碍拆分的耦合

| 耦合 | 位置 | 拆开后的处理 |
|---|---|---|
| agent 经 `collabInstance()` 的 direct connection 直接写**本进程**内存里的 Y.Doc | `packages/mod-agent/src/canvas-access.ts`、`runs-broadcast.ts` | agent 角色自带一个不监听 WebSocket 的 Hocuspocus（§3.4.2） |
| web 路由直接调 `revokeCollabAccess` / `flushRoomToDatabase` / `applyFlowUpdate` | `routes/flows.ts`、`routes/projects.ts` | 广播 / 请求-应答 / 共享库（§3.7） |
| agent 的 HTTP 入口挂在 `/api/flows/:id/agent` 下，和发起它的进程是同一个 | `routes/flows.ts`、`routes/agent.ts` | 派发：web 判权后派给一个 agent 副本执行（§3.6） |
| 启停顺序手写在 `index.ts` | `apps/server/index.ts` | 内核按依赖拓扑序 setup / 逆序 shutdown（§3.1.3） |
| 所有能力的环境变量混在一个 739 行的 `config.ts` 里 | `apps/server/config.ts` | 按模块切分（§3.3） |
| `frontend/dev.ts` 虽是动态 `import()`，esbuild 仍把它打成 chunk 放进产物 | `frontend/index.ts`、`scripts/build-server.mjs` | 独立的 dev 入口 + 构建断言（§3.8） |

### 2.3 为什么不换框架

评估过 Egg 4 / tegg、Midway v4、NestJS 11（含 microservices）、Fastify 5、Moleculer、Nitro v3 / h3 v2、Platformatic Watt，结论是**保留 Hono，自研一层很薄的模块内核**：

- 要跨服务同步的是 Yjs 文档和共享状态，Hocuspocus + Redis 共享层已经覆盖；再引入一套 broker / RPC 就是两套总线并存。
- Egg / Midway / Nest 的构造器注入依赖 `emitDecoratorMetadata`，`tsx` 和 esbuild 都不支持；本项目开着 `erasableSyntaxOnly`，
  参数属性写法也被禁止。要用它们就得把 dev 和 build 都换掉，顺带重写 `build-server.mjs` 的产物分析和沙箱镜像上下文。
- Egg / Midway / Fastify 都意味着重写全部路由；Nitro v3 还在 beta 且自带构建；Watt 是"合进一个进程多线程"，和独立扩容的目标相反。
- 真正的工作量在拆耦合（§2.2），不在框架。

## 3. 功能需求

### 3.1 底座与模块

**底座只提供平台，业务能力全是模块（登录也是）**；模块按一套集成协议自己接进来 —— 声明自己的配置段、表、入口，在 `setup` 里挂自己的路由和 WebSocket、注册服务。
底座是一个包（`@shadecn/server-core`），**不认识任何模块**；`apps/server` 只是"组装成一个产物"：两个入口 + 一份模块清单（`apps/server/modules.ts`）。
加一个能力 = 清单里加一行。

#### 3.1.1 底座（core）

底座（`@shadecn/server-core`）不是模块，每个角色都带：

- **HTTP 管线**（Hono + `@hono/node-server`）：请求日志与请求上下文、CORS、**角色闸门**、会话解析、**登录闸门**、页面守卫、`notFound` / `onError`、
  WebSocket 的 `upgrade` 分发；前端托管（生产静态资源 / 开发 Vite 中间件，挂在所有接口之后，只在 `web` 角色）；
- **数据库**（MikroORM 单例按"`User` + 清单里每个模块的 `entities`"建、`db:push`）、**配置**（§3.3）、**日志**、**共享层与总线**、**权限撤销信号**；
- 平台契约的实现（`runtime` / `origins` / `log`），模块的装配（`prepare` / `assemble`）与启动（`boot`）；
- `/api/health`、`/api/features`。

管线上的会话解析、登录闸门、页面守卫是**平台的 `auth`**，底座只留了位置：谁 `provides: ['auth']` 就转给谁（`@shadecn/mod-auth`：登录流程、会话、身份绑定、
头像、登录页的两条路由、本地开发用户）；清单里没有登录模块时登录未启用、闸门放行。`User` 表是平台的（`@shadecn/server-kit/identity`，所有模块的公共外键目标）。

项目 / 画布 / 成员也**不是底座**：它是 `canvas` 模块（硬依赖 auth），storage / collab / agent 都硬依赖它（§3.1.4）。

#### 3.1.2 集成协议：模块声明

每个能力包**默认导出一份声明**（`defineModule`，`@shadecn/server-kit/kernel`）：

| 字段 | 含义 |
|---|---|
| `name` | 唯一名：配置里的 `modules.<name>`、`/api/features` 的键 |
| `roles` | 随哪些角色加载。不在当前角色里的模块**不加载** |
| `dependsOn` | 硬依赖：没加载 → 启动失败并说明缺谁、为什么缺。可以按角色生效：`{ module: 'collab', roles: ['agent'] }` = 只在本进程扮演 agent 时才要 |
| `optional` | 软依赖：`ctx.service('x')` 可能是 `undefined`，模块自己退化 |
| `provides` | 注册给别的模块的服务名 |
| `config` | 本模块的配置段：`schema`（文件里的键，环境变量名由路径推导）+ `parse(read, runtime)`（默认值与校验，一处解析）。内核把它挂到 `modules.<name>` 下并自动加 `enabled`（§3.3） |
| `entities` | 本模块的表。**不论开关、角色都注册**：关掉模块不能让它的表"消失"，否则 `db:push` 判成有损变更拒绝启动（[REQ-DEPLOY §3.6](12-deployment.md)） |
| `routes` | 本模块的入口：路径、归哪个角色、`access: 'user' \| 'public'`、`kind: 'http' \| 'upgrade'`。**路由归属表、登录闸门的放行名单、前置分流都从这里推出**（§3.9） |
| `enabled(config)` | 按自己的配置判开不开（storage 看 S3 配齐没有）；配置里的 `enabled: false` 先于它 |
| `setup(ctx)` | 装配：挂路由（`ctx.http`）、注册服务、起定时器。返回 `ready` / `shutdown` 句柄 |

`ctx` 是底座交给模块的全部东西：

| | |
|---|---|
| `ctx.config` | 本模块解析好的配置段 |
| `ctx.http.route(path, app)` / `use` / `upgrade(path, handler)` | **只能挂本模块声明过的入口**（没声明 → 装配失败）；声明的角色不在本进程时挂载是空操作 —— 所以模块代码不按角色分支，web 上的 agent 只挂面板、agent 副本上只挂网关，是声明决定的 |
| `ctx.platform.auth` | 由登录模块提供：`userId(c)`（未启用登录时给本地开发用户）、`identify(cookieHeader)`（WebSocket 握手、定期复验）、`deriveSecret(purpose)`（从会话密钥派生用途专属的密钥），以及底座管线调的 `session` / `requireUser` / `pageGuard` |
| `ctx.platform.origins` | 对外域名：`primary`、`isAllowed(origin)`、`of(c)`（这次请求认哪个对外地址） |
| `ctx.platform.runtime` | 实例身份、监听地址、应用根 / 数据目录、产物与否、Redis；`envVar(name)` 只给名字由别处约定的密钥和 `POD_IP` |
| `ctx.platform.log` | 带字段的结构化日志（普通一行话照旧 `console.*('[前缀] …')`） |
| `ctx.service` / `ctx.provide` | 模块之间的服务 |

数据库经 `@shadecn/server-kit/db` 的 `db()` 拿（ORM 由底座按"底座的表 + 清单里每个模块的 `entities`"建好交进来），写实体用的列与跨库查询片段也在那里。

#### 3.1.3 生命周期

1. import 时读底座的配置段；入口把模块清单交给 `prepare(modules)`：整份配置按完整的 schema 再校验一遍、解析各模块的段（`parse` 抛错 = 配置错，
   比如生产缺登录配置）、建 ORM、建路由归属表 —— 任何一步失败进程都不监听端口；
2. 校验副本模式和角色集、起共享层与总线；
3. 按角色、开关（配置的 `enabled` → 模块的 `enabled(config)`）选出模块，校验依赖（缺硬依赖、循环依赖都在这一步失败），按拓扑序 `setup`；
4. 挂前端（web 角色）、挂 `upgrade` 分发、全部 `ready`，再 `listen`，输出启动摘要（配置文件、角色、已加载 / 未加载的模块及原因）；
5. 退出：逆序 `shutdown`，每一步带上限（超时记一笔、不阻断后面的步骤；整体落在 k8s 的 60 秒宽限期内）。
   "先叫停 agent → 再落库 collab → 关共享层 → 断库"这个顺序由 agent 依赖 collab 自然得出，不手写。

测试的 setup 走同一个装配（`prepare` + `assemble`，不 listen），所以测的是生产那套路由和接线。

#### 3.1.4 包结构

| 包 | 内容 | 谁能 import 它 |
|---|---|---|
| `@shadecn/server-kit` | 集成协议与内核（`./kernel`：声明、入口与归属表、配置段、选模块与排序、生命周期）、平台契约（`./platform`）、数据库（`./db`）、`User`（`./identity`）、配置层（`./config`）、共享层（`./cluster`）、总线（`./bus`）、撤权信号（`./access`） | 所有服务端包 |
| `@shadecn/server-core` | 底座：HTTP 管线、配置（`./config`、`./config-source`）、数据库（`./db`、`./db-sync`、`./schema-sync`）、日志、前端托管（`./frontend/static`；`./frontend/dev` 只给开发入口）、平台契约的实现（`./platform`）、装配（`./server`）、路由归属表（`./routes-table`）、启动（`./boot`）。**不 import 任何模块包** | `apps/server` |
| `@shadecn/mod-auth` | 登录：Keycloak / GitHub、会话、身份绑定、默认头像、页面守卫与登录页的两条路由、本地开发用户、`modules.auth` 配置段；向平台提供 `auth` | — |
| `@shadecn/mod-notes` | 笔记示例（内存里的 `/api/notes`）：最小的模块 | — |
| `@shadecn/mod-canvas` | 项目 / 成员 / 邀请 / 画布元数据的表、store、REST（`/api/projects`、`/api/invites`、`/api/flows`）、成员判定；`canvas` 服务（`flowGuard`、`locate`、`roleOf`、画布内容的存取 `docs`）；契约 `./contract`（服务接口 + "复制前落库"的总线请求 `flushFlowContent`）、`./entities` | 契约与实体：其它模块包 |
| `@shadecn/mod-storage` | S3 客户端、对象键、缩略图、上传接口、上传记录表；`storage` 服务（`./contract`） | 契约、`./client`、`./keys`：其它模块包 |
| `@shadecn/mod-collab` | 协同（Hocuspocus、落库、配额、撤权复验、headless）、握手鉴权、协同日志扩展、`/doc` 与监控接口；给 agent 的活房间入口（`./canvas-host`） | `canvas-host`：mod-agent |
| `@shadecn/mod-agent` | agent 的宿主侧（配置段、会话 / 运行日志 / Grant 的表与 store、运行登记、沙箱驱动、派发、面板与网关接口）；编排引擎仍是 `@shadecn/agent` | — |
| `apps/server` | 组装成一个产物：入口 `index.ts`（静态前端）/ `dev.ts`（Vite）、`db-sync.ts`（表结构同步）、模块清单 `modules.ts`；构建脚本、`dev:cluster`、集成测试；运行时依赖表（`dependencies`） | — |

规则：

- **模块包永远不 import `apps/server` 和 `@shadecn/server-core`**，也不读 `process.env`；底座的东西只经 `@shadecn/server-kit` 和 `ctx` 拿。
  底座也不 import 任何模块包 —— 两边只在 `apps/server` 的入口里相遇。
- **模块之间只经对方的契约入口、实体入口、`ctx.service()`、总线说话**，不 import 对方的实现文件。依赖方向是 storage / collab / agent → canvas，canvas 不认识任何一个：
  "复制画布前把活房间落库"是画布发出的总线请求，协同登记处理。
- 包都是 source-only TS，由 esbuild 内联进产物；包自己的第三方依赖写成 `peerDependencies`，运行时那份仍声明在 `apps/server` 的 `dependencies`（构建脚本据此核对）。
- 新增一个包：模块清单加一行；根 `Dockerfile` 补一行 `COPY packages/<name>/package.json`，根 `vitest.config.ts` 的 `projects` 补一项。

### 3.2 角色

| 角色 | 加载的模块 | 对外 | 副本 |
|---|---|---|---|
| `web` | core（含前端托管）+ `canvas` + `storage` + `agent`（面板接口：只读与派发，§3.6） | `/`、`/api/*` | 1～2 |
| `collab` | core + `canvas`（判权、内容存取，不挂 REST）+ `collab` | `/ws/collaboration`、`/api/collab/*`、`/api/flows/:id/doc` | N，按连接数扩容 |
| `agent` | core + `canvas` + `storage` + `collab`（headless，§3.4.2）+ `agent`（执行、网关） | `/api/agent-gateway/*`（只给本副本起的沙箱回连，不经 ingress） | M |

一个模块在不同角色里挂哪些入口，由它的 `routes` 声明的角色决定（§3.1.2），模块代码里不按角色分支。

- `SERVER_ROLES=web,collab,agent`，逗号分隔，不区分顺序。**不配 = 全部角色**，即今天的单进程形态；`pnpm dev` 就是这样跑。
- `dev` 不是角色，是入口（§3.8）：全部角色 + Vite 中间件。
- 角色之间只经共享层和数据库说话，**不互相发 HTTP**。

### 3.3 配置管理

- **一份配置文件**：数据目录（`DATA_DIR`，默认 `<应用根目录>/data`）里的 `server.config.yaml`（也认 `.yml` / `.json`），
  示例 `server.config.example.yaml` 进仓库，真正的文件和 `.env` 一样不进仓库、不进镜像。
  `.env` 不跟着数据目录走，仍在应用根目录（源码运行是仓库根，产物 / 容器里是进程 cwd）。
  ```yaml
  server:   { port, host, roles, instanceId, staticDir, origin, origins }
  database: { provider, url }
  cluster:  { mode, redisUrl, redisKeyPrefix }
  log:      { level, format, dir, http, slowMs, slowQueryMs }
  modules:
    auth:    { enabled, sessionSecret, sessionTtl, keycloak: {...}, github: {...} }
    canvas:  { enabled }
    collab:  { enabled }
    storage: { enabled, endpoint, internalEndpoint, region, bucket, accessKeyId, secretAccessKey, maxUploadMb, keyPrefix }
    agent:   { enabled, provider, model, …, sandbox: { driver, …, oci: {...}, k8s: {...} } }
    notes:   { enabled }
  ```
- **分层**：基础文件之上叠 `server.config.<NODE_ENV>.*`（`production` / `development`，没设 `NODE_ENV` 按 development）；对象逐键合并，数组和标量整个替换。
  同一层同时有两种扩展名 = 启动失败。`SERVER_CONFIG=a.yaml,b.yaml` 显式指定文件（按顺序叠，相对路径按数据目录；k8s 上指到挂进来的 ConfigMap，
  例如一份公共的 + 一份按角色的），给了就不再自动找；指定的文件不存在 = 启动失败；`SERVER_CONFIG=`（空串）= 不用配置文件。
- **环境变量是同一份结构的另一种写法，且优先于文件**：配置文件的结构是唯一的定义，变量名由路径按规则推导，**没有例外、没有另一张表** ——
  路径每一级转大写、camelCase 拆词（带数字的词不拆，`k8s` → `K8S`）、用下划线连接：
  `server.port` → `SERVER_PORT`，`cluster.redisUrl` → `CLUSTER_REDIS_URL`，`log.slowMs` → `LOG_SLOW_MS`，
  `modules.agent.sandbox.k8s.apiUrl` → `MODULES_AGENT_SANDBOX_K8S_API_URL`，`modules.storage.maxUploadMb` → `MODULES_STORAGE_MAX_UPLOAD_MB`。
  给 schema 加一项，文件和环境变量就同时能配。两个路径推导出同一个名字（`a.bC` 和 `a.b.c`）或撞上下面「不放进文件的」引导变量 = 启动失败。
  `.env` 和真实环境变量都算；设了就以它为准，空串也算设了。按角色区分的值（`SERVER_ROLES`、`SERVER_INSTANCE_ID`）可由 Deployment 的 env 覆盖同一份文件。
  **不认识的环境变量不报错**（环境里本来就有各种别的变量）：写错或没改名的变量名只是不生效，排查时对照这条规则看。
- **每个模块声明并解析自己那段**：底座的段由底座声明（`@shadecn/server-core` 的 `config-source.ts`）、解析（`config.ts`）；能力的段是模块声明里的 `config`
  （`schema` + `parse`），内核按模块清单挂到 `modules.<模块名>` 下。文件里出现没声明的键、或类型不对（数字写成字符串、布尔写成 `no`）→ 启动失败，
  错误一次列出全部问题，每条带完整路径和推导出的环境变量名。默认值与语义解析各在一处（底座的在 `config.ts`，模块的在它的 `parse`），从文件来、从环境变量来走同一条解析。
- **开关**：每个模块的段都自动带 `enabled`（同样按规则推导：`MODULES_CANVAS_ENABLED` / `MODULES_COLLAB_ENABLED` / `MODULES_STORAGE_ENABLED` / `MODULES_AGENT_ENABLED`），
  `false` / `0` 关掉模块，启动日志和 `/api/features` 写明「配置关闭」。`true` / 不写 = 由模块自己定（storage 看 S3 配置齐不齐）——
  **开关只能关，不能把缺配置的模块硬打开**。关掉被硬依赖的模块 → 启动失败（关 canvas 永远失败；agent 开着时在 agent 角色上关 collab 失败）。
  关掉的模块**整个不加载**：它的入口不存在（不归本进程的路由仍回 404 说明归谁），web 的面板按 `/api/features` 隐藏。
- 不放进文件的：`NODE_ENV`（它决定叠哪层文件）、`DATA_DIR`（它决定到哪找文件）、`SERVER_CONFIG` 本身、按模型提供方退回的 key（`ANTHROPIC_API_KEY` 这类各家 SDK 的约定变量；文件里要写 key 就写 `modules.agent.apiKey`）、
  k8s 注入的 `POD_IP`。密钥可以写进文件，但生产上应当走环境变量 / Secret（配置文件常被整份放进 ConfigMap）。
- 启动日志第一屏打出读到了哪些配置文件。
- `GET /api/features` 回 `{ canvas, collab, storage, agent }` 布尔表，前端据此隐藏关掉的入口（agent 面板、上传按钮）。
  **这是"显示什么"，不是权限**：关掉的模块的接口本来就不存在；开着的模块里暂时不可用的（agent 没配模型）回 503 并说明原因；不归本进程角色的路由回 404（§3.9）。
- `db:push` 仍经 `apps/server/env.ts` + 配置层拿数据库连接（所以也认配置文件），不自己读文件（[REQ-DEPLOY §3.6](12-deployment.md)）。

### 3.4 collab 模块

#### 3.4.1 对外形态

和 [REQ-COLLAB](04-realtime-collab.md) 一致：`/ws/collaboration`、persistence（读 → 合并 → CAS）、quota、awareness、one-window-per-user、撤权。
多副本按 [REQ-CLUSTER](14-clustering.md)。`GET /api/collab/health` 随 collab 角色走。

直接碰 Y.Doc 的接口（REST 读写 `/doc`、`?sv=` 增量、个人画布的推送）**归 collab 模块**，由它声明、挂在 `canvas.flowGuard` 之后，归 collab 角色；
`flows` 的元数据部分在 canvas 模块。ingress 按路径把这几条路由给 collab（§3.9）。

协同不认识会话和成员表：握手鉴权经平台认人（`ctx.platform.auth.identify`）、经 `canvas` 服务判成员；画布内容的读写是 `canvas.docs`（读 → 合并 → CAS 仍在协同里）。

#### 3.4.2 headless 模式

collab 模块随 `collab` 和 `agent` 两个角色加载，但它的 WebSocket 入口声明的角色是 `collab` —— 只有 agent 角色的进程里内核不让它认领，
于是它挂 persistence 和 redis 扩展、**不接 WebSocket upgrade**。agent 角色用它：agent 经 direct connection 打开的房间，改动经 redis 扩展广播到各 collab 副本，落库仍走同一条 CAS 路径 ——
agent 进程等于一个不对外的 collab 副本。`canvas-access.ts` 里写下的全部语义（每次读写判权、`quotaLocked`、一轮一条连接、不偷偷重开）不变。

成立的前提，拆分前要逐条验证（§4）：

- `quotaLocked` 的裁决在共享层，agent 副本量到的是全局字节数；
- 同一更新在每个副本触发一次 `onChange`，副作用已按 `source === 'redis'` 跳过（[REQ-CLUSTER](14-clustering.md)）；
- 房间在 agent 副本上在线而所有 collab 副本上都没人时，落库由 agent 副本在 `close()` 时完成（现在就是这样）。

**单副本（`CLUSTER_MODE=single`）下 agent 角色和 collab 角色不能分开部署**：没有 Redis，两个进程各持一份 Y.Doc 就回到 [REQ-CLUSTER §2](14-clustering.md) 的丢数据场景。
内核在启动时拒绝"`single` + 角色集不含全部角色"。

### 3.5 storage 包

**是库不是角色**：S3 本身是外部服务，不值得再包一层。`@shadecn/mod-storage` 导出 `assetStorage` / key 规则 / 缩略图生成，
在 web（`/api/assets`、[REQ-ASSET-THUMB](27-asset-thumbnails.md)）和 agent（媒体读取）两处按配置启用。
上传接口与上传记录表都在模块里，agent 经 `storage` 服务查上传记录、经 `./client` 读字节。没配齐 S3 或配置关掉 → 模块不加载：上传接口不存在、
agent 没有附件和 `view_media`。缩略图的 sharp 仍同步在上传路径上生成，成瓶颈再拆（§5）。

### 3.6 agent 模块：web 派发、agent 副本执行

web 角色不跑 agent。agent 模块随 `web` 和 `agent` 两个角色加载：面板接口声明归 web，网关声明归 agent；只在执行角色上硬依赖 collab、起派发 / 对账 / 清孤儿沙箱。`POST /api/flows/:flowId/agent/messages` 在 web 上做完判权、`validatePrompt`、附件归属、续聊会话存在性，
然后把发起请求**派给一个** agent 副本（`@shadecn/mod-agent/dispatch`）：

```
浏览器 ──POST /messages──▶ web：判权、校验 ──bus.dispatch(agent.start-run)──▶ 某个 agent 副本：runtime.start()
   ▲                                                                              │ 回「开始了 / busy / disabled / unavailable」
   │                                                                              │ 发给发起者的每一帧 → 攒批 → 追加进
   └──── SSE ◀── web 从头读 SharedLog agent-dispatch:<派发 id>（带连续 seq，末尾结束标记）◀──┘
```

- **派发**：`bus.dispatch` 在登记了 `agent.start-run` 的实例里挑一个（本进程登记了就交给本进程），只发一次、不自动换实例重试 ——
  超时不代表没做，重发可能让同一件事做两遍。没有任何 agent 副本 → 立刻 503「没有正在运行的 agent 实例」；超时 → 503「没有响应」。
- **执行侧做 `start()`**：会话槽位（`busy` → web 回 409）、模型、沙箱、Grant 全在执行的这一侧。Grant 由执行的副本签，
  「发起人此刻能进这张画布」在执行那一刻判（docs/22 §5）。
- **事件回传不复用编排层的补发日志**：那条要等这一轮进了任务列表才有登记，发起后立刻订阅会 404，很短的一轮结束得比订阅还早也会 404。
  派发日志从第一帧起就在，和编排层内部的时机无关。读到断号（被截断 / 过期）就停止转发，浏览器照常走「流断了 → `GET …/runs/:runId/events` 接回」。
- **浏览器断开** = web 不读了，这一轮照常跑完（和改造前「发起者退订」一样），派发日志靠 TTL 自己消失。
- **只读接口留在 web**：视图、会话列表 / 详情 / 删除、`GET …/runs/:runId/events`（接回走编排层的共享补发日志，本来就跨副本）、中止
  （停止指令经共享层转给持有副本，本来就跨副本）。web 进程里的 runtime 只用来读，它从不 `start()`。
- **网关**：`/api/agent-gateway/*` 只对 agent 角色有意义，鉴权仍是 run 令牌、不认会话（[REQ-AGENT-SANDBOX](22-agent-sandbox.md)）。
  沙箱回连的 `MODULES_AGENT_GATEWAY_URL` 按副本算（k8s 驱动用 `POD_IP`），不经 ingress。
- **单进程（全部角色）也走这一条**：派发交给本进程的处理函数，事件经内存实现的派发日志回来。没有「本地就直接 start」的快路径。
- **已知限制**：视图里的 `enabled` / 模型名由 web 进程按自己的配置算 —— web 和 agent 两种 Deployment 要用同一份 agent 配置
  （同一份配置文件 / Secret），否则面板显示和实际能不能跑会对不上。配置里关掉 agent（§3.3）是一致的：每个进程都不加载它。

### 3.7 跨角色通信

只有两种模式，都建在共享层上，不引入新组件：

| 模式 | 用什么 | 用在哪 |
|---|---|---|
| **权限撤销信号**（底座发、能力订阅） | `@shadecn/server-kit/access`：共享层里的世代号 + 本实例的订阅者 | 移除成员 / 删项目 / 删画布 → 路由 `await revokeAccess()`；协同订阅「复验并断掉失权连接」，agent 订阅「按当前权限对账」；别的实例由协同的巡检（3s）转成本实例的通知 |
| **请求-应答**（要等结果，scatter-gather） | `@shadecn/server-kit/bus`：令牌 + 提供方登记表 + 每实例一个收件频道 | 复制画布前让**所有**持有活内容的实例落库（`@shadecn/mod-canvas/contract` 的 `flushFlowContent()`，协同登记处理） |

- **scatter-gather**：请求发给所有登记了该令牌的实例（登记表在共享层，TTL 30s、按 1/3 续期），等它们**全部**回话或超时；回来的进 `replies`，抛错的进 `failures`，没回的进 `missing`。没有任何提供方时立刻返回空结果，不白等一个超时。本实例的处理函数直接调，单进程时整个请求不碰共享层。
- 这比改造前好一点：以前 `flushRoomToDatabase` 只落本进程的房间，多副本下房间开在别的副本上就读到旧内容；现在每个协同副本都落。
- 请求-应答必须有退路：`flushFlowContent()` **从不抛错**，超时 / 失败 / 没有协同实例都只记一笔，按库里现有内容继续。`SharedChannel` 本就不保证送达（[REQ-CLUSTER](14-clustering.md)），不能把正确性押在它上。
- 撤权**不**走总线：它已经有「世代号 + 巡检」这条跨实例的路，总线只是更快，不是更对；路由要的「204 = 本实例上的人已经被踢」由 `revokeAccess()` 等本实例订阅者做完来保证，跨实例仍是最迟一个巡检周期。
- 模块之间**不直接 import 对方的内部文件**，只经契约 / 实体入口、`ctx.service()`、总线、撤权信号。
- ~~纯函数搬家：`applyFlowUpdate` / `readFlowUpdate` 移到共享包~~ —— 改为随协同模块走：它们是个人画布 / 离线补推的 REST 写入路径，属于「直接碰 Y.Doc 的接口」，和 `/doc` 路由一起在 `@shadecn/mod-collab`，由 ingress 按路径分给协同角色（§3.4.1）。

### 3.8 前端 dev 中间件只存在于开发入口

- `apps/server/dev.ts` 是 `tsx watch` 的入口：和 `index.ts` 同一份模块清单，只是前端托管换成 Vite 中间件（HMR 仍走同一端口）。前端托管是底座的事，不是模块。
- 生产入口 `apps/server/index.ts` **没有任何指向 `frontend/dev.ts` 的 import**，静态还是动态都没有；esbuild 据此不会把它带进产物。
- `scripts/build-server.mjs` 加断言：metafile 里出现 `frontend/dev` 或 `vite` 即构建失败。`output/package.json` 的依赖表里也不再需要 `DEV_ONLY` 过滤 `vite`。
- 静态前端只随 `web` 角色挂；登录守卫（`frontend/guard.ts`）读会话，所以静态文件仍由 Node 托管，不改成 nginx / CDN（§5）。

### 3.9 构建与部署

- **仍然一个产物、一个镜像**。`pnpm build` 不变；角色只是启动时的环境变量。这保住了"一个产物两种数据库"、沙箱镜像上下文等现有约束。
- `pnpm dev:cluster` 按角色起进程：`DEV_CLUSTER_ROLES="web:3001,collab:3002,collab:3003,agent:3004"`，前面再起一个**前置代理**听 `SERVER_PORT`（默认 3000），按路径分流（HTTP 和 WebSocket，同一角色轮流分），作用等同于生产的 ingress；子进程的 `SERVER_ORIGIN` 都是代理地址。没配它就用 `DEV_CLUSTER_PORTS`（每个端口一个全角色进程，没有代理）。
- **路由归属是一张表，由入口声明推出**（`@shadecn/server-core/routes-table` 按模块清单建：底座的入口 + 清单里每个模块的 `routes`，不论本进程加载与否）：
  服务端的角色闸门（不归本进程的路由 404 并说明归谁）、登录闸门的放行名单（`access: 'public'`）、`dev:cluster` 的前置代理（经 tsx 直接 import）都读它；
  生产的 `k8s/variants/roles/ingress.yaml` 由测试按 ingress-nginx 的匹配方式（`use-regex`）逐条对着声明核对 —— 模块新声明了不归 web 的入口而清单没补，测试就红。
  一条路径同时被两处声明 → 启动失败。
- k8s：每个角色一个 Deployment + Service；`web` 可保留 `Recreate` 与 PVC（SQLite 单副本部署仍然允许，但那时只能全角色一个 Pod），`collab` 用 `RollingUpdate` + HPA（指标：连接数或 CPU），`agent` 按运行中的轮次数扩容。
  ingress 按路径分流：`/ws/collaboration` 与 collab 模块的那几条 REST → collab Service，其余 → web。agent Service 只在集群内。
  清单在 `k8s/variants/roles/`（docs/12 §3.7）。
- 健康检查：每个角色的 `/api/health` 只报自己加载的模块；`collab` 的 `/api/collab/health` 随模块走。

## 4. 验收标准

1. 什么都不配，`pnpm dev` / `pnpm start` 的行为和改造前逐项一致（现有全部测试通过）。
2. 生产产物里 grep 不到 `vite` 和 `frontend/dev`；构建断言在人为加回引用时会失败。
3. `SERVER_ROLES=web` 的进程不加载 Hocuspocus、sharp、pi-ai；`SERVER_ROLES=collab` 的进程不加载静态前端和 S3 客户端（用 `process.moduleLoadList` 或 esbuild chunk 命中断言）。
4. `SERVER_ROLES=agent` 而 collab 模块被配置关掉 → 启动失败，错误信息指出缺 `collab`；关掉 canvas → 启动失败；`CLUSTER_MODE=single` + 非全角色 → 启动失败。
5. `dev:cluster` 以 `web:1 + collab:2 + agent:1` 启动，用 Redis + PostgreSQL：
   - 两个浏览器分别连到两个 collab 副本编辑同一张画布，互相可见、落库一致；
   - 发起 agent，一轮由 agent 副本认领，改动在两个浏览器里实时可见，撤回按 `runId` 正确；
   - 执行中移除发起人的成员资格：collab 侧断连、agent 侧一轮被叫停（现有行为，跨进程仍成立）；
   - web 复制画布时（`flushFlowContent`）能等到 collab 的回执；杀掉全部 collab 副本后调用在超时内退回读库。
6. 没有 agent 副本时 `POST /messages` 回 503；派发给的副本超时回 503；派给另一个实例执行时整条事件流经派发日志回到 web 的 SSE。
7. 关掉 storage：`/api/features.storage === false`，上传接口不存在，前端不显示上传入口；agent 没有附件和 `view_media`。
8. 配置文件里写错的键、类型不对的值 → 启动失败，错误列出每一处的完整路径（如 `modules.agent.modle`）和对应的环境变量；
   同一项文件和环境变量都配了，以环境变量为准；YAML 和 JSON 两种格式等价。

## 5. 本期不做

- 静态前端改由 nginx / CDN 托管（登录守卫要先挪到 ingress 的 auth 上）。
- 缩略图生成拆成独立 worker。
- agent 入口的 ingress 路由模式（评估时的方案 B）—— 已选队列，不留第二条路。
- 按角色裁剪产物（每角色一个更小的镜像）：先保"一个产物"，有需要再在 `build-server.mjs` 里按 `roles` 做 tree-shaking。
- 角色之间的 HTTP 调用、服务发现、RPC 框架。

## 6. 待确认事项

1. ~~collab 模块那几条 REST 走 ingress 分流还是 web 转发~~ —— **已定：ingress 路径分流**（§3.9）。
2. ~~`agent-workers` 心跳与"没有 worker 就 503"~~ —— **已定**：没有单独的心跳表。发起改成总线派发（§3.6），「有没有 agent 副本」看总线的提供方登记表（TTL 30s、按 1/3 续期）；一个没有就当场 503。Redis 抖动时登记续不上会误判成 503，浏览器重试即可；不做「只警告、照样入队」—— 没有队列，派不出去就是没人执行。
3. HPA 用什么指标：连接数要先把 `collabStats()` 暴露成 Prometheus 指标，CPU 现成但滞后。

## 7. 分期

| 期 | 内容 | 可独立合入 | 立刻拿到的收益 |
|---|---|---|---|
| 1 | **已做**：内核（`apps/server/kernel/`）+ 角色解析（`SERVER_ROLES`，非全角色暂拒绝）+ 模块收口生命周期（`apps/server/modules/`，路由仍静态挂、配置仍在 `config.ts`）；dev 入口 `apps/server/dev.ts` + 构建断言；`GET /api/features` | ✓ | 生产产物无 Vite |
| 2 | **已做**：`@shadecn/server-kit`（内核、共享层、总线、撤权信号从 `apps/server` 搬入）；`@shadecn/mod-storage`（整个 storage 搬入，宿主只交配置）；`@shadecn/mod-collab` 契约入口；撤权改走 `revokeAccess()`、复制画布前的落库改走 `flushRoom()`（scatter-gather）。（当时 `/doc` 读写仍在宿主直接 import 协同实现，第 7 期随路由一起进了协同包） | ✓ | 能力开始离开 `apps/server` |
| 3 | **已做**：collab headless（只有 agent 角色的进程挂 Hocuspocus 不接 WebSocket）+ agent 只经 `@shadecn/mod-collab/canvas-host` 拿活房间 | ✓ | — |
| 4 | **已做**：collab 成包（`CollabPorts`、headless）、agent 成包（`AgentPorts`、惰性单例）、发起一轮改成 web 派发 / agent 执行（§3.6）。按角色启动见第 5 期，路由归包见第 7 期 | 每个包一次 | — |
| 5 | **已做**：路由按角色归属（`routes/ownership.ts` 的 `roleGate`），解除「非全角色拒绝启动」（单副本仍拒绝）；`dev:cluster` 按角色起进程 + 前置代理 | ✓ | 本地可按角色跑 |
| 6 | **已做**：`k8s/variants/roles/`（三个 Deployment、两个 Service、按路径分流的 ingress、collab 的 HPA），测试钉住角色 / 标签 / 探针和 ingress 与路由归属表一致。**没切到线上**：要先在集群里备好 Redis + PostgreSQL，再按 docs/12 §3.7 切换 | ✓ | 协同独立扩容 |
| 7 | **已做**：能力的 HTTP 接口搬进各自的包（`@shadecn/mod-collab/routes`、`@shadecn/mod-storage/routes`、`@shadecn/mod-agent/routes`），请求者身份经 `@shadecn/server-kit/http` 的 `FlowRequestPort` 从宿主拿；`apps/server/routes/` 只剩底座路由 | ✓ | 能力代码全部离开 `apps/server` |
| 8 | **已做**：配置文件（§3.3）：`@shadecn/server-kit/config`（找文件、YAML / JSON 解析、分层合并、按 schema 校验、和环境变量合层），各能力包的 `./config` 声明自己那段，宿主声明底座的段；`modules.<name>.enabled` 开关进内核的 `resolveModules` | ✓ | 一份文件配一个进程 |
| 9 | **已做**：**集成协议**（§3.1）：模块默认导出声明（配置段、表、入口、角色、依赖），`setup` 里经 `ctx.http` 自己挂路由 / WebSocket；平台能力经 `@shadecn/server-kit/platform` 交给模块（宿主实现在 `apps/server/platform.ts`）；项目 / 画布成为 `@shadecn/mod-canvas`；各模块的表、store、配置解析、鉴权细节回到各自的包；路由归属表与登录放行名单从声明推出（删掉手写的 `routes/ownership.ts`、`scripts/dev-route.mjs`、`PUBLIC_API`）；宿主的 `modules/*.ts` 装配文件全部删除，只剩模块清单 `apps/server/modules.ts` | ✓ | 加一个能力只改清单一行 |
| 10 | **已做**：底座成包（`@shadecn/server-core`，不认识任何模块，清单由入口交给 `prepare`）；登录成为模块（`@shadecn/mod-auth`，向平台提供 `auth`，配置段移到 `modules.auth`）、笔记成为模块（`@shadecn/mod-notes`）；`apps/server` 只剩入口、模块清单、`db-sync` 入口、脚本与集成测试 | ✓ | 底座和业务彻底分开 |
