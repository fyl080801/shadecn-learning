# REQ-MODULES 服务端模块化：底座 + 可开关能力，按角色独立部署

> 状态：**已实现**（第 1～6 期，见 §7）。按角色拆分的 k8s 清单在 `k8s/variants/roles/`，尚未切到线上（要先备好 Redis + PostgreSQL）。
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
| agent 的 HTTP 入口挂在 `/api/flows/:id/agent` 下，和发起它的进程是同一个 | `routes/flows.ts`、`routes/agent.ts` | 队列：web 入队、agent 认领（§3.6） |
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

#### 3.1.1 底座（core）

底座不是模块，每个角色都带：

- HTTP（Hono + `@hono/node-server`）、请求日志与请求上下文、CORS、`withSession` / `requireAuth`、`/api/health`、`/api/auth`、`/api/avatars`；
- 数据库（MikroORM 单例、`db:push`）、日志（`logger/`）、鉴权与权限（会话、成员关系、**权限撤销信号**）；
- 运行时库 `@shadecn/server-kit`（见 §3.1.4）：模块内核、共享层、总线、权限撤销信号；
- `/api/features`。

#### 3.1.4 包结构：能力在 `packages/`，`apps/server` 只做底座和组装

能力不集中在 `apps/server` 一个包里。每个能力一个 `packages/mod-<name>`，底座的公共运行时一个 `packages/server-kit`：

| 包 | 内容 | 谁能 import 它 |
|---|---|---|
| `@shadecn/server-kit` | 模块内核（`./kernel`）、共享层（`./cluster`，内存 / Redis 两套实现）、总线（`./bus`）、权限撤销信号（`./access`） | 所有服务端包 |
| `@shadecn/mod-storage` | S3 客户端、对象键、缩略图、`createStorageModule()` | 底座、其它能力包 |
| `@shadecn/mod-collab` | 第 2 期只有对外契约（`./contract`：落库请求令牌 + `flushRoom()`）；实现第 4 期从 `packages/mod-collab/src/` 搬入 | 契约：所有服务端包；实现：只有宿主 |
| `@shadecn/mod-agent`（第 4 期） | agent 的宿主侧装配（编排引擎仍是 `@shadecn/agent`） | 只有宿主 |
| `apps/server` | 底座（HTTP、鉴权、数据库与实体、底座路由）+ 组装点（`modules/*.ts` 把配置交给各能力包的工厂、`index.ts` / `dev.ts`） | — |

规则：

- **能力包永远不 import `apps/server`**，也不读 `process.env`。底座的东西只经两条路拿：`@shadecn/server-kit`，和宿主构造模块时交进来的参数 / 端口（`createStorageModule({ s3 })`）。
- **能力包之间只 import 对方的契约入口**（`@shadecn/mod-collab/contract`），不 import 实现。契约入口只依赖 `@shadecn/server-kit`，所以没开协同的进程 import 它也不会把 Hocuspocus 拖进来。
- 包都是 source-only TS，由 esbuild 内联进产物（和 `@shadecn/shared` / `@shadecn/agent` 一样）；包自己的第三方依赖写成 `peerDependencies`，运行时那份仍声明在 `apps/server` 的 `dependencies`（构建脚本据此核对）。
- 新增一个包：根 `Dockerfile` 补一行 `COPY packages/<name>/package.json`，根 `vitest.config.ts` 的 `projects` 补一项。

**项目 / 画布的元数据 REST（`/api/projects`、`/api/invites`、`/api/flows` 的非 Y.Doc 部分）属于底座**，因为 collab 的 `onConnect`
和 agent 的判权都要查成员关系。

#### 3.1.2 模块定义

每个能力是 `packages/` 下的一个包（`@shadecn/mod-<name>`，源码直引，和 `@shadecn/shared` 一样的约束），导出一个模块定义：

| 字段 | 含义 |
|---|---|
| `name` | 唯一名，也是配置里的键 |
| `roles` | 随哪些角色启动。不在当前角色里的模块**不加载** |
| `dependsOn` | 硬依赖：当前角色里没加载 → 启动失败并说明缺谁 |
| `optional` | 软依赖：`ctx.service('x')` 可能是 `undefined`，模块自己退化 |
| `provides` | 暴露给别的模块的服务（如 collab 的 `canvasHost`） |
| `entities` | 本模块的 MikroORM 实体。**无论开关如何始终注册**：关掉模块不能让它的表"消失"，否则 `db:push` 会把它判成有损变更而拒绝启动（[REQ-DEPLOY §3.6](12-deployment.md)） |
| `config` | 本模块配置的 schema（Standard Schema，valibot 或 zod 任一），内核只把属于它的那段交给它 |
| `setup(ctx)` | 装配：挂路由、挂 upgrade、订阅事件、注册服务。返回 `ready` / `shutdown` |

`ctx` 给模块的东西：当前角色、Hono app、原始 node `server`（collab 要挂 `upgrade`）、校验过的本模块配置、事件总线（§3.7）、
已注册的服务、共享层、`db()`、`isDev`。模块**不读 `process.env`**（和 `@shadecn/agent` 一样），环境相关的决定在配置层做。

#### 3.1.3 生命周期

1. 读配置、定角色、选出模块；校验依赖（缺硬依赖、循环依赖都在这一步失败，进程不监听端口）。
2. 按拓扑序 `setup`；全部 setup 完才 `listen`。
3. 全部 `ready` 后输出启动摘要（角色、已加载模块、模式）。
4. 退出：逆序 `shutdown`，每一步带上限（沿用现在 `withDeadline` 的做法：超时记一笔、不阻断后面的步骤；整体仍落在 k8s 的 60 秒宽限期内）。
   现在 `index.ts` 里"先叫停 agent → 再落库 collab → 关前端 → 关共享层 → 断库"这个顺序由 agent `dependsOn: collab` 自然得出，不再手写。

### 3.2 角色

| 角色 | 加载的模块 | 对外 | 副本 |
|---|---|---|---|
| `web` | core + `frontend`（静态前端 + 登录守卫）+ `storage` + agent 的**只读接口与入队**（§3.6） | `/`、`/api/*` | 1～2 |
| `collab` | core + `collab` | `/ws/collaboration`（`/api/*` 只留健康检查与鉴权所需） | N，按连接数扩容 |
| `agent` | core + `agent` + `storage` + `collab`（headless，§3.4.2） | `/api/agent-gateway/*`（只给本副本起的沙箱回连，不经 ingress） | M |

- `SERVER_ROLES=web,collab,agent`，逗号分隔，不区分顺序。**不配 = 全部角色**，即今天的单进程形态；`pnpm dev` 就是这样跑。
- `dev` 不是角色，是入口（§3.8）：全部角色 + Vite 中间件。
- 角色之间只经共享层和数据库说话，**不互相发 HTTP**。

### 3.3 配置管理

- 仓库根一份 `server.config.ts`：`defineConfig({ roles, modules: { collab: {...}, storage: {...}, agent: {...} } })`。
  用 `c12` 加载：支持 `server.config.{production,development}.ts` 分层，环境变量覆盖（`SHADECN_MODULES_AGENT_ENABLED=false` 这一类），
  现有的 `.env` 变量在过渡期**继续有效**（映射到对应模块的配置项），一次只迁一个模块。
- 每个模块的 `enabled` 默认值由模块自己定（storage 看 S3 配置齐不齐，agent 看有没有模型 key，collab 默认开）。**第 1 期只有这一项**（`enabled()`）；配置文件、环境变量开关、各模块的 schema 随第 4 期成包一起做。
- 底座保留的只有：端口、host、`NODE_ENV`、数据库、共享层、日志、鉴权、origin。`agentConfig` / `s3Config` / 协同限额各归各模块。
- `GET /api/features` 回 `{ collab, storage, agent, ... }` 布尔表，前端据此隐藏关掉的入口（agent 面板、上传按钮）。
  **这是"显示什么"，不是权限**；关掉的模块的路由根本不存在（404）。
- `db:push` 仍经 `apps/server/env.ts` + 配置层拿数据库连接，不自己读文件（[REQ-DEPLOY §3.6](12-deployment.md)）。

### 3.4 collab 模块

#### 3.4.1 对外形态

和 [REQ-COLLAB](04-realtime-collab.md) 一致：`/ws/collaboration`、persistence（读 → 合并 → CAS）、quota、awareness、one-window-per-user、撤权。
多副本按 [REQ-CLUSTER](14-clustering.md)。`GET /api/collab/health` 随 collab 角色走。

`routes/flows.ts` 里直接碰 Y.Doc 的接口（REST 读写 `/doc`、`?sv=` 增量、个人画布的推送）**归 collab 模块**，由 collab 角色提供；
`flows` 的元数据部分留在底座。ingress 按路径把这几条路由给 collab（§3.9）。

#### 3.4.2 headless 模式

`collab` 模块带一个 `listen: false` 选项：挂 persistence 和 redis 扩展，**不接 WebSocket upgrade**，只把 `canvasHost` 服务注册出去。
agent 角色用它：agent 经 direct connection 打开的房间，改动经 redis 扩展广播到各 collab 副本，落库仍走同一条 CAS 路径 ——
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
`enabled: false` 时 web 的上传接口 404、agent 的 `view_media` 报"未启用"。缩略图的 sharp 仍同步在上传路径上生成，成瓶颈再拆（§5）。

### 3.6 agent 模块：web 派发、agent 副本执行

web 角色不跑 agent。`POST /api/flows/:flowId/agent/messages` 在 web 上做完判权、`validatePrompt`、附件归属、续聊会话存在性，
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
  沙箱回连的 `AGENT_GATEWAY_URL` 按副本算（k8s 驱动用 `POD_IP`），不经 ingress。
- **单进程（全部角色）也走这一条**：派发交给本进程的处理函数，事件经内存实现的派发日志回来。没有「本地就直接 start」的快路径。
- **已知限制**：视图里的 `enabled` / 模型名由 web 进程按自己的配置算 —— web 和 agent 两种 Deployment 要用同一份 agent 配置
  （同一个 ConfigMap / Secret），否则面板显示和实际能不能跑会对不上。

### 3.7 跨角色通信

只有两种模式，都建在共享层上，不引入新组件：

| 模式 | 用什么 | 用在哪 |
|---|---|---|
| **权限撤销信号**（底座发、能力订阅） | `@shadecn/server-kit/access`：共享层里的世代号 + 本实例的订阅者 | 移除成员 / 删项目 / 删画布 → 路由 `await revokeAccess()`；协同订阅「复验并断掉失权连接」，agent 订阅「按当前权限对账」；别的实例由协同的巡检（3s）转成本实例的通知 |
| **请求-应答**（要等结果，scatter-gather） | `@shadecn/server-kit/bus`：令牌 + 提供方登记表 + 每实例一个收件频道 | 复制画布前让**所有**协同实例落库（`@shadecn/mod-collab/contract` 的 `flushRoom()`） |

- **scatter-gather**：请求发给所有登记了该令牌的实例（登记表在共享层，TTL 30s、按 1/3 续期），等它们**全部**回话或超时；回来的进 `replies`，抛错的进 `failures`，没回的进 `missing`。没有任何提供方时立刻返回空结果，不白等一个超时。本实例的处理函数直接调，单进程时整个请求不碰共享层。
- 这比改造前好一点：以前 `flushRoomToDatabase` 只落本进程的房间，多副本下房间开在别的副本上就读到旧内容；现在每个协同副本都落。
- 请求-应答必须有退路：`flushRoom()` **从不抛错**，超时 / 失败 / 没有协同实例都只记一笔，按库里现有内容继续。`SharedChannel` 本就不保证送达（[REQ-CLUSTER](14-clustering.md)），不能把正确性押在它上。
- 撤权**不**走总线：它已经有「世代号 + 巡检」这条跨实例的路，总线只是更快，不是更对；路由要的「204 = 本实例上的人已经被踢」由 `revokeAccess()` 等本实例订阅者做完来保证，跨实例仍是最迟一个巡检周期。
- 模块之间**不直接 import 对方的内部文件**，只经契约入口、`ctx.service()`、总线、撤权信号。
- ~~纯函数搬家：`applyFlowUpdate` / `readFlowUpdate` 移到共享包~~ —— 改为随协同模块走：它们是个人画布 / 离线补推的 REST 写入路径，属于「直接碰 Y.Doc 的接口」，第 4 期和 `/doc` 路由一起进 `@shadecn/mod-collab`，由 ingress 按路径分给协同角色（§3.4.1）。

### 3.8 前端 dev 中间件只存在于开发入口

- 新增 `apps/server/dev.ts` 作为 `tsx watch` 的入口：加载全部角色，再挂 Vite 中间件（HMR 仍走同一端口）。
- 生产入口 `apps/server/index.ts` **没有任何指向 `frontend/dev.ts` 的 import**，静态还是动态都没有；esbuild 据此不会把它带进产物。
- `scripts/build-server.mjs` 加断言：metafile 里出现 `frontend/dev` 或 `vite` 即构建失败。`output/package.json` 的依赖表里也不再需要 `DEV_ONLY` 过滤 `vite`。
- 静态前端只随 `web` 角色挂；登录守卫（`frontend/guard.ts`）读会话，所以静态文件仍由 Node 托管，不改成 nginx / CDN（§5）。

### 3.9 构建与部署

- **仍然一个产物、一个镜像**。`pnpm build` 不变；角色只是启动时的环境变量。这保住了"一个产物两种数据库"、沙箱镜像上下文等现有约束。
- `pnpm dev:cluster` 按角色起进程：`DEV_CLUSTER_ROLES="web:3001,collab:3002,collab:3003,agent:3004"`，前面再起一个**前置代理**听 `PORT`（默认 3000），按路径分流（HTTP 和 WebSocket，同一角色轮流分），作用等同于生产的 ingress；子进程的 `APP_ORIGIN` 都是代理地址。没配它就用 `DEV_CLUSTER_PORTS`（每个端口一个全角色进程，没有代理）。
- **路由归属是一张表、三处实现**：服务端的 `apps/server/routes/ownership.ts`（不归本进程的路由 404）、本地代理的 `apps/server/scripts/dev-route.mjs`、生产的 `k8s/ingress.yaml`。前两份由测试逐条对比。
- k8s：每个角色一个 Deployment + Service；`web` 可保留 `Recreate` 与 PVC（SQLite 单副本部署仍然允许，但那时只能全角色一个 Pod），`collab` 用 `RollingUpdate` + HPA（指标：连接数或 CPU），`agent` 按运行中的轮次数扩容。
  ingress 按路径分流：`/ws/collaboration` 与 collab 模块的那几条 REST → collab Service，其余 → web。agent Service 只在集群内。
  清单在 `k8s/variants/roles/`（docs/12 §3.7）。
- 健康检查：每个角色的 `/api/health` 只报自己加载的模块；`collab` 的 `/api/collab/health` 随模块走。

## 4. 验收标准

1. 什么都不配，`pnpm dev` / `pnpm start` 的行为和改造前逐项一致（现有全部测试通过）。
2. 生产产物里 grep 不到 `vite` 和 `frontend/dev`；构建断言在人为加回引用时会失败。
3. `SERVER_ROLES=web` 的进程不加载 Hocuspocus、sharp、pi-ai；`SERVER_ROLES=collab` 的进程不加载静态前端和 S3 客户端（用 `process.moduleLoadList` 或 esbuild chunk 命中断言）。
4. `SERVER_ROLES=agent` 而 collab 模块被配置关掉 → 启动失败，错误信息指出缺 `collab`；`CLUSTER_MODE=single` + 非全角色 → 启动失败。
5. `dev:cluster` 以 `web:1 + collab:2 + agent:1` 启动，用 Redis + PostgreSQL：
   - 两个浏览器分别连到两个 collab 副本编辑同一张画布，互相可见、落库一致；
   - 发起 agent，一轮由 agent 副本认领，改动在两个浏览器里实时可见，撤回按 `runId` 正确；
   - 执行中移除发起人的成员资格：collab 侧断连、agent 侧一轮被叫停（现有行为，跨进程仍成立）；
   - web 调 `flushRoomToDatabase` 能等到 collab 的回执；杀掉全部 collab 副本后调用在超时内退回读库。
6. 没有 agent 副本时 `POST /messages` 回 503；派发给的副本超时回 503；派给另一个实例执行时整条事件流经派发日志回到 web 的 SSE。
7. 关掉 storage：`/api/features.storage === false`，上传接口 404，前端不显示上传入口；agent 的 `view_media` 回"未启用"。
8. 每个模块各自的配置校验失败时，启动错误指出模块名和字段。

## 5. 本期不做

- 静态前端改由 nginx / CDN 托管（登录守卫要先挪到 ingress 的 auth 上）。
- 缩略图生成拆成独立 worker。
- agent 入口的 ingress 路由模式（评估时的方案 B）—— 已选队列，不留第二条路。
- 按角色裁剪产物（每角色一个更小的镜像）：先保"一个产物"，有需要再在 `build-server.mjs` 里按 `roles` 做 tree-shaking。
- 角色之间的 HTTP 调用、服务发现、RPC 框架。

## 6. 待确认事项

1. ~~collab 模块那几条 REST 走 ingress 分流还是 web 转发~~ —— **已定：ingress 路径分流**（§3.9）。
2. `agent-workers` 心跳与"没有 worker 就 503"：是否接受偶发的误判（Redis 抖动时心跳没续上）？备选是只警告不拒绝、靠 TTL 兜底。
3. HPA 用什么指标：连接数要先把 `collabStats()` 暴露成 Prometheus 指标，CPU 现成但滞后。

## 7. 分期

| 期 | 内容 | 可独立合入 | 立刻拿到的收益 |
|---|---|---|---|
| 1 | **已做**：内核（`apps/server/kernel/`）+ 角色解析（`SERVER_ROLES`，非全角色暂拒绝）+ 模块收口生命周期（`apps/server/modules/`，路由仍静态挂、配置仍在 `config.ts`）；dev 入口 `apps/server/dev.ts` + 构建断言；`GET /api/features` | ✓ | 生产产物无 Vite |
| 2 | **已做**：`@shadecn/server-kit`（内核、共享层、总线、撤权信号从 `apps/server` 搬入）；`@shadecn/mod-storage`（整个 storage 搬入，宿主只交配置）；`@shadecn/mod-collab` 契约入口；撤权改走 `revokeAccess()`、复制画布前的落库改走 `flushRoom()`（scatter-gather）。**剩余**：`routes/flows.ts` 的 `/doc` 读写仍直接 import `collab/flow-writer.ts` 和 `COLLAB_LIMITS`，第 4 期随路由一起进协同包 | ✓ | 能力开始离开 `apps/server` |
| 3 | **已做**：collab headless（只有 agent 角色的进程挂 Hocuspocus 不接 WebSocket）+ agent 只经 `@shadecn/mod-collab/canvas-host` 拿活房间 | ✓ | — |
| 4 | **已做**：collab 成包（`CollabPorts`、headless）、agent 成包（`AgentPorts`、惰性单例）、发起一轮改成 web 派发 / agent 执行（§3.6）。路由随模块走、按角色启动见第 5 期 | 每个包一次 | — |
| 5 | **已做**：路由按角色归属（`routes/ownership.ts` 的 `roleGate`），解除「非全角色拒绝启动」（单副本仍拒绝）；`dev:cluster` 按角色起进程 + 前置代理 | ✓ | 本地可按角色跑 |
| 6 | **已做**：`k8s/variants/roles/`（三个 Deployment、两个 Service、按路径分流的 ingress、collab 的 HPA），测试钉住角色 / 标签 / 探针和 ingress 与路由归属表一致。**没切到线上**：要先在集群里备好 Redis + PostgreSQL，再按 docs/12 §3.7 切换 | ✓ | 协同独立扩容 |
