# REQ-AGENT-SANDBOX Agent 沙箱：身份、委托授权与执行运行时

> 状态：**一期（身份核心）、二期（网关 + runner + `process` 驱动）、三期（`oci` 驱动 + 沙箱镜像）、四期（`k8s` 驱动 + 部署清单，§9 第 1～4 项）已实现**；
> 四期**还没在真实集群上跑过**（单元测试对着假的 k8s API，真集群的用例默认跳过，见 §7.5）。五期起为方案。
> 模型请求改由服务端发起（§4.3）：**第 1 步（换传输：runner 用 `streamProxy`、服务端调上游、按请求数步数）、第 2 步（服务端维护权威 transcript，模型请求与落库只用它）、第 3 步（对话里给人看的事件由服务端产生）、第 4 步（清理线协议，`RUNNER_PROTOCOL_VERSION` 6 → 7）、第 5 步（模型用量累计进 `agent_run`）已实现**。
> 本文里的「父 agent / 子 agent」按 [REQ-AGENT-DEF](26-agent-definitions.md) 改称「入口 agent / 被调用的 agent」（同一沙箱里对等协作，差别只在角色）；
> 那边的 P3 **已实现**（`RUNNER_PROTOCOL_VERSION` 7 → 8，沙箱镜像要重建）：`/agent/delegate`、`/agent/finish` 改成 `/agent/task/start`、`/agent/task/finish`，
> 发起请求带调用方的 agent id 与 `{ agent, task, nodeIds }`；`RunnerInput` 的入口 agent 和任务输入各带这个 agent 自己的技能、工具白名单（runner 按它滤工具）和模型元数据，
> 外加可调用的 agent 目录。P4 起各 agent 按自己定义里的模型调上游、费用按各自模型算（§4.3 第 5 步的「一轮一行合计」不变）。下面的实现说明保留实现时的称呼。
> 一期已实现：Grant / scope 表（`agent_grant` / `agent_grant_scope`，签发时 scope = 请求的 ∩ 发起人当时的权限 ∩ 服务端配置）；
> run 状态机 running → success / cancelled / error / expired（线上 RUN_FINISHED 仍只有 success / cancelled，expired 在线上是 cancelled）；
> 全部工具执行前、每次请求模型前、画布每次读写前 `authorize(capability)`；失效即 `stop`（整轮立即停，cancelled + 原因，Grant 标撤销）；
> Reconciler（撤销事件本实例当场、跨实例经撤销广播 + 每 10 分钟全量对账，含到期）；中止即杀沙箱子进程、清工作目录；
> 审计字段 `grant_id`（`agent_run` / `agent_tool_call`）；账号级撤销 `revokeAllGrantsForUser`（接入点待定，见 §5）。
> 二期已实现：pi 推理循环搬进每轮一个的沙箱（runner），经网关 `/api/agent-gateway/*` 说话（§4，实现与原方案的差异见 §9 第 2 项的说明）；
> STS（bootstrap token → run 短令牌、续期）、模型代理、画布工具 RPC、事件上报、改动通知下行；`process` 驱动（生产拒绝）。
> （模型代理已由服务端调用模型取代、改动通知下行已删，见 §4.3。）
> 三期已实现：`oci` 驱动（每轮一个 Docker / Podman 容器，Engine API 直连 unix socket，生产可用）、沙箱镜像（`pnpm build:sandbox-image`）、
> 启动自检 + 孤儿容器清理；本地用 podman machine 跑通（§7.2、§7.3；本地的出网限制做到什么程度见 §7.4）。
> 四期已实现：`k8s` 驱动（每轮一个 Pod，Kubernetes API 直连，零依赖；Pod 规格满足 Pod Security `restricted`）、启动自检决定启不启用、
> 孤儿 Pod 清理；部署清单（沙箱命名空间、RBAC、NetworkPolicy、配额兜底、可选的 gVisor RuntimeClass、服务端 Deployment 补丁，
> 都在 `k8s/variants/`）。工作负载凭证仍是一次性 bootstrap token（projected token + TokenReview 没做，见 §4.1）（§7.5）。
>
> 前置：[REQ-AGENT](20-agent-canvas.md)（画布 agent，本需求改写它的 §3.1「大脑在服务端」与 §3.9 ①④）。
> 来源：《多用户 Agent 沙箱：身份、委托授权与权限设计方案》（2026-10-29），本文把它落到本项目，
> 原方案里与本项目无关或冲突的部分在 §8 列出。

## 1. 结论

1. **每个 agent 任务（run）是一个独立的授权主体**，凭发起人签发的委托授权（Grant）运行；
   有效权限实时等于「授予范围 ∩ 发起人此刻的权限」。用户登录态只用于人操作控制面，**不是任务的执行身份**。
2. **agent 的推理循环（pi）搬进沙箱**。沙箱只持有「我是哪个 run」的工作负载凭证，不持有任何长期密钥
   （LLM key、数据库、会话）。画布读写、模型调用、事件上报一律经服务端的**网关**，网关每次调用实时判权。
3. **Y.Doc 与原子操作留在服务端**：沙箱里的画布工具只是 RPC 客户端，真正的写入仍是服务端
   `@shadecn/shared/flow-ops` 在协同房间的直连上执行（REQ-AGENT §3.10.1 不变）。
4. 沙箱运行时是可替换的驱动：本地开发 `process`、单机 `oci`（Docker / Podman）、生产 `k8s`（gVisor）。

## 2. 原则（与原方案一致）

1. **会话与执行身份解耦**：登录过期、退出都不打断任务；账号安全事件与用户显式撤销才停止任务。
2. **委托而非冒充**：永远不把用户的 refresh token / 会话交给 agent 或沙箱。
3. **授权只缩不扩**：Grant 签发后，用户新获得的权限不自动加给已有任务。
4. **实时判定，token 只是缓存**：网关每次调用按当前权限判定，token 里的 scope 不是最终依据。
5. **沙箱零长期密钥**：真实凭证（LLM key 等）只在网关注入。
6. **人才能审批**：决策与高风险确认必须由用户会话提交，run 凭证永远不能自我审批。
7. **按 run 精确撤销**：权限变化逐个 run 对账。

## 3. 身份模型

| 层 | 主体 | 凭证 | 生命周期 | 用途 |
|---|---|---|---|---|
| 用户 | `user:{id}` | 会话 cookie（OIDC / GitHub BFF） | 随登录态 | 控制面：发起、查看、取消、决策 |
| 委托授权 Grant | 用户 → 某个 run | 服务端记录，不是 token | 任务级，有绝对过期时间，可撤销 | 授权上限、撤销策略 |
| 运行时 Run | `agent-run:{runId}` | 工作负载凭证 → 换取 run 短令牌 | 短令牌 10 分钟，Grant 有效时续期 | 调网关 |

**本项目的 scope**（每个都声明 `on_revoke`；一期只实现 `stop`）：

| scope | 资源 | 含义 | `on_revoke` |
|---|---|---|---|
| `flow:read` | `flow:{id}` | 读画布 | stop |
| `flow:write` | `flow:{id}` | 新建 / 修改 / 连线 / 布局 | stop |
| `flow:delete` | `flow:{id}` | 删除元素（仍受每轮删除预算） | stop |
| `llm:invoke` | `model:{provider/id}` | 调用服务端配置的模型 | stop |
| `sandbox:exec` | `run:{id}` | 在自己的沙箱里跑白名单命令（ffmpeg / ffprobe） | —（沙箱内部动作，不经网关） |

**run 短令牌**：服务端签名（HMAC，密钥只在服务端），用 RFC 8693 的 `act` 表达「代表谁 / 谁在执行」：

```json
{ "iss": "shadecn-agent-sts", "sub": "user:<id>", "act": { "sub": "agent-run:<runId>" },
  "grant_id": "<grantId>", "aud": "agent-gateway", "scope": "flow:<id>:read flow:<id>:write llm:invoke",
  "exp": 1793000000 }
```

网关**不信 token 里的 scope**，每次都查 Grant 状态与发起人当前权限（§5）。

## 4. 架构

```
浏览器 ──会话──▶ 控制面 /api/flows/:flowId/agent/*（发起 = 签发 Grant + 建 run + 网关登记 + 驱动起沙箱；查看 / 取消 / 旁观）
                      │
                      ▼
          服务端（apps/server + @shadecn/agent 的 session / gateway）
          ├─ run 注册表 + 补发缓冲 + SSE + 任务列表广播（不变）
          ├─ events.ts：服务端合成的 pi 事件（模型流 / 执行记录 / transcript）→ AG-UI（映射只在这里）
          ├─ 每个 agent 的权威 transcript（模型请求与落库只用它；别人的改动通知在父 agent 的下一次请求时插进去）
          ├─ 画布：direct connection + tools.ts + flow-ops（工具在这里执行）、常驻观察、跨轮差异
          ├─ 落库：会话、运行日志、工具调用日志（画布工具以网关的执行记录为准）、Grant
          └─ authorize + Reconciler（一期）；真实 LLM key 只在模型代理里
                      ▲  run 短令牌（Bearer）
                      │
                 网关 /api/agent-gateway/*（会话登录闸之外，只认 run 短令牌）
                      ├─ POST /sts/token        bootstrap token → run 短令牌；带有效令牌续期
                      ├─ POST /run/input        本轮输入：提供 / 一开始加载的技能、模型描述（无地址无 key）、runner 执行的命令的调用上限、工作目录的文件
                      │                         （没有系统提示、提示词、模型上下文：它们只在服务端的 transcript 里）
                      ├─ POST /model/<agentId>/api/stream  服务端调用模型（§4.3）：判 llm:invoke → 按 agent 数步数 → 用服务端的 transcript 带真实 key 调上游 → SSE 下发；叫停即掐断
                      ├─ POST /canvas/tool      画布工具：对上服务端回复里的调用 → 计数判上限、单独调用 → authorize(工具的能力) → 执行（一次一个 Y 事务）
                      ├─ POST /agent/delegate   派子 agent；POST /agent/finish 子 agent 结束（只报 agentId，怎么结束的服务端判）
                      ├─ POST /events           工具的开始 / 结束分批上报（批次序号逐一递增；只用作时机、runner 执行的工具的计数与结果、日志）
                      └─ POST /run/finish       runner 收尾（随后令牌作废）
                      │
沙箱（runner：pi 推理循环，环境变量只有网关地址 + 一次性 bootstrap token + 工作目录 + PATH）
   ├─ 画布工具 = /canvas/tool 的代理（schema / 描述 / 能力来自同一份 tools.ts）
   ├─ 模型：pi 的 streamProxy（authToken = run 短令牌，proxyUrl = 网关 /model/<agentId>；只送空的上下文；模型、参数、key、上下文都在服务端）
   ├─ 拦截只剩到不了网关的：request_confirmation 没单独调用、runner 执行的命令超过调用上限（其余由网关判）
   └─ ffmpeg / ffprobe 在自己的工作目录里跑（runner 就是沙箱，sandbox:exec 不经网关）
```

- **runner**（`@shadecn/agent/runner`）：沙箱里的入口。启动时用 bootstrap token 换 run 短令牌，取本轮输入，跑 pi（它的 transcript
  只用来驱动循环：按服务端发回的回复执行工具）；工具的开始 / 结束裁成 `RunnerEvent`（`protocol.ts`）分批上报。它**不决定结局**：成功 / 中止 / 出错、步数上限、
  时长上限、工具调用上限、删除预算、补发缓冲、落库都在服务端。
- **画布工具**：schema / 描述在 runner 侧，执行在网关侧（复用 `tools.ts` 的校验与 `flow-ops`）。一次工具调用 = 一次网关请求 = 一个 Y 事务。
  工具调用次数全轮一个数，由服务端计：网关执行的在调用到达网关时计、超了网关拒；runner 执行的命令（到不了网关）在它上报开始时计，
  runner 自己按同一个上限在执行前拦下（§4.3 第 4 步）。
- **事件**：pi → AG-UI 的映射在服务端（`events.ts`），喂给它的事件也由服务端产生（§4.3 第 3 步：文字来自服务端调模型的流，工具条目来自
  服务端的回复与执行记录），因为 runner 随时可能被杀、而且不可信：收尾帧（关文字段、把还在转的工具标成「已中止」）
  和落库的 assistant 消息由服务端补齐。模型上下文**不**按上报的 `message_end` 重建：它是服务端维护的 transcript（§4.3 第 2 步）；被杀时最后一批缺的工具结果补成「结果未知」。
- **会话持久化**：服务端仍是唯一写库方，runner 只上报事件、不交「最终结果」。
- **模型请求（§4.3）**：服务端自己调模型（第 1 步，已实现：runner 用 pi 的 `streamProxy`，取代原来的 `/llm/*` 透传）；
  上下文只用服务端为每个 agent 维护的 transcript，runner 送来的上下文都不进请求、不落库（第 2 步，已实现）；runner 只送空的上下文、不上报消息（第 4 步，已实现）。
- **叫停**（中止 / 超时 / 失权 / 步数超限 / 进程退出）：作废这一轮在网关上的登记（令牌即刻 401、在途的上游模型请求掐断），
  驱动立即杀掉沙箱（`process`：整个进程组 SIGKILL，ffmpeg 一起），等它退出、照常收尾。沙箱没报收尾就退出 → RUN_ERROR 写明原因。
- **一轮只在发起它的副本上有登记**（run 注册表在进程内存，F14）：runner 必须连回同一个实例。`process` 驱动天然如此
  （网关地址默认本机回环）；`oci` 驱动的网关地址是「容器里看到的这个实例」（默认 `host.docker.internal:<PORT>`，§7.2），
  同一台机器上多个实例各有各的地址；`k8s` 驱动的网关地址是**发起它的那个服务端 Pod 的 IP**（Downward API 注入的 `POD_IP`，
  默认 `http://$POD_IP:$PORT`，§7.5），不经 Service —— Service 会把请求分给任意副本，别的副本上没有这一轮的登记（401）。

### 4.1 工作负载凭证

| 驱动 | 凭证 | 换取 |
|---|---|---|
| `process` / `oci` | 起沙箱时注入**一次性 bootstrap token**（绑定 runId，只存哈希，兑换一次即废） | 首次兑换得 run 短令牌，之后用短令牌续期 |
| `k8s`（四期实现） | 同上：一次性 bootstrap token 放在 Pod 的 env 里；`automountServiceAccountToken: false` | 同上 |
| `k8s`（原方案，未做） | projected ServiceAccount token（audience=`shadecn-agent-sts`，10 分钟，kubelet 轮换） | 网关经 TokenReview 校验 Pod → run 映射 |

- 四期没做 projected token + TokenReview：那要求每一轮一个独立的 ServiceAccount（或按 Pod 名 / uid 在 TokenReview 结果里认 run），
  服务端还要有 `tokenreviews create`（集群级）和建 ServiceAccount 的权限，换来的只是「token 不进 Pod 规格」。
  bootstrap token 60 秒内有效、兑换一次即废，runner 起来一两秒就兑换掉；代价是**能 `get` 沙箱命名空间里 Pod 的人在那几秒里看得到它**
  （见 §7.5「凭证可见性」）。

### 4.2 网络

- 沙箱只能访问网关；`k8s` 用默认拒绝 + 仅放行服务端 Pod 网关端口的 NetworkPolicy（四期：按 Pod 选择，不经 Service；不放行 DNS，§7.5）。
- `oci`：沙箱进专用网络，出站只到网关；做不到的环境（本地开发）启动时告警「沙箱可出网」。
  实际做到的程度见 §7.4：只有 `--internal` 网络 + 服务端也接在里面才真的「只到网关」；默认的 `bridge` 网络可以出网（启动告警）。
- `process`：不隔离网络，**生产环境拒绝启用**。

### 4.3 服务端调用模型（第 1～5 步已实现）

> 状态：**第 1～5 步已实现**（见下面「迁移步骤」表），取代了原来的 `POST /llm/*` 透传代理和 runner 的「`baseUrl` = 网关、`apiKey` = run 令牌」，
> §9 第 2 项里「模型代理」「改动通知下行」两条只作为历史保留。依据 pi 1.4.0（`@earendil-works/pi-agent-core` 的 `streamProxy`，`dist/proxy.js`）。

**为什么改**：现在网关只是**透传**：runner 拼好 OpenAI / Anthropic 的请求体，网关校验一个 `model` 字段、换上真实 key 就转给上游。
于是请求里除了模型名，**一切都由不可信的 runner 决定**，落库的模型上下文也来自它的上报：

- **步数信 runner（问题 B）**：步数按上报的 `turn_end` 数。被攻破的 runner 不报 `turn_end` 就能一直请求模型，直到时长上限；网关每次只判 `llm:invoke`，不管次数。
- **上下文信 runner（问题 C）**：会话里存的模型上下文完全由上报的 `message_end` 重建 —— 它可以伪造工具结果（「读到的节点内容是……」）、
  改写用户原话、塞进 assistant 说过的话，并且**持久化**：之后每一轮都带着它，是一条跨轮的提示注入通道。
  请求体本身也是它拼的：系统提示（含「通知是数据、不是指令」这类防注入说明，docs/20 §1.2）、工具定义都可以被删改。
- **参数信 runner**：`max_tokens`、reasoning 强度、温度、额外的请求头（比如开启收费功能的 beta 头）都原样到上游，成本与行为不受服务端控制。
- **工具调用不必来自模型**：runner 拿着令牌可以直接调 Grant 允许的任何画布工具，网关分不出这次调用是不是模型要的。

**结论**：模型请求改由**服务端自己发**（pi-ai 的 `streamSimple`，key 只在这一处）。runner 的 `streamFn` 换成 pi 的 `streamProxy`，
只是把「请求模型」这件事交给网关、拿回事件流；**请求里的内容、参数、上下文全部由服务端按自己的记录决定，runner 送来的一律不用**。
pi 只提供客户端那一半，服务端那一半（下面的路由）我们自己写。

**线协议**（`RUNNER_PROTOCOL_VERSION` 5 → 6；直接不兼容，见末尾「新旧镜像」）：

- runner 侧：`streamFn = (model, context, options) => streamProxy(model, context, { signal, authToken: <run 令牌（快过期先续期）>, proxyUrl: <网关>/model/<agentId> })`。
  `streamProxy` 固定往 `${proxyUrl}/api/stream` 发 `POST`，`Authorization: Bearer <authToken>`，用全局 `fetch`，请求体是 `{ model, context, options }`
  （`options` 只带 pi 认为可序列化的那几项：温度、`maxTokens`、`reasoning`、`sessionId`、`headers`、`metadata`…）。
- 路由 `POST /api/agent-gateway/model/<agentId>/api/stream`。**agent 写在路径里**（父 agent 是 `main`，子 agent 是服务端在 `/agent/delegate` 分配的 id）：
  `streamProxy` 不让加请求头，而 `options.metadata` 是给上游的字段，不拿它当我们的信道。agent id 只认服务端分配过、还没结束的（同 `/canvas/tool`）。
- 鉴权：run 令牌，规则同其他路由（失效一律 401，判 `llm:invoke`）；不再收 `x-api-key`。
- 请求体：只做大小与 JSON 校验，**内容一个字段都不用**（见下表；第 1 步例外，见「迁移」）。runner 最终只送空的上下文，请求体上限随之从 32 MiB 降到普通路由的量级。
- 开流之前的拒绝回 JSON `{ "error": "<原因>" }` + 状态码（401 / 403 / 409 / 413 / 503）：`streamProxy` 只认 `error` 是**字符串**（把它拼成 `Proxy error: …`），
  现在给 SDK 用的 OpenAI 形状 `{ error: { message } }` 在这里会变成 `[object Object]`。
- 开流之后回 `200 text/event-stream`，每帧一行 `data: <ProxyAssistantMessageEvent 的 JSON>\n\n`：`start`、`text_*`、`thinking_*`、`toolcall_start`、
  `toolcall_end`（带完整的 `toolCall`）、`done { reason, usage }` / `error { reason, errorMessage, usage }`。**`toolcall_delta` 不转发**（见「#9265」）：
  `streamProxy` 在 `toolcall_start` 建好空的调用块，`toolcall_end` 整个覆盖，runner 拿到的定稿消息一样。
- 上游出错（含 pi-ai 重试用完）→ `error` 帧，`errorMessage` 是 pi 格式化好的原文（`<status>: <上游 JSON>`，前端 `modelError.ts` 照旧解析）；
  这一轮被叫停、或 runner 断开 → 服务端掐断上游，若连接还在就补一帧 `error { reason: 'aborted' }` 再正常结束 —— 取代现在按协议手写的 `stoppedFrame` / `guardedBody`，
  理由不变：中断是预期内的结局，不能变成 HTTP 层的流错误。流在终止帧之前断开时 `streamProxy` 自己报「连接被关闭」。

**服务端决定什么、不信 runner 什么：**

| 项 | 由谁定 | 理由 |
|---|---|---|
| 模型 | 服务端解析的那个（`model.ts`），runner 送的 `model` 不看 | 不需要再「校验 runner 送的是不是同一个」：它根本不进请求 |
| `maxTokens` / `reasoning` / 温度 / `samplingParams` / `transport` / `cacheRetention` | **完全由服务端定**（配置 + 每个 agent 的策略），不做白名单 | 白名单 + 钳制要逐项维护上下界、跟着 pi 加字段；完全不用更简单也更严。`maxTokens` 另有上限，见「#9265」 |
| 请求头、`metadata` | 只有模型配置里的 `headers`；runner 的一概不透传 | beta 头、组织头能开收费功能或换计费主体 |
| `identity`（UA、归属头） | 服务端定 | pi-agent-core 默认把请求归属到 pi 的 OpenRouter 应用，这是部署方的决定，不是 runner 的 |
| 系统提示 | 服务端：父 agent 用 `RunnerInput.systemPrompt` 那一份，子 agent 用 `/agent/delegate` 定的那一份 | 防注入说明不能被删 |
| 工具定义 | 服务端按**这个 agent 已加载的技能**从同一份注册表构造（+ `load_skill`；子 agent + `request_confirmation`，没有 `delegate_task`） | 和网关执行时的「已加载」检查同一个来源；runner 加不进、改不了描述 |
| 消息历史 | **服务端维护的权威 transcript**（下一段），runner 的 `context.messages` 不用 | 问题 C |
| 工具调用 | `/canvas/tool`、`/agent/delegate` 必须对得上**服务端发出的、这个 agent 最近一条回复里还没结果的**那个调用（id 相同，名字、参数以服务端那份为准，runner 送的只用来核对，不一致就拒） | runner 不能再替模型做决定；最多不执行、或执行得慢 |

**权威 transcript（问题 C）**。两种做法：

- **A. 核对**：服务端维护一份，要求 runner 送来的 `context.messages` 与它对应（例如是它的前缀），不一致就拒绝。
  要比对就得先有完整的服务端 transcript，而 runner 那份还混着服务端不关心的字段：pi 的 system 消息（开头的系统提示 + 工具表、`toolsAdded`）、
  runner 时钟盖的 `timestamp`、`durationMs`、`thinkingLevel`、`streamProxy` 重建时丢掉的 `responseId`、图片（服务端存的是占位）……
  比对规则要把这些都去掉，跟着 pi 的内部字段变；比不上就拒绝，pi 一升级就可能误杀正常的轮次。安全性一点不比 B 多。
- **B. 只用服务端 transcript**（**推荐**）：服务端为每个 agent 各维护一份，runner 送来的消息一律不看（第 4 步起它只送空的）。
  这份 transcript 的每一段都有服务端自己的来源：

  | 段 | 来源 |
  |---|---|
  | 开头的 system 消息 | 服务端的系统提示 + 这个 agent 一开始加载的技能的工具（`createInitialSystemMessage`） |
  | 之前几轮 | 库里的 `llmMessages`（父 agent；子 agent 没有） |
  | 这一轮的用户消息 | 服务端拼的提示词（跨轮差异 + 展开提及 + 附件说明）；子 agent 是 `/agent/delegate` 给的那条 |
  | assistant 消息 | 服务端自己调模型的结果（`result()` 定稿；空 / 重复的调用 id 在这里补，`withToolCallIds` 从 runner 挪到服务端，补好的 id 随 `toolcall_end` 交给 runner） |
  | 网关工具的结果 | 网关的执行记录：回给 runner 的就是记进 transcript 的那一份（含图片，见下） |
  | `delegate_task` 的结果 | 服务端 `finishSubagent` 拼的那段（本来就不信 runner） |
  | 网关没执行的网关工具调用 | 服务端按 runner 会用的同一套规则算出结果：参数过不了 schema（pi-ai 同一个 `validateToolArguments`）、工具不存在 / 未加载、`request_confirmation` 没单独调用；都不是 → 「这次调用没有执行」。runner 报的不用。（第 4 步起 `load_skill` 没单独调用、超过工具调用上限由网关在调用到达时判，结果就是网关的执行记录） |
  | runner 执行的工具（`execution: 'runner'`：`run_media_command`、`request_confirmation`）的结果 | **唯一取 runner 上报的**（`tool_execution_end`）：只认服务端那条回复里确有、名字是 runner 工具的调用，内容限长、图片换占位 |
  | 被杀时没结果的调用 | 补「结果未知」（`completeToolResults` 照旧） |
  | `load_skill` 之后的 `toolsAdded` system 消息 | 服务端在那一批工具结果之后自己插（同 pi 的位置），只在这一轮内存里，不落库（现在也不落） |
  | 别人改动的通知 | 服务端插（下一段「通知」） |

  - **通知的插入点从 runner 挪到服务端**：一个**父 agent** 的模型请求进来时，若它的 transcript 正停在一批工具结果之后（不是这一轮第一次请求），
    服务端先冲掉合并窗口、把排着的并成一条用户消息追加进去，同时发 `agent.canvas-change` —— 这就是 docs/20 §3.10.2 的时机：一批工具调用之后、下一次请求之前；
    最终回复不调工具，runner 不会再请求，「写最终回复时不插」仍是结构保证。仍是**取**的形状（时机由「下一次请求」决定），不是推送；
    服务端冲窗口的那一刻也还是那一刻。`/canvas/changes` 从此恒回 `null`（老 runner 照常调、不出错），`steerId` 不再用（第 4 步连同路由一起删掉）。
    额外的好处：被攻破的 runner 不能再靠不取来扣下通知。
  - **请求的合法性**：同一个 agent 同时只能有一个在途请求（pi 的循环本来就是串行的；并行的子 agent 各算各的）；只有在它刚开始、或最近一条回复调了工具时
    才能再请求 —— 最近一条是最终回复、出错或中止之后再来请求 = runner 不守规矩，拒绝。最近一条回复的调用还有没出结果的，按上表补齐后再发。
  - **图片**：`view_node_media` 的图片块随执行记录进服务端这一轮的 transcript（只在内存里，受每轮图片字节预算限制），所以模型照样看得到；
    落库时仍换成占位（`slimMessage`），下一轮看不到之前的图片 —— 和现在一致。
  - **子 agent**：各自一份 transcript，`/agent/delegate` 时建、`/agent/finish` 后丢，不落库（现在也不落）。
  - **落库**：父 agent 的 transcript 去掉 system 消息、图片换占位，再按现在的规则补齐 / 裁剪（`completeToolResults` / `trimLlmHistory`）后存进会话。
    pi-ai 1.4.0 在失败的流里会把原始参数文本（`partialJson` / `partialArgs`）留在调用块上，存之前去掉。被叫停时那段半截回复不进上下文（与现在一致）。
  - **库里已有的上下文**是旧规则下由 runner 上报的，迁移不清洗；新规则只保证从这之后写进去的。
  - **对 pi 循环的兼容**：runner 里的 pi 照旧跑自己的循环、照旧在 `prepareNextTurnWithContext` 里并新工具（它要按新工具表执行调用），
    只是它的上下文不再进请求。两边看到的回复是同一条（服务端发的）、工具结果是同一份（服务端回的），差别只在 runner 不知道的通知和服务端代算的拒绝文字 ——
    它们只影响模型看到什么，不影响 runner 怎么执行。

**事件从哪来**（第 3 步，**已实现**，见「第 3 步的实现说明」）：对话记录、补发、旁观看到的 assistant 文字和工具条目原来由 runner 上报的事件映射而来，
被攻破的 runner 能让人看到、并且落库一段模型没说过的话（「我什么都没删」）。服务端有了自己的模型流和执行记录之后，
父 / 子 agent 的文字增量、回复定稿、网关工具的开始与结束都由服务端合成同名同形的事件喂给 `events.ts`（映射器不用改）；
runner 上报的只剩 runner 执行的工具的开始 / 结束。顺序天然对：网关工具在执行之前发开始，旁观者先看到条目、再看到画布变化。
改动量中等（`session.ts` 的事件入口 + 测试），不改协议。不做这一步，C 只解决了一半：模型看到的对了，人看到的仍可伪造。

**步数与请求上限（问题 B）**：**一次模型请求 = 一步**，在网关上按 agent 硬计数，取代按上报的 `turn_end` 计数：

- 父 agent 第 `maxTurns + 1` 次请求 → 不调上游，整轮以「超过本轮步数上限」停下（同现在的原因与结局）。和现在的差别只有一处：
  第 `maxTurns` 次正好是最终回复时，现在会被当成超限停掉，改后正常结束。
- 子 agent 超过 `maxTurns` 的请求 → 回 `error` 帧、标成步数用完（之后它的工具调用被拒），不调上游；runner 的 `finishTurn` 仍会自己停，但服务端不靠它。
- 原来挂在父 agent `turn_end` 上的两件事改挂在「父 agent 的下一次请求」上（服务端自己看得到）：清空在途的 `delegatedCalls`、
  关掉还挂着的子 agent（`abandonSubagents`，父 agent 卡在 `delegate_task` 里时不可能发请求）。`turn_end` 从此只用于界面。
- 被叫停、出错、runner 断开的请求同样算一步（请求已经发出去了）。

**重试、缓存、身份、中止**：

- **重试**：服务端调 `streamSimple` 时给 `maxRetries`（默认 2，同 SDK）与 `maxRetryDelayMs`。pi-ai 的 `retryProviderRequest` 只重试**建立请求**这一段
  （开始流式输出之前），退避可被中止信号打断，所以不会给 runner 发出重复的半截内容；重试期间请求算在途，不算空闲。
- **缓存**：`sessionId` 由服务端给（OpenAI 的 `prompt_cache_key` 和各家的会话亲和头都从它来）；`cacheRetention` 服务端定。取值见「已定」。
- **身份**：`identity` 由服务端给，取值见「已定」。
- **中止**：上游请求的信号 = 这一轮的 `runAbort` ∪ 这次 HTTP 请求的 `signal`（runner 断开、取消）。叫停时先作废登记、再 abort，在途的上游请求随之掐断；
  空闲上限照旧看「在途」：模型请求从进来算到服务端的流结束（或断开）为止。

**用量**：服务端拿到的 `usage`（输入 / 输出 / 缓存读写 token，按模型价格算出的费用）是可信的，runner 报的不再看。
每次请求结束打一行日志（`[agent-gateway] run=… agent=… step=n` + 用量），并累计进这一轮在运行日志 `agent_run` 上的用量列（第 5 步，见「第 5 步的实现说明」），
供审计和以后的每用户预算（docs/20 §3.10.6、§9 第 6 项的「预算计量」）。会话里不存。

**pi #9265（`streamProxy` 每个增量都重新解析整段工具参数）**：

- **1.4.0 受影响**，而且不只是 `streamProxy`：pi-ai 1.4.0 的三种线协议实现（`openai-completions` / `openai-responses` / `anthropic-messages`）
  同样在每个 `toolcall_delta` 上对累积的参数文本整段 `parseStreamingJson`。修复（增量解析器 `ToolCallArgumentsStream`）在 pi 仓库里，
  pi-ai 与 pi-agent-core 的 CHANGELOG 都还在 Unreleased，没发版。上游的说法：90 KB 的工具调用堆峰值约 140 MB、500 KB 的要几分钟。
  本机实测 1.4.0 的 `parseStreamingJson` 按 6 字一个增量累加解析：8 KB 约 50 ms、32 KB 约 0.6 s、64 KB 约 2.3 s、128 KB 约 9.4 s（CPU，二次方）。
- **影响**：现在这笔账在沙箱里付（runner 自己的 CPU 上限内）；改成服务端调用后，**服务端的 `streamSimple` 付同样一笔，而且在服务端主线程上**
  （分散在每个增量里，不是一整块阻塞，但并发的几轮会叠加）。参数多大由模型决定，画布内容里的注入可以诱导它输出超长参数。
  runner 那侧的 `streamProxy` 不受影响：服务端不转发 `toolcall_delta`。
- **对策**：① 服务端定 `maxTokens` 并设上限（输出 token 决定了参数最长能有多长）；② 服务端数每个调用累计的参数增量，
  超过「最大合法参数的若干倍」（按 `TOOL_LIMITS` 定，单次 data 补丁上限 32 000 字节）就掐断这次请求，以错误结果回给模型（参数过长），
  把最坏情况钉在一两秒 CPU 以内；③ pi 发版后升级（服务端这一半对着的线协议不变，升级不影响 runner）。
  另：1.4.0 失败的流把原始参数文本留在调用块上，落库前去掉（见上）。

**测试**：`registerScriptedModel` 仍是 HTTP 的假 OpenAI 上游，只是改由**服务端**的 `streamSimple` 去调（`ProviderRequestOptions.fetch` 注入它的 `fetch`，
三种线协议实现都把它交给 SDK 的客户端），所以照样走真实的 SDK 解析路径；它仍只认服务端那把 key，记下的 `requests` 现在就是服务端发出的请求，
可以直接断言「伪造的上下文没有进请求」。runner 侧照旧 `vi.stubGlobal('fetch', gatewayFetch(...))`（`streamProxy` 用全局 `fetch`），
于是测试里跑的就是 pi 真正的 `streamProxy` 对我们的服务端那一半，线协议的兼容性天然被钉住。新增的用例：runner 送伪造上下文 / 工具表 / 参数时上游收到的是服务端那份；
对不上服务端回复的工具调用、`delegate` 被拒；第 `maxTurns + 1` 次请求；同一 agent 并发请求；`toolcall_delta` 不出现在下行；叫停时的 `aborted` 帧；
开流前拒绝的 `{ error: string }` 形状；参数过长时掐断；用量日志。

**迁移步骤**（每步单独可验证、可提交）：

| 步 | 内容 | 协议 | 改动量 / 风险 |
|---|---|---|---|
| 1（**已实现**） | **传输换成服务端调用**：新路由与服务端调用模型（三种线协议分派、调用 id 补齐、参数 / 头 / `identity` / 重试 / `sessionId` 服务端定、不转 `toolcall_delta`、叫停发 `aborted` 帧、参数过长掐断）；runner 的 `streamFn` 换成 `streamProxy` 的包装；按 agent 数请求、同 agent 不并发（问题 B）；用量日志；删掉 `/llm/*` 透传（`LLM_PROXY`、`guardedBody`、`stoppedFrame`、头过滤）。**上下文仍取 runner 送的 `context`**（只校验形状与大小），系统提示与工具也还在里面 —— 这一步不解决 C，只换传输，所以现有用例应当原样通过 | 5 → 6 | 中等（网关 / runner / 测试工具各一处，删多于加）/ 低～中 |
| 2（**已实现**） | **权威 transcript**：服务端按上表维护每个 agent 的 transcript 并只用它发请求；工具调用与 `delegate` 绑到服务端回复；通知改由服务端在请求时插（`/canvas/changes` 恒回 `null`）；落库改用服务端 transcript | 不升（第 1 步的 runner 行为兼容）；动了 `protocol.ts` 就照规矩升 | 大（`session.ts` 核心路径）/ 高：要逐条对齐 pi 的行为（`toolsAdded` 的位置、runner 侧拒绝的文字、并行批的结果顺序），对抗性用例要多 |
| 3（**已实现**） | **事件由服务端产生**（见「事件从哪来」） | 不升 | 中 / 中 |
| 4（**已实现**） | **清理**：runner 只送空上下文、请求体上限降下来；`RunnerInput` 去掉 `llmMessages`；删 `/canvas/changes` 与 `steerId`；runner 侧的「单独调用 / 工具调用上限」拦截挪到网关（服务端不必再代算这两种文字）；父 agent 不再上报 `message_end` | 6 → 7 | 中（以删为主）/ 低 |
| 5（**已实现**） | **用量落库**（`agent_run` 加列，`finishRun` 写入） | 不升 | 小 / 低 |

**第 1 步的实现说明**（`packages/agent/src/model-stream.ts` + `gateway.ts` 的模型路由 + `session.ts` 的 `modelRequest`；runner 的 `runner/stream.ts` 删掉）：

- 输出 token 上限的配置是 `AGENT_MAX_OUTPUT_TOKENS`（实际取 min(模型的 `maxTokens`, 它)，不配 16384）；重试是常量 `maxRetries` 2、`maxRetryDelayMs` 60 秒（同 SDK），不加配置。
  `reasoning` / 温度 / `cacheRetention` / `transport` 这一步不设（与原来 runner 发出去的一致：思考关、缓存按 pi-ai 默认）。
- 开流前拒绝的状态码：401（令牌 / 失权 / 这一轮已停）、403（`llm:invoke` 不在授予范围、agent id 不认识或已结束）、404（路径不对）、
  409（同一 agent 已有在途请求、父 agent 超过步数上限）、413、400（请求体形状 / JSON）、503（没配模型）。
- **参数过长掐断的结局**（第 1 步）：这次模型请求以一帧 `error`（原因写明「工具调用参数过长」）结束，pi 按模型出错收尾这一轮（`model_error`）——
  第 1 步的上下文仍是 runner 的，服务端没有地方插入那条工具结果。**第 2 步已改成工具错误**，见下面「第 2 步的实现说明」。
- 步数不再看 `turn_end`：循环本身出错（`handleRunFailure`，没有请求模型）不再算一步；子 agent 用满 `maxTurns` 之后的结局仍由 runner 的 `finishTurn` 报成失败，
  服务端只在第 `maxTurns + 1` 次请求时标「步数用完」（之后它的工具调用被拒）。

**第 2 步的实现说明**（`packages/agent/src/transcript.ts` + `session.ts` 的 `modelRequest` / `executeTool` / `delegateTask` / 收尾 + `model-stream.ts` 的定稿；协议**没升**：`protocol.ts` 只改了注释，runner 只把「工具调用已达上限」那句话换成和服务端共用的常量）：

- **transcript 的形状**：每个 agent 一份，开头 system 消息（系统提示 + 这个 agent 的工具表，pi-ai 的 `createInitialSystemMessage`），父 agent 接库里的上下文
  （只认 user / assistant / toolResult 三种），再接服务端拼的这一轮提示词。工具表 = `load_skill`（子 agent 再加 `request_confirmation`）+ 已加载技能的工具，
  顺序同 runner 里 pi 的工具表。
- **回复先记、终止帧后发**：服务端的定稿（调用 id 已补齐、`partialJson` / `partialArgs` 已去掉）在终止帧写给 runner **之前**记进 transcript ——
  runner 一拿到终止帧就可能来执行工具。这一轮已被叫停时到的回复不记（半截回复不进上下文）。
- **服务端代算的拒绝**在回复定稿时就按 pi 的顺序算好：`stopReason: 'length'`（pi 的原文）→ 参数过长被掐断 → `Tool X not found`（对这次请求声明的工具表）→
  `validateToolArguments` → runner 的 `beforeToolCall`（先计数判「已达上限」、再判「必须单独调用」）。计数是全轮的、按 runner 的口径（找得到工具、参数合法的才计），
  在回复定稿时按先后编号；runner 在 `beforeToolCall` 时编号 —— 并行的子 agent 恰好在上限附近交错时两边可能编得不一样（网关自己的 `gatewayToolCalls` 硬上限不受影响）。
  被预判拒绝的调用，网关上同样以那句话拒绝。（第 4 步起计数和「单独调用」不再预判：由网关在调用到达时判，见「第 4 步的实现说明」。）
- **工具调用绑定**：`/canvas/tool` 在「工具不存在 / 未加载」两道检查之后、计数之前对上这个 agent 最近一条回复里还没有结果的调用（id、名字、参数都要一致，
  参数按服务端校验过的那份比较，键的顺序不算），执行用服务端的参数，同一次调用只执行一次。对上之后网关回给 runner 的每个结果都是那次调用在 transcript 里的结果；
  对不上的拒绝不记。`/agent/delegate` 同样要对上（任务说明 / 节点以服务端那份为准），结果是 `finishSubagent` 拼的那段。
- **结果补齐的时机**：这个 agent 的下一次请求进来时按调用顺序补（没有记录、也没预判的是「这次调用没有执行」，网关已开始执行却没等到结果的是「结果未知」）；
  收尾时最后一批没结果的一律「结果未知」。runner 执行的工具（`run_media_command`、`request_confirmation`）取它上报的 `tool_execution_end`，只留文字、限 8000 字。
- **通知**在父 agent 的下一次请求、补完结果（和 `toolsAdded`）之后插，`agent.canvas-change` 同时发出；`/canvas/changes` 恒回 `null`。
- **参数过长**：服务端掐断上游后把这条回复收成「调用了工具」（还开着的块补结束帧，被掐断的调用以空参数下发，其后才开始的块不下发），以 `done { reason: 'toolUse' }` 结束；
  runner 照常「执行」（参数过不了 schema 就本地报错，过得了的到网关被拒），下一次请求里这次调用的结果是「参数过长」的工具错误，这一轮继续。
- **落库**：父 agent 这一轮的那段去掉 system 消息、图片换占位，再 `completeToolResults` / `trimLlmHistory`；父 agent 一次模型请求都没发出去（runner 没起来、协议不对）就不留这一轮的用户消息。
  界面事件（对话文字、工具条目、子任务条目、模型错误文字）当时仍按 runner 上报的映射，第 3 步改掉（见下）。

**第 3 步的实现说明**（`session.ts` 的事件入口 `display` / `onEvents` / `modelRequest` / `executeTool` / `delegateTask` / `finishSubagent` / 收尾，
`gateway.ts` 的 `ModelRequestDecision.frame` 与 `modelRefused`，`transcript.ts` 的 `batchResult`；`events.ts` 的映射规则不变；协议**没升**：`protocol.ts` 只改了注释，runner 没改代码）：

- **喂给 `events.ts` 的事件**由服务端按 pi 事件的同名同形合成：

  | 界面上的 | 来源 |
  |---|---|
  | 父 agent 的文字增量 | 服务端调模型的流里每一个 `text_delta` / `text_end`（网关在写给 runner 之前交给编排层），攒 40ms 一批发出（同原来 runner 上报的节奏，补发日志不逐帧写）；仍是逐增量的流式 |
  | 回复定稿（关文字段、模型报错、子 agent 的回复文字） | 服务端的定稿（`ModelTurnResult`，和记进 transcript 的同一份）。`mapper.modelError` / `subtaskReply` 因此是服务端的 |
  | 工具条目的开始（名字、参数） | 服务端那条回复里的调用。网关工具在对上调用之后、执行之前开始；`delegate_task` 在 `/agent/delegate` 对上时开始（不再要求 runner 先报开始） |
  | 网关工具的结束 | 网关的执行记录（回给 runner 的那份，图片换占位） |
  | `delegate_task` 的结束 | 服务端 `finishSubagent` 拼的结果（派发被拒时是那句拒绝），紧跟在子任务的结束帧之后 |
  | 被 runner 就地拦下的调用（不存在、参数不对、超上限、没单独调用、输出被截断、参数过长） | 服务端代算的那句（= 模型下一步看到的那句） |
  | runner 执行的工具（`run_media_command`；子 agent 的 `request_confirmation` 不显示） | 结果取它上报的 `tool_execution_end`（transcript 里本来就取它），结束时的那句话取它报的 `summary`（限 200 字） |
  | 子任务的状态 / 问题 / 失败原因 | 服务端按子 agent 的 transcript 判：这一轮已停 › 步数用完 › 最近一条回复里有没被拦下的 `request_confirmation`（问题取那次调用的参数）› 最近一条回复出错 / 中止 › 调了工具却没再请求（步数到了被 runner 结束，或循环自己出错）› 完成。`/agent/finish` 报的 status / question / error / text 一概不用 |

- **时机**：runner 执行的调用、被它就地拦下的调用，服务端不知道 runner 什么时候走到它，就按它报的 `tool_execution_start` / `_end` 显示（只用作时机，内容仍取服务端的）；
  一次调用开始显示时，同一条回复里排在它前面、还没显示的先按调用顺序补上，所以条目的先后总是调用的先后；runner 什么都不报，
  这一批没显示完的在这个 agent 的下一次模型请求时（子 agent：交回时）补完，结果就是那时补进 transcript 的那句。叫停之后不再产生（同以前：叫停之后上报一律 401）。
- **runner 上报的事件还留着**（协议不变，第 4 步再删父 agent 的 `message_end`；第 4 步实际删掉了除工具开始 / 结束之外的全部，见下）：用作上面的时机、runner 执行的工具的结果、工具调用日志（runner 执行的 / 被拦下的那几种）、
  `delegatedCalls` 的清理；父 agent 循环自己出错时它报的原因只进服务端日志。`message_update` / `turn_end` 不用。
- **runner 没走完就收尾**（父 agent 调了工具之后没再请求模型、或一次都没请求过，且 runner 报的是正常收尾）：以前靠 runner 报的那条出错消息当「模型报错」，
  现在服务端自己判：最近一次请求在开流之前被网关拒了（如 `llm:invoke` 不在授予范围）→ `model_error`「模型请求被拒绝：<服务端的原因>」；
  否则 `run_failed`「agent 运行环境没有走完这一轮……」。子 agent 同理（「子任务没有做完 / 没有请求过模型」）。
- **事件序列的变化**（对照改动前的全部 agent 用例逐帧比较；其余用例逐帧相同）：子任务交回时 `delegate_task` 的 TOOL_CALL_RESULT 紧跟子任务的结束帧
  （以前等 runner 报，可能排在别的子任务的帧之后）；派发被拒的那次立即结束；被拦下的调用显示服务端代算的原因（参数过长时以前显示 runner 本地的 schema 报错）；
  runner 发来对不上的工具调用 / 派发时，条目的结果是模型看到的「这次调用没有执行」（以前是网关回给 runner 的那句）；循环自己出错见上一条。
- **测试**：`packages/agent/test/server-events.test.ts` —— runner 伪造文字增量 / 回复 / 模型报错、凭空的工具调用和改写的参数 / 结果、子 agent 的回复与 `/agent/finish` 的状态 / 问题时，
  事件流和落库的对话都是服务端那份；runner 一个事件都不报时事件流和老实上报时相同；上游卡在半句时前端已经收到前半句（流式）。

**第 4 步的实现说明**（`RUNNER_PROTOCOL_VERSION` 6 → 7；`protocol.ts` / `gateway.ts` / `runner/index.ts` / `runner/client.ts` / `session.ts` / `transcript.ts`）：

- **runner 只送空的上下文**：`streamProxy` 收到的是 `{ messages: [] }`；模型路由的请求体上限从 32 MiB 降到 64 KiB（`MODEL_BODY_LIMIT`），
  只校验是个 JSON 对象，内容一个字段都不用（送了非空的、在上限以内的照样不看，超了 413）。
- **`RunnerInput` 只剩 runner 真用得着的**：技能（提供 / 一开始加载）、模型描述、调用上限、工作目录的文件、`runId`。`llmMessages` 删了；
  **`systemPrompt`、`prompt` 也删了**（比表里多删两项：上下文送空之后它们在 runner 里没有用处，不必让用户原话、展开的节点内容进沙箱）。
  子 agent 的 `SubagentInput` 同理只剩 `agentId`、技能、步数上限。runner 里 pi 的 transcript 从空开始，`prompt('')` 起循环 —— 它只用来按服务端发回的回复执行工具。
- **删掉的线格式**：`/canvas/changes` 路由与 `CanvasChangesResponse`、`steerId`；`RunnerEvent` 只剩 `tool_execution_start` / `_end`
  （`message_update` / `message_end` / `turn_end` 删掉 —— 比表里的「父 agent 的 `message_end`」多：子 agent 的 `message_end`、文字增量、一批结束第 3 步起服务端就不用了；
  夹带它们的整批 400）；`SubagentFinishRequest` 只剩 `agentId`（状态 / 回复 / 问题 / 原因第 3 步起就是服务端判的）；`ToolCallResponse.terminate` 删掉
  （只给老镜像的 `load_skill` 用，老镜像现在在兑换时就被 409 拒掉）；`ModelStreamRequest` 换成「是个 JSON 对象」的判断。
- **拦截挪到网关**：工具调用上限与 `load_skill` 单独调用由网关在调用对上之后判（先计数、再判单独调用，同 runner 原来的顺序），拒绝的话与原来一字不差，
  回给 runner 的就是记进 transcript 的那一份；服务端在回复定稿时不再预判这两种。工具调用次数全轮**一个数**：网关执行的调用、`delegate_task`（它的拒绝也改成同一句）在网关上计；
  **runner 执行的命令**（`run_media_command`）到不了网关，改在它上报开始时计，超了的结果就是那句话 —— runner 按同一个上限在执行前拦下它（只拦这一类，`limits.maxToolCalls` 因此保留）。
  `request_confirmation` 没单独调用仍由 runner 拦、服务端在回复定稿时按同一条规则算（它在 runner 里执行、到不了网关；规则只看这条回复，两边不会不一致）。
  **`request_confirmation` 不再计入工具调用次数**（它是子 agent 交回的方式，审计日志本来也不记它；计进去的话服务端只能信 runner 的计数来判子任务是不是「需要确认」）。
- **上报的时机**：runner 在每次画布工具调用、每次模型请求之前冲事件（原来在 `turn_end` 时冲、再去取通知）—— 服务端在下一次请求时补齐上一批的结果，runner 执行的命令的结果要先到。
- **父 agent 循环出错的原因**原来随 `message_end` 上报、只进服务端日志；现在 runner 自己写一行日志（驱动把 runner 的输出收进服务端日志），协议里没有它。
- **老镜像**：第 6 版的 runner 在兑换 bootstrap 时就被 409 拒掉，以 `runner_protocol_mismatch` 收尾（不调模型、不留这一轮的上下文）。

要改写的规则与不变式：`.claude/rules/agent.md` 里网关的模型代理（只放行一个路径、校验 `model`、头过滤、协议内错误帧）、runner 的 `streamFn`（`runner/stream.ts`、
在 runner 里补调用 id）、「runner 不可信」那条（步数按 `turn_end`、上下文按 `message_end` 重建）、「别人的改动只在 runner 的 `prepareNextTurnWithContext` 里交」、
空闲上限的「上游响应体读完」、子 agent 按 `turn_end` 数步数、`model` 里「代理只能注入一个头里的 key」、测试工具的说明、图片「只往下行」；
本文 §4 的图与 §9 第 2 项；docs/20 §3.10.2 的插入时机、§3.10.8 空闲上限里的 `/llm`、§3.10.11「步数各算」；REQ-DEPLOY 里「网关的模型代理」的说法。
不变的：key 只在服务端；令牌、判权、Grant；`model.ts` 的 `CUSTOM_ENDPOINT_COMPAT`（服务端调用时同样生效）；上下文的裁剪规则。

**第 5 步的实现说明**（`session.ts` 的 `modelRequest` / 收尾、`store.ts` 的 `AgentRunUsage`、`apps/server` 的 `agent_run` 实体与 `store/agent.ts`；协议不升，runner 不变）：

- **落了什么**：`agent_run` 加五列 —— `input_tokens`（不含缓存命中 / 写入的输入，pi-ai 的 `usage.input`）、`output_tokens`、`cache_read_tokens`、
  `cache_write_tokens`、`cost_micro_usd`（费用，**百万分之一美元的整数**），都可空、`db:push` 直接加列。
  一轮一行、**父 agent 与全部子 agent 合计**，不分开记（子 agent 不是 run，预算按 run / 按人计；按 agent 的明细在每次请求的那行日志里）。
- **累计口径**：每次模型请求交回定稿时（网关的 `release`，和那行日志同一个 `usage`）加一次 —— 成功、出错、中止、参数过长被掐断的请求都算 pi 报了的那部分；
  上游直接拒绝、一个 token 都没报的加 0；没调上游的（开流前拒绝、子 agent 步数用完那一帧）不算。这一轮被叫停之后才交回的回复不进上下文，用量照算（请求已经发出去了）。
  收尾写运行日志之前，最多等 5 秒让还在途的请求（叫停时被掐断的）交回定稿，等不到的那几次不计、打一行警告。
- **费用**：pi-ai 按模型价格表算（`calculateCost`，含分档价、1 小时缓存写入的倍价），各次请求的 `usage.cost.total` 相加，**整轮合计上**换成微美元舍入一次。
  只能用五种列类型（没有小数 / decimal），浮点列又不能精确求和，所以存整数；微美元在最便宜的模型上也分得出几十个 token，
  PG 的 32 位 `int` 上限约 2147 美元一轮（token 列同理，一轮到不了 21 亿），超出按上限记。
  **模型没有价格信息**（价格表全是 0：自定义端点、`ollama` 预设）→ 费用为空，而不是 0：「不知道多少钱」不能被预算当成「免费」。
- **空值**：`startRun` 写的那一行五列都是空，`finishRun` 才写（按 runId upsert，同其他收尾字段）；进程被硬杀、停在 `running` 的行和加列之前的旧行都是空 = 「没记」，与「一个 token 都没用」的 0 分得开。
  写失败照旧 fail open（运行日志是旁路）。
- **不展示**：这一步只落库，接口与前端都不出用量；每用户预算是规划（docs/20 §3.10.6）。

**新旧镜像**：直接不兼容。第 1 步把协议升到 6、第 4 步升到 7，老镜像在兑换 bootstrap 时就被 409 拒掉，这一轮以 `runner_protocol_mismatch` 收尾（§7.2）；
不做双栈：`process` 驱动永远一致，`oci` / `k8s` 的镜像和服务端同一次 CI 构建、同一个 tag，错位只出现在本地没重建镜像时，提示里已经写明怎么办。

**已定**（2026-10-30，均按建议）：

1. 上下文只用服务端 transcript（B），不核对 runner 送来的消息。
2. 事件也改由服务端产生，排在 transcript 之后的第 3 步（已实现）。
3. 通知插入点挪到服务端的「下一次模型请求」，时机规则不变；docs/20 §3.10.2「由 runner 执行」随之改。
4. 模型参数完全由服务端定；`maxTokens` 上限新增配置，默认 min(模型的 `maxTokens`, 16384)。
5. `sessionId`：父 agent 用会话 id（前后几轮都能命中缓存），子 agent 用 `<runId>:<agentId>`。
6. `identity`：关掉归属头（`attribution: null`），UA 用自定义的 `shadecn-agent`。
7. #9265：先上线 + 两道缓解（`maxTokens` 上限、参数增量超过最大合法参数约 2 倍就掐断，阈值按 `TOOL_LIMITS` 定），pi 发版后升级。
8. 被叫停时的半截回复不进上下文（保持现状）。
9. Bedrock / Vertex 等要凭据链的协议不在这次放开，另立需求。
10. 用量：第 1 步只打日志，第 5 步在 `agent_run` 加列（已实现）。

## 5. 有效权限与撤销

```
effective(run) = grant.scopes ∩ current_perms(发起人, 画布) ∩ entitlements(服务端配置)
```

- `current_perms`：`canAccessFlow`（成员关系、画布仍在、仍属同一项目；个人画布仍是同一所有者）。
- `entitlements`：服务端配置（模型是否可用、沙箱命令白名单）。
- **判定位置**：网关每次请求；结果可缓存数秒。
- **Reconciler**：订阅现有撤销事件（`revokeCollabAccess` 的三个触发点：移除成员 / 删项目 / 删画布，
  经 `collab/revocation.ts` 跨实例广播）+ 每 10 分钟全量对账；按「用户 + 画布」找出受影响 run，执行 `on_revoke`。
- **stop**：撤销 Grant、作废 run 短令牌、驱动立即 kill 沙箱、这一轮以 cancelled 收尾并写明原因
  （「发起人已失去这张画布的访问权限」）。已写进画布的内容保留（之后由 REQ-AGENT §3.5 撤回）。
- 账号级安全事件（封禁、改密码等，接入点待定）撤销该用户全部 Grant。
- 一期取值：Grant 的绝对过期时间 = 签发时刻 + 一轮的时长上限 + `AGENT_GRANT_MARGIN_MS`（默认 60 秒）；判权结论缓存 3 秒；
  一轮结束时 Grant 随之关闭（`revoke_reason`「本轮已结束（…）」），已因失权撤销的保留失权原因。

## 6. 用户状态变化语义

| 事件 | 对任务的影响 |
|---|---|
| 会话过期（access / refresh） | 无 |
| 用户主动退出 | 默认无；后续提供「退出并停止所有任务」 |
| 关页面、断网 | 无（现有：一轮不随 HTTP 连接存亡） |
| 被移出项目 / 画布被删 / 项目被删 | 该画布上的 run `stop` |
| 用户取消某任务 | 撤销对应 Grant，停止对应 run |
| Grant 到期 | run 转 expired |
| 账号安全事件 | 撤销该用户全部 Grant |

## 7. 沙箱驱动

```ts
interface SandboxSpec {
  runId: string; flowId: string; ownerId: string; grantId: string
  image: string                          // agent-sandbox 镜像：Node + runner + ffmpeg，非 root
  resources: { cpu: number; memoryMiB: number; pids: number; diskMiB: number; deadlineMs: number }
  gatewayUrl: string                     // 沙箱里看到的网关地址
  credential: WorkloadCredential         // bootstrap token 或 k8s projected token 的配置
}
interface SandboxDriver {
  start(spec: SandboxSpec): Promise<SandboxHandle>
  reap(liveRunIds: ReadonlySet<string>): Promise<void>   // 清理服务端崩溃留下的孤儿
}
interface SandboxHandle {
  readonly id: string
  wait(): Promise<{ exitCode: number | null; reason?: string }>
  kill(reason: string): Promise<void>                    // 撤销 / 中止 / 超时：立即杀
}
```

| 驱动 | 实现 | 隔离 | 用途 |
|---|---|---|---|
| `process` | `node` 子进程跑 runner，env 从零造（只有网关地址 + bootstrap token） | 弱 | 本地开发；`NODE_ENV=production` 拒绝 |
| `oci` | Docker Engine API（unix socket，node `http`，不加依赖）；Docker 与 Podman 兼容 | `--read-only` + tmpfs、非 root、`--cap-drop ALL`、`no-new-privileges`、pids / 内存 / CPU 上限；Linux 主机有 gVisor 时 `--runtime runsc` | 本地（podman machine）、单机部署 |
| `k8s` | 每个 run 一个 Pod（label 同 `oci`），K8s API 直连（`node:https`，不加依赖） | Pod Security `restricted`（独立命名空间）或 ValidatingAdmissionPolicy（共用命名空间）、可选 gVisor RuntimeClass、NetworkPolicy、只读根文件系统、`resources` / `ephemeral-storage`、`activeDeadlineSeconds` | 生产（§7.5） |

- 服务端的 ServiceAccount 只在沙箱所在的命名空间有建 / 读 / 删 Pod 和读 Pod 日志的权限（当前部署是 `dev`，见 §7.5「部署形态」）；沙箱看不到 K8s API、不挂任何 socket。
- 沙箱镜像多架构，构建时用 `TARGETARCH` 与 `uname -m` 校验（REQ-DEPLOY §2.5.1）。
- 配置：`AGENT_SANDBOX=process|oci|k8s`、`AGENT_SANDBOX_IMAGE`、`AGENT_SANDBOX_OCI_SOCKET`、`AGENT_SANDBOX_OCI_NETWORK`、
  `AGENT_SANDBOX_RUNTIME`（可选 `runsc`）、`AGENT_SANDBOX_CPUS` / `_MEMORY_MIB` / `_PIDS` / `_DISK_MIB`、
  `AGENT_SANDBOX_K8S_*`（四期）、`AGENT_GATEWAY_URL`（沙箱看到的网关地址）。三期的取值与默认值见 §7.2，四期见 §7.5。
- 二期已有的配置：`AGENT_SANDBOX`（默认 `process`；一期的 `local` 当作 `process` + 媒体工具）、
  `AGENT_SANDBOX_EXEC=1`（给模型 ffmpeg / ffprobe 工具，即授 `sandbox:exec`）、`AGENT_SANDBOX_ALLOW_PROCESS=1`（生产也放行 `process`，不建议）、
  `AGENT_GATEWAY_URL`（默认 `http://127.0.0.1:<PORT>`）、`AGENT_TOKEN_SECRET`（签 run 短令牌；不配由 `SESSION_SECRET` 派生）。

### 7.1 本地开发

- 默认 `process`：不装容器也能跑，runner 由 `tsx` 直接执行，启动时告警「非强隔离」。
- 要验证隔离用 `oci` + podman machine（macOS 上是 Linux 虚拟机；没有 gVisor，只保证其它隔离参数与生产一致），步骤见 §7.3。
- `k8s` 驱动的本地验证用 kind / k3d；共享集群上的部署形态见 §7.5「部署形态」。

### 7.2 `oci` 驱动（三期）

**每轮一个容器**，Docker Engine API 直连 unix socket（Node 自带的 `http`，不加依赖；路径不带 API 版本前缀，
Docker 与 Podman 的 compat API 都按各自的当前版本处理）。runner、协议、网关与 `process` 驱动完全相同，差别只在隔离。

| 项 | 取值 |
|---|---|
| 容器名 / label | `shadecn-agent-<runId>`；`shadecn.agent/managed=true`、`/run`、`/flow`、`/grant`、`/instance`（本实例标识 = 网关地址的哈希） |
| 用户 | `10001:10001`（镜像里的 `sandbox` 用户；驱动也显式指定，镜像漏写 `USER` 也不会以 root 跑） |
| 文件系统 | 根文件系统只读；`/work`（工作目录，大小 = `diskMiB`）与 `/tmp`（64 MiB）是 `noexec,nosuid,nodev` 的 tmpfs —— 容器一停内容就没了；不挂任何卷、不挂引擎 socket |
| 权限 | `CapDrop: ALL`、`no-new-privileges`、引擎默认的 seccomp（不传任何 seccomp 选项）、非特权 |
| 资源 | 内存 = `memoryMiB`（不给 swap；tmpfs 也计入内存）、CPU = `cpu` 核（`NanoCpus`）、PIDs = `pids`（线程也算） |
| 运行时 | 可选 `AGENT_SANDBOX_RUNTIME`（Linux 上装了 gVisor 时 `runsc`）；不配用引擎默认（podman machine 上是 crun） |
| 环境变量 | 驱动只传 `SHADECN_GATEWAY_URL`、`SHADECN_BOOTSTRAP_TOKEN`、`SHADECN_WORKDIR`；`PATH` 来自镜像（镜像是 `FROM scratch` 拼出来的，配置里只有 `PATH`）。引擎自己会加 `HOSTNAME`、`HOME`（Podman 另加 `container=podman`），不是密钥 |
| 杀 | 编排层先作废令牌，驱动再 `SIGKILL` 容器；`wait()` 在容器退出**并删除**之后才兑现；`deadlineMs` 到点兜底杀；引擎失联时杀完最多再等 10 秒确认，之后放弃（留给孤儿清理），一轮不会卡死 |
| 结局 | 正常退出给退出码；被杀给原因；OOM 写明「内存超过上限 N MiB」 |
| 输出 | 容器日志（stdout / stderr）逐行进服务端日志 `[agent-runner] run=…`，上限与 `process` 驱动相同（500 行、每行 2000 字） |
| 孤儿 | 服务端启动时先自检（引擎版本、镜像在不在、网络是不是 internal），再按 label 删掉**本实例**的旧容器，之后每 10 分钟一次；别的实例（别的网关地址）的容器不碰 |

配置与默认值：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_SANDBOX=oci` | — | 生产可用（不受 `process` 的生产拒绝限制） |
| `AGENT_SANDBOX_IMAGE` | `shadecn-agent-sandbox:latest` | 沙箱镜像；不会自动拉取，起不来时错误里写明 |
| `AGENT_SANDBOX_OCI_SOCKET` | 自动找 | `DOCKER_HOST`（只认 `unix://`）→ `/var/run/docker.sock` → Linux 的 podman（rootless / rootful）→ macOS podman machine（`~/.local/share/containers/podman/machine/podman.sock`、`$TMPDIR/podman/podman-machine-default-api.sock`）→ Docker Desktop。只看文件系统、不调 CLI；找不到 = agent 未启用并写明原因 |
| `AGENT_SANDBOX_OCI_NETWORK` | `bridge` | 容器进哪个网络；`host` / `none` 拒绝；不是 `internal` 的网络启动时告警「可以出网」 |
| `AGENT_SANDBOX_RUNTIME` | 引擎默认 | 如 `runsc` |
| `AGENT_SANDBOX_CPUS` / `_MEMORY_MIB` / `_PIDS` / `_DISK_MIB` | 1 / 512 / 128 / 512 | 每个沙箱的上限（`process` 驱动不执行）。PIDs 含线程：runner 约 13 个，ffmpeg（x264）按 CPU 核数开线程（7 核实测峰值约 40）；内存峰值含页缓存，720p 编码实测接近 500 MiB，重的媒体任务要调大 |
| `AGENT_GATEWAY_URL` | `http://host.docker.internal:<PORT>` | 容器里看到的这个实例。Podman 5 与 Docker Desktop 都给容器加了这个名字（Podman 另有 `host.containers.internal`）；Linux 上的 Docker 没有，要显式配（如 `docker0` 的地址，服务端监听在上面） |

**沙箱镜像**（`apps/server/scripts/agent-sandbox/Dockerfile`，`pnpm build` 把它和 runner 一起放进 `output/agent-sandbox/`）：
node 22 alpine（≥ 22.19，pi 1.x 的要求）的 node 本体（npm / yarn / corepack 删掉）+ ffmpeg / ffprobe + runner 和它 import 到的 chunk +
runner 的 4 个第三方包（`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`yjs`、`@dagrejs/dagre`，版本锁到构建时装的那一个；
不含服务端的 hono / MikroORM / 数据库驱动）+ 非 root 用户 `sandbox`。构建期自检：架构与目标一致、runner 的 import 全部解析得到。
镜像里没有 `.env`、没有任何密钥（构建上下文里本来就没有）。**改了 `packages/agent` 的 runner 侧或协议就要重建镜像**：
镜像里的 runner 和服务端协议对不上时，网关会拒绝这一轮（见下面「版本一致性检查」）。

**版本一致性检查**（`oci` 的镜像是预先构建的，没重建就会和服务端错位；`process` 驱动直接跑源码，永远一致）两层：

- **协议版本，硬校验**：`packages/agent/src/protocol.ts` 的 `RUNNER_PROTOCOL_VERSION`（整数）。runner 在 bootstrap 兑换请求里带上自己的版本，
  网关不一致就拒绝（缺这个字段 = 老镜像，同样算不一致）：回 **409** `{ error: 'protocol_mismatch', runnerVersion, serverVersion, message }`
  （和令牌失效的 401 区分），这个 bootstrap 同时作废；runner 以**退出码 4** 退出。这一轮以 RUN_ERROR 收尾，错误码 `runner_protocol_mismatch`，
  消息「沙箱 runner 的协议版本 X 和服务端的 Y 不一致，请重建沙箱镜像（pnpm build:sandbox-image）」，服务端另打一条 warn。
  改了 runner ↔ 网关的协议就把版本号加一；`packages/agent/test/protocol-version.test.ts` 对 `protocol.ts`（去掉注释和空白）算哈希，
  版本号没跟着变就失败。
- **构建标识，软提示**：`pnpm build` 往服务端和 runner 两个入口注入同一个构建 id（`__AGENT_BUILD_ID__`，时间戳 + 随机数；源码运行是 `source`）。
  runner 在兑换请求里一并报上；双方都不是 `source` 且不相同时，服务端只打一条 warn「沙箱镜像和服务端不是同一次构建」，**不拒绝**
  （协议兼容就放行：镜像比服务端旧一个无关紧要的版本是常态）。

### 7.3 本地用 podman 跑 `oci`

```bash
# 1. 构建镜像（podman 优先，没有再找 docker；CONTAINER_CLI 可指定）。多给的参数原样交给 `build`：
pnpm build:sandbox-image
#    基础镜像默认是上游的 docker.io/library/node:22-alpine；要走镜像代理就用 build arg 指定，
#    构建容器要经代理出网时同理（podman machine 里 host.containers.internal 指向宿主）：
pnpm build:sandbox-image --build-arg NODE_IMAGE=<镜像代理>/docker.io/library/node:22-alpine
pnpm build:sandbox-image --build-arg HTTPS_PROXY=http://host.containers.internal:<端口>

# 2. 服务端（.env 或命令行）
AGENT_SANDBOX=oci pnpm dev
```

- podman machine 的 socket 一般能自动找到（mac-helper 的 `/var/run/docker.sock` 链接，或 `podman machine inspect` 的
  `ConnectionInfo.PodmanSocket.Path`）；找不到时把后者配给 `AGENT_SANDBOX_OCI_SOCKET`。
- **服务端照常只听 127.0.0.1**：podman machine（gvproxy 用户态网络）把容器里的 `host.docker.internal` / `host.containers.internal`
  转到 macOS 的回环地址，容器连得到 `127.0.0.1:<PORT>` 上的服务端。Linux 上的 podman / docker 不是这样（那个名字是宿主网卡的地址），
  服务端要监听在容器够得着的地址上。
- 启动日志里有一行 `[agent] oci 沙箱：Podman Engine 5.x（API 1.44，<socket>），镜像 …，网络 bridge，网关 …`，
  以及「oci 沙箱可以出网」的告警（默认网络，见 §7.4）。镜像不存在会另有一条告警。
- 跑真实引擎的测试：`AGENT_SANDBOX_OCI_IT=1 TEST_DATABASE_URL= pnpm exec vitest run --project=server sandbox-oci`（默认跳过）。

### 7.4 隔离程度与已知限制

| 方面 | 本地（podman machine，默认 `bridge` 网络） | 单机生产（建议形态） |
|---|---|---|
| 环境变量 / 密钥 | 只有网关地址、一次性 bootstrap token、工作目录、`PATH`（+ 引擎加的 `HOSTNAME` / `HOME` / `container`） | 同左 |
| 文件系统 | 只读根 + `noexec` tmpfs；看不到宿主文件 | 同左 |
| 权限 / 系统调用 | 非 root、无能力、`no-new-privileges`、默认 seccomp；**没有 gVisor** | 同左 + Linux 主机装 gVisor 时 `AGENT_SANDBOX_RUNTIME=runsc` |
| 资源 | 内存 / CPU / PIDs / 工作目录大小都有上限 | 同左 |
| **网络** | **可以出网**：默认网络有 NAT，容器能访问外网；而且 `host.docker.internal` 落到 macOS 的回环地址，**宿主上所有只听 127.0.0.1 的服务（别的 dev server、ollama、映射到本机的数据库端口…）容器都连得到**。沙箱里没有任何凭据，但无鉴权的本机服务（如 ollama）可以被绕过网关直接调用。启动日志告警 | 服务端以容器运行并同时接入一个 `--internal` 网络（`docker network create --internal shadecn-agent`），`AGENT_SANDBOX_OCI_NETWORK=shadecn-agent`、`AGENT_GATEWAY_URL=http://<服务端容器名>:3000`：沙箱只连得到这个网络里的服务端，外网和宿主都不通（实测见 `sandbox-oci.test.ts` 最后一个用例）。服务端容器挂引擎 socket 是给**服务端**的权限，沙箱里不挂 |
| 凭证可见性 | 一次性 bootstrap token 在容器配置里（`podman inspect` 可见，有引擎权限的人本来就是 root 等价）；60 秒内兑换一次即废 | 同左 |

- 更严的出网控制在 `k8s` 驱动里由 NetworkPolicy 做（§7.5）；按目的地放行的出网网关仍未做。
- 日志走引擎默认的日志驱动：一轮结束容器即删，日志随之删除；一轮之内的日志量没有在引擎侧另设上限（转进服务端日志的有行数上限）。
- 镜像不会自动拉取：多机部署要先把镜像推到各台机器能拉到的仓库，`AGENT_SANDBOX_IMAGE` 写完整引用。

### 7.5 `k8s` 驱动（四期）

**每轮一个 Pod**，Kubernetes API 直连（Node 自带的 `https`，不加依赖，**不解析 kubeconfig**）。镜像、runner、协议、网关和 `oci` 驱动完全相同，
差别只在隔离由谁执行（kubelet + 准入 + CNI）。

**为什么是裸 Pod 不是 Job**：Job 的价值是「失败重来」和「控制器替你建 Pod」，这里都不要 —— runner 重跑会拿同一个**一次性** bootstrap token
再兑换一次（必然被拒），一轮的结局只由服务端判；多一层控制器只多一段建 Pod 的延迟、多一种要授权的资源、删的时候还要管级联。
`restartPolicy: Never` 的裸 Pod 正好是「跑一次、我们自己删」；节点挂了 Pod 不会被重建，这一轮按 runner 异常退出收尾。

**Pod 形态**（`k8sPodSpec`；清单测试 `apps/server/test/agent/k8s-manifests.test.ts` 和它对齐）：

| 项 | 取值 |
|---|---|
| 名字 / label | `shadecn-agent-<runId 转小写、_ 换成 ->`；label 同 `oci`（`shadecn.agent/managed=true`、`/run`、`/flow`、`/grant`、`/instance`） |
| 命名空间 | `AGENT_SANDBOX_K8S_NAMESPACE`；驱动默认独立的 `shadecn-agent-sandbox`（强制 Pod Security `restricted`），当前部署配成 `dev`（ValidatingAdmissionPolicy 兜底），见下面「部署形态」 |
| 生命周期 | `restartPolicy: Never`；`activeDeadlineSeconds` = 沙箱时长上限（一轮的时长上限 + 30 秒）；`terminationGracePeriodSeconds: 1` |
| 身份 / 宿主 | `automountServiceAccountToken: false`、`enableServiceLinks: false`、`hostNetwork` / `hostPID` / `hostIPC` / `shareProcessNamespace` 都是 `false` |
| 用户 / 权限 | Pod 级 `runAsNonRoot`、`runAsUser` / `runAsGroup` / `fsGroup` = 10001、`seccompProfile: RuntimeDefault`；容器 `allowPrivilegeEscalation: false`、`privileged: false`、`readOnlyRootFilesystem: true`、`capabilities.drop: [ALL]` |
| 文件系统 | `/work`（大小 = `diskMiB`）与 `/tmp`（64 MiB）是 `medium: Memory` 的 `emptyDir`（对应 `oci` 的 tmpfs，计入内存上限）；不挂别的卷 |
| 资源 | requests = limits（Guaranteed）：`cpu` = 核数 × 1000m、`memory` = `memoryMiB`、`ephemeral-storage` = 128 MiB（根文件系统只读、工作目录在内存里，节点磁盘上只剩**容器日志**，这就是日志量的上限：超了 kubelet 驱逐，结局写明「被节点驱逐」） |
| 可选 | `runtimeClassName`（gVisor）、`nodeSelector`（`AGENT_SANDBOX_K8S_NODE_SELECTOR`，如镜像只有 arm64 时 `kubernetes.io/arch=arm64`）、`imagePullSecrets`、`imagePullPolicy` |
| 环境变量 | 驱动只传 `SHADECN_GATEWAY_URL`、`SHADECN_BOOTSTRAP_TOKEN`、`SHADECN_WORKDIR`；`PATH` 来自镜像。kubelet 另外**无条件**注入 default 命名空间 `kubernetes` Service 的地址（`KUBERNETES_SERVICE_HOST` / `_PORT` / `KUBERNETES_PORT*`，`enableServiceLinks: false` 也去不掉），运行时加 `HOSTNAME`（可能还有 `HOME`）：都不是密钥，沙箱也没有 token、NetworkPolicy 不放行到 API |

**生命周期与超时**：

1. 建 Pod（失败的原因按 API 的回应写明：命名空间不存在 / 配额已满 / 没有权限 / 被准入拒绝 / 规格不合法；一次性 token 从错误信息里抹掉）。
2. 跟着 Pod 的状态：GET 一次，再从那个 `resourceVersion` 起 **watch**（单个 Pod 的 fieldSelector，60 秒一段）；watch 断开、到点或过期（410）
   就重新 GET 再 watch —— 断开期间的变化不会漏。选 watch 而不是轮询：终态几毫秒内就到（runner 收尾后服务端只等它 5 秒），
   长跑的一轮只占一条空闲连接，不是每秒一次 GET。
3. **Pending 有上限**：50 秒（比 bootstrap token 的 60 秒有效期短 —— 过了那个点起来也兑换不了）还没起来就删掉，原因写明卡在哪：
   调度不了（`PodScheduled=False` 的 message，如 `Insufficient memory`）/ 镜像拉不下来（`ErrImagePull` / `ImagePullBackOff` + 该查的配置项）/ 其他等待原因。
   `InvalidImageName`、`ErrImageNeverPull`、`CreateContainerConfigError`（如镜像以 root 运行）不会自己好，当场收尾。
4. 容器起来后跟随 `pods/log?follow=true` 逐行转进服务端日志 `[agent-runner] run=…`（k8s 的日志接口不分 stdout / stderr；500 行、每行 2000 字，
   到上限就断开日志流，单次最多拉 4 MiB）。
5. 终态（Succeeded / Failed）后读结局：退出码原样；`OOMKilled` → 「内存超过上限 N MiB」；`DeadlineExceeded` → 「超过沙箱时长上限」；
   `Evicted` → 「被节点驱逐」+ kubelet 的说明；128+n → 「被信号 n 结束」。
6. 删 Pod（`gracePeriodSeconds: 0` + uid 前提），**确认它不在了 `wait()` 才兑现**。
7. **杀** = 编排层先作废令牌，驱动再删 Pod（grace 0）：API 层面立即删除对象，节点上的容器由 kubelet 随后结束（kubelet 的最短宽限 2 秒：
   runner 是 1 号进程、不处理 SIGTERM，于是 2 秒后 SIGKILL）；这段尾巴里令牌已经无效，沙箱什么也做不了。
8. **API 失联有上限**：时长上限、Pending 上限、编排层的叫停都走同一条「杀」的路；杀了之后最多再等 10 秒确认删掉，之后放弃（留给孤儿清理），一轮不会卡死。

**孤儿清理**（启动时 + 每 10 分钟；按 `shadecn.agent/managed=true` 列沙箱命名空间里的 Pod）：

- 本实例（`instance` label）的：不在在跑的轮次里、也不是驱动正在管的，删（服务端容器在同一个 Pod 里重启时 Pod IP 不变，实例标识不变）；
- **别的实例的：只删过了它自己的 `activeDeadlineSeconds` + 5 分钟的**。实例标识是网关地址（Pod IP）的哈希，服务端 Pod 被替换后 IP 就变了，
  它留下的 Pod 再也没有「本实例」来认领；而过了时长上限的 Pod 不可能还属于哪个在跑的轮次（每个实例的驱动到点都会删它），所以任何副本都可以清。

**网络**（NetworkPolicy）：沙箱 Pod 入站全拒（服务端到 runner 不需要连进来，日志走 kubelet → API）；出站只放行服务端 Pod（`app=shadecn-learning`）的 TCP 3000。
**不放行 DNS**：网关地址是 IP，runner 不解析任何名字，放行 kube-dns 就多一条经 DNS 查询带出数据的路（显式配了带主机名的 `AGENT_GATEWAY_URL` 时才放行）。
共用 `dev` 的形态下策略只选中 `shadecn.agent/managed=true` 的 Pod（`k8s/agent-sandbox.yaml`），dev 里别的服务不受影响；独立命名空间的形态选中整个命名空间
（`k8s/variants/agent-sandbox.yaml`，清单里有注释掉的 DNS 放行段）。**需要集群执行 NetworkPolicy**：本集群是 k3s，自带内嵌 kube-router 的策略控制器
（server 参数里没有 `--disable-network-policy`；flannel 本身不执行策略）；换成不执行策略的 CNI 时它被静默忽略，那样沙箱可以出网。
**不要**给服务端 Pod 或整个 `dev` 加 ingress 策略：被选中的 Pod 会变成「只放行列出来的来源」，ingress-nginx 的流量就进不来了（`dev` 若本来就默认拒绝入站，才另加一条放行沙箱 → 3000）。
跨节点的 Pod 流量走 flannel 的 `wireguard-native` 后端，是加密的。

**F14 的 Pod IP 方案**：服务端 Deployment 用 Downward API 注入 `POD_IP`（`status.podIP`），`AGENT_SANDBOX=k8s` 时网关地址默认 `http://$POD_IP:$PORT`
（IPv6 加方括号；显式 `AGENT_GATEWAY_URL` 优先），服务端监听 `0.0.0.0`。没有 `POD_IP` 又没配 = agent 未启用并写明原因。

**凭据**：集群内用服务端 Pod 的 ServiceAccount（`/var/run/secrets/kubernetes.io/serviceaccount/{token,ca.crt}`，地址取 `KUBERNETES_SERVICE_HOST` / `_PORT`）；
**token 文件每个请求重新读**（projected token 由 kubelet 轮换，默认 1 小时），CA 启动时读一次。集群外开发显式给
`AGENT_SANDBOX_K8S_API_URL` / `_TOKEN_FILE` / `_CA_FILE`，或用 `kubectl proxy`（`http://127.0.0.1:8001`，token 文件配成空；注意它连的是 kubectl 当前的 context）；
`http://` 只许回环地址。

**凭证可见性**：bootstrap token 在 Pod 规格的 env 里，**任何能 `get` 沙箱所在命名空间里 Pod 的人都读得到**（服务端自己的 ServiceAccount、集群管理员、
被绑了 `view` / `edit` 一类角色的人）。它 60 秒内有效、兑换一次即废，runner 起来一两秒就兑换掉；但在那之前抢先兑换的人能拿到这一轮的 run 令牌
（权限 = 这一轮的 Grant），runner 则以 401 失败。所以**那个命名空间的 Pod 读权限只给服务端和管理员**（共用 `dev` 时，dev 里别的 CI / 服务账号若有 `pods get`，
也读得到 —— 这是共用命名空间的代价之一）。

**部署形态**（两种，驱动和镜像相同，差别只在命名空间和由谁兜底准入）：

| | **当前：共用 `dev` + ValidatingAdmissionPolicy** | **更强：独立命名空间 + Pod Security** |
|---|---|---|
| 清单 | `k8s/agent-sandbox.yaml`（ArgoCD 同步：服务端 SA、`dev` 里的 Role / RoleBinding、只选沙箱 Pod 的 NetworkPolicy）+ `k8s/variants/agent-sandbox-vap.yaml`（集群级，管理员 apply） | `k8s/variants/agent-sandbox.yaml`（Namespace、跨命名空间的 Role / RoleBinding、NetworkPolicy、ResourceQuota、LimitRange，管理员 apply） |
| 谁限死服务端能建的 Pod | VAP：只管 `dev` 里**服务端 SA 发起的** Pod CREATE，逐条拒绝（下表） | 命名空间强制 Pod Security `restricted` |
| 服务端 RBAC 的波及面 | `get` / `list` / `watch` / `delete` / `pods/log` 对 **`dev` 里所有 Pod** 生效（能读别的服务的 Pod 规格和日志、能删它们的 Pod —— 由各自的控制器重建）；RBAC 不能按 label 收窄 | 只有沙箱 Pod |
| 能挂的 Secret / SA | VAP 禁止一切非 emptyDir 卷、`envFrom`、`valueFrom`、非 default 的 SA、SA token —— 挂不到 `dev` 里别的服务的 Secret | 命名空间里只有拉镜像的那一个 Secret |
| 配额 | **没有集群级兜底**（`dev` 里加 ResourceQuota 会要求所有服务都写 requests / limits），只有每用户配额 | ResourceQuota 限并发 Pod 数和资源总量，LimitRange 限单个容器 |

切到更强的形态：apply `k8s/variants/agent-sandbox.yaml` → 在新命名空间建拉镜像的 Secret → 提交（`AGENT_SANDBOX_K8S_NAMESPACE=shadecn-agent-sandbox`，
从 `k8s/agent-sandbox.yaml` 删掉 `dev` 里的 Role / RoleBinding / NetworkPolicy，SA 留着），步骤在那份清单的文件头。

**ValidatingAdmissionPolicy**（`shadecn-agent-sandbox`，`failurePolicy: Fail`，绑定 `Deny`）：`matchConstraints` 只看 `dev` 里的 Pod CREATE，
`matchConditions` 只看 `system:serviceaccount:dev:shadecn-learning`（一次字符串比较，不会求值出错，别的用户、控制器替 Deployment 建的 Pod 都直接跳过）。
规则与 Pod Security `restricted` 对齐，再加几条只适合沙箱的（每条 message 以 `[规则名]` 开头）：

| 规则 | 要求 |
|---|---|
| `managed-label` | 带 `shadecn.agent/managed=true`（NetworkPolicy 也按它选中） |
| `single-container` / `no-init-containers` / `no-ephemeral-containers` | 只有一个容器，没有 init / ephemeral 容器 |
| `sandbox-image` | 镜像是 `192.168.68.95:31443/apps/shadecn-agent-sandbox:<tag>` |
| `no-host-namespaces` / `no-privileged` / `no-host-ports` / `no-sysctls` / `default-proc-mount` | 不共享宿主网络 / PID / IPC，不 privileged，没有 hostPort、sysctls，procMount 只能 Default |
| `emptydir-only` | 只有 emptyDir 卷（hostPath、secret、configMap、projected、csi、ephemeral… 都不行） |
| `no-env-from` / `no-value-from` | 不许 `envFrom`，环境变量只许字面值 |
| `no-service-account-token` / `default-service-account` | `automountServiceAccountToken: false`；`serviceAccountName` 只能是 `default` 或不填 |
| `run-as-non-root` / `no-privilege-escalation` / `drop-all-capabilities` / `read-only-root` / `seccomp` | `runAsNonRoot`（`runAsUser` 不能是 0）、`allowPrivilegeEscalation: false`、`drop: [ALL]` 且不加能力、只读根、`RuntimeDefault` / `Localhost` |

驱动生成的 Pod 满足每一条（清单测试用逐条等价的 TS 判定核对，见下）；`k8s/variants/agent-sandbox-vap-samples/` 是一份正例和二十来份各违反一条的反例，
管理员 apply 之后用 `kubectl create --dry-run=server --as=system:serviceaccount:dev:shadecn-learning -f …` 验证（文件头里有命令和期望输出）。
它只限**建 Pod**；读 / 删 / 日志的波及面见上表。

**RBAC**（Role，只在沙箱所在的命名空间）：`pods` 的 `create` / `get` / `list` / `watch` / `delete` + `pods/log` 的 `get`。没有 `secrets`、`pods/exec`、
`update` / `patch`、ClusterRole。服务端被攻破时，这份权限最坏只能在那个命名空间里建 Pod —— 而建出来的 Pod 由准入兜底（restricted 或 VAP：不能 hostPath / hostNetwork /
privileged、挂不了 Secret），NetworkPolicy 也罩着它建的沙箱 Pod，所以拿不到节点 root、也出不了网。

**启动自检**（决定启不启用）：`GET /version`（连不上 / 401 = 失败）→ 用 SelfSubjectAccessReview 逐项查上面 6 个权限（缺了 = 失败；能读 `secrets` /
`pods/exec` = 告警「权限多于需要」）→ dry-run 建一个沙箱 Pod（命名空间不在、过不了 Pod Security / VAP / LimitRange / RuntimeClass 的准入 = 失败；
配额此刻已满、准入 webhook 不支持 dry-run = 告警）→ **再 dry-run 一个只改成 privileged 的反例，它必须被拒**（被放行 = 准入兜底不在：命名空间没打 Pod Security 标签、
VAP 没 apply 或没匹配上这个 SA —— 这时服务端的 `pods create` 等于节点 root，算失败；反例撞上配额只告警）→ 镜像没写仓库地址、没配 RuntimeClass、服务端只听回环地址 = 告警。
**没过 = agent 未启用**（原因写在日志和面板上），也拒绝起 Pod；之后每 10 分钟（清孤儿之前）重查一次，**过了的也重查**：没过的过了就恢复，过了的兜底被拿掉（VAP 被删、Role 被删）就在那一轮停用，不等重启。详情只在第一次和结论变化时打日志。所以「先推送、后 apply VAP」不会有一段不设防的窗口，只是 agent 晚一会儿可用。

**gVisor**：`AGENT_SANDBOX_K8S_RUNTIME_CLASS=gvisor` + 清单末尾注释掉的 RuntimeClass（`handler: runsc`）。节点要装 runsc 并在 containerd 里配好那个 handler；
只有部分节点装了时用 RuntimeClass 的 `scheduling`（nodeSelector / tolerations）把沙箱调度过去（和 `AGENT_SANDBOX_K8S_NODE_SELECTOR` 叠加；驱动不配 tolerations）。
没配时启动日志告警「不是 gVisor」。本集群的 RuntimeClass 里没有 gVisor。

**配额兜底**（只有独立命名空间的形态有）：沙箱命名空间的 ResourceQuota 限同时在跑的 Pod 数（默认 20）和 CPU / 内存 / ephemeral-storage 总量 —— 每用户配额（REQ-AGENT §3.10.6）之外的
集群级上限；满了建 Pod 回 403，那一轮以「配额已满，稍后再试」失败。LimitRange 限单个容器（4 核 / 4 GiB / 1 GiB 日志），配错资源时 API 直接拒绝。

配置与默认值：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_SANDBOX=k8s` | — | 生产可用 |
| `AGENT_SANDBOX_IMAGE` | `shadecn-agent-sandbox:latest` | 和 `oci` 同一个镜像；集群里要写节点拉得到的**完整引用**（没写仓库地址启动时告警）。驱动不会构建 / 推送它；本仓库的 CI 和服务端镜像一起构建（同一个 tag，REQ-DEPLOY §4.2） |
| `AGENT_SANDBOX_K8S_NAMESPACE` | `shadecn-agent-sandbox` | 沙箱 Pod 建在哪（当前部署是 `dev`） |
| `AGENT_SANDBOX_K8S_NODE_SELECTOR` | — | 逗号分隔的 `key=value`，写进 Pod 的 `nodeSelector`（如 `kubernetes.io/arch=arm64`：镜像只构建了 arm64）；格式错 = agent 未启用并写明原因 |
| `AGENT_SANDBOX_K8S_RUNTIME_CLASS` | 节点默认 | 如 `gvisor` |
| `AGENT_SANDBOX_K8S_PULL_SECRET` | — | 沙箱命名空间里拉镜像的 Secret 名（kubelet 用，服务端不读 Secret） |
| `AGENT_SANDBOX_K8S_PULL_POLICY` | k8s 的默认 | `Always` / `IfNotPresent` / `Never`；认不出 = agent 未启用 |
| `AGENT_SANDBOX_K8S_API_URL` | `https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT` | 集群外开发用；`http://` 只许回环地址 |
| `AGENT_SANDBOX_K8S_TOKEN_FILE` / `_CA_FILE` | ServiceAccount 挂进来的 `token` / `ca.crt` | 配成空串 = 不用（`kubectl proxy` 不要 token；系统 CA） |
| `POD_IP` | — | Downward API 的 `status.podIP`；决定默认的 `AGENT_GATEWAY_URL` = `http://$POD_IP:$PORT` |
| `AGENT_SANDBOX_CPUS` / `_MEMORY_MIB` / `_DISK_MIB` | 1 / 512 / 512 | 同 `oci`；`_DISK_MIB` 是内存型 `emptyDir` 的大小 |

**清单**：

- `k8s/deployment.yaml`（ArgoCD 同步）：服务端的 `serviceAccountName`、`nodeSelector: kubernetes.io/arch: arm64`，和 env（`AGENT_SANDBOX=k8s`、`POD_IP`、
  `AGENT_SANDBOX_K8S_NAMESPACE=dev`、`AGENT_SANDBOX_IMAGE`（和服务端镜像同一个 tag，CI 一起写回）、`AGENT_SANDBOX_K8S_PULL_SECRET=harbor-pull-secret`、
  `AGENT_SANDBOX_K8S_PULL_POLICY=IfNotPresent`、`AGENT_SANDBOX_K8S_NODE_SELECTOR=kubernetes.io/arch=arm64`）。模型的配置（`AGENT_PROVIDER` / `AGENT_MODEL` /
  `AGENT_API_KEY`…）不在这里：来自带外的 ConfigMap / Secret `dev/shadecn-learning-agent`（`envFrom`、`optional`，REQ-DEPLOY §3.3），空值 / 没配 = agent 未启用。
- `k8s/agent-sandbox.yaml`（ArgoCD 同步）：当前形态在 `dev` 里的配套（见「部署形态」）。和 Deployment 同一次 sync，ArgoCD 按 kind 先建 ServiceAccount，
  所以 `serviceAccountName` 不会让 ReplicaSet 建不出 Pod（`dev` 的 AppProject 放行命名空间级的任意资源）。
- `k8s/variants/agent-sandbox-vap.yaml`（集群级，不进 ArgoCD）：VAP + 绑定，管理员 `kubectl apply`；`agent-sandbox-vap-samples/` 是验证用的样例 Pod。
- `k8s/variants/agent-sandbox.yaml`（不进 ArgoCD）：更强的独立命名空间形态，含注释掉的 gVisor RuntimeClass。

**已知限制**：

- **驱动和清单没在真实集群上跑通过**（部署形态已定为 `dev` + VAP，上线后的第一轮才是实测）。单元测试对着假的 k8s API（`packages/agent/test/sandbox/k8s-driver.test.ts`），
  清单测试（`apps/server/test/agent/k8s-manifests.test.ts`）用等价的 TS 判定核对 VAP；真集群的用例 `apps/server/test/agent/sandbox-k8s.test.ts` 默认跳过，
  要 `AGENT_SANDBOX_K8S_IT=1` 加显式的 `AGENT_SANDBOX_K8S_IT_API_URL` / `_NAMESPACE` 和 `AGENT_SANDBOX_IMAGE`（可选 `_GATEWAY_HOST` 跑完整一轮、`_NETPOL=1` 验出网限制、
  `_NODE_SELECTOR`；在 `dev` 里跑时 `kubectl proxy` 要带 `--as=system:serviceaccount:dev:shadecn-learning`，否则 VAP 不匹配、自检的反例会被放行）。
- **共用 `dev` 的代价**（「部署形态」表）：服务端的 SA 能读 `dev` 里所有 Pod 的规格和日志、能删 `dev` 里任何 Pod；没有并发沙箱数 / 资源总量的集群级上限。
  VAP 只管建 Pod。要收窄这些，换独立命名空间的形态。
- VAP 的 CEL 只在真集群里求值：字段名写错不会让 apply 失败（只在 `status.typeChecking` 里出告警）、对应的规则就成了空操作 —— 所以 apply 之后要看 typeChecking、
  跑一遍反例样例；启动自检的 privileged 反例也会兜住最要紧的那一条。
- **PIDs 上限不执行**：Pod 规格里没有这个字段，由节点 kubelet 的 `podPidsLimit` 统一设；`AGENT_SANDBOX_PIDS` 对 `k8s` 无效。
- `emptyDir` 不能设 `noexec` / `nosuid`（`oci` 的 tmpfs 能）：非 root + 无能力 + `allowPrivilegeEscalation: false` 让 setuid 无效，但沙箱能执行写进 `/work` 的文件 ——
  被攻破的 runner 本来就能执行任意 JS，这不扩大能力；gVisor 下系统调用面另有收窄。
- NetworkPolicy 是 L4：沙箱到得了每个服务端副本 3000 端口上的**全部路由**（匿名身份：没有 cookie，只有 run 令牌对网关有用）；收紧到 `/api/agent-gateway` 要 L7 策略
  （如 Cilium）或把网关拆到独立端口。runner ↔ 网关是 Pod 网络上的明文 HTTP（令牌在里面），需要加密就开 CNI 的透明加密（WireGuard / IPsec）；
  严格 mTLS 的服务网格会挡住它。
- 工作负载凭证是 env 里的 bootstrap token，不是 projected token + TokenReview（上面「凭证可见性」）。
- 日志接口不分 stdout / stderr，runner 的错误输出在服务端日志里是 info 级。
- 被强制删除时节点失联（kubelet 收不到）的容器会活到 kubelet 恢复为止；它的令牌已经作废。

## 8. 与原方案的差异

- **项目写锁不采纳**：画布是 CRDT 多人协作，同一画布多个 run 并行（REQ-AGENT §3.10.3），
  冲突靠原子操作、改动通知与写入前提条件解决。
- **每用户配额（`max_active` / `max_open`、原子准入）只做规划**（REQ-AGENT §3.10.6）。
- **策略引擎**（OpenFGA / Cedar / OPA）暂不引入：权限模型只有「项目成员 + 管理员」，`canAccessFlow` 足够；
  出现资源级 ACL 时再引入。
- 状态 `pending` 依赖配额排队，随配额一起规划。

## 9. 分期

1. **身份核心**（服务端，与大脑位置无关）：Grant / scope 表、run 状态机（running → success / cancelled / error / expired）、
   `authorize(capability)` 覆盖全部工具、Reconciler（事件 + 定时对账）执行 `stop`、中止即杀沙箱进程、审计字段 `grant_id`。
2. **网关 + runner + `process` 驱动**（**已实现**）：STS（bootstrap token → run 短令牌）、模型代理、画布工具 RPC、事件上报、改动通知下行；
   pi 搬进 runner 子进程；现有行为（SSE、补发、旁观、任务列表、改动通知、跨轮差异）保持不变。实现说明：
   - **令牌**：HS256（JWT 形状），声明见 §3，`exp` 10 分钟，续期要带有效未过期的令牌、且 Grant 仍有效（拿 `flow:read` 判一次）；
     bootstrap token 32 字节随机、只存 SHA-256、绑定 runId、60 秒内兑换、兑换一次即废。令牌与登记都在本进程内存：令牌只在发起它的副本上有效。
   - **网关不信令牌里的 scope**：每次调用都按这一轮的 `authorize` 判；判权失效 → 401（这一轮已被叫停），不在授予范围 → 403。
   - **改动通知下行做成「一批工具调用结束时 runner 来取」**（`/canvas/changes`），而不是服务端推送：§3.10.2 要求这一刻先冲掉合并窗口里
     攒着的改动，推送做不到这一点，取的时候服务端冲完窗口再交。（已改成服务端在父 agent 的下一次模型请求时直接插进 transcript，路由在 §4.3 第 4 步删掉。）
     **中止不经下行通知**：叫停 = 作废令牌 + 立即杀沙箱（§5 stop）。
   - **模型代理**按线协议放行：`openai-completions`（`/chat/completions`）、`openai-responses`（`/responses`）、`anthropic-messages`（`/v1/messages`）；
     请求体里的 `model` 必须是服务端配置的那个。其余协议（Bedrock、Vertex、Google 的 key 头…）这一期不支持，配了 = agent 未启用并写明原因；
     Anthropic 的 OAuth token（`sk-ant-oat`）这一期也不支持（需要额外的 beta 头）。pi 按地址猜的兼容开关（如 `chutes.ai`）在 runner 里看不到真实地址，需要时显式给 `compat`。
     （已由 §4.3 的服务端调用模型取代，第 1 步。）
   - **`sandbox:exec` 不经网关**（§3 表）：只决定给不给媒体工具，命令在 runner 的工作目录里跑。
   - **行为差异**：被中止 / 失权 / 超时的一轮，runner 被杀前还没进上下文的那段半截回复不再进模型上下文（对话记录里照样有已经流出来的文字）；
     最后一批没跑完的工具调用在模型上下文里补成「已中止」的错误结果。工具调用日志里画布工具的成败以网关的执行记录为准。
   - **生产环境**（`NODE_ENV=production`）默认拒绝 `process` 驱动 → 生产用 `oci`（三期）；确需 `process` 得显式 `AGENT_SANDBOX_ALLOW_PROCESS=1`。
3. **`oci` 驱动 + 沙箱镜像**（**已实现**）：podman / docker 跑通（本地实测 podman machine）。实现说明见 §7.2～§7.4，要点：
   - 驱动直连 Engine API（unix socket，零新依赖），容器配置固定收紧（只读根、tmpfs、非 root、`CapDrop: ALL`、`no-new-privileges`、资源上限）；
   - 网络「只到网关」只在 `internal` 网络 + 服务端也在里面时成立；本地默认网络可以出网，启动日志告警（验收 7 的「做不到就告警」）；
   - 容器里没有「父进程」关系，孤儿由服务端启动时（及之后每 10 分钟）按本实例的 label 清理；runner 是 1 号进程时不看父进程；
   - 镜像是 `FROM scratch` 拼的：配置里只有 `PATH`，基础镜像的 `NODE_VERSION` 等不会进沙箱环境；基础镜像走 build arg，默认上游官方引用。
4. **`k8s` 驱动 + 部署清单**（**已实现，未在真实集群上跑过**）：实现说明见 §7.5，要点：
   - 每轮一个裸 Pod（不用 Job），Kubernetes API 直连（零新依赖、不读 kubeconfig、token 文件每次请求重读）；Pod 规格满足 Pod Security `restricted`；
   - watch 跟状态，Pending 50 秒上限（小于 bootstrap token 的有效期）且原因写明，终态读退出码 / OOM / 超时 / 驱逐，删除（grace 0）确认后 `wait()` 才兑现；
   - F14：网关地址默认是发起它的服务端 Pod 的 IP（Downward API `POD_IP`）；
   - 孤儿：本实例的照 `oci` 清，别的实例的只清过了时长上限的（服务端 Pod 换了 IP 后旧 Pod 没人认领）；
   - 启动自检（权限、命名空间、dry-run 过准入）决定 agent 启不启用；
   - 清单：当前形态 = 共用 `dev`（`k8s/agent-sandbox.yaml` 由 ArgoCD 同步：SA、最小 RBAC、只选沙箱 Pod 的 NetworkPolicy）+ 集群级 VAP（`k8s/variants/agent-sandbox-vap.yaml`，替 `dev` 补 Pod Security 的缺口）；
     更强的独立命名空间形态（`restricted`、配额兜底、可选 gVisor）留在 `k8s/variants/agent-sandbox.yaml`；
   - 自检另 dry-run 一个 privileged 的反例，被放行就不启用（准入兜底不在）；`AGENT_SANDBOX_K8S_NODE_SELECTOR` 把沙箱钉在镜像有的那种架构上；
   - 原方案的 projected token + TokenReview **没做**，仍用一次性 bootstrap token（§4.1）。
5. **等待决策与恢复**：checkpoint、waiting_input / suspended、interactions + nonce、step-up、通知。需求见 [REQ-AGENT-HITL](24-agent-interaction.md)（本期恢复只基于模型上下文，不 checkpoint 沙箱）。
6. **部分撤销**：`perm_version`、`pause` / `degrade` / `finish_current`、按 effective 动态工具列表、结构化拒绝、预算计量。

## 10. 验收标准（一期～四期）

1. 沙箱进程 / 容器内读不到 LLM key、数据库连接串、会话密钥；环境变量只有网关地址与一次性凭证。
2. bootstrap token 兑换一次即失效；伪造 / 过期 / 别的 run 的短令牌调网关一律 401。
3. 把发起人移出项目：该画布上的 run 在一次对账内（本实例立即，跨实例 ≤ 撤销广播周期）被 kill，以 cancelled 收尾并写明原因；
   同一发起人在其它画布上的 run 不受影响。
4. 发起人退出登录 / 会话过期：run 照常跑完。
5. 中止一轮：沙箱（含正在跑的 ffmpeg）立即被杀，工作目录清理。
6. 审计能回答「谁、哪个 run、哪份 Grant、做了什么」。
7. `oci` 驱动下，沙箱访问网关以外的地址失败（本地开发环境若做不到，启动日志明确告警）。
   三期：`internal` 网络的部署形态下成立（外网、宿主都不通）；默认 `bridge` 网络（含本地 podman machine）做不到，启动日志告警「oci 沙箱可以出网」。
8. `k8s` 驱动下：沙箱 Pod 满足 Pod Security `restricted`（共用 `dev` 时满足 VAP 的每一条，VAP 的反例样例全部被拒）、不挂 ServiceAccount token；
   NetworkPolicy 生效时，沙箱只连得到服务端 Pod 的网关端口，外网、DNS、k8s API 都不通；服务端的 ServiceAccount 只在沙箱所在的命名空间有 Pod 的建 / 读 / 删 / 日志权限，读不到 Secret；
   准入兜底不在（privileged 的反例能建）时 agent 不启用；中止一轮 Pod 当场删除；Pending 起不来的一轮在 bootstrap token 失效前收尾并写明原因。
   **四期：以上由单元测试 + 清单测试覆盖，未在真实集群验证。**
