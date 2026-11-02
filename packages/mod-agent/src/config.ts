import path from 'node:path'
import { setting, type ConfigPath, type ConfigReader } from '@shadecn/server-kit/config'
import { defineModuleConfig, moduleEnvName } from '@shadecn/server-kit/kernel'
import type { RuntimeInfo } from '@shadecn/server-kit/platform'
import type { AgentHostConfig, AgentSandboxDriver } from './ports.ts'

export { AGENT_PROVIDER_KEY_ENV, agentProviderApiKey } from '@shadecn/agent/llm-providers'

/**
 * 画布 agent 模块的配置段：`modules.agent`（docs/28 §3.3）。环境变量名由路径推导（`modules.agent.model` → `MODULES_AGENT_MODEL`），环境变量优先于文件；
 * 默认值和校验都在这里，一处解析。
 *
 * **连接信息不在这一段**：地址、线协议、key、模型能力在底座的 `llm.providers`（`LLM_PROVIDERS`），这里的 `provider` 只是引用它的 key（或 pi 的内置提供方）。
 * 不在任何 schema 里的：按提供方退回的 key（`ANTHROPIC_API_KEY` 这类，`@shadecn/agent/llm-providers` 的 {@link AGENT_PROVIDER_KEY_ENV}）—— 那是各家 SDK 的约定变量名，
 * 只认环境变量（经平台的 `envVar`）。`POD_IP` 是 Downward API 注入的运行环境，也不是配置。
 */

export interface AgentPaths {
  /** 沙箱工作目录的根：`<dataDir>/agent-workspaces/<flowId>/<runId>`，一张画布一个项目目录 */
  workspaceDir: string
  /**
   * 模型表文件（docs/26 §3.4）：`default` 以外的模型。默认 `<dataDir>/agent-models.json`（不在仓库里；k8s 上就是数据卷里的那个文件），
   * `MODULES_AGENT_MODELS_FILE` 整个换掉（相对路径按应用根目录算；例如挂一个 ConfigMap 文件）。文件不存在 = 模型表只有 `default`，不是错误
   */
  modelsFile: string
  /**
   * agent 定义（docs/26 §3.1，`<name>.md`）随代码发布，不读外部目录、不可配：源码 `packages/agent/agents/`，
   * 产物 `output/server/agents/`（`scripts/build-server.mjs` 拷过去）
   */
  definitionsDir: string
  /** 文字技能（docs/26 §3.8，pi `SKILL.md`）同 agent 定义：源码 `packages/agent/skills/`，产物 `output/server/skills/`；目录不存在 = 没有 */
  textSkillsDir: string
}

export interface AgentConfig {
  host: AgentHostConfig
  paths: AgentPaths
}

const schema = {
  provider: setting('string'),
  model: setting('string'),
  thinking: setting('string'),
  titleModel: setting('string'),
  maxOutputTokens: setting('number'),
  modelsFile: setting('string', '模型表文件（docs/26 §3.4）'),
  tokenSecret: setting('string'),
  gatewayUrl: setting('string', '沙箱里看到的服务端地址'),
  grantMarginMs: setting('number'),
  leaseTtlMs: setting('number'),
  runIdleTimeoutMs: setting('number'),
  runTotalTimeoutMs: setting('number'),
  sandbox: {
    driver: setting('string', 'process / oci / k8s'),
    exec: setting('boolean', '给模型 run_media_command'),
    allowProcess: setting('boolean', '生产环境放行 process 驱动'),
    image: setting('string'),
    runtime: setting('string', 'OCI 运行时（如 runsc）'),
    cpus: setting('number'),
    memoryMib: setting('number'),
    pids: setting('number'),
    diskMib: setting('number'),
    oci: {
      socket: setting('string'),
      network: setting('string'),
    },
    k8s: {
      namespace: setting('string'),
      runtimeClass: setting('string'),
      pullSecret: setting('string'),
      pullPolicy: setting('string', 'Always / IfNotPresent / Never'),
      nodeSelector: setting('map', '沙箱 Pod 的 nodeSelector'),
      apiUrl: setting('string'),
      tokenFile: setting('string'),
      caFile: setting('string'),
    },
  },
}

type Read = ConfigReader<ConfigPath<typeof schema>>

/** 模块名：配置段 `modules.agent`、`/api/features` 的键 */
export const AGENT_MODULE = 'agent'

/** 这一项对应的环境变量名（报错 / 提示文案用，别手写）：`agentEnv('sandbox.driver')` → `MODULES_AGENT_SANDBOX_DRIVER` */
export function agentEnv(path: ConfigPath<typeof schema>): string {
  return moduleEnvName(AGENT_MODULE, path)
}

export const agentConfig = defineModuleConfig({
  schema,
  parse(read, runtime): AgentConfig {
    const modelsFile = read('modelsFile')?.trim()
    return {
      host: parseHostConfig(read, runtime),
      paths: {
        workspaceDir: path.join(runtime.dataDir, 'agent-workspaces'),
        modelsFile: modelsFile ? path.resolve(runtime.appRoot, modelsFile) : path.join(runtime.dataDir, 'agent-models.json'),
        definitionsDir: runtime.isBundle
          ? path.join(runtime.moduleDir, 'agents')
          : path.join(runtime.appRoot, 'packages', 'agent', 'agents'),
        textSkillsDir: runtime.isBundle
          ? path.join(runtime.moduleDir, 'skills')
          : path.join(runtime.appRoot, 'packages', 'agent', 'skills'),
      },
    }
  },
})

/**
 * 画布 Agent 的模型配置（REQ-AGENT，`docs/20-agent-canvas.md`）。
 *
 * 这里只做**配置 → 参数对象**这一步；拿它选模型是 `@shadecn/agent/llm-providers` 的 `resolveProviderModel` 的事（和模型表、应用表的 `llm` 驱动同一条路）。
 *
 * **拿不到模型或 key = agent 没开**，不是配错了：`GET …/agent` 回 `enabled: false`，
 * 发消息 503，**不影响启动** —— 这个仓库里大多数人不会配 LLM key。
 *
 * - `MODULES_AGENT_PROVIDER`：引用 `llm.providers` 的 key（连接信息、key、模型能力都在那边）；表里没有就当 pi 的内置提供方（`anthropic`、`ollama` 预设…），
 *   key 按提供方退回（{@link AGENT_PROVIDER_KEY_ENV}）。**只在服务端**：沙箱里的 runner 拿到的是 run 短令牌，真实 key 由网关的模型代理注入（docs/22 §4.1）；
 * - `MODULES_AGENT_MODEL`：模型 id；`ollama` 照 `ollama list`。模型的图片输入、上下文窗口、输出上限写在 `llm.providers.<id>.models` 里。
 *   每次请求实际的输出上限是 min(模型的 maxTokens, `MODULES_AGENT_MAX_OUTPUT_TOKENS` ?? 16384)；
 * - `MODULES_AGENT_THINKING`：请模型思考的等级（`minimal` | `low` | `medium` | `high` | `xhigh`）。不配 = 不请求思考（有的端点不请求也会吐思考，照样显示）；
 *   配了不认识的值等于没配，并在启动时警告。思考随对话流显示、落库（docs/20 §3.10.13）；
 * - 这三项是模型表里的 `default`（docs/26 §3.4）。其余的项在模型表文件里（`MODULES_AGENT_MODELS_FILE` 可换路径，见 {@link AgentPaths.modelsFile}），
 *   解析在 `./models.ts`；
 * - `MODULES_AGENT_SANDBOX_DRIVER`：沙箱驱动（docs/22 §7）—— pi 的推理循环跑在每轮一个的沙箱里：
 *   `process`（默认：本机 `node` 子进程，**不是强隔离**，`NODE_ENV=production` 时拒绝，除非 `MODULES_AGENT_SANDBOX_ALLOW_PROCESS=1`）；
 *   `oci`（每轮一个 Docker / Podman 容器，经 Engine API 的 unix socket；生产可用）；
 *   `k8s`（每轮一个 Pod，经 Kubernetes API；生产可用，清单在 `k8s/variants/agent-sandbox.yaml`，docs/22 §7.5）。
 *   一期的取值 `local` 当作 `process` + 开媒体工具，打一行提示；
 * - `MODULES_AGENT_SANDBOX_EXEC=1`：给模型 `run_media_command`（ffmpeg / ffprobe，在 runner 自己的工作目录里跑）。默认不开；
 * - `MODULES_AGENT_SANDBOX_IMAGE`：`oci` 的沙箱镜像（`pnpm build:sandbox-image` 构建），默认 `shadecn-agent-sandbox:latest`；
 * - `MODULES_AGENT_SANDBOX_OCI_SOCKET`：容器引擎的 unix socket（`unix://` 前缀可有可无）。不配按常见位置找
 *   （`DOCKER_HOST`、`/var/run/docker.sock`、Linux 的 podman、macOS 的 podman machine、Docker Desktop，见 `@shadecn/agent/sandbox/drivers` 的 `engineSocketCandidates`）；
 * - `MODULES_AGENT_SANDBOX_OCI_NETWORK`：容器进哪个网络，默认引擎的 `bridge`（**可以出网**，启动时告警）；
 *   只有 `--internal` 网络（服务端也接在里面）才真的「只能到网关」，见 docs/22 §7.2；
 * - `MODULES_AGENT_SANDBOX_RUNTIME`：OCI 运行时（Linux 上装了 gVisor 时 `runsc`），不配用引擎默认；
 * - `k8s` 驱动（docs/22 §7.5）：`MODULES_AGENT_SANDBOX_K8S_NAMESPACE`（沙箱 Pod 建在哪，默认 `shadecn-agent-sandbox`）、
 *   `MODULES_AGENT_SANDBOX_K8S_RUNTIME_CLASS`（如 gVisor 的 `gvisor`）、`MODULES_AGENT_SANDBOX_K8S_PULL_SECRET`（沙箱命名空间里拉镜像的 Secret 名）、
 *   `MODULES_AGENT_SANDBOX_K8S_PULL_POLICY`（`Always` / `IfNotPresent` / `Never`，不配用 k8s 的默认）、
 *   `MODULES_AGENT_SANDBOX_K8S_NODE_SELECTOR`（逗号分隔的 `key=value`，如 `kubernetes.io/arch=arm64`：镜像只有一种架构时把沙箱钉在那种节点上；
 *   格式错 = agent 未启用并写明原因）；
 *   API 地址默认按集群内的约定（`KUBERNETES_SERVICE_HOST` / `_PORT` + ServiceAccount 的 token / CA），集群外开发用
 *   `MODULES_AGENT_SANDBOX_K8S_API_URL` / `MODULES_AGENT_SANDBOX_K8S_TOKEN_FILE` / `MODULES_AGENT_SANDBOX_K8S_CA_FILE` 覆盖（**不读 kubeconfig**；两个文件配成空串 = 不用：
 *   `kubectl proxy` 不要 token，系统 CA 不要 CA 文件）；
 * - `MODULES_AGENT_SANDBOX_CPUS` / `MODULES_AGENT_SANDBOX_MEMORY_MIB` / `MODULES_AGENT_SANDBOX_PIDS` / `MODULES_AGENT_SANDBOX_DISK_MIB`：每个沙箱的资源上限
 *   （默认 1 核 / 512 MiB / 128 / 512 MiB；`process` 驱动不执行这几项）。PIDs 含线程：runner 自己约 13 个，ffmpeg（x264）
 *   按 CPU 核数开线程，实测 7 核的机器上峰值约 40 个。`MODULES_AGENT_SANDBOX_DISK_MIB` 是工作目录 tmpfs 的大小，tmpfs 计入内存上限；
 * - `MODULES_AGENT_GATEWAY_URL`：沙箱里看到的服务端地址（网关挂在它的 `/api/agent-gateway` 下）。默认：
 *   `process` → `http://127.0.0.1:<SERVER_PORT>`（runner 和服务端在同一台机器上）；
 *   `oci` → `http://host.docker.internal:<SERVER_PORT>`（Podman 5 与 Docker Desktop 都给容器加了这个名字；Linux 上的 Docker 没有，要显式配）；
 *   `k8s` → `http://<POD_IP>:<SERVER_PORT>`（`POD_IP` 由 Deployment 经 Downward API 注入 `status.podIP`）：一轮的令牌和登记只在发起它的副本的内存里，
 *   沙箱必须直连**这个** Pod，不能走 Service（会被分到别的副本，401）。没有 `POD_IP` 又没配 = agent 未启用并写明原因；
 * - `MODULES_AGENT_TOKEN_SECRET`：签 run 短令牌的 HMAC 密钥。不配时由 `MODULES_AUTH_SESSION_SECRET` 派生（加了域分隔，和会话的 HMAC 不是同一把）；
 *   两个都没有（只可能在开发环境，生产缺 `MODULES_AUTH_SESSION_SECRET` 起不来）就每次启动随机一把 —— 令牌本来就只在发起它的进程里有效；
 * - `MODULES_AGENT_GRANT_MARGIN_MS`：委托授权（Grant，docs/22）的绝对过期时间 = 签发时刻 + 这一轮的**总**时长上限 + 这个余量（默认 60 秒）。
 *   正常情况下一轮先撞上自己的时长上限（cancelled）；Grant 到期（expired）是兜底。
 * - `MODULES_AGENT_LEASE_TTL_MS`：任务登记、会话槽位、节点占用这些共享表条目的 TTL（默认 30 秒），持有者按它的一部分续期；
 * - `MODULES_AGENT_RUN_IDLE_TIMEOUT_MS`：一个 run 的空闲上限（默认 120 秒）：网关上既没有在途请求、也这么久没有新请求就停下；
 * - `MODULES_AGENT_TITLE_MODEL`：生成会话标题（docs/20 §3.9「会话标题」）用模型表里的哪一项，默认 `default`；可以指向模型表文件里一个更便宜的模型。
 *   `off` = 不生成，标题一直是首条消息的开头。写了表里没有的键启动即失败；
 * - `MODULES_AGENT_MAX_OUTPUT_TOKENS`：每次模型请求的输出 token 上限（docs/22 §4.3）。模型请求由服务端发、参数完全由服务端定，
 *   实际取 min(模型的 maxTokens, 它)；不配按 16384。它也决定了工具参数最长能有多长（pi #9265 的缓解之一）；
 * - `MODULES_AGENT_RUN_TOTAL_TIMEOUT_MS`：一轮含它全部被调用的 agent 的总时长上限（墙钟，默认 30 分钟，docs/20 §3.10.11）：等被调用的 agent 的时间不算进单轮上限，
 *   由它封顶；沙箱硬期限（`deadlineMs` / `activeDeadlineSeconds`）和 Grant 的绝对过期按它算。
 */
function parseHostConfig(read: Read, runtime: RuntimeInfo): AgentHostConfig {
  return {
  provider: read('provider')?.trim() || 'anthropic',
  model: read('model')?.trim() || 'claude-sonnet-4-6',
  /** 原样的字符串；合法性由 `@shadecn/agent/model` 判（`agent/index.ts` 里不合法就警告并当没配） */
  thinking: read('thinking')?.trim() || undefined,
  sandbox: resolveSandboxDriver(read('sandbox.driver')),
  sandboxExec: isOn(read('sandbox.exec')) || read('sandbox.driver')?.trim() === 'local',
  allowProcessInProduction: isOn(read('sandbox.allowProcess')),
  sandboxImage: read('sandbox.image')?.trim() || 'shadecn-agent-sandbox:latest',
  ociSocket: read('sandbox.oci.socket')?.trim() ?? '',
  ociNetwork: read('sandbox.oci.network')?.trim() || 'bridge',
  sandboxRuntime: read('sandbox.runtime')?.trim() ?? '',
  k8s: {
    /** 空 = 驱动的默认（`shadecn-agent-sandbox`） */
    namespace: read('sandbox.k8s.namespace')?.trim() ?? '',
    runtimeClass: read('sandbox.k8s.runtimeClass')?.trim() ?? '',
    pullSecret: read('sandbox.k8s.pullSecret')?.trim() ?? '',
    /** 原样带着，由 agent 装配点校验（认不出 = 未启用并写明原因） */
    pullPolicy: read('sandbox.k8s.pullPolicy')?.trim() ?? '',
    /** 原样带着，由 agent 装配点解析（`parseK8sNodeSelector`，格式错 = 未启用并写明原因）；空 = 不限节点 */
    nodeSelector: read('sandbox.k8s.nodeSelector')?.trim() ?? '',
    apiUrl: read('sandbox.k8s.apiUrl')?.trim() ?? '',
    /** `undefined` = ServiceAccount 的默认位置；`''` = 不用（不带 token / 用系统 CA） */
    tokenFile: read('sandbox.k8s.tokenFile'),
    caFile: read('sandbox.k8s.caFile'),
  },
  sandboxResources: {
    cpu: positive(Number(read('sandbox.cpus') ?? 1), 1),
    memoryMiB: Math.floor(positive(Number(read('sandbox.memoryMib') ?? 512), 512)),
    pids: Math.floor(positive(Number(read('sandbox.pids') ?? 128), 128)),
    diskMiB: Math.floor(positive(Number(read('sandbox.diskMib') ?? 512), 512)),
  },
  gatewayUrl: (read('gatewayUrl')?.trim() || defaultGatewayUrl(read('sandbox.driver'), runtime)).replace(/\/+$/, ''),
  tokenSecret: read('tokenSecret')?.trim() ?? '',
  grantMarginMs: nonNegative(Number(read('grantMarginMs') ?? 60_000), 60_000),
  leaseTtlMs: Math.floor(positive(Number(read('leaseTtlMs') ?? 30_000), 30_000)),
  runIdleTimeoutMs: Math.floor(positive(Number(read('runIdleTimeoutMs') ?? 120_000), 120_000)),
  runTotalTimeoutMs: Math.floor(positive(Number(read('runTotalTimeoutMs') ?? 1_800_000), 1_800_000)),
  /** 没配 / 不是正数 = undefined（`@shadecn/agent` 按 min(模型的 maxTokens, 16384)） */
  maxOutputTokens: positiveInteger(read('maxOutputTokens')),
  /** 生成会话标题用的模型表键；不配 = `default`，`off` = 不生成（标题只取首条消息的开头） */
  titleModel: resolveTitleModel(read('titleModel')),
  }
}

/** `MODULES_AGENT_TITLE_MODEL` → 模型表键；`off` / `none` / `0` / `false` = 不生成（undefined） */
function resolveTitleModel(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return 'default'
  return ['off', 'none', '0', 'false'].includes(value.toLowerCase()) ? undefined : value
}

function resolveSandboxDriver(raw: string | undefined): AgentSandboxDriver {
  const value = raw?.trim() || 'process'
  if (value === 'process' || value === 'oci' || value === 'k8s') return value
  // 一期的取值：那时 local = 「开本机沙箱的 ffmpeg 工具」；现在 runner 本身就在沙箱里
  if (value === 'local') {
    console.warn(`[agent] ${agentEnv('sandbox.driver')}=local 已改名：现在按 process 驱动 + ${agentEnv('sandbox.exec')}=1 处理（docs/22 §7）`)
    return 'process'
  }
  return { unknown: value }
}

function isOn(raw: string | undefined): boolean {
  return ['1', 'true', 'on', 'yes'].includes(raw?.trim().toLowerCase() ?? '')
}

/** 监听全部地址时，同机的沙箱从回环地址进来 */
function loopbackOf(listen: string): string {
  return listen === '0.0.0.0' || listen === '::' || listen === '' ? '127.0.0.1' : listen
}

/**
 * 沙箱看到的网关地址的默认值：`process` 同机走回环；`oci` 的容器里回环是容器自己，要走引擎给的宿主名。
 * podman machine（macOS）上这个名字落到宿主的回环地址，所以服务端照常只听 127.0.0.1 就够；
 * Linux 上它是宿主网卡的地址，服务端要监听在那上面（或配 `MODULES_AGENT_GATEWAY_URL`），见 docs/22 §7.2。
 * `k8s` 是本 Pod 的 IP（Downward API 的 `POD_IP`，IPv6 加方括号）：沙箱必须连回发起它的那个副本（F14），
 * Service 会把它分到任意一个副本。没有 `POD_IP` 就是空串 —— 装配点据此报「未启用」，不猜一个连不上的地址。
 */
function defaultGatewayUrl(sandbox: string | undefined, runtime: RuntimeInfo): string {
  const { port, host } = runtime
  const choice = sandbox?.trim()
  if (choice === 'oci') return `http://host.docker.internal:${port}`
  if (choice === 'k8s') {
    const podIp = runtime.envVar('POD_IP')?.trim()
    return podIp ? `http://${podIp.includes(':') ? `[${podIp}]` : podIp}:${port}` : ''
  }
  return `http://${loopbackOf(host)}:${port}`
}

/** 不是正的有限数（没配好）就用默认值 */
function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 正整数；没配 / 认不出 = undefined（按使用方的默认） */
function positiveInteger(raw: string | undefined): number | undefined {
  const value = Math.floor(Number(raw?.trim() || NaN))
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** 不是非负有限数（没配好）就用默认值 */
function nonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}
