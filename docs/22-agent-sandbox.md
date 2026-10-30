# REQ-AGENT-SANDBOX Agent 沙箱：身份、委托授权与执行运行时

> 状态：**一期（身份核心）、二期（网关 + runner + `process` 驱动）、三期（`oci` 驱动 + 沙箱镜像，§9 第 1～3 项）已实现**；四期起（`k8s` 驱动等）为方案。
> 一期已实现：Grant / scope 表（`agent_grant` / `agent_grant_scope`，签发时 scope = 请求的 ∩ 发起人当时的权限 ∩ 服务端配置）；
> run 状态机 running → success / cancelled / error / expired（线上 RUN_FINISHED 仍只有 success / cancelled，expired 在线上是 cancelled）；
> 全部工具执行前、每次请求模型前、画布每次读写前 `authorize(capability)`；失效即 `stop`（整轮立即停，cancelled + 原因，Grant 标撤销）；
> Reconciler（撤销事件本实例当场、跨实例经撤销广播 + 每 10 分钟全量对账，含到期）；中止即杀沙箱子进程、清工作目录；
> 审计字段 `grant_id`（`agent_run` / `agent_tool_call`）；账号级撤销 `revokeAllGrantsForUser`（接入点待定，见 §5）。
> 二期已实现：pi 推理循环搬进每轮一个的沙箱（runner），经网关 `/api/agent-gateway/*` 说话（§4，实现与原方案的差异见 §9 第 2 项的说明）；
> STS（bootstrap token → run 短令牌、续期）、模型代理、画布工具 RPC、事件上报、改动通知下行；`process` 驱动（生产拒绝）。
> 三期已实现：`oci` 驱动（每轮一个 Docker / Podman 容器，Engine API 直连 unix socket，生产可用）、沙箱镜像（`pnpm build:sandbox-image`）、
> 启动自检 + 孤儿容器清理；本地用 podman machine 跑通（§7.2、§7.3；本地的出网限制做到什么程度见 §7.4）。
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
          ├─ events.ts：runner 上报的 pi 事件 → AG-UI（映射只在这里）
          ├─ 画布：direct connection + tools.ts + flow-ops（工具在这里执行）、常驻观察、跨轮差异
          ├─ 落库：会话、运行日志、工具调用日志（画布工具以网关的执行记录为准）、Grant
          └─ authorize + Reconciler（一期）；真实 LLM key 只在模型代理里
                      ▲  run 短令牌（Bearer）
                      │
                 网关 /api/agent-gateway/*（会话登录闸之外，只认 run 短令牌）
                      ├─ POST /sts/token        bootstrap token → run 短令牌；带有效令牌续期
                      ├─ POST /run/input        本轮输入：系统提示、提示词（跨轮差异 + 展开提及）、模型上下文、Grant 允许的工具名、模型描述（无地址无 key）
                      ├─ POST /llm/*            模型代理：判 llm:invoke → 注入真实 key → 流式透传；叫停即掐断
                      ├─ POST /canvas/tool      画布工具：authorize(工具的能力) → 按 schema 再校验参数 → 执行（一次一个 Y 事务）
                      ├─ POST /canvas/changes   别人改动的通知（下行）：先冲合并窗口，排着的并成一条交给 runner
                      ├─ POST /events           裁剪后的 pi 事件分批上报（批次序号逐一递增）
                      └─ POST /run/finish       runner 收尾（随后令牌作废）
                      │
沙箱（runner：pi 推理循环，环境变量只有网关地址 + 一次性 bootstrap token + 工作目录 + PATH）
   ├─ 画布工具 = /canvas/tool 的代理（schema / 描述 / 能力来自同一份 tools.ts）
   ├─ 模型：pi 自带的 provider，baseUrl = 网关 /llm、apiKey = run 短令牌
   ├─ steer：只在调过工具的那一批的 turn_end 取通知并 steer（docs/20 §3.10.2 的时机规则在这里执行）
   └─ ffmpeg / ffprobe 在自己的工作目录里跑（runner 就是沙箱，sandbox:exec 不经网关）
```

- **runner**（`@shadecn/agent/runner`）：沙箱里的入口。启动时用 bootstrap token 换 run 短令牌，取本轮输入，跑 pi；
  事件裁成 `RunnerEvent`（`protocol.ts`，只留服务端要读的字段）分批上报。它**不决定结局**：成功 / 中止 / 出错、步数上限、
  时长上限、删除预算、补发缓冲、落库都在服务端。
- **画布工具**：schema / 描述在 runner 侧，执行在网关侧（复用 `tools.ts` 的校验与 `flow-ops`）。一次工具调用 = 一次网关请求 = 一个 Y 事务。
  工具调用次数 runner 先拦（回给模型），网关按同一个数硬拦。
- **事件**：pi → AG-UI 的映射在服务端（`events.ts`），因为 runner 随时可能被杀：收尾帧（关文字段、把还在转的工具标成「已中止」）
  和落库的 assistant 消息由服务端按已收到的事件补齐。模型上下文按上报的 `message_end` 重建；被杀时最后一批缺的工具结果补成「已中止」。
- **会话持久化**：服务端仍是唯一写库方，runner 只上报事件、不交「最终结果」。
- **叫停**（中止 / 超时 / 失权 / 步数超限 / 进程退出）：作废这一轮在网关上的登记（令牌即刻 401、在途的上游模型请求掐断），
  驱动立即杀掉沙箱（`process`：整个进程组 SIGKILL，ffmpeg 一起），等它退出、照常收尾。沙箱没报收尾就退出 → RUN_ERROR 写明原因。
- **一轮只在发起它的副本上有登记**（run 注册表在进程内存，F14）：runner 必须连回同一个实例。`process` 驱动天然如此
  （网关地址默认本机回环）；`oci` 驱动的网关地址是「容器里看到的这个实例」（默认 `host.docker.internal:<PORT>`，§7.2），
  同一台机器上多个实例各有各的地址；`k8s` 驱动要按实例路由，留到四期。

### 4.1 工作负载凭证

| 驱动 | 凭证 | 换取 |
|---|---|---|
| `process` / `oci` | 起沙箱时注入**一次性 bootstrap token**（绑定 runId，只存哈希，兑换一次即废） | 首次兑换得 run 短令牌，之后用短令牌续期 |
| `k8s` | projected ServiceAccount token（audience=`shadecn-agent-sts`，10 分钟，kubelet 轮换），`automountServiceAccountToken: false` | 网关经 TokenReview 校验 Pod → run 映射 |

### 4.2 网络

- 沙箱只能访问网关；`k8s` 用默认拒绝 + 仅放行服务端 Service 的 NetworkPolicy。
- `oci`：沙箱进专用网络，出站只到网关；做不到的环境（本地开发）启动时告警「沙箱可出网」。
  实际做到的程度见 §7.4：只有 `--internal` 网络 + 服务端也接在里面才真的「只到网关」；默认的 `bridge` 网络可以出网（启动告警）。
- `process`：不隔离网络，**生产环境拒绝启用**。

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
| `k8s` | 每个 run 一个 Pod（标签 `shadecn.agent/run`），K8s API 直连 | gVisor RuntimeClass、NetworkPolicy、只读根文件系统、`resources` / `ephemeral-storage`、`activeDeadlineSeconds` | 生产 |

- 服务端的 ServiceAccount 只在 `agent-sandbox` 命名空间有创建 / 删除 Pod 的权限；沙箱看不到 K8s API、不挂任何 socket。
- 沙箱镜像多架构，构建时用 `TARGETARCH` 与 `uname -m` 校验（REQ-DEPLOY §2.5.1）。
- 配置：`AGENT_SANDBOX=process|oci|k8s`、`AGENT_SANDBOX_IMAGE`、`AGENT_SANDBOX_OCI_SOCKET`、`AGENT_SANDBOX_OCI_NETWORK`、
  `AGENT_SANDBOX_RUNTIME`（可选 `runsc`）、`AGENT_SANDBOX_CPUS` / `_MEMORY_MIB` / `_PIDS` / `_DISK_MIB`、
  `AGENT_SANDBOX_NAMESPACE`（四期）、`AGENT_GATEWAY_URL`（沙箱看到的网关地址）。三期的取值与默认值见 §7.2。
- 二期已有的配置：`AGENT_SANDBOX`（默认 `process`；`oci` / `k8s` 配了 = agent 未启用并写明原因；一期的 `local` 当作 `process` + 媒体工具）、
  `AGENT_SANDBOX_EXEC=1`（给模型 ffmpeg / ffprobe 工具，即授 `sandbox:exec`）、`AGENT_SANDBOX_ALLOW_PROCESS=1`（生产也放行 `process`，不建议）、
  `AGENT_GATEWAY_URL`（默认 `http://127.0.0.1:<PORT>`）、`AGENT_TOKEN_SECRET`（签 run 短令牌；不配由 `SESSION_SECRET` 派生）。

### 7.1 本地开发

- 默认 `process`：不装容器也能跑，runner 由 `tsx` 直接执行，启动时告警「非强隔离」。
- 要验证隔离用 `oci` + podman machine（macOS 上是 Linux 虚拟机；没有 gVisor，只保证其它隔离参数与生产一致），步骤见 §7.3。
- `k8s` 驱动用 kind / k3d 本地集群验证，不碰共享集群。

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
node 22 alpine 的 node 本体（npm / yarn / corepack 删掉）+ ffmpeg / ffprobe + runner 和它 import 到的 chunk +
runner 的 4 个第三方包（`@mariozechner/pi-agent-core`、`@mariozechner/pi-ai`、`yjs`、`@dagrejs/dagre`，版本锁到构建时装的那一个；
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

- 更严的出网控制（按目的地放行的出网网关、NetworkPolicy）在四期 `k8s` 驱动里做。
- 日志走引擎默认的日志驱动：一轮结束容器即删，日志随之删除；一轮之内的日志量没有在引擎侧另设上限（转进服务端日志的有行数上限）。
- 镜像不会自动拉取：多机部署要先把镜像推到各台机器能拉到的仓库，`AGENT_SANDBOX_IMAGE` 写完整引用。

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
     攒着的改动，推送做不到这一点，取的时候服务端冲完窗口再交。**中止不经下行通知**：叫停 = 作废令牌 + 立即杀沙箱（§5 stop）。
   - **模型代理**按线协议放行：`openai-completions`（`/chat/completions`）、`openai-responses`（`/responses`）、`anthropic-messages`（`/v1/messages`）；
     请求体里的 `model` 必须是服务端配置的那个。其余协议（Bedrock、Vertex、Google 的 key 头…）这一期不支持，配了 = agent 未启用并写明原因；
     Anthropic 的 OAuth token（`sk-ant-oat`）这一期也不支持（需要额外的 beta 头）。pi 按地址猜的兼容开关（如 `chutes.ai`）在 runner 里看不到真实地址，需要时显式给 `compat`。
   - **`sandbox:exec` 不经网关**（§3 表）：只决定给不给媒体工具，命令在 runner 的工作目录里跑。
   - **行为差异**：被中止 / 失权 / 超时的一轮，runner 被杀前还没进上下文的那段半截回复不再进模型上下文（对话记录里照样有已经流出来的文字）；
     最后一批没跑完的工具调用在模型上下文里补成「已中止」的错误结果。工具调用日志里画布工具的成败以网关的执行记录为准。
   - **生产环境**（`NODE_ENV=production`）默认拒绝 `process` 驱动 → 生产用 `oci`（三期）；确需 `process` 得显式 `AGENT_SANDBOX_ALLOW_PROCESS=1`。
3. **`oci` 驱动 + 沙箱镜像**（**已实现**）：podman / docker 跑通（本地实测 podman machine）。实现说明见 §7.2～§7.4，要点：
   - 驱动直连 Engine API（unix socket，零新依赖），容器配置固定收紧（只读根、tmpfs、非 root、`CapDrop: ALL`、`no-new-privileges`、资源上限）；
   - 网络「只到网关」只在 `internal` 网络 + 服务端也在里面时成立；本地默认网络可以出网，启动日志告警（验收 7 的「做不到就告警」）；
   - 容器里没有「父进程」关系，孤儿由服务端启动时（及之后每 10 分钟）按本实例的 label 清理；runner 是 1 号进程时不看父进程；
   - 镜像是 `FROM scratch` 拼的：配置里只有 `PATH`，基础镜像的 `NODE_VERSION` 等不会进沙箱环境；基础镜像走 build arg，默认上游官方引用。
4. **`k8s` 驱动**：Pod 规格、RBAC、NetworkPolicy、RuntimeClass、projected token + TokenReview、孤儿清理。
5. **等待决策与恢复**：checkpoint、waiting_input / suspended、interactions + nonce、step-up、通知。需求见 [REQ-AGENT-HITL](24-agent-interaction.md)（本期恢复只基于模型上下文，不 checkpoint 沙箱）。
6. **部分撤销**：`perm_version`、`pause` / `degrade` / `finish_current`、按 effective 动态工具列表、结构化拒绝、预算计量。

## 10. 验收标准（一期～三期）

1. 沙箱进程 / 容器内读不到 LLM key、数据库连接串、会话密钥；环境变量只有网关地址与一次性凭证。
2. bootstrap token 兑换一次即失效；伪造 / 过期 / 别的 run 的短令牌调网关一律 401。
3. 把发起人移出项目：该画布上的 run 在一次对账内（本实例立即，跨实例 ≤ 撤销广播周期）被 kill，以 cancelled 收尾并写明原因；
   同一发起人在其它画布上的 run 不受影响。
4. 发起人退出登录 / 会话过期：run 照常跑完。
5. 中止一轮：沙箱（含正在跑的 ffmpeg）立即被杀，工作目录清理。
6. 审计能回答「谁、哪个 run、哪份 Grant、做了什么」。
7. `oci` 驱动下，沙箱访问网关以外的地址失败（本地开发环境若做不到，启动日志明确告警）。
   三期：`internal` 网络的部署形态下成立（外网、宿主都不通）；默认 `bridge` 网络（含本地 podman machine）做不到，启动日志告警「oci 沙箱可以出网」。
