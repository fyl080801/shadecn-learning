import path from 'node:path'
import { setting } from '@shadecn/server-kit/config'
import type { ModuleConfig } from '@shadecn/server-kit/kernel'
import type { RuntimeInfo } from '@shadecn/server-kit/platform'
import type { AgentHostConfig, AgentSandboxDriver } from './ports.ts'

/**
 * 画布 agent 模块的配置段：`modules.agent`（docs/28 §3.3）。每项对应一个环境变量（原名不变），环境变量优先于文件；
 * 默认值和校验都在这里，一处解析。
 *
 * 不在 schema 里的：按提供方退回的 key（`ANTHROPIC_API_KEY` 这类，{@link AGENT_PROVIDER_KEY_ENV}）—— 那是各家 SDK 的约定变量名，
 * 只认环境变量（经平台的 `envVar`）；文件里要写 key 就写 `apiKey`。`POD_IP` 是 Downward API 注入的运行环境，也不是配置。
 */

type Read = (envName: string) => string | undefined

export interface AgentPaths {
  /** 沙箱工作目录的根：`<dataDir>/agent-workspaces/<flowId>/<runId>`，一张画布一个项目目录 */
  workspaceDir: string
  /**
   * 模型表文件（docs/26 §3.4）：`default` 以外的模型。默认 `<dataDir>/agent-models.json`（不在仓库里；k8s 上就是数据卷里的那个文件），
   * `AGENT_MODELS_FILE` 整个换掉（相对路径按应用根目录算；例如挂一个 ConfigMap 文件）。文件不存在 = 模型表只有 `default`，不是错误
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
  provider: setting('AGENT_PROVIDER', 'string'),
  model: setting('AGENT_MODEL', 'string'),
  baseUrl: setting('AGENT_BASE_URL', 'string'),
  api: setting('AGENT_API', 'string'),
  apiKey: setting('AGENT_API_KEY', 'string'),
  imageInput: setting('AGENT_IMAGE_INPUT', 'boolean'),
  contextWindow: setting('AGENT_CONTEXT_WINDOW', 'number'),
  maxTokens: setting('AGENT_MAX_TOKENS', 'number'),
  thinking: setting('AGENT_THINKING', 'string'),
  titleModel: setting('AGENT_TITLE_MODEL', 'string'),
  maxOutputTokens: setting('AGENT_MAX_OUTPUT_TOKENS', 'number'),
  modelsFile: setting('AGENT_MODELS_FILE', 'string', '模型表文件（docs/26 §3.4）'),
  tokenSecret: setting('AGENT_TOKEN_SECRET', 'string'),
  gatewayUrl: setting('AGENT_GATEWAY_URL', 'string', '沙箱里看到的服务端地址'),
  grantMarginMs: setting('AGENT_GRANT_MARGIN_MS', 'number'),
  leaseTtlMs: setting('AGENT_LEASE_TTL_MS', 'number'),
  runIdleTimeoutMs: setting('AGENT_RUN_IDLE_TIMEOUT_MS', 'number'),
  runTotalTimeoutMs: setting('AGENT_RUN_TOTAL_TIMEOUT_MS', 'number'),
  sandbox: {
    driver: setting('AGENT_SANDBOX', 'string', 'process / oci / k8s'),
    exec: setting('AGENT_SANDBOX_EXEC', 'boolean', '给模型 run_media_command'),
    allowProcess: setting('AGENT_SANDBOX_ALLOW_PROCESS', 'boolean', '生产环境放行 process 驱动'),
    image: setting('AGENT_SANDBOX_IMAGE', 'string'),
    runtime: setting('AGENT_SANDBOX_RUNTIME', 'string', 'OCI 运行时（如 runsc）'),
    cpus: setting('AGENT_SANDBOX_CPUS', 'number'),
    memoryMib: setting('AGENT_SANDBOX_MEMORY_MIB', 'number'),
    pids: setting('AGENT_SANDBOX_PIDS', 'number'),
    diskMib: setting('AGENT_SANDBOX_DISK_MIB', 'number'),
    oci: {
      socket: setting('AGENT_SANDBOX_OCI_SOCKET', 'string'),
      network: setting('AGENT_SANDBOX_OCI_NETWORK', 'string'),
    },
    k8s: {
      namespace: setting('AGENT_SANDBOX_K8S_NAMESPACE', 'string'),
      runtimeClass: setting('AGENT_SANDBOX_K8S_RUNTIME_CLASS', 'string'),
      pullSecret: setting('AGENT_SANDBOX_K8S_PULL_SECRET', 'string'),
      pullPolicy: setting('AGENT_SANDBOX_K8S_PULL_POLICY', 'string', 'Always / IfNotPresent / Never'),
      nodeSelector: setting('AGENT_SANDBOX_K8S_NODE_SELECTOR', 'map', '沙箱 Pod 的 nodeSelector'),
      apiUrl: setting('AGENT_SANDBOX_K8S_API_URL', 'string'),
      tokenFile: setting('AGENT_SANDBOX_K8S_TOKEN_FILE', 'string'),
      caFile: setting('AGENT_SANDBOX_K8S_CA_FILE', 'string'),
    },
  },
}

export const agentConfig: ModuleConfig<AgentConfig> = {
  schema,
  parse(read, runtime) {
    const modelsFile = read('AGENT_MODELS_FILE')?.trim()
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
}

/**
 * 画布 Agent 的模型配置（REQ-AGENT，`docs/20-agent-canvas.md`）。
 *
 * 这里只做**环境变量 → 参数对象**这一步；拿它选模型（注册表 / 自定义端点 / 缺 key）是
 * `@shadecn/agent/model` 的事；没给 `AGENT_API_KEY` 时按提供方退回它自己的环境变量
 * （`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`…，映射见 {@link AGENT_PROVIDER_KEY_ENV}，经平台的 `envVar` 读）。
 *
 * **拿不到模型或 key = agent 没开**，不是配错了：`GET …/agent` 回 `enabled: false`，
 * 发消息 503，**不影响启动** —— 这个仓库里大多数人不会配 LLM key。
 *
 * - `AGENT_PROVIDER` / `AGENT_MODEL`：pi 注册表里的提供方与模型 id；`ollama` 是内置预设
 *   （本机 `/v1`、不要 key），模型名照 `ollama list`；
 * - `AGENT_BASE_URL` + `AGENT_API`：自建 / 代理端点（`openai-completions` | `anthropic-messages`），
 *   此时按这两项构造一个自定义模型，`AGENT_PROVIDER` 只当名字用；
 * - `AGENT_IMAGE_INPUT`：模型吃不吃图片（`1` / `0`）。不配按 pi 注册表的元数据，自建端点和 ollama 默认只吃文字；
 *   吃图片的模型才拿得到 `view_node_media`（看节点上的图，docs/20 §3.10.7），所以自建的多模态端点要显式配 `1`；
 * - `AGENT_CONTEXT_WINDOW` / `AGENT_MAX_TOKENS`：模型的上下文窗口、单次最多输出多少 token（正整数）。不配按 pi 注册表的元数据，
 *   自建端点和 ollama 按 128000 / 8192。窗口决定跨轮历史留多少、什么时候算超长；`AGENT_MAX_TOKENS` 是模型的能力，
 *   每次请求实际的输出上限是 min(它, `AGENT_MAX_OUTPUT_TOKENS` ?? 16384)；
 * - `AGENT_THINKING`：请模型思考的等级（`minimal` | `low` | `medium` | `high` | `xhigh`）。不配 = 不请求思考（有的端点不请求也会吐思考，照样显示）；
 *   配了不认识的值等于没配，并在启动时警告。思考随对话流显示、落库（docs/20 §3.10.13）；
 * - `AGENT_API_KEY`：显式的 key，优先于按提供方的环境变量（{@link AGENT_PROVIDER_KEY_ENV}）。**只在服务端**：沙箱里的 runner 拿到的是 run 短令牌，
 *   真实 key 由网关的模型代理注入（docs/22 §4.1）；
 * - 以上几项是模型表里的 `default`（docs/26 §3.4）。其余的项在模型表文件里（`AGENT_MODELS_FILE` 可换路径，见 {@link AgentPaths.modelsFile}），
 *   解析在 `./models.ts`；
 * - `AGENT_SANDBOX`：沙箱驱动（docs/22 §7）—— pi 的推理循环跑在每轮一个的沙箱里：
 *   `process`（默认：本机 `node` 子进程，**不是强隔离**，`NODE_ENV=production` 时拒绝，除非 `AGENT_SANDBOX_ALLOW_PROCESS=1`）；
 *   `oci`（每轮一个 Docker / Podman 容器，经 Engine API 的 unix socket；生产可用）；
 *   `k8s`（每轮一个 Pod，经 Kubernetes API；生产可用，清单在 `k8s/variants/agent-sandbox.yaml`，docs/22 §7.5）。
 *   一期的取值 `local` 当作 `process` + 开媒体工具，打一行提示；
 * - `AGENT_SANDBOX_EXEC=1`：给模型 `run_media_command`（ffmpeg / ffprobe，在 runner 自己的工作目录里跑）。默认不开；
 * - `AGENT_SANDBOX_IMAGE`：`oci` 的沙箱镜像（`pnpm build:sandbox-image` 构建），默认 `shadecn-agent-sandbox:latest`；
 * - `AGENT_SANDBOX_OCI_SOCKET`：容器引擎的 unix socket（`unix://` 前缀可有可无）。不配按常见位置找
 *   （`DOCKER_HOST`、`/var/run/docker.sock`、Linux 的 podman、macOS 的 podman machine、Docker Desktop，见 `@shadecn/agent/sandbox/drivers` 的 `engineSocketCandidates`）；
 * - `AGENT_SANDBOX_OCI_NETWORK`：容器进哪个网络，默认引擎的 `bridge`（**可以出网**，启动时告警）；
 *   只有 `--internal` 网络（服务端也接在里面）才真的「只能到网关」，见 docs/22 §7.2；
 * - `AGENT_SANDBOX_RUNTIME`：OCI 运行时（Linux 上装了 gVisor 时 `runsc`），不配用引擎默认；
 * - `k8s` 驱动（docs/22 §7.5）：`AGENT_SANDBOX_K8S_NAMESPACE`（沙箱 Pod 建在哪，默认 `shadecn-agent-sandbox`）、
 *   `AGENT_SANDBOX_K8S_RUNTIME_CLASS`（如 gVisor 的 `gvisor`）、`AGENT_SANDBOX_K8S_PULL_SECRET`（沙箱命名空间里拉镜像的 Secret 名）、
 *   `AGENT_SANDBOX_K8S_PULL_POLICY`（`Always` / `IfNotPresent` / `Never`，不配用 k8s 的默认）、
 *   `AGENT_SANDBOX_K8S_NODE_SELECTOR`（逗号分隔的 `key=value`，如 `kubernetes.io/arch=arm64`：镜像只有一种架构时把沙箱钉在那种节点上；
 *   格式错 = agent 未启用并写明原因）；
 *   API 地址默认按集群内的约定（`KUBERNETES_SERVICE_HOST` / `_PORT` + ServiceAccount 的 token / CA），集群外开发用
 *   `AGENT_SANDBOX_K8S_API_URL` / `_TOKEN_FILE` / `_CA_FILE` 覆盖（**不读 kubeconfig**；两个文件配成空串 = 不用：
 *   `kubectl proxy` 不要 token，系统 CA 不要 CA 文件）；
 * - `AGENT_SANDBOX_CPUS` / `AGENT_SANDBOX_MEMORY_MIB` / `AGENT_SANDBOX_PIDS` / `AGENT_SANDBOX_DISK_MIB`：每个沙箱的资源上限
 *   （默认 1 核 / 512 MiB / 128 / 512 MiB；`process` 驱动不执行这几项）。PIDs 含线程：runner 自己约 13 个，ffmpeg（x264）
 *   按 CPU 核数开线程，实测 7 核的机器上峰值约 40 个。`DISK_MIB` 是工作目录 tmpfs 的大小，tmpfs 计入内存上限；
 * - `AGENT_GATEWAY_URL`：沙箱里看到的服务端地址（网关挂在它的 `/api/agent-gateway` 下）。默认：
 *   `process` → `http://127.0.0.1:<PORT>`（runner 和服务端在同一台机器上）；
 *   `oci` → `http://host.docker.internal:<PORT>`（Podman 5 与 Docker Desktop 都给容器加了这个名字；Linux 上的 Docker 没有，要显式配）；
 *   `k8s` → `http://<POD_IP>:<PORT>`（`POD_IP` 由 Deployment 经 Downward API 注入 `status.podIP`）：一轮的令牌和登记只在发起它的副本的内存里，
 *   沙箱必须直连**这个** Pod，不能走 Service（会被分到别的副本，401）。没有 `POD_IP` 又没配 = agent 未启用并写明原因；
 * - `AGENT_TOKEN_SECRET`：签 run 短令牌的 HMAC 密钥。不配时由 `SESSION_SECRET` 派生（加了域分隔，和会话的 HMAC 不是同一把）；
 *   两个都没有（只可能在开发环境，生产缺 `SESSION_SECRET` 起不来）就每次启动随机一把 —— 令牌本来就只在发起它的进程里有效；
 * - `AGENT_GRANT_MARGIN_MS`：委托授权（Grant，docs/22）的绝对过期时间 = 签发时刻 + 这一轮的**总**时长上限 + 这个余量（默认 60 秒）。
 *   正常情况下一轮先撞上自己的时长上限（cancelled）；Grant 到期（expired）是兜底。
 * - `AGENT_LEASE_TTL_MS`：任务登记、会话槽位、节点占用这些共享表条目的 TTL（默认 30 秒），持有者按它的一部分续期；
 * - `AGENT_RUN_IDLE_TIMEOUT_MS`：一个 run 的空闲上限（默认 120 秒）：网关上既没有在途请求、也这么久没有新请求就停下；
 * - `AGENT_TITLE_MODEL`：生成会话标题（docs/20 §3.9「会话标题」）用模型表里的哪一项，默认 `default`；可以指向模型表文件里一个更便宜的模型。
 *   `off` = 不生成，标题一直是首条消息的开头。写了表里没有的键启动即失败；
 * - `AGENT_MAX_OUTPUT_TOKENS`：每次模型请求的输出 token 上限（docs/22 §4.3）。模型请求由服务端发、参数完全由服务端定，
 *   实际取 min(模型的 maxTokens, 它)；不配按 16384。它也决定了工具参数最长能有多长（pi #9265 的缓解之一）；
 * - `AGENT_RUN_TOTAL_TIMEOUT_MS`：一轮含它全部被调用的 agent 的总时长上限（墙钟，默认 30 分钟，docs/20 §3.10.11）：等被调用的 agent 的时间不算进单轮上限，
 *   由它封顶；沙箱硬期限（`deadlineMs` / `activeDeadlineSeconds`）和 Grant 的绝对过期按它算。
 */
function parseHostConfig(read: Read, runtime: RuntimeInfo): AgentHostConfig {
  return {
  provider: read('AGENT_PROVIDER')?.trim() || 'anthropic',
  model: read('AGENT_MODEL')?.trim() || 'claude-sonnet-4-6',
  baseUrl: read('AGENT_BASE_URL')?.trim() ?? '',
  api: read('AGENT_API')?.trim() ?? '',
  apiKey: read('AGENT_API_KEY')?.trim() ?? '',
  imageInput: flag(read('AGENT_IMAGE_INPUT')),
  contextWindow: positiveInteger(read('AGENT_CONTEXT_WINDOW')),
  maxTokens: positiveInteger(read('AGENT_MAX_TOKENS')),
  /** 原样的字符串；合法性由 `@shadecn/agent/model` 判（`agent/index.ts` 里不合法就警告并当没配） */
  thinking: read('AGENT_THINKING')?.trim() || undefined,
  sandbox: resolveSandboxDriver(read('AGENT_SANDBOX')),
  sandboxExec: isOn(read('AGENT_SANDBOX_EXEC')) || read('AGENT_SANDBOX')?.trim() === 'local',
  allowProcessInProduction: isOn(read('AGENT_SANDBOX_ALLOW_PROCESS')),
  sandboxImage: read('AGENT_SANDBOX_IMAGE')?.trim() || 'shadecn-agent-sandbox:latest',
  ociSocket: read('AGENT_SANDBOX_OCI_SOCKET')?.trim() ?? '',
  ociNetwork: read('AGENT_SANDBOX_OCI_NETWORK')?.trim() || 'bridge',
  sandboxRuntime: read('AGENT_SANDBOX_RUNTIME')?.trim() ?? '',
  k8s: {
    /** 空 = 驱动的默认（`shadecn-agent-sandbox`） */
    namespace: read('AGENT_SANDBOX_K8S_NAMESPACE')?.trim() ?? '',
    runtimeClass: read('AGENT_SANDBOX_K8S_RUNTIME_CLASS')?.trim() ?? '',
    pullSecret: read('AGENT_SANDBOX_K8S_PULL_SECRET')?.trim() ?? '',
    /** 原样带着，由 agent 装配点校验（认不出 = 未启用并写明原因） */
    pullPolicy: read('AGENT_SANDBOX_K8S_PULL_POLICY')?.trim() ?? '',
    /** 原样带着，由 agent 装配点解析（`parseK8sNodeSelector`，格式错 = 未启用并写明原因）；空 = 不限节点 */
    nodeSelector: read('AGENT_SANDBOX_K8S_NODE_SELECTOR')?.trim() ?? '',
    apiUrl: read('AGENT_SANDBOX_K8S_API_URL')?.trim() ?? '',
    /** `undefined` = ServiceAccount 的默认位置；`''` = 不用（不带 token / 用系统 CA） */
    tokenFile: read('AGENT_SANDBOX_K8S_TOKEN_FILE'),
    caFile: read('AGENT_SANDBOX_K8S_CA_FILE'),
  },
  sandboxResources: {
    cpu: positive(Number(read('AGENT_SANDBOX_CPUS') ?? 1), 1),
    memoryMiB: Math.floor(positive(Number(read('AGENT_SANDBOX_MEMORY_MIB') ?? 512), 512)),
    pids: Math.floor(positive(Number(read('AGENT_SANDBOX_PIDS') ?? 128), 128)),
    diskMiB: Math.floor(positive(Number(read('AGENT_SANDBOX_DISK_MIB') ?? 512), 512)),
  },
  gatewayUrl: (read('AGENT_GATEWAY_URL')?.trim() || defaultGatewayUrl(read('AGENT_SANDBOX'), runtime)).replace(/\/+$/, ''),
  tokenSecret: read('AGENT_TOKEN_SECRET')?.trim() ?? '',
  grantMarginMs: nonNegative(Number(read('AGENT_GRANT_MARGIN_MS') ?? 60_000), 60_000),
  leaseTtlMs: Math.floor(positive(Number(read('AGENT_LEASE_TTL_MS') ?? 30_000), 30_000)),
  runIdleTimeoutMs: Math.floor(positive(Number(read('AGENT_RUN_IDLE_TIMEOUT_MS') ?? 120_000), 120_000)),
  runTotalTimeoutMs: Math.floor(positive(Number(read('AGENT_RUN_TOTAL_TIMEOUT_MS') ?? 1_800_000), 1_800_000)),
  /** 没配 / 不是正数 = undefined（`@shadecn/agent` 按 min(模型的 maxTokens, 16384)） */
  maxOutputTokens: positiveInteger(read('AGENT_MAX_OUTPUT_TOKENS')),
  /** 生成会话标题用的模型表键；不配 = `default`，`off` = 不生成（标题只取首条消息的开头） */
  titleModel: resolveTitleModel(read('AGENT_TITLE_MODEL')),
  }
}

/** `AGENT_TITLE_MODEL` → 模型表键；`off` / `none` / `0` / `false` = 不生成（undefined） */
function resolveTitleModel(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return 'default'
  return ['off', 'none', '0', 'false'].includes(value.toLowerCase()) ? undefined : value
}

/**
 * 没配 `AGENT_API_KEY` 时，按 `AGENT_PROVIDER` 退回的环境变量（按顺序取第一个非空的）。
 *
 * 我们自己维护这份表，不用 pi 的 `getEnvApiKey`（pi 1.x 起它只在 `/compat` 兼容层里）：取值照 pi 0.73.1 / 1.4.0
 * `env-api-keys` 里纯 key 的那些提供方抄的，两版不一致时保持 0.73.1 的行为（我们之前一直按它跑）。
 * 刻意**不收**的：
 * - `google-vertex` / `amazon-bedrock` 的 ADC / AWS 凭据链（pi 那边回一个 `<authenticated>` 占位）——
 *   网关的模型代理只会把 key 注入成 `Authorization` / `x-api-key`，这两家的线协议它也不转发；
 * - `ANTHROPIC_AUTH_TOKEN`（pi 1.x 新加，它把它当 Bearer 头而不是 key 用），同理。
 *
 * **不要 key 的本地端点**（`ollama`）：列成空表 —— 不读任何变量，由 `@shadecn/agent/model` 的预设补占位 key；
 * 远端带鉴权的 ollama 用 `AGENT_API_KEY`。表里没有的提供方（自建端点只拿 `AGENT_PROVIDER` 当名字）同样只认 `AGENT_API_KEY`。
 */
export const AGENT_PROVIDER_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
  // OAuth token 在前（pi 0.73 的顺序）
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  huggingface: ['HF_TOKEN'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  baseten: ['BASETEN_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  // 本机端点不鉴权：不读变量，预设补占位
  ollama: [],
}

/**
 * 按 {@link AGENT_PROVIDER_KEY_ENV} 从环境变量取 `provider` 的 key；没有（表里没有 / 都没配 / 只有空白）= `''`。
 * `AGENT_API_KEY` 不在这里：它优先，由调用方先看（`agentConfig.apiKey || agentProviderApiKey(…)`）。
 */
export function agentProviderApiKey(provider: string, envVar: (name: string) => string | undefined): string {
  const names = (Object.hasOwn(AGENT_PROVIDER_KEY_ENV, provider) && AGENT_PROVIDER_KEY_ENV[provider]) || []
  for (const name of names) {
    const value = envVar(name)?.trim()
    if (value) return value
  }
  return ''
}


function resolveSandboxDriver(raw: string | undefined): AgentSandboxDriver {
  const value = raw?.trim() || 'process'
  if (value === 'process' || value === 'oci' || value === 'k8s') return value
  // 一期的取值：那时 local = 「开本机沙箱的 ffmpeg 工具」；现在 runner 本身就在沙箱里
  if (value === 'local') {
    console.warn('[agent] AGENT_SANDBOX=local 已改名：现在按 process 驱动 + AGENT_SANDBOX_EXEC=1 处理（docs/22 §7）')
    return 'process'
  }
  return { unknown: value }
}

function isOn(raw: string | undefined): boolean {
  return ['1', 'true', 'on', 'yes'].includes(raw?.trim().toLowerCase() ?? '')
}

/** 三态开关：没配 / 认不出 = undefined（按默认），其余按开 / 关 */
function flag(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase() ?? ''
  if (['1', 'true', 'on', 'yes'].includes(value)) return true
  if (['0', 'false', 'off', 'no'].includes(value)) return false
  return undefined
}

/** 监听全部地址时，同机的沙箱从回环地址进来 */
function loopbackOf(listen: string): string {
  return listen === '0.0.0.0' || listen === '::' || listen === '' ? '127.0.0.1' : listen
}

/**
 * 沙箱看到的网关地址的默认值：`process` 同机走回环；`oci` 的容器里回环是容器自己，要走引擎给的宿主名。
 * podman machine（macOS）上这个名字落到宿主的回环地址，所以服务端照常只听 127.0.0.1 就够；
 * Linux 上它是宿主网卡的地址，服务端要监听在那上面（或配 `AGENT_GATEWAY_URL`），见 docs/22 §7.2。
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
