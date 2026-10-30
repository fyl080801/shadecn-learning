import './env.ts'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { appRoot, isBundle, moduleDir } from './runtime.ts'

/** 应用根目录：.env、data/、output/ 都以它为准 */
export const rootDir = appRoot

/**
 * 前端包的目录（apps/web）：dev 下 Vite 的 root、vite.config.ts、index.html / login.html 都在这儿。
 *
 * 和 rootDir 是两个基准：运行时数据跟仓库根走，前端源码跟 apps/web 走。
 * 只有源码运行（dev）才用得到 —— 产物里没有前端源码，生产吐的是 staticDir。
 */
export const webRoot = path.join(rootDir, 'apps', 'web')

/** 构建产物根目录：`pnpm build` 把后端和前端都放这儿 */
export const outputDir = path.join(rootDir, 'output')

/**
 * 后端的静态资源目录 —— 前端 `vite build` 的产物就落在这里，生产模式直接吐它。
 *
 * - 构建产物运行：自己旁边的 output/public（output/server/index.js → ../public）；
 * - 源码运行（tsx，NODE_ENV=production）：output/public；
 * - STATIC_DIR 可整个覆盖（相对路径按应用根目录算）。
 */
export const staticDir = process.env.STATIC_DIR
  ? resolveFromRoot(process.env.STATIC_DIR)
  : isBundle
    ? path.resolve(moduleDir, '..', 'public')
    : path.join(outputDir, 'public')

/** 没显式设 NODE_ENV=production 就按开发处理（开发时由后端挂 Vite 中间件） */
export const isDev = (process.env.NODE_ENV ?? 'development') !== 'production'

export const port = Number(process.env.PORT ?? 3000)
export const host = process.env.HOST ?? '127.0.0.1'

/** /api 与 /api/* —— 这部分永远由 Hono 处理，不交给前端 */
export function isApiPath(pathname: string) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

/**
 * 运行时数据目录：SQLite 库放这儿，整个目录已 gitignore。
 * DATA_DIR 可覆盖（相对路径按仓库根目录算，绝对路径直接用），
 * 容器里就是靠它把库指到挂载卷上。
 */
export const dataDir = resolveFromRoot(process.env.DATA_DIR ?? 'data')

/**
 * 画布 Agent 的模型配置（REQ-AGENT，`docs/20-agent-canvas.md`）。
 *
 * 这里只做**环境变量 → 参数对象**这一步；拿它选模型（注册表 / 自定义端点 / 缺 key）是
 * `@shadecn/agent/model` 的事；没给 `AGENT_API_KEY` 时按提供方退回它自己的环境变量
 * （`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`…，映射见 {@link AGENT_PROVIDER_KEY_ENV}，由 `apps/server/agent/index.ts` 调用）。
 * 那个包刻意不读 `process.env`，环境约定只在宿主这一处。
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
 * - `AGENT_API_KEY`：显式的 key，优先于按提供方的环境变量（{@link AGENT_PROVIDER_KEY_ENV}）。**只在服务端**：沙箱里的 runner 拿到的是 run 短令牌，
 *   真实 key 由网关的模型代理注入（docs/22 §4.1）；
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
 * - `AGENT_RUN_TOTAL_TIMEOUT_MS`：一轮含它全部子 agent 的总时长上限（墙钟，默认 30 分钟，docs/20 §3.10.11）：等子 agent 的时间不算进单轮上限，
 *   由它封顶；沙箱硬期限（`deadlineMs` / `activeDeadlineSeconds`）和 Grant 的绝对过期按它算。
 */
export const agentConfig = {
  provider: process.env.AGENT_PROVIDER?.trim() || 'anthropic',
  model: process.env.AGENT_MODEL?.trim() || 'claude-sonnet-4-6',
  baseUrl: process.env.AGENT_BASE_URL?.trim() ?? '',
  api: process.env.AGENT_API?.trim() ?? '',
  apiKey: process.env.AGENT_API_KEY?.trim() ?? '',
  imageInput: flag(process.env.AGENT_IMAGE_INPUT),
  sandbox: resolveSandboxDriver(process.env.AGENT_SANDBOX),
  sandboxExec: isOn(process.env.AGENT_SANDBOX_EXEC) || process.env.AGENT_SANDBOX?.trim() === 'local',
  allowProcessInProduction: isOn(process.env.AGENT_SANDBOX_ALLOW_PROCESS),
  sandboxImage: process.env.AGENT_SANDBOX_IMAGE?.trim() || 'shadecn-agent-sandbox:latest',
  ociSocket: process.env.AGENT_SANDBOX_OCI_SOCKET?.trim() ?? '',
  ociNetwork: process.env.AGENT_SANDBOX_OCI_NETWORK?.trim() || 'bridge',
  sandboxRuntime: process.env.AGENT_SANDBOX_RUNTIME?.trim() ?? '',
  k8s: {
    /** 空 = 驱动的默认（`shadecn-agent-sandbox`） */
    namespace: process.env.AGENT_SANDBOX_K8S_NAMESPACE?.trim() ?? '',
    runtimeClass: process.env.AGENT_SANDBOX_K8S_RUNTIME_CLASS?.trim() ?? '',
    pullSecret: process.env.AGENT_SANDBOX_K8S_PULL_SECRET?.trim() ?? '',
    /** 原样带着，由 agent 装配点校验（认不出 = 未启用并写明原因） */
    pullPolicy: process.env.AGENT_SANDBOX_K8S_PULL_POLICY?.trim() ?? '',
    /** 原样带着，由 agent 装配点解析（`parseK8sNodeSelector`，格式错 = 未启用并写明原因）；空 = 不限节点 */
    nodeSelector: process.env.AGENT_SANDBOX_K8S_NODE_SELECTOR?.trim() ?? '',
    apiUrl: process.env.AGENT_SANDBOX_K8S_API_URL?.trim() ?? '',
    /** `undefined` = ServiceAccount 的默认位置；`''` = 不用（不带 token / 用系统 CA） */
    tokenFile: process.env.AGENT_SANDBOX_K8S_TOKEN_FILE,
    caFile: process.env.AGENT_SANDBOX_K8S_CA_FILE,
  },
  sandboxResources: {
    cpu: positive(Number(process.env.AGENT_SANDBOX_CPUS ?? 1), 1),
    memoryMiB: Math.floor(positive(Number(process.env.AGENT_SANDBOX_MEMORY_MIB ?? 512), 512)),
    pids: Math.floor(positive(Number(process.env.AGENT_SANDBOX_PIDS ?? 128), 128)),
    diskMiB: Math.floor(positive(Number(process.env.AGENT_SANDBOX_DISK_MIB ?? 512), 512)),
  },
  gatewayUrl: (process.env.AGENT_GATEWAY_URL?.trim() || defaultGatewayUrl(process.env.AGENT_SANDBOX)).replace(/\/+$/, ''),
  tokenSecret: resolveAgentTokenSecret(),
  grantMarginMs: nonNegative(Number(process.env.AGENT_GRANT_MARGIN_MS ?? 60_000), 60_000),
  leaseTtlMs: Math.floor(positive(Number(process.env.AGENT_LEASE_TTL_MS ?? 30_000), 30_000)),
  runIdleTimeoutMs: Math.floor(positive(Number(process.env.AGENT_RUN_IDLE_TIMEOUT_MS ?? 120_000), 120_000)),
  runTotalTimeoutMs: Math.floor(positive(Number(process.env.AGENT_RUN_TOTAL_TIMEOUT_MS ?? 1_800_000), 1_800_000)),
} as const

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
export function agentProviderApiKey(provider: string, env: NodeJS.ProcessEnv = process.env): string {
  const names = (Object.hasOwn(AGENT_PROVIDER_KEY_ENV, provider) && AGENT_PROVIDER_KEY_ENV[provider]) || []
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return ''
}

/** 沙箱驱动的取值；认不出的原样带着，由 agent 装配点写成「未启用」的原因 */
export type AgentSandboxDriver = 'process' | 'oci' | 'k8s' | { unknown: string }

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
function defaultGatewayUrl(sandbox: string | undefined): string {
  const choice = sandbox?.trim()
  if (choice === 'oci') return `http://host.docker.internal:${port}`
  if (choice === 'k8s') {
    const podIp = process.env.POD_IP?.trim()
    return podIp ? `http://${podIp.includes(':') ? `[${podIp}]` : podIp}:${port}` : ''
  }
  return `http://${loopbackOf(host)}:${port}`
}

/** 不是正的有限数（没配好）就用默认值 */
function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function resolveAgentTokenSecret(): string {
  const explicit = process.env.AGENT_TOKEN_SECRET?.trim()
  if (explicit) return explicit
  const session = process.env.SESSION_SECRET?.trim()
  // 域分隔：同一把 SESSION_SECRET 派生出另一把，会话 cookie 的 HMAC 和 run 令牌的签名互不通用
  if (session) return createHmac('sha256', session).update('shadecn-agent-sts').digest('hex')
  return randomBytes(32).toString('hex')
}

/** 不是非负有限数（没配好）就用默认值 */
function nonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 沙箱工作目录的根：`<dataDir>/agent-workspaces/<flowId>/<runId>`，一张画布一个项目目录 */
export const agentWorkspaceDir = path.join(dataDir, 'agent-workspaces')

/**
 * 画布资源（图片 / 视频）的对象存储：S3 协议，path-style（`<endpoint>/<bucket>/<key>`）。
 *
 * - `S3_ENDPOINT`：**公开**地址，默认 `https://s3.fyl080801.uk`。节点 `data.src` 存的、浏览器直接读的都是 `<它>/<bucket>/<key>`，
 *   所以必须是浏览器访问得到的地址（不能是集群内的 `*.svc`）；
 * - `S3_INTERNAL_ENDPOINT`：服务端自己发请求（上传、读字节给 agent 看图）用的地址，空 = 和 `S3_ENDPOINT` 一样。
 *   只影响服务端 → S3 这一段：集群里配成内网地址（如 `http://minio.minio.svc.cluster.local:9000`），不绕公网；
 *   浏览器照旧读 `S3_ENDPOINT`，存进节点的地址也照旧（两边必须是同一个桶、同一份数据）；
 * - `S3_REGION`：签名用的 region，默认 `us-east-1`（MinIO 一类自建服务没改过就是它）；
 * - `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`：三样缺一个就是**没开上传**
 *   （上传接口 503），和 agent 一样不影响启动；
 * - `S3_MAX_UPLOAD_MB`：单个文件上限，默认 100。
 * - `S3_KEY_PREFIX`：对象键的根目录，默认 `canvas`；几个环境共用一个桶时用它隔开（如 `dev/canvas`）。
 *   之下按项目 / 画布 / 类别 / uuid 分层，见 `storage/keys.ts`。
 *
 * **读资源直接用 S3 原始地址**（`<endpoint>/<bucket>/<key>`，写进节点 `data.src`），不经后端转发 ——
 * 所以桶要对匿名开放读（`s3:GetObject`），否则画布上的图都是裂的。
 */
export const s3Config = {
  endpoint: (process.env.S3_ENDPOINT?.trim() || 'https://s3.fyl080801.uk').replace(/\/+$/, ''),
  /** 空 = 和 endpoint 一样（`createS3Client` 里兜底） */
  requestEndpoint: (process.env.S3_INTERNAL_ENDPOINT?.trim() ?? '').replace(/\/+$/, ''),
  region: process.env.S3_REGION?.trim() || 'us-east-1',
  bucket: process.env.S3_BUCKET?.trim() ?? '',
  accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim() ?? '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim() ?? '',
  maxUploadBytes: Number(process.env.S3_MAX_UPLOAD_MB ?? 100) * 1024 * 1024,
  keyPrefix: (process.env.S3_KEY_PREFIX?.trim() ?? 'canvas').replace(/^\/+|\/+$/g, ''),
} as const

export const s3Enabled = Boolean(s3Config.bucket && s3Config.accessKeyId && s3Config.secretAccessKey)

/** 支持的两种库 */
export type DbProvider = 'sqlite' | 'postgresql'

/**
 * 用哪种库。**这是唯一的一份解析规则**：服务端进程（apps/server/db/orm.ts）和表结构同步入口
 * （apps/server/db/sync-cli.ts，源码态 `pnpm db:push`、产物态 `node server/db-sync.js`）
 * 都从这里取，不会出现「同步的是这个库、服务端连的是那个库」。
 *
 * 只决定运行时加载哪个驱动 —— 实体定义和构建产物都和库无关。
 *
 *   1. 显式的 DB_PROVIDER 最优先；
 *   2. 否则看 DATABASE_URL 的协议；
 *   3. 都没有 → sqlite（零外部依赖的默认形态）。
 */
export const dbProvider: DbProvider = resolveProvider()

/**
 * 数据库连接串。
 *
 * - sqlite：默认 <dataDir>/app.db，DATABASE_URL 可整个换掉（相对路径同样按仓库根目录
 *   解析，不按 cwd —— `pnpm db:push` 在 apps/server 下跑，服务端进程的 cwd 可能又是别处，
 *   两边必须看到同一个文件）；
 * - postgresql：必须给 DATABASE_URL。Prisma 时代的 `?schema=xxx` 写法照旧认
 *   （db/orm.ts 把它摘出来交给 MikroORM 的 schema 选项，pg 本身不认这个参数）。
 */
export const databaseUrl = resolveDatabaseUrl()

function resolveFromRoot(target: string) {
  return path.isAbsolute(target) ? target : path.join(rootDir, target)
}

/** 从连接串协议反推 provider；认不出来返回 undefined */
function providerFromUrl(url: string | undefined): DbProvider | undefined {
  if (!url) return undefined
  if (url.startsWith('file:')) return 'sqlite'
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgresql'
  return undefined
}

function resolveProvider(): DbProvider {
  const explicit = process.env.DB_PROVIDER?.trim()
  if (explicit) {
    if (explicit !== 'sqlite' && explicit !== 'postgresql') {
      throw new Error(`DB_PROVIDER 只能是 sqlite / postgresql，收到的是 "${explicit}"`)
    }
    return explicit
  }
  return providerFromUrl(process.env.DATABASE_URL?.trim()) ?? 'sqlite'
}

function resolveDatabaseUrl() {
  // 空串当没设：`DATABASE_URL=` 常被用来在命令行上临时盖掉 .env 里的那一行
  const configured = process.env.DATABASE_URL?.trim() || undefined
  const scheme = providerFromUrl(configured)
  if (configured && scheme && scheme !== dbProvider) {
    throw new Error(`DB_PROVIDER=${dbProvider} 与 DATABASE_URL 的协议（${scheme}）不一致`)
  }

  if (dbProvider === 'postgresql') {
    if (!configured) throw new Error('DB_PROVIDER=postgresql 时必须提供 DATABASE_URL')
    return configured
  }

  const url = configured ?? `file:${path.join(dataDir, 'app.db')}`
  return url.startsWith('file:') ? `file:${resolveFromRoot(url.slice('file:'.length))}` : url
}

/** better-sqlite3 不会自动建目录，打开库之前先把父目录补上（postgres 无事发生） */
export function ensureDatabaseDir() {
  if (!databaseUrl.startsWith('file:')) return
  mkdirSync(path.dirname(databaseUrl.slice('file:'.length)), { recursive: true })
}

/** 单副本（进程内存）还是多副本（Redis 共享） */
export type ClusterMode = 'single' | 'redis'

/**
 * 跑成一个进程还是一群进程。
 *
 * 解析规则和上面的 `dbProvider` 逐条对齐 —— 显式变量最优先，其次看连接串在不在，
 * 都没有就是最省事的那个默认值：
 *
 *   1. 显式的 CLUSTER_MODE 最优先；
 *   2. 否则看 REDIS_URL 有没有；
 *   3. 都没有 → single（零外部依赖的默认形态，一行 Redis 代码都不加载）。
 *
 * **数据库和 Redis 是两件独立的事**：这里不去看 DB_PROVIDER，那边也不看 REDIS_URL。
 * 两者的搭配是否合理由 `assertClusterConfig()` 判，而且只在生产才是硬错误。
 */
export const clusterMode: ClusterMode = resolveClusterMode()
export const isClustered = clusterMode === 'redis'

/** Redis 连接串，形如 redis://[:password@]host:port[/db]。密码走连接串，不另设变量 */
export const redisUrl = process.env.REDIS_URL?.trim() ?? ''

/** 键空间前缀：多个环境共用一台 Redis 时靠它隔离 */
export const redisKeyPrefix = process.env.REDIS_KEY_PREFIX?.trim() || 'shadecn'

/**
 * 这个进程的身份。
 *
 * awareness 的 clientID 归属登记要区分「哪个实例的哪条连接」—— socketId 只在
 * 单个进程里唯一，多副本下必须带上实例前缀，否则两个实例的 socket 撞号，
 * 冒名防线会把正主的更新当成冒用丢掉。日志前缀也用它。
 */
export const instanceId =
  process.env.INSTANCE_ID?.trim() || `${hostname()}-${randomUUID().slice(0, 8)}`

function resolveClusterMode(): ClusterMode {
  const explicit = process.env.CLUSTER_MODE?.trim()
  if (explicit) {
    if (explicit !== 'single' && explicit !== 'redis') {
      throw new Error(`CLUSTER_MODE 只能是 single / redis，收到的是 "${explicit}"`)
    }
    return explicit
  }
  return process.env.REDIS_URL?.trim() ? 'redis' : 'single'
}

/**
 * 启动时校验一次。
 *
 * 两条的性质不一样：
 * - 说要多副本却没给 REDIS_URL —— 这是**配置自相矛盾**，任何环境都直接拒绝启动；
 * - 多副本配着 SQLite —— 真跑多副本时不成立（单文件库没法被多个进程共享），
 *   但本地拿 SQLite + Redis 单进程验证 Redis 那条链路是完全合理的调试姿势，
 *   所以开发环境只警告，生产才拒绝。
 */
export function assertClusterConfig() {
  if (!isClustered) return

  if (!redisUrl) throw new Error('[cluster] CLUSTER_MODE=redis 时必须提供 REDIS_URL')

  if (dbProvider !== 'postgresql') {
    const hint =
      'CLUSTER_MODE=redis 配的却是 SQLite —— 单文件库没法被多个进程/Pod 共享，真要多副本请切 PostgreSQL'
    if (!isDev) throw new Error(`[cluster] ${hint}`)
    console.warn(`[cluster] ${hint}（本地单进程调试可忽略）`)
  }
}

// ------------------------------------------------------------------ 日志

/**
 * 日志级别。`silent` 关掉全部输出。
 *
 * 默认 `info`（**开发环境也一样**）：`debug` 会把每条 SQL、每次落库、每帧协同事件都打出来，
 * 那是排查时临时开的档位，不是日常。
 */
export const logLevel = process.env.LOG_LEVEL?.trim() || 'info'

/**
 * 输出形态。`json` 一行一个对象（给日志采集用），`pretty` 是给人看的带色彩单行。
 *
 * 默认按环境走：生产 json，开发 pretty。容器里如果接了 Loki / ELK，保持 json。
 */
export const logFormat = (process.env.LOG_FORMAT?.trim() || (isDev ? 'pretty' : 'json')) as
  | 'pretty'
  | 'json'

/**
 * 额外写文件的目录（相对路径按仓库根目录算）。**不设 = 只写 stdout**，这也是容器里该有的样子 ——
 * k8s 收的是 stdout，往容器内写文件只会把日志留在一个随 Pod 一起消失的层里。
 */
export const logDir = process.env.LOG_DIR?.trim() ? resolveFromRoot(process.env.LOG_DIR) : ''

/**
 * 请求日志记到什么程度：
 * - `api` —— **默认**。只记 `/api/*`，外加任何路径上的失败（4xx/5xx）和慢请求。
 *   非 API 的成功请求就是静态资源：dev 下 Vite 每个模块一条，一次刷新几百行，纯噪音。
 * - `all` —— 全记，排查静态资源 / 页面守卫时才需要。
 * - `off` —— 一条不记（失败也不记，那时靠 `app.onError`）。
 */
export const logHttp = (process.env.LOG_HTTP?.trim() || 'api') as 'api' | 'all' | 'off'

/** 超过这个毫秒数的请求单独记一条 warn，`api` 模式下即使不是 /api 也记 */
export const logSlowRequestMs = Number(process.env.LOG_SLOW_MS ?? 1000)

/** 超过这个毫秒数的数据库查询记一条 warn。0 = 不记 */
export const logSlowQueryMs = Number(process.env.LOG_SLOW_QUERY_MS ?? 200)

/**
 * 把一个 origin 归一化成可比较的形式：`协议://host[:非默认端口]`，全小写、去尾斜杠。
 *
 * 比较必须走这一步而不是字符串相等 —— `https://a.com/`、`https://A.com`、
 * `https://a.com:443` 是同一个源，浏览器发 `Origin` 头时给的又永远是最规范的那种写法。
 * 认不出来的（不是合法 URL、不是 http/https）返回 null，一律当不在名单里。
 */
export function normalizeOrigin(value: string | null | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin.toLowerCase()
  } catch {
    return null
  }
}

/** 应用对外地址：没配 `APP_ORIGIN` 时按监听地址兜底，同时也是白名单的默认成员 */
export const appOrigin =
  normalizeOrigin(process.env.APP_ORIGIN) ?? normalizeOrigin(`http://${host}:${port}`) ?? ''

/**
 * 允许的对外域名白名单。
 *
 * 同一套部署常常挂在好几个域名下（内网域名 / 外网域名 / 老域名 / 裸 IP），
 * 而 OAuth 的 `redirect_uri`、CORS、WebSocket 的 `Origin` 校验都是**绝对地址**，
 * 写死一个 `APP_ORIGIN` 就意味着：从别的域名进来的人，登录会被甩到另一个域名上
 * （cookie 也就落在了那个域名下），或者干脆被提供方以 redirect_uri 不匹配拒掉。
 *
 * 所以这些地方一律改成「按这次请求的域名来」，再用这份名单收口 ——
 * 名单之外的一律回落到 `APP_ORIGIN`，绝不跟着 `Host` 头走。
 * 反代后面 `Host` 是外部可控的输入，无脑相信它就是 host header 注入。
 *
 * 写法：`APP_ORIGINS="https://a.example.com,https://b.example.com"`（逗号或空白分隔）。
 * **不支持通配符**：每个域名的 `/api/auth/callback` 都得在 Keycloak / GitHub 那边
 * 注册成合法回调，通配符只会造出一批注册不了的地址。
 */
export const appOrigins: readonly string[] = (() => {
  const listed = (process.env.APP_ORIGINS ?? '')
    .split(/[\s,]+/)
    .map((item) => normalizeOrigin(item))
    .filter((item): item is string => Boolean(item))
  // APP_ORIGIN 永远在名单里：它是兜底值，不在名单里的话回落目标自己就是非法的
  return [...new Set([appOrigin, ...listed].filter(Boolean))]
})()

/** 这个 origin 在名单里吗 */
export function isAllowedOrigin(value: string | null | undefined): boolean {
  const origin = normalizeOrigin(value)
  return Boolean(origin) && appOrigins.includes(origin as string)
}

/**
 * 这次请求该用哪个对外地址。
 *
 * 依次看 `X-Forwarded-Proto` + `X-Forwarded-Host`（反代改写过的对外地址）、`Host`、
 * 最后才是 `Origin`（整页导航根本不带这个头，只在 XHR 上有）。取第一个**在白名单里**的；
 * 一个都不在就回落 `APP_ORIGIN` —— 行为和加这个特性之前完全一样。
 */
export function resolveOrigin(headers: {
  origin?: string | null
  forwardedProto?: string | null
  forwardedHost?: string | null
  host?: string | null
  /** 直连（没有反代）时的协议，用来给 Host 头补上 scheme */
  protocol?: string | null
}): string {
  const proto = headers.forwardedProto?.split(',')[0]?.trim() || headers.protocol || 'http'
  const forwardedHost = headers.forwardedHost?.split(',')[0]?.trim()

  const candidates = [
    // 反代改写过的对外地址最贴近「用户在浏览器地址栏里看到的那个域名」
    forwardedHost ? `${proto}://${forwardedHost}` : null,
    headers.host ? `${proto}://${headers.host}` : null,
    // 反代终止了 https 却没给 X-Forwarded-Proto 时的补救
    headers.host ? `https://${headers.host}` : null,
    // 最后才看 Origin：反代把 Host 改成了内网名字时，只有它还认得对外域名
    headers.origin,
  ]

  for (const candidate of candidates) {
    const origin = normalizeOrigin(candidate)
    if (origin && appOrigins.includes(origin)) return origin
  }
  return appOrigin
}

/** 某个 origin 下的 OAuth 回调地址。回调只有这一个路径，靠 `AuthRequest.provider` 分发 */
export function callbackUriFor(origin: string) {
  return `${origin}/api/auth/callback`
}

/** Keycloak / OIDC 配置。issuer 就是 {keycloak}/realms/{realm} */
export const authConfig = {
  issuer: (process.env.KEYCLOAK_ISSUER ?? '').replace(/\/+$/, ''),
  clientId: process.env.KEYCLOAK_CLIENT_ID ?? '',
  /** public client（纯 PKCE）留空 */
  clientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? '',
  scope: process.env.KEYCLOAK_SCOPE ?? 'openid profile email',
  /** 登出后回到的前端地址 */
  postLogoutRedirectUri: `${appOrigin}/login`,
  /** 会话 cookie 名 */
  cookieName: 'sid',
  /** 授权过程中的临时 cookie 名 */
  txCookieName: 'oidc_tx',
  /** 会话最长存活时间（秒） */
  ttl: Number(process.env.SESSION_TTL ?? 7 * 24 * 3600),
  /** 会话 token 做 HMAC 的密钥：库里存的是 HMAC 结果，光拖库伪造不出 cookie */
  secret: process.env.SESSION_SECRET ?? '',
  /**
   * https 部署时 cookie 带 Secure。
   *
   * 这是**默认值**（拿不到请求上下文时用它）；有 `Context` 的地方一律走
   * `secureCookieFor(originOf(c))` —— 白名单里可以同时有 http 和 https 的域名，
   * 按 `APP_ORIGIN` 一刀切的话，https 那边不带 Secure（浪费一层保护），
   * http 那边带上 Secure（cookie 直接种不下去，表现为「登录成功但还是未登录」）。
   */
  secureCookie: appOrigin.startsWith('https://'),
} as const

/** 这个 origin 下的 cookie 该不该带 Secure */
export function secureCookieFor(origin: string) {
  return origin.startsWith('https://')
}

/**
 * GitHub OAuth App 配置。
 *
 * GitHub 是 **OAuth2 而不是 OIDC**：没有 discovery、没有 JWKS、没有 id_token，
 * 身份要再调一次 `/user` 才拿得到 —— 所以它不能复用 `auth/oidc.ts`，
 * 单独一个 provider 实现（`auth/providers/github.ts`）。
 *
 * 回调地址和 Keycloak 是**同一个** `/api/auth/callback`，靠 `AuthRequest.provider`
 * 分发。这样多接一个提供方不用改 Keycloak 那边已注册的 redirect_uri。
 */
export const githubConfig = {
  clientId: process.env.GITHUB_CLIENT_ID ?? '',
  clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
  /** 只要读身份：read:user 拿档案，user:email 拿主邮箱（GitHub 可能把邮箱设为私密） */
  scope: process.env.GITHUB_SCOPE ?? 'read:user user:email',
  /** 落进 User.issuer / UserIdentity.issuer 的固定值 */
  issuer: 'https://github.com',
} as const

export const keycloakEnabled = Boolean(authConfig.issuer && authConfig.clientId)
/** OAuth App 一定是 confidential client，没有 secret 就换不了 token */
export const githubEnabled = Boolean(githubConfig.clientId && githubConfig.clientSecret)

/** 一个提供方都没配就退化成「不鉴权」，方便本地只跑前端 demo；生产必须至少配一个 */
export const authEnabled = keycloakEnabled || githubEnabled

/** 启动时校验一次，配置不全在生产直接拒绝启动 */
export function assertAuthConfig() {
  const missing: string[] = []
  // Keycloak 配了一半（只有 issuer 或只有 client id）当成「想配但配漏了」，明确报出来；
  // 两个都空则是「这次不用 Keycloak」，不算缺
  if (authConfig.issuer || authConfig.clientId) {
    if (!authConfig.issuer) missing.push('KEYCLOAK_ISSUER')
    if (!authConfig.clientId) missing.push('KEYCLOAK_CLIENT_ID')
  }
  if (githubConfig.clientId || githubConfig.clientSecret) {
    if (!githubConfig.clientId) missing.push('GITHUB_CLIENT_ID')
    if (!githubConfig.clientSecret) missing.push('GITHUB_CLIENT_SECRET')
  }
  if (!authEnabled) {
    missing.push('KEYCLOAK_ISSUER + KEYCLOAK_CLIENT_ID 或 GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET')
  }
  if (!authConfig.secret) missing.push('SESSION_SECRET')

  if (missing.length === 0) return

  const hint = `缺少环境变量：${missing.join(', ')}（参考 .env.example）`
  if (!isDev) throw new Error(`[auth] ${hint}`)
  console.warn(`[auth] ${hint}`)
  if (!authEnabled) console.warn('[auth] 登录已关闭，所有接口与页面按匿名放行')
}
