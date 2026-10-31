# REQ-MODULES 服务端模块化：底座 + 可开关能力，按角色独立部署

> 状态：**规划中**。
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
| agent 经 `collabInstance()` 的 direct connection 直接写**本进程**内存里的 Y.Doc | `apps/server/agent/canvas-access.ts`、`runs-broadcast.ts` | agent 角色自带一个不监听 WebSocket 的 Hocuspocus（§3.4.2） |
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
- 数据库（MikroORM 单例、`db:push`）、共享层（`cluster/`）、日志（`logger/`）；
- 模块内核：加载、依赖校验、生命周期、`/api/features`。

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
- 每个模块的 `enabled` 默认值由模块自己定（storage 看 S3 配置齐不齐，agent 看有没有模型 key，collab 默认开）。
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

### 3.6 agent 模块：队列模式

现在的 `POST /api/flows/:flowId/agent/messages` 在接收请求的进程里直接起一轮。拆开后 web 角色不跑 agent，改成**入队 → 认领**：

```
浏览器 ──POST /messages──▶ web：判权、校验、占会话槽位、写入 agent-queue ──▶ SSE 接回（补发日志）
                                                                       │
                      agent 副本 ×M ◀── 认领（SharedMap.claim）───────┘
                      签 Grant → 开画布 → 起沙箱 → 推进 → 写 agent-replay / 任务登记（照旧）
```

- **入队**：web 做 `requireFlowMember`、`validatePrompt`、附件校验、会话槽位 `claim`（[REQ-AGENT §3.10.10](20-agent-canvas.md) 已有），
  然后往 `SharedLog` `agent-queue` 追加 `{ runId, flowId, conversationId, userId, prompt, attachments, enqueuedAt }`，
  并在任务登记里写一条状态为 `queued` 的记录（TTL 同其它登记）。响应仍是同一条 SSE：先回 `queued`，之后接到补发日志上 —— 接回落在哪个副本上结果都一样，这一点现在就成立。
- **认领**：每个 agent 副本是一个消费者，`SharedLog.wait` 阻塞读队列，对每条用 `SharedMap.claim('<flowId>:<runId>')` 抢；抢到的那个按今天 `agentRuntime().start()` 的流程往下走（签 Grant、判权、开画布、起沙箱），
  登记改为 `running` 并带上自己的 `instanceId`。没抢到的跳过。**Grant 由认领的副本签**，因为"发起人此刻能进这张画布"本来就要在执行那一刻判。
- **没有 agent 副本时不收单**：agent 副本每 1/3 TTL 在 `SharedMap` `agent-workers` 心跳一次；web 入队前先看有没有活着的，没有回 503 `agent_unavailable`，
  前端提示"agent 服务不可用"。排进去又没人认领的（副本在入队后全挂了）：登记 TTL 到期自动消失，SSE 在 `queued` 状态等到 TTL 后收到 `error: no_worker`。
- **停止**：`POST /runs/:runId/abort` 不变 —— 已认领的经 `agent-stop` 频道送到持有副本（现有）；还在 `queued` 的，web 直接 `deleteIfEquals` 掉登记并写一条 `aborted` 到补发日志，认领者抢不到就算了。
- **只读接口留在 web**：`GET /agent`（视图）、会话列表、会话详情、删除会话、`GET /runs/:runId/events` 都只读库和共享层，不需要 agent 运行时。
  这要求把 `agentRuntime` 里的读路径和执行路径分成两份导出 —— 读那份在 web 角色可用，执行那份只在 agent 角色装配。
- **网关**：`/api/agent-gateway/*` 只在 agent 角色上，鉴权仍是 run 令牌、不认会话（[REQ-AGENT-SANDBOX](22-agent-sandbox.md)）。
  沙箱回连的 `AGENT_GATEWAY_URL` 按副本算（k8s 驱动已用 `POD_IP`），不经 ingress。
- **单进程（全部角色）下同一套路径照跑**：`SharedLog` 的内存实现 + 本进程的消费者，就是今天的行为多绕一次队列。不另留一条"直接起"的快路径。

### 3.7 跨角色通信

只有两种模式，都建在共享层上，不引入新组件：

| 模式 | 用什么 | 用在哪 |
|---|---|---|
| **事件**（fire-and-forget，谁关心谁订阅） | `SharedChannel` | 成员移除 → collab 撤权 + agent 失权对账；画布删除；权限变更 |
| **请求-应答**（要等结果） | `SharedChannel` 请求 + 带 `requestId` 的回执，调用方设超时 | web 要 collab"把这张画布现在落库"（`flushRoomToDatabase`） |

- 进程内总线和跨进程总线是**同一个接口**：单进程时就是内存 `SharedChannel`，事件照发照收。模块之间**不直接 import 对方的内部文件**，只经 `ctx.service()` 拿声明过的服务、经总线收发事件。
- 请求-应答必须有退路：`flush` 超时或无人应答 = 房间不在线 → 直接读库。`SharedChannel` 本就不保证送达（[REQ-CLUSTER](14-clustering.md)），不能把正确性押在它上。
- 纯函数搬家：`applyFlowUpdate` / `readFlowUpdate` / `decodeStateVectorParam` 只碰数据库和 Yjs，不碰房间，移到 `@shadecn/shared/flow-doc` 旁边的服务端共享包，web 和 collab 都能用。

### 3.8 前端 dev 中间件只存在于开发入口

- 新增 `apps/server/dev.ts` 作为 `tsx watch` 的入口：加载全部角色，再挂 Vite 中间件（HMR 仍走同一端口）。
- 生产入口 `apps/server/index.ts` **没有任何指向 `frontend/dev.ts` 的 import**，静态还是动态都没有；esbuild 据此不会把它带进产物。
- `scripts/build-server.mjs` 加断言：metafile 里出现 `frontend/dev` 或 `vite` 即构建失败。`output/package.json` 的依赖表里也不再需要 `DEV_ONLY` 过滤 `vite`。
- 静态前端只随 `web` 角色挂；登录守卫（`frontend/guard.ts`）读会话，所以静态文件仍由 Node 托管，不改成 nginx / CDN（§5）。

### 3.9 构建与部署

- **仍然一个产物、一个镜像**。`pnpm build` 不变；角色只是启动时的环境变量。这保住了"一个产物两种数据库"、沙箱镜像上下文等现有约束。
- `pnpm dev:cluster` 扩展为按角色起进程：`DEV_CLUSTER_ROLES=web:3000,collab:3001,collab:3002,agent:3003`（现有的 `DEV_CLUSTER_PORTS` 继续可用，等价于每个端口全部角色）。
- k8s：每个角色一个 Deployment + Service；`web` 可保留 `Recreate` 与 PVC（SQLite 单副本部署仍然允许，但那时只能全角色一个 Pod），`collab` 用 `RollingUpdate` + HPA（指标：连接数或 CPU），`agent` 按运行中的轮次数扩容。
  ingress 按路径分流：`/ws/collaboration` 与 collab 模块的那几条 REST → collab Service，其余 → web。agent Service 只在集群内。
  `k8s/variants/` 那套"复制覆盖"的切换方式退役，由角色 Deployment 取代。
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
6. 没有 agent 副本时 `POST /messages` 回 503；入队后杀掉全部 agent 副本，SSE 在 TTL 内收到 `no_worker`。
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
| 1 | 内核 + 角色 + 配置分模块；单进程全角色，行为不变；dev 入口 + 构建断言 | ✓ | 生产产物无 Vite |
| 2 | 事件总线；拆掉 web → collab 的三个直接调用；flow-writer 移到共享包 | ✓ | — |
| 3 | **spike**：collab headless + agent `canvasHost`，在 `dev:cluster` 下跑 §4.5 | ✓（spike 结论决定是否继续） | — |
| 4 | storage / collab / agent 依次成包；agent 入口改队列 | 每个包一次 | 可按角色启动 |
| 5 | `dev:cluster` 按角色；补 §4 的测试 | ✓ | — |
| 6 | k8s 按角色拆 Deployment、ingress 分流、HPA | ✓ | 协同独立扩容 |
