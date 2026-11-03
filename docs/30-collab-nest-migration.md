# REQ-NEST NestJS 版服务

> 状态：**实施中** —— 已完成第 1～4 步和里程碑 A、B（§6）：登录、项目、画布、协同单进程跑通，平台 + 两个协同副本也跑通。

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
| `SessionModule`（`@learning/session`，已有） | `mod-auth` | 登录、会话。账号关联和头像待补 | — | `SessionService`、`UserService`、`RequestOrigins`、守卫 | `AuthController`，待补关联、头像 | `Session`、`UserIdentity`、`PendingLink`、`AuthRequest` |
| `CanvasModule`（`@learning/canvas`） | `mod-canvas` 服务层 | 项目、成员、邀请、画布的读写，判权，`FlowDocStore`，撤权信号，落库请求令牌 | — | `ProjectsService`、`FlowsService`、`FlowDocStore`、`AccessRevocation`、`FlowMemberGuard` | — | `Project`、`ProjectMember`、`ProjectInvite`、`Flow`、`FlowUserState` |
| `CanvasApiModule`（同上） | `mod-canvas/routes` | 画布 REST | `CanvasModule` | — | `ProjectsController`、`InvitesController`、`FlowsController` | — |
| `CollabModule`（`@learning/collab`） | `mod-collab` | Hocuspocus 实例、持久化、配额、awareness、单连接互斥、写闸门、复验、退出 | `CanvasModule` | `CollabServer`、`FlowPersistence` | — | — |
| `CollabGatewayModule`（同上） | `mod-collab` 入口 | WebSocket upgrade，监控和 `/doc` 接口 | `CollabModule`、`CanvasModule`（`FlowMemberGuard` 在控制器所在模块实例化） | — | `CollabMonitorController`、`FlowDocController` | — |
| `StorageModule`（`@learning/storage`） | `mod-storage` | S3、上传、缩略图 | `CanvasModule` | `AssetStorage` | `AssetsController` | `FlowAsset` |
| `AppsModule`（`@learning/apps`） | `mod-apps` | `executeApp`、生成任务 | `CanvasModule`、`CollabModule`、`StorageModule` | `AppsService` | `AppsController`、`FlowAppsController` | `AppTask` |
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
- `PlatformBaseModule`（`main-without-collab.ts`）：页面、登录、`CanvasApiModule`，功能到了再加 `StorageModule`、`AppsModule`、`AgentModule`。协同由副本提供时跑这个入口。

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

新建 `@learning/contracts`（tsc 产物，`yjs` 是 peer），**把后端要用的文件原样复制进去**，先是 `collab`、`flow-graph`、`flow-doc`、`canvas`、`auth`，做到 agent、apps 时再加。前端继续用 `@shadecn/shared`。

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

**到里程碑 A 时前端的状况**（读代码确认，未在浏览器跑过）：登录、项目、成员、邀请、画布、协同可用。其余功能报错或显示为空，都不白屏、不无限重试：

- 设置页「登录方式」弹错误提示（`LinkedAccounts.vue:97-104`）。
- 上传失败并弹提示。
- 应用列表和生成任务按空处理（`api.ts` 的 `appApi.list`、`useFlowAppTasks.ts:97`）。
- agent 面板显示加载失败（`useFlowAgent.ts:310-316`）。

头像为空时走 `v-if` 的回退显示。

## 7. 需要用户决定的事项

无。
