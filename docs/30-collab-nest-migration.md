# REQ-NEST NestJS 版服务

> 状态：**实施中** —— 已完成第 1～7 步和里程碑 A、B（§6）：登录、账号关联、默认头像、项目、画布、协同、节点上传图片和缩略图、应用列表和节点生成单进程跑通，平台 + 两个协同副本也跑通。

## 1. 目标与边界

用 NestJS 照着现有模块的行为另写一份服务，放在 `@learning/*`，按功能分模块，以后能按功能出镜像。第一个里程碑是登录 + canvas + 协同在本地跑通。

- `apps/server` 和 `@shadecn/*` 完全不动，新服务不和它们共用数据库，也不依赖它们（各包 `package.test.ts` 钉着）。
- 没有旧数据：不做迁移、兼容和切换。线上和 k8s 本地跑通后再议。
- 前端 `apps/web` 尽量不改，路径、状态码和响应形状照旧。
- 依赖只走 Nest DI，每个模块用 `@Module` 的 `imports` / `exports` / `providers` / `controllers` 表达。**不仿造 `server-kit` 的 kernel、`ctx.service`、ports、`defineModule`**；模块级可变状态都放进 provider。
- `docs/17` 搁置，本文不处理。

## 2. 模块

已有的全局底座：`ConfigModule`、`DataAccessModule`（`User`）、`ClusterModule`、`SessionIdentityModule`，各模块直接注入，不用 import。实体由所属模块用 `DATA_ACCESS_ENTITIES` 登记。

| 模块（包） | 对应 | 职责 | imports | exports | Controller | 实体 |
|---|---|---|---|---|---|---|
| `SessionModule`（`@learning/session`，已有） | `mod-auth` | 登录、会话、账号关联、默认头像 | — | `SessionService`、`UserService`、`RequestOrigins`、守卫 | `AuthController`、`IdentitiesController`、`AvatarsController` | `Session`、`UserIdentity`、`PendingLink`、`AuthRequest` |
| `CanvasModule`（`@learning/canvas`） | `mod-canvas` 服务层 | 项目、成员、邀请、画布的读写，判权，`FlowDocStore`，撤权信号，落库请求令牌 | — | `ProjectsService`、`FlowsService`、`FlowDocStore`、`AccessRevocation`、`FlowMemberGuard`、`FlowBodyParsers` | — | `Project`、`ProjectMember`、`ProjectInvite`、`Flow`、`FlowUserState` |
| `CanvasApiModule`（同上） | `mod-canvas/routes` | 画布 REST | `CanvasModule` | — | `ProjectsController`、`InvitesController`、`FlowsController` | — |
| `CollabModule`（`@learning/collab`） | `mod-collab` | Hocuspocus 实例、持久化、配额、awareness、单连接互斥、写闸门、复验、退出 | `CanvasModule` | `CollabServer`、`FlowPersistence` | — | — |
| `CollabGatewayModule`（同上） | `mod-collab` 入口 | WebSocket upgrade，监控和 `/doc` 接口 | `CollabModule`、`CanvasModule`（`FlowMemberGuard` 在控制器所在模块实例化） | — | `CollabMonitorController`、`FlowDocController` | — |
| `StorageModule`（`@learning/storage`） | `mod-storage` | S3、上传、缩略图 | `CanvasModule` | `AssetStorage` | `AssetsController` | `FlowAsset` |
| `AppsModule`（`@learning/apps`，目录 `packages/apps`） | `mod-apps` | `executeApp`、生成任务 | `CanvasModule`、`CollabModule`、`StorageModule` | `AppsService` | `AppsController`、`FlowAppsController` | `AppTask` |
| `AgentModule`（`@learning/agent`，目录 `packages/agent-service`） | `mod-agent` | agent 编排、网关 | `CanvasModule`、`CollabModule`、`StorageModule` | — | 面板、网关 | `AgentConversation`、`AgentRun`、`AgentToolCall`、`AgentGrant`、`AgentGrantScope` |

```
config, data-access, cluster, session        全局底座
        └─ canvas                            实体、判权、撤权信号
             ├─ storage
             ├─ collab
             └─ agent, apps（依赖 collab + storage）
contracts                                    只依赖 yjs，任何模块都可用
```

- **Canvas 和 Collab 各拆两个 `@Module`**：协同进程不需要画布 REST；将来 agent 进程要房间，但不接 WebSocket。
- **canvas 不认识 collab，也不 import 它**：跨进程只走共享层和数据库。
  - 撤权：路由 `await accessRevocation.revoke()`，写共享层的世代号，并通知本进程的订阅者；`CollabModule` 订阅，并每 3 秒轮询世代号。
  - 复制画布前落库：`Bus` 发 `canvas.flush-content`，各协同副本回话，超时就读库，不抛错。
- **`@learning/cluster` 要加**：`SharedMap`、`SharedChannel`、`Bus`、`health()`、`instanceId`（语义照 `server-kit` 的 `cluster/`、`bus.ts`）。
- **`@learning/session` 要加**：`load(token, { refresh })`（握手续期、复验和写闸门不续，同现有语义）；导出 `readCookie`、`normalizeOrigin`、`displayNameOf`。
- **`@learning/foundation` 要加**：可选的 `readiness`（`/api/health/ready`）；`enableShutdownHooks` 改用 `useProcessExit`（实测 node 作容器 PID 1 时，默认的 `process.kill(self)` 杀不掉自己）。

## 3. 组装

**`apps/platform`**：两个根模块、两个入口，都是静态模块列表，差别只在有没有协同入口，不靠配置开关。

- `AppModule`（`main.ts`）= `PlatformBaseModule` + `CollabGatewayModule`。默认 `cluster: single`、`schemaSync: apply`，`pnpm dev:platform` 一个进程一个端口就能用全部功能。
- `PlatformBaseModule`：页面、登录、`CanvasApiModule`、`StorageModule`、`AppsModule`，功能到了再加 `AgentModule`。协同由副本提供时，入口 `main-without-collab.ts` 的根模块是 `PlatformSplitModule`（`PlatformBaseModule` 加一道检查，不是 `cluster: redis` 就拒绝启动）。这个入口没有协同入口，但有房间（§8）。

**`apps/collab`**（`@learning/collab-service`）：只有 `main.ts` + `AppModule`，用于协同独立扩缩。

```
imports: ConfigModule, DataAccessModule, ClusterModule, SessionIdentityModule,
         CollabGatewayModule, ClusterDatabaseCheckModule
providers: APP_GUARD = ApiSessionGuard
```

配置用现有的 `<dataDir>/config.yaml`，每个进程设自己的 `DATA_DIR`（示例：`apps/collab/config.example.yaml`）。不是 `cluster: redis` 或不是 `schemaSync: off` 都拒绝启动：

```yaml
server: { port: 3002, origins: [http://127.0.0.1:3000] }
database: { schemaSync: off, url: postgresql://… }   # 带密码的放 PLATFORM_DATABASE_URL
cluster: { mode: redis, url: redis://127.0.0.1:6379 }
auth: { oidc: … }                                    # 和 platform 相同：握手要续期
```

**本地多副本**：一个 `apps/platform`（`apply`）+ 两个 `apps/collab`（`off`），共用本地 PG 和 Redis。`PLATFORM_SESSION_SECRET` 相同；平台也切到 `cluster: redis`。

- 前端的 WebSocket 同源，要加一个小前置代理（`apps/collab/scripts/dev-front.mjs`，思路同 `dev-cluster.mjs`）。它监听 3000（`DEV_FRONT_PORT`），把 `/ws/collaboration`、`/api/collab`、`/api/flows/*/doc` 轮流分给协同副本，其余给平台。此时平台跑 `main-without-collab`，不导入 `CollabGatewayModule`。
- 启动脚本先等平台就绪，再起协同（`off` 不建表），都就绪了代理才开门。
- 平台退出就整组收摊。副本退出只摘掉它，客户端自动重连到别的副本；最后一个副本退出才收摊。

```
pnpm dev:front       # 构建平台和副本，再跑 dev-front.mjs。生产模式：NODE_ENV=production，web.root 指向 output/public，先 pnpm build:platform

data/dev-front/      # DEV_FRONT_ROOT，也是所有进程的运行目录
  .env               # 大家共用：PLATFORM_SESSION_SECRET 必须相同
  platform/config.yaml    # server.port: 3001
  collab-a/config.yaml    # server.port: 3002
  collab-b/config.yaml    # server.port: 3003
```

每个 `config.yaml` 都要写明 `server.port`，`server.origins` 要包含代理的地址，缺了脚本当场报错。

## 4. `@shadecn/shared` 契约

新建 `@learning/contracts`（tsc 产物，`yjs` 是 peer），**把后端要用的文件原样复制进去**：`collab`、`flow-graph`、`flow-doc`、`canvas`、`auth`，第 7 步加了 `apps`、`flow-collection`、`flow-node-types`、`flow-ops-core`，做到 agent 时再加。前端继续用 `@shadecn/shared`。

一个测试防漂移：读 `packages/shared/src/` 的同名文件，只归一化相对 import 的扩展名后逐字比较。文件形状对不上时画布会静默变空，所以这个测试不放宽。

## 5. 仿写时最容易写错的约束

完整规则在 `.claude/rules/collab.md`、`cluster.md`、`database.md`、`auth.md`，动手前先读。

- **读 → 合并 → CAS**：落库先读 `ydoc`（`legacy: false`）合并再写，`nativeUpdate` 自己写 `updatedAt`。只加 CAS 不够。
- **落库失败必须往外抛**：Hocuspocus 靠钩子抛错保住内存文档；另有欠账表，30 秒重试一轮。不能写 `catch` 吞掉。
- **yjs 单份**：全部 `import`、`peer`，测试断言 Hocuspocus 文档里的 `getMap` 结果 `instanceof` 本包的 `Y.Map`。否则画布静默变空。
- **优雅退出顺序**：`onModuleDestroy` 停接入和定时器 → `beforeApplicationShutdown` 关连接、逐房间落库、排空（上限 20 秒）→ Nest 关 HTTP → `onApplicationShutdown` 关 ORM、Redis。
  - 实测只调 `closeConnections()` 不关 socket 时，`app.close()` 一直不返回，ORM 和 Redis 也就关不掉。
  - 不能用 `flushPendingStores()`。
- **upgrade 接入**：在 `onApplicationBootstrap` 挂 `getHttpServer().on('upgrade')`（实测此时还没 `listen`），只处理 `/ws/collaboration`。其他路径有别的监听者（Vite HMR）就不管，没有才 `destroy`。Nest 守卫管不到这里，所以要手工查 `Origin`，并在 `onConnect` 里鉴权。
- **踢人要关 socket**：CLOSE 消息加真正的关闭帧。握手拒绝没有关闭事件，原因放在错误的 `reason` 上。`unauthorized` 和 `forbidden` 不能合并。
- **多副本**：socketId 带 `instanceId` 前缀；每次更新的副作用跳过 `source === 'redis'`；Redis 扩展的 `lockTimeout` 设 10 秒；共享层故障 fail-open。
- **不要照抄落库统计**：实测两副本撞 redlock 时，`logging.ts` 的「开始 − 完成」会把正常跳过记成失败，`/api/collab/health` 一直 503。改成在业务钩子里计数。
- **`/api/collab/health` 只看现在**：欠着落库、写队列卡住或共享层故障才 503，补齐后回到 200。累计的 `store.failed` 只留在响应里（旧服务翻了就 503 到重启，这里故意不同）。
- **配额和写闸门拒绝时不抛错**：置 `readOnly`；写闸门挂 `beforeSync`，不拦 SyncStep1。

## 6. 实现顺序

| # | 交付物 | 怎么验证 |
|---|---|---|
| 1 | `cluster`、`session`、`foundation` 的补充（§2）；`@learning/contracts` | 共享结构的契约测试过内存和 Redis；平价测试；现有测试全过 |
| 2 | `CanvasModule` + `CanvasApiModule` | 移植 `apps/server/test/routes/{projects,flows,invites,personal-space}`，走 `app.inject`；浏览器能登录、建项目、建画布 |
| 3 | `CollabModule` + `CollabGatewayModule`，接进 `apps/platform` | 移植 `apps/server/test/collab/*`；新增真 `@hocuspocus/provider` 用例：同步、落库失败不丢、真 SIGTERM 后内容在库、yjs 单份 |
| **里程碑 A** | 登录 + canvas + 协同本地跑通（单进程） | 真实浏览器 + `@learning/session/testing` 的假 IdP：登录、建画布，两个账号同时编辑互相可见，刷新后内容还在；`kill -TERM` 后重启内容不丢；移除成员后对方被踢 |
| 4 | `apps/collab`、前置代理、Redis 扩展、撤权轮询、flush 回话 | 真 provider 用例改用两个副本（`packages/collab/test/replicas.test.ts`）：跨副本可见、未落库内容可见、撤权 3 秒内生效、单连接互斥跨副本、复制画布拿到未落库内容、两副本同时落库不丢且 health 不误报 |
| **里程碑 B** | 平台 + 两个协同副本本地跑通 | 里程碑 A 的步骤经前置代理重跑；再 `kill -TERM` 一个副本，客户端切到另一个，内容不丢 |
| 5 | 账号关联、identicon 头像（`session`） | 移植 `apps/server/test/auth/*` 相关用例；设置页可用 |
| 6 | `StorageModule` | 移植 storage 用例；节点上传图片可用 |
| 7 | `AppsModule` | 移植 `flow-apps` 用例；节点生成可用 |
| 8 | `AgentModule` | 它依赖的 `@shadecn/agent` 规模大，又不能直接引用，到这一步先单独出一份方案 |

**第 7 步之后前端的状况**：登录、设置页「登录方式」、默认头像、项目、成员、邀请、画布、协同、节点上传图片和缩略图、应用列表、节点生成可用（浏览器走过）。没配对象存储时上传回 503 并弹提示，生成结果挂上游地址；没配应用时列表是空的。别的功能照常。agent 面板显示加载失败（`useFlowAgent.ts:310-316`），不白屏、不无限重试（读代码确认）。

头像为空（这个功能上线前登录、会话还活着）时走 `v-if` 的回退显示，下次登录补上。

## 7. 对象存储（第 6 步）

行为同 `docs/13` §3.7、`docs/27`，配置和与 `mod-storage` 不同的地方如下。

配置在 `config.yaml` 的 `storage` 段（`endpoint`、`internalEndpoint`、`region`、`bucket`、`maxUploadMb`、`keyPrefix`，含义同 `MODULES_STORAGE_*`），凭据在 `.env` 的 `PLATFORM_S3_ACCESS_KEY_ID`、`PLATFORM_S3_SECRET_ACCESS_KEY`，写进 `config.yaml` 拒绝启动。协同副本不 import 这个模块，也不用配：`flow_asset` 由平台建，上传的路径前置代理都分给平台。

- **没配齐时模块照样加载**，接口回 503（旧服务是模块不加载，路由不存在；`docs/13` 写的是 503）。没有 `/api/features`，前端也没有用它。
- **读资源不经过服务**：和旧服务一样，节点里存对象的原始地址，桶对匿名开放读。所以「被移除的成员读不到」只管得到画布、协同和上传接口，**知道地址的人照样能读对象**。私有访问是 `docs/25` 的方案，还没实施。
- **和 canvas 没有回调**：复制画布不动对象和记录（节点里的地址原样带过去，补缩略图不要求记录属于当前画布）；画布软删时记录留着，真删靠外键级联；对象都不删（`docs/13` §3.7）。撤权靠每个请求重新判成员。所以不需要 canvas 反过来调 storage。
- **同一个键记两次**（`complete` 重放）：靠 `key` 的唯一约束判输赢。同一张画布算成功，别的画布持有这个键算失败（500），归属不会被改写。旧服务一律 500。
- **判权在读请求体之前**：匿名和非成员发多大的文件都是 401 / 404，不占内存。但 JSON 写坏的请求（`multipart`、`complete`、`variants`）由 Fastify 在路由之前拦下，非成员也是 400，同 canvas（`CLAUDE.md`）。
- **请求的 `content-type`**：上传和分片路由只特别收 `multipart/form-data`、`application/octet-stream`。写成 Fastify 不认识的类型是 415（旧服务是 400 或照收），前端不会这样发。
- **sharp 用到才加载**：装不上只是没有缩略图，服务照常启动。

## 8. 应用和生成任务（第 7 步）

行为同 `docs/29`，配置和与 `mod-apps` 不同的地方如下。

配置在 `config.yaml` 的 `apps` 段（`timeoutMs`、`providers`、`apps`，形状同 `docs/29` §3.3 的 `modules.apps`，每个模型的收窄照抄 `sample/server.config.example.yaml`）和 `llm.providers`。没有 `MODULES_APPS_*` 这些 JSON 环境变量。密钥只写 `"$环境变量名"`，值放运行目录的 `.env`，写明文拒绝启动。协同副本不 import 这个模块，也不用配：`app_task` 由平台建，这些路径前置代理都分给平台。

- **一个应用都没配也照样加载**：`GET /api/apps` 回 `[]`（旧服务是模块不加载，404，前端两种都当空）。
- **平台进程有房间，没有 WebSocket 入口**：结果要写进 Y.Doc，所以 `AppsModule` import `CollabModule`，`PlatformBaseModule` 里因此有一个 Hocuspocus。它没有 upgrade 监听（入口只在 `CollabGatewayModule`）；拆开部署时任务开一条 direct connection，靠 Redis 扩展和副本同步：开房间时等别的副本把内存里的状态推过来，写回和 `apps:tasks` 都转发给持有房间的副本。任务结束断开即落库、卸载。平时没有房间，它的代价只是定时器和每 3 秒读一次撤权世代号；它也回 `CANVAS_FLUSH_CONTENT`，房间在平台上时复制画布才拿得到还没落库的写回。**平台在拆开形态必须 `cluster: redis`**（§3，配错拒绝启动）：`single` 下平台的房间是孤岛，写回到不了用户，只会经落库合并。
- **受理和执行在同一个进程，没有派发**：旧服务分 web / agent 角色，要经总线派给 agent 副本；这里只有平台有这个模块，路由建好任务行就调 `TaskRunner`，所以 `Bus.dispatch` 和 503「没有 agent 实例」都没有了。还留着的是取消通知（`Bus.request`）：将来平台多副本时，任务可能跑在别的平台进程上。排队中的任务被取消时本进程补推列表。
- **同一节点一个任务靠唯一约束**：`app_task.active_key`，进行中是 `<flowId>/<nodeId>`，结束清成 null。旧服务是先查后插，并发提交能插出两个。
- **请求体上限同别的路由是 1MB**（旧服务 `docs/29` §3.6 是 32MB）：Fastify 在路由之前解析 JSON，放宽的话匿名和非成员也能让服务端先读满上限，再收 401 / 404。前端只发提示词和参考图地址，用不到更大的。要放开得先解决这一点。坏 JSON 同 canvas，先于守卫回 400：`/api/flows/...` 是 `{ error }`，`/api/apps/...` 是 Nest 默认形状（前端不调这个入口）。
- **写回节点的操作只摘了要用的**：`recordGeneration`、`attachAsset`、`appendGeneratedText` 从 `flow-ops.ts` 逐字摘进 `packages/apps/src/generation-ops.ts`，测试逐函数比对。整份 `flow-ops` 的闭包还有 `agent.ts`、`director-*.ts`、`flow-layout.ts`（带 dagre），约 6000 行。第 8 步要整份时删掉这个文件，按 §4 整文件复制。
- **LLM 通路的最小闭包在 `packages/apps/src/llm/`**：`llm-providers`、`model` 两个文件和 `model-stream` 里 `streamUpstream` 那一段（约 400 行，加 `llm.providers` 的解析），依赖 `@earendil-works/pi-ai`，版本同 `mod-apps`。agent 编排没搬。第 8 步也要模型通路时再决定抽不抽成小包。

## 9. 需要用户决定的事项

无。
