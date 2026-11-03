# REQ-NEST-AGENT Agent 搬到 Nest 的方案

> 状态：**实施中** —— 这是 [REQ-NEST](30-collab-nest-migration.md) §6 第 8 步的方案，§8.1 的事项都已定，按推荐执行。

## 1. 结论

1. **`packages/agent` 复制一份，不重写。** 它不认识任何框架，全部第三方依赖只有 pi、`yaml`、`yjs`、`dagre`。复制 41 个文件约 15400 行，改 import 就能跑：探针里 tsc 零错误，旧测试 435 个过 434 个（§2）。
2. **Nest 只重写宿主。** `packages/mod-agent` 约 3060 行变成 `AgentModule`，约 2300 行（估算）。旧的 `dispatch.ts` 和 `ports.ts` 都不要了。
3. **runner 也用这份副本。** 这样新服务和 `@shadecn/*` 没有任何代码或构建上的联系。代价是两份各自维护，修 bug 要修两处。
4. **agent 先留在平台进程。** 没有 web / agent 角色，也没有总线派发，同第 7 步。`apps/agent` 只差一个入口和一条代理规则，本地跑通后再决定。
5. **共 8 步，每步能单独提交和验证。** 第 1～3 步是机械搬运，真正要写的是第 4～6 步。

## 2. 实测依据

探针都是一次性的，放在仓库外，没有改动仓库。

| 问题 | 结果 |
|---|---|
| `packages/agent/src` 有多大 | 46 个文件，17106 行 |
| 外部依赖 | pi 两个包、`yaml`、`yjs`、`@dagrejs/dagre`、`node:*`。**没有** hono、MikroORM、Nest、`server-kit` |
| runner 的运行时闭包（`runner/main.ts`） | agent 16 个文件 4970 行 + shared 13 个文件 7555 行，共 12525 行 |
| 编排的运行时闭包（`session.ts`，含 `gateway`） | agent 27 个文件 12410 行 + 同样的 shared，共 19965 行 |
| `flow-ops` 的闭包 | shared 13 个文件 7555 行；contracts 已有 6 个，**差 7 个，5720 行** |
| 模块级可变状态 | `packages/agent/src` 没有顶层 `let`。顶层 `new Set` / `new Map` 都是常量查表（如 `session.ts:1034`）。运行状态都在 `createAgentRuntime` 的闭包里 |
| 机械复制后能否编译 | 改写规则：`.ts` → `.js`、`@shadecn/shared/` → `@learning/contracts/`。用 TS 6.0.3 和 `@learning/*` 的 `nodenext` 配置编译（原包是 TS 5.9 + `bundler`）：**contracts 13 个文件、agent 43 个文件都零错误**，`erasableSyntaxOnly` 开着 |
| 复制后的测试 | 去掉 k8s 后 28 个测试文件 435 个用例，**过 434 个**。唯一失败的是 `protocol-version.test.ts:58`：哈希覆盖了 import 行，改写后要重记一次，协议版本不变 |
| tsc 产物能否直接运行 | `node dist/runner/main.js` 缺环境变量时退出码 2（符合预期）。`session`、`gateway`、`flow-ops` 的产物都能在 Node 22 上加载，dagre 的具名 import 没问题 |
| 真子进程跑一轮 | `process` 驱动 + tsc 产物的 runner + 真 HTTP 网关 + 脚本化上游：节点写进 Y.Doc，事件从 `RUN_STARTED` 到 `RUN_FINISHED` |
| 从副本打 runner bundle | esbuild 29 个输入，312 KB，第三方依赖是 pi 两个包、`yjs`、`dagre`，同 `apps/agent-sandbox/Dockerfile` 的清单 |
| 网关挂进 Nest + Fastify | 用模拟的 `Request → Response` 处理函数测 Fastify 封装作用域（§4.3）：3MB JSON 原样读到，坏 JSON 交给处理函数，流式响应正常，客户端断开时触发 `cancel`，全局守卫一次都没经过。别的路由不受影响：坏 JSON 仍是 400，2MB 仍是 413 |

## 3. agent 的代码怎么处理

### 3.1 选项

| 选项 | 做法 | 代价 | 结论 |
|---|---|---|---|
| A 复制分叉 | `packages/agent-core`（`@learning/agent-core`），tsc 产物，runner 也在里面 | 多 15400 行实现和约 11700 行测试；旧服务的修复要手工带过来 | **推荐** |
| B 重写成 Nest 类 | 把 `session.ts` 拆成多个 provider | 4052 行编排要重写；`.claude/rules/agent.md` 第 21～64 行的不变式要逐条重新保证，测试也要跟着改。它不依赖任何框架，重写换不来好处 | 不选 |
| C 直接依赖 | `@learning/*` 依赖 `@shadecn/agent`（或打成产物） | 违反已定的边界（各包 `package.test.ts` 钉着），要改 `@shadecn/*`；源码包放进 `node_modules` 还会报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | 不选 |
| D 反向依赖 | 抽成 `@learning/agent-core`，让 `@shadecn/agent` 依赖它 | 只维护一份，但要动 `@shadecn/*` 和旧服务的打包（`scripts/bundle-common.mjs:16` 只内联 `@shadecn/`） | 不选，除非放开「旧服务不动」 |

**这里确实有张力**：不依赖 `@shadecn/*` 的代价就是这 15400 行副本。只有放开边界才能避免，这由用户决定（§8 第 1 项）。

### 3.2 逐块去向（选项 A）

| 块 | 文件 | 行数 | 跑在哪 | 去向 |
|---|---|---|---|---|
| 编排 | `session`、`transcript`、`events`、`canvas-changes`、`occupancy`、`run-registry`、`store`、`authority`、`prompt`、`title`、`canvas` | 7443 | 服务端 | 复制 |
| 网关和协议 | `gateway`、`protocol`、`token`、`model-stream`、`build-id` | 1647 | 服务端；`protocol`、`build-id` 两侧都用 | 复制。`model-stream` 去掉和 `@learning/llm` 重复的一段（§5.3） |
| 模型选择 | `model`、`llm-providers` | 373 | 服务端；编排只 `import type`（`session.ts:68`、`gateway.ts:5`） | 进 `@learning/llm`（§5.3） |
| 定义 | `agents`、`text-skills`、`frontmatter`，加 `agents/*.md`、`skills/README.md` | 394 + 50 | 服务端 | 复制。目录由宿主传，宿主按包路径定位 |
| 技能和工具 | `skills/**`、`tools`、`media` | 3407 | 两侧 | 复制 |
| runner | `runner/*` | 681 | 沙箱 | 复制（§3.3） |
| 沙箱基础 | `sandbox/{local,media-tool,types,driver,index}` | 473 | 两侧 | 复制 |
| 驱动 | `process`、`oci`、`engine`、`inline` | 1006 | 服务端；`inline` 只给测试 | 复制，按子路径导出 |
| k8s 驱动 | `k8s`、`kube`、`drivers/index` | 1325 | 服务端 | **不搬**。`docs/30` §1 定了 k8s 跑通后再议；要用时再复制，宿主另加约 130 行 |
| 测试工具 | `testing` | 357 | 测试 | 复制 |

合计 41 个文件约 15400 行。测试复制 26 个文件约 11700 行（`llm-providers`、`model` 两个测试跟去 `@learning/llm`，k8s 那个不搬）。

**不在范围内的**：`docs/24`（人机交互）、`docs/23` 的 `director-view` / `director-script`、`docs/20` 的 `AgentProfile`。旧代码里也没有这些，这里只搬现有行为。

### 3.3 runner 和沙箱

runner 和 Nest 无关，能复用代码，问题是复用哪一份。

| 选项 | `process` 驱动怎么起 | 镜像 | 代价 |
|---|---|---|---|
| R1 用副本 | `node <agent-core>/dist/runner/main.js`。tsc 产物直接跑，pi 从包自己的 `node_modules` 解析（探针已跑通） | 新的小应用 `apps/agent-runner`（`@learning/agent-runner`），约 430 行 | 多一个镜像定义。**推荐** |
| R2 用旧 runner | 要指向 `@shadecn/agent` 的源码或 `output/`。pnpm 不提升依赖（根 `node_modules` 里没有 pi），要带上 `local-start` 钩子（`mod-agent/src/runner-command.ts:9-13`） | 复用 `apps/agent-sandbox` 的镜像 | 协议哈希不覆盖工具 schema（`.claude/rules/agent.md:118`），得给 `tools`、`skills/**` 加防漂移测试，agent-core 从此不能独立演进。开发时还要依赖 `@shadecn/agent` |

- `apps/agent-sandbox` 原样不动，继续给旧服务用。
- `apps/agent-runner` 的 `Dockerfile` 和构建脚本照抄，打包配置自带一份（`bundle-common.mjs` 的公共选项里只内联 `@shadecn/`，不去改它），边界判定的路径换成 `packages/agent-core`，依赖范围同样是 4 个包。基础镜像继续走 `NODE_IMAGE` 构建参数。
- gateway 协议不改，还是第 9 版。协议的两端都在 `agent-core` 里，`RUNNER_PROTOCOL_VERSION` 和 409 `protocol_mismatch` 的规则照旧。

## 4. Nest 模块

### 4.1 包

| 包 | 目录 | 内容 | 依赖约束 |
|---|---|---|---|
| `@learning/agent-core` | `packages/agent-core` | §3.2 的框架无关代码 | 不 import `@nestjs/*`、`@mikro-orm/*`、`@learning/*` 的业务包（`package.test.ts` 钉）。pi 两个包和 `yaml` 是自己的依赖，`yjs`、`@learning/contracts` 是 peer |
| `@learning/agent` | `packages/agent-service` | `AgentModule` | 同 `@learning/apps`：`@learning/*`、`@nestjs/*`、`@mikro-orm/core`、`yjs` 都是 peer，要 `@hocuspocus/*` 的 `paths` |

分两个包，是为了让 runner 的闭包和沙箱镜像碰不到 Nest 和 ORM，旧结构也是这样分的。核心包的边界测试保留「没有顶层 `let`」，不要 `@learning/apps` 那条「顶层不能 `new Set`」（§2 的常量表会命中）。

### 4.2 `AgentModule`

```
imports:     CanvasModule, CollabModule, StorageModule
controllers: AgentController（/api/flows/:flowId/agent，叠 FlowMemberGuard）
exports:     无
实体:        { provide: DATA_ACCESS_ENTITIES, useValue: [AgentConversation, AgentRun, AgentToolCall, AgentGrant, AgentGrantScope] }
全局底座:    ConfigModule、DataAccessModule、ClusterModule、SessionIdentityModule（直接注入）
```

不再拆成两个 `@Module`：现在没有「只要服务不要控制器」的进程。

| 旧文件（`mod-agent/src`） | 行数 | 新 provider | 说明 |
|---|---|---|---|
| `module.ts` | 121 | `agent.module.ts` | 校验放进工厂：定义、文字技能、模型表坏了就拒绝启动 |
| `ports.ts` | 175 | 删 | 依赖走 DI，`lazySingleton` 不要了 |
| `dispatch.ts` | 200 | 删 | 路由直接调 `runtime.start`（§6.1） |
| `config.ts` | 272 | `AGENT_OPTIONS`（`resolveAgentOptions`） | 读 `agent` 段，去掉 k8s 和环境变量名推导 |
| `index.ts` | 436 | `SANDBOX_DRIVER`、`AGENT_RUNTIME`、`AgentSandboxReaper` | 模块级的 `runtime`、`builtDriver` 变成 provider。去掉 k8s（`buildK8sDriver` 42 行、`checkK8s` 33 行等） |
| `authority.ts` | 345 | `AgentAuthorities` | 订阅 `AccessRevocation.onRevoked`，10 分钟对账放 `OnModuleDestroy` 能停的定时器 |
| `canvas-access.ts` | 161 | `AgentCanvasAccess` | 注入 `CollabServer`，用它的 `hocuspocus`、`quotaLocked`。`flowHasNode` 读 `FlowDocStore.read` |
| `runs-broadcast.ts` | 34 | 并入 `AgentCanvasAccess` | |
| `stores.ts` | 321 | `AgentConversations`、`AgentRunLog`、`AgentGrants` | `db` 换成 `DataAccess` |
| `entities.ts` | 196 | `entities.ts` | 外键指向 `@learning/canvas` 的 `Flow` 和 `@learning/data-access` 的 `User` |
| `leases.ts`、`runs.ts` | 211 | `AgentLeases`、`AgentRuns` | 从 `Cluster` 取表，编解码规则不变 |
| `media.ts` | 34 | `AgentMediaReader` | 见 §4.4 |
| `models.ts`、`definitions.ts` | 193 | `AGENT_MODELS`、`AGENT_DEFINITIONS`、`AGENT_TEXT_SKILLS` | 工厂 |
| `runner-command.ts` | 40 | 约 5 行 | 按包解析 `@learning/agent-core/runner/main`，不用 tsx 和 `--import` 转发 |
| `routes.ts` | 318 | `AgentController`、`sse.ts`、`AgentGatewayMount` | 见 §4.3 |

**退出**：`abortAll` 放 `onModuleDestroy`，上限 5 秒（`mod-agent/src/module.ts:75-76`）。理由同 `.claude/rules/apps.md:40`：一轮收尾要断开 direct connection，而 `CollabServer` 在下一阶段才关房间。

### 4.3 两个 HTTP 入口

- **面板**是 `@learning/*` 里第一个 SSE。控制器走 `FlowMemberGuard`，判完状态码再 `reply.hijack()`。沿用 `sseRelay` 的顺序：先订阅、再开流、补发积压、15 秒心跳，断开只退订。`@CurrentAccess().role` 判管理员中止。
- **网关**不走控制器，理由有三：`gateway.handle` 要 `Request → Response`（`gateway.ts:206`）；Fastify 在路由之前解析 JSON，默认上限 1MB，而网关要 4MB（`gateway.ts:84`）；runner 带的是 bearer，不走会话。
  - 做法同 `@learning/foundation` 的探针，用普通 Fastify 路由：`AgentGatewayMount` 在 `onModuleInit` 里 `register` 一个封装作用域，`removeAllContentTypeParsers` 后只留直通解析器，路由是 `/api/agent-gateway/*`。
  - 响应要写 `reply.raw`，还要处理背压，连接关闭时 `reader.cancel()`：空闲判定靠 SSE body 被取消（`.claude/rules/agent.md:48`）。

### 4.4 要补的跨模块接口

| 包 | 加什么 | 依据 | 量级 |
|---|---|---|---|
| `@learning/cluster` | `SharedMap.compareAndSet`、`SharedLog` + `Cluster.createLog`，内存和 Redis 两套 | 现在都没有（`shared-state.ts:28-40`、`cluster.ts:34-44`）。占用和槽位续期要 CAS，补发日志要 log。Redis 的 `XREAD BLOCK` 要单独连接（`server-kit/src/cluster/redis.ts:26,243`） | 约 260 行 + 契约测试 |
| `@learning/session` | `UserService.briefs(ids)`、`SessionService.deriveSecret(purpose)` | 现在都没有（`user.service.ts:27,35`）。`mod-agent/src/module.ts:37,50` 要用 | 约 20 行 |
| `@learning/storage` | `AssetStorage.objectUrl(key)`、不查归属的按地址读 | `AssetStorage.read` 要求记录属于这张画布（`asset-storage.ts:81-85`），而复制画布只带地址、不带记录（`docs/30` §7），直接用的话复制出来的画布上 `view_node_media` 会读不到。旧服务只判「本桶的键」（`mod-agent/src/media.ts:20-24`）。防 SSRF 的规则不变：不是本桶的地址一律不请求 | 约 15 行 |

`revokeAllGrantsForUser` 只有定义和测试，没有生产调用方（`mod-agent/src/authority.ts:330`），不搬。

### 4.5 配置

```yaml
agent:                    # 一个都不配也照样加载：view 回 enabled: false，发消息 503
  provider: selfhost      # 引用 llm.providers（密钥只写 "$ENV"）
  model: qwen3
  thinking: medium        # 可选，titleModel、maxOutputTokens 同样可选
  runIdleTimeoutMs: …     # 还有 runTotalTimeoutMs、leaseTtlMs、grantMarginMs
  gatewayUrl: …           # 默认由驱动和 server.port 推出（mod-agent/src/config.ts:247-257）
  sandbox:
    driver: process       # process | oci；process 在生产拒绝，除非 allowProcess
    exec: false           # image、runtime、cpus、memoryMib、pids、diskMib、oci.{socket,network}
```

- `PLATFORM_AGENT_TOKEN_SECRET` 放 `.env`，没配就从会话密钥派生（同 `mod-agent/src/module.ts:37`）。
- 模型表文件在 `<dataDir>/agent-models.json`，工作目录在 `<dataDir>/agent-workspaces`。
- 写 `driver: k8s` 时 agent 不启用，并写明原因。

## 5. contracts 和模型通路

### 5.1 整文件复制

新增 7 个文件：`agent`（1123 行）、`director-doc`（751）、`director-eval`（956）、`director-ops`（1494）、`flow-layout`（307）、`flow-ops`（1044）、`id`（45），共 5720 行。

- `lib: ES2020` + `types: []` 下零错误（§2），不用改 `tsconfig.build.json`。
- `@dagrejs/dagre` 进 `peerDependencies`，并标成可选：只有 import `flow-ops` 或 `flow-layout` 的进程才加载它，协同副本不 import。`apps/platform` 要声明它。
- agent 的 wire 形状仍从 `packages/shared` 改起，再复制过来。

### 5.2 `contracts.test.ts` 和 `generation-ops.ts`

- `contracts.test.ts:18` 的文件清单加这 7 个。逐字比较和闭包检查的逻辑不用动（`export * from` 也匹配归一化规则）。
- `contracts.test.ts:53,60` 的「第三方依赖只有 `yjs`」改成 `yjs` + `@dagrejs/dagre`，并断言 dagre 和 `packages/shared` 是同一份。
- `packages/apps/src/generation-ops.ts` 删除，`task-runner.ts:14` 改 import `@learning/contracts/flow-ops`。`generation-ops.test.ts` 删掉防漂移部分，行为用例改测 contracts 的导出。`@learning/apps` 的 peer 加 dagre。

### 5.3 模型通路：抽成 `@learning/llm`

| 选项 | 代价 | 结论 |
|---|---|---|
| 抽 `@learning/llm` | 把 `packages/apps/src/llm/` 的 4 个文件（559 行）移过去，不写新代码；`apps` 和 `agent-*` 都依赖它 | **推荐** |
| 各留一份 | 不动 `apps`。但 `llm.providers` 这一段就有两个解析器，一份配置可能得出两种结论 | 不选 |
| `apps` 依赖 `agent-core` 的子路径 | 同 `mod-apps` 的做法。但 `model-stream` 经 `tools.ts` 带上约 9000 行闭包（`model-stream.ts:16`），`apps` 单独出镜像时也要带 agent-core | 不选 |

依据：两边的 `model.ts`、`llm-providers.ts` 只有注释不同（实测 diff），`apps` 的 `model-stream.ts` 是 agent 那份的子集。

`@learning/llm` 含 `llm-config`、`llm-providers`、`model`、`stream-upstream`，pi-ai 是它自己的依赖。runner 碰不到它（runner 的闭包连类型都不引用 `model.ts`）。agent-core 只把 `./model.ts` 的类型 import 改过去。`.claude/rules/apps.md` 关于不再写一个客户端的规则不变。

### 5.4 副本要不要防漂移

- **contracts 继续逐字比较**：前端用 `@shadecn/shared`，形状对不上时画布会静默变空。
- **agent-core 不加防漂移测试**：runner 和网关都在副本里，新旧之间没有 wire 关系，同 `@learning/apps`（「复制自 … 不互相同步」）。要是钉死，agent-core 改一行就得先改 `@shadecn/agent`。
- 复制那次提交用一次性脚本核对：归一化后和 `packages/agent/src` 比，差异只能是 §3.2 列出的那些。

## 6. 部署形态

### 6.1 留在平台进程，没有角色和派发

- `AgentModule` 进 `PlatformBaseModule`。平台因为 `AppsModule` 已经有 Hocuspocus（`docs/30` §8），不会多一个。
- 旧服务要派发，是因为 web 和 agent 是两种副本（`mod-agent/src/dispatch.ts:105,142`、`docs/28` §3.6）。这里面板和网关在同一个模块里，路由直接 `runtime.start({ emit })`，返回值带 `done` 和 `unsubscribe`（`session.ts:547`）。
- 所以 `agent-dispatch` 这条中继日志、15 秒派发超时、「没有 agent 实例」的 503 都没有了。`Bus` 也用不到，`@learning/cluster` 的 `Bus` 本来就没有 `dispatch`。
- 共享登记留着（`RunRegistry` 是 agent-core 的必需项）：`single` 用内存，`redis` 用 Redis。

### 6.2 和协同副本的关系

和生成任务相同，平台没有 WebSocket 入口，一轮经 direct connection 持有房间。`cluster: redis` 时 Redis 扩展双向转发。

| 现象 | 依据 | 处理 |
|---|---|---|
| 副本上别人的改动，在平台上 origin 是 `redis`，只能认成「其他协作者」 | `mod-agent/src/canvas-access.ts:69-71` | 同旧服务的 agent 副本，接受 |
| 房间在副本上时，刚建的节点可能判成不存在（库里慢一个防抖窗口） | `mod-agent/src/canvas-access.ts:145` | 同旧服务，再点一次即可 |
| `agent:runs` 从平台发，经 Redis 到副本上的客户端 | `mod-agent/src/runs-broadcast.ts` | 里程碑 D 验证 |
| 平台 `cluster: single` 配副本时，房间是孤岛 | `docs/30` §8 | 拆分入口（`PlatformSplitModule`）拒绝启动 |
| `/api/flows/*/agent` 默认分给平台，流经 `pipe` 转发 | `apps/collab/scripts/front-proxy.mjs:27,40-43` | 不改代理。网关不经代理，runner 直连平台端口 |

### 6.3 单独的 `apps/agent`（可选）

形状同 `apps/collab`（`src` 45 行 + 配置示例）：`AgentModule` + 全局底座，不要页面和 REST。代理加一条 `/api/flows/*/agent`。不用派发，收到请求的进程就执行。量级约 150 行。

**要注意表结构**：`AGENT_*` 实体只有 import 它的进程才会建（`.claude/rules/database.md:62`），而 DDL 只能由一个 `apply` 进程跑（`packages/data-access/src/module.ts:35`）。所以平台要 import 一个只登记实体的 `AgentTablesModule`（约 10 行），agent 进程用 `schemaSync: off`。

好处是长时间的 run 和 pi 不占页面进程的事件循环，也能单独出镜像。没有集群部署之前，这些都用不上。

### 6.4 沙箱和驱动

- 本地默认 `process`，它**不是强隔离**：runner 和服务端同用户、同文件系统、可出网。这和旧服务一样，生产默认拒绝。
- `oci` 给「想要真隔离」或拆进容器的时候用。网关地址默认 `http://host.docker.internal:<port>`（`mod-agent/src/config.ts:250`），podman machine 上平台只听回环也能连。

## 7. 实现顺序

前置：第 7 步（`packages/apps`）先提交，第 1、2 步都要动它。每步同时更新 `.claude/rules/agent.md`、`CLAUDE.md` 的包说明、`docs/30` §2、§3。新包都要在根 `Dockerfile` 加一行 `COPY`（`Dockerfile:38`），在根 `vitest.config.ts`、`package.json` 加 project。

| # | 交付物 | 量级 | 验收 |
|---|---|---|---|
| 1 | contracts 加 7 个文件（§5.1、§5.2），删 `generation-ops.ts` | 新增 5720 行（复制），删 93 行 | `test:contracts`、`test:apps`、`test:platform` 过；`pnpm build:platform` 后产物能加载 `flow-ops`；浏览器走一次节点生成 |
| 2 | `@learning/llm`（§5.3） | 移动 559 行 | `test:apps` 过；移植 `llm-providers`、`model` 两个测试 |
| 3 | `@learning/agent-core`：复制 + 改写 + 边界测试 | 41 个文件约 15400 行（复制），测试约 11700 行 | 新增的 `test:agent-core` 全过，协议哈希重记、版本仍是 9；归一化差异核对；新增用例：`process` 驱动起 tsc 产物的真子进程跑完一轮（探针可直接改成测试）。不接 Nest，不碰浏览器 |
| 4 | §4.4 的三处补充 | 约 300 行 | `SharedMap`、`SharedLog` 契约测试过内存和 Redis（`PLATFORM_TEST_REDIS_URL`）；`test:session`、`test:storage` 过 |
| 5 | `@learning/agent`，不带 HTTP：配置、实体、stores、判权、登记、画布访问、runtime | 约 1600 行（估算） | 移植 `apps/server/test/agent/` 的 `authority`、`canvas-access`、`leases`、`runs`、`runs-broadcast`、`view-media`、`agent-models` 和 `sandbox-config` 适用部分（约 2000 行）；SQLite 和 PG 上同步表结构后 diff 为空 |
| 6 | 控制器、SSE、网关挂载，接进 `PlatformBaseModule`，`process` 驱动 | 约 700 行（估算） | 移植 `routes/agent`、`routes/agent-gateway`、`sandbox-process`（真子进程，`app.listen`，约 1450 行）；新增真 SIGTERM 用例：运行中收到信号，5 秒内收尾且对话已落库 |
| **里程碑 C** | 单进程跑通 | — | 真实浏览器 + 假 IdP + 脚本化上游：发消息看到流式文字，节点出现，另一账号同画布可见；运行中刷新接回；中止；移除发起人后这一轮被叫停；重启后内容和会话都在 |
| 7 | 拆开形态 | 配置和脚本，代码改动很少 | 移植 `multi-replica`（480 行）；`agent:runs` 跨副本到达 |
| **里程碑 D** | 平台 + 两个副本跑通 | — | 经 `pnpm dev:front` 重走里程碑 C；副本上的人改节点，模型下一步收到改动通知，被改的节点写入被拒绝；`kill -TERM` 一个副本，这一轮继续 |
| 8 | `oci` 驱动接线 + `apps/agent-runner` 镜像 | 约 430 行（照抄）+ 宿主约 60 行 | 移植边界测试；`oci-driver` 已在第 3 步覆盖；`sandbox-oci`（`AGENT_SANDBOX_OCI_IT=1`）在本地引擎上跑 |

**不搬的旧测试**：`dispatch`、`k8s-manifests`、`sandbox-k8s`、`k8s-driver`。

**不调付费模型**：单元和路由测试用 `registerScriptedModel`。浏览器要真 HTTP，`@learning/agent-core/testing` 加一个 `startScriptedUpstream()`（约 40 行，思路同 `@learning/session/testing` 的假 IdP），`llm.providers` 指向它。

## 8. 风险和待用户决定的事项

### 8.1 已决定（都按推荐）

| # | 事项 | 推荐 | 理由 | 量级 |
|---|---|---|---|---|
| 1 | 接受复制分叉吗（§3.1） | 接受 | 探针已证明可行；不依赖 `@shadecn/*` 的代价就是这份副本，要避免只能放开「旧服务不动」 | 复制 41 个文件约 15400 行 + 测试约 11700 行；修 bug 要修两处，直到 `@shadecn/*` 下线 |
| 2 | runner 和镜像用副本还是旧的（§3.3） | 用副本，第 8 步才出镜像 | 和 `@shadecn/*` 彻底没有联系，agent-core 能独立改 | 约 430 行 |
| 3 | 抽 `@learning/llm` 吗（§5.3） | 抽 | `llm.providers` 只留一个解析器；只是移动代码 | 移动 559 行，动 `packages/apps` |
| 4 | agent-core 加防漂移测试吗（§5.4） | 不加 | 新旧之间没有 wire 关系，钉死会挡住新服务演进。代价是旧服务的修复不会自动提醒 | 不加为 0；加的话约 100 行，且改动要先落到 `@shadecn/agent` |
| 5 | `apps/agent` 现在做吗（§6.3） | 里程碑 D 之后再定 | 只差入口和代理规则，晚做不增加成本；现在没有集群部署要用 | 约 150 行 |
| 6 | k8s 驱动搬吗（§3.2） | 不搬 | `docs/30` §1 已定 k8s 后议；旧代码也没在真实集群跑过（`docs/22` §9 第 4 项） | 搬的话复制 1325 行 + 测试 944 行 + 宿主约 130 行 |

### 8.2 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 网关桥接写错：背压、取消 | 空闲上限误判，或 run 卡住 | 探针已验证 Fastify 这一半；第 6 步用真 runner 走完整路径 |
| hijack 的 SSE 拖住 `app.close()` | `docs/30` §5 记过类似情况：socket 没关就不返回，ORM 和 Redis 也关不掉 | `abortAll` 之后流都该结束，第 6 步用真 SIGTERM 钉住 |
| 宿主重写漏掉不变式 | 权限或数据问题，不一定报错 | 重点是这几条：每次读写判权、写前查 `quotaLocked`、释放只走 `deleteIfEquals`、`titleModel` 不进测试接线、stores 写操作的 `where` 带 `user`。旧测试照搬，不放宽 |
| `flow-ops` 进 `@learning/apps` 后平台要有 dagre | 没声明的话，产物运行时才报错 | `package.test.ts` 的「import 的包都声明了」会拦住；第 1 步验收跑产物 |
| run 和页面共用平台的事件循环 | 模型流和工具执行可能拖慢页面 | 本地不算问题；`apps/agent` 是退路（§6.3） |

## 9. 没有核实的部分

- **真 runner + 真网关 + Nest 没有合起来跑过**：Fastify 挂载用的是模拟处理函数，真 runner 用的是普通 `http.createServer`。两半分别验证过，合起来在第 6 步。
- **没有构建和运行过 OCI 镜像**：只验证了从副本打 bundle，这次没有启动容器。
- `SharedLog`、`compareAndSet` 的 Redis 版本没有移植试跑；约 260 行是按旧实现的行数估的。
- `@learning/llm` 的移动没有试过。§5.3 的依据是 diff 和 import 关系。
- SSE 经 `front-proxy.mjs` 没有实际跑过，只读了代码（`response.pipe(res)`）。
- hijack 的 SSE 和 `app.close()` 的关系没有实测。
- `AgentModule` 的约 2300 行、第 5 步和第 6 步的行数都是估算。
- `docs/20`、`docs/22`、`docs/23`、`docs/24`、`docs/26` 只读了状态和相关章节，行为细节以 `.claude/rules/agent.md` 和代码为准。
