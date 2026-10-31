import { createHash } from 'node:crypto'
import { agentModelKey, DEFAULT_AGENT_MODEL } from '@shadecn/agent/agents'
import { AGENT_THINKING_LEVELS, isAgentThinkingLevel, resolveAgentModel, type AgentThinkingLevel } from '@shadecn/agent/model'
import { AGENT_GATEWAY_PATH } from '@shadecn/agent/protocol'
import {
  createEngineClient,
  createK8sDriver,
  createKubeClient,
  createOciDriver,
  createProcessDriver,
  findEngineSocket,
  K8S_PULL_POLICIES,
  kubeConnection,
  parseK8sNodeSelector,
  type K8sPullPolicy,
  type K8sSandboxDriver,
  type OciSandboxDriver,
  type SandboxDriver,
} from '@shadecn/agent/sandbox/drivers'
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeOptions } from '@shadecn/agent/session'
import { agentConfig, agentProviderApiKey, agentWorkspaceDir, host, isDev, s3Enabled } from '../config.ts'
import { agentConversations, agentRunLog } from '../store/agent.ts'
import { users } from '../store/users.ts'
import { agentAuthority } from './authority.ts'
import { agentDefinitions, agentTextSkills } from './definitions.ts'
import { agentModels } from './models.ts'
import { agentNodeLeases } from './leases.ts'
import { agentRunRegistry } from './runs.ts'
import { agentMediaReader } from './media.ts'
import { runnerCommand } from './runner-command.ts'
import { broadcastAgentRuns } from './runs-broadcast.ts'

/**
 * 画布 Agent 在本服务里的装配点：环境变量 → `@shadecn/agent` 的显式参数。
 *
 * 那个包不读 `process.env`（见 `@shadecn/agent/model`），所以「没给 `AGENT_API_KEY` 时退回
 * 提供方自己的环境变量（`config.ts` 的 `AGENT_PROVIDER_KEY_ENV`）」「沙箱子进程的 PATH」「生产环境拒绝 process 驱动」这类环境相关的决定都在这里做。
 *
 * **二期～四期（docs/22 §9 第 2～4 项）**：pi 的推理循环跑在每轮一个的沙箱里（`process` 驱动 = 本机 node 子进程；
 * `oci` 驱动 = 每轮一个 Docker / Podman 容器；`k8s` 驱动 = 每轮一个 Pod），经网关（`routes/agent-gateway.ts`，挂在 `AGENT_GATEWAY_PATH`）说话。
 * 真实的 LLM key 只在这里交给网关（模型请求由服务端发，docs/22 §4.3）；沙箱的环境变量只有网关地址、一次性 bootstrap token、工作目录和 `PATH`。
 *
 * 驱动和 runtime 分开懒建：驱动在启动时就要用（{@link startAgentSandboxReaper}：`oci` / `k8s` 的启动自检 + 清孤儿），
 * runtime 等第一次有人访问 agent 接口。两边拿的是同一个驱动实例。
 * **`k8s` 的自检决定 agent 开不开**（API 连不上、没权限、命名空间不存在、Pod 规格过不了准入 = 每一轮都会失败）：
 * 结论记在 {@link sandboxProblem}，没过就按未启用构造 runtime、驱动也拒绝起 Pod；之后每次清孤儿时重查，过了就恢复。
 *
 * **懒创建**：第一次有人访问 agent 接口时才解析模型。没配 key / 驱动不可用的进程里它只是一个
 * `enabled: false` 的空壳，不影响启动、也不打一行警告以外的东西。
 */

let runtime: AgentRuntime | null = null

/**
 * 宿主这一侧接给编排层的东西：落库、用户信息、任务列表变更时的房间广播（docs/20 §3.10.4）、
 * 每一轮的执行身份（Grant 签发 / 判权 / 对账，docs/22，`authority.ts`）、节点占用的登记表（`leases.ts`）、运行中轮次的共享登记（`runs.ts`）、
 * 启动时校验过的 agent 定义与文字技能（docs/26，`definitions.ts`）。
 * 启用与否都一样；测试换成假模型时也展开它，测的就是生产的那套接线。
 */
export const agentHostOptions = {
  store: agentConversations,
  runLog: agentRunLog,
  userProfiles: users.briefs,
  onRunsChange: (flowId, runs) => {
    broadcastAgentRuns(flowId, runs)
  },
  authorities: agentAuthority,
  // 节点占用（docs/20 §3.10.8）：共享层的登记表，单副本内存、多副本 redis
  leases: agentNodeLeases,
  // 运行中轮次（docs/20 §3.10.10，F14）：任务登记、会话槽位、补发日志、停止指令，同样在共享层
  runRegistry: agentRunRegistry,
  // agent 定义（docs/26）：随产物发布的 `agents/*.md`，启动时已校验
  agents: agentDefinitions,
  // 文字技能（docs/26 §3.8）：随产物发布的 `skills/`，启动时已校验
  textSkills: agentTextSkills,
} satisfies Pick<
  AgentRuntimeOptions,
  'store' | 'runLog' | 'userProfiles' | 'onRunsChange' | 'authorities' | 'leases' | 'runRegistry' | 'agents' | 'textSkills'
>

/** 沙箱里看到的网关地址 */
export const agentGatewayUrl = `${agentConfig.gatewayUrl}${AGENT_GATEWAY_PATH}`

/**
 * 这个实例在容器引擎 / 集群上的标识（`oci` 容器、`k8s` Pod 的 `instance` label，`reap` 只清这个值的）：沙箱看到的网关地址的哈希。
 * 一轮只能连回发起它的实例（令牌和登记在进程内存），同一个网关地址的旧容器在重启之后就是孤儿；
 * 同一个引擎上别的实例（别的端口 / 别的主机名）的容器不受影响。`k8s` 下网关地址是本 Pod 的 IP：
 * 服务端容器在同一个 Pod 里重启，标识不变；Pod 被替换，标识跟着变（旧 Pod 留下的由驱动按「过了时长上限」清）。
 */
export const agentSandboxInstance = createHash('sha256').update(agentGatewayUrl).digest('hex').slice(0, 16)

/** 没启用时也要给的驱动：永远起不来（start 根本不会被调到） */
const NO_DRIVER: SandboxDriver = {
  name: 'none',
  start: () => Promise.reject(new Error('agent 未启用')),
  reap: async () => {},
}

const logRunnerOutput = (runId: string, stream: 'stdout' | 'stderr', line: string) => {
  if (stream === 'stderr') console.warn(`[agent-runner] run=${runId} ${line}`)
  else console.info(`[agent-runner] run=${runId} ${line}`)
}

type BuiltDriver =
  | { ok: true; driver: SandboxDriver; oci?: OciSandboxDriver; k8s?: K8sSandboxDriver }
  | { ok: false; reason: string }
let builtDriver: BuiltDriver | null = null

/** `k8s` 的启动自检没过的原因（null = 过了 / 还没查完）。没过 = agent 未启用 */
let sandboxProblem: string | null = null
/** 第一次自检（起 Pod 之前要等它查完） */
let firstSandboxCheck: Promise<void> | null = null

/** 按 `AGENT_SANDBOX` 建驱动（只建一次）；建不了 → 未启用的原因 */
function sandboxDriver(): BuiltDriver {
  builtDriver ??= buildDriver()
  return builtDriver
}

function buildDriver(): BuiltDriver {
  const choice = agentConfig.sandbox
  if (typeof choice === 'object') {
    return { ok: false, reason: `不认识的沙箱驱动 AGENT_SANDBOX=${choice.unknown}（可选 process / oci / k8s）` }
  }
  if (choice === 'k8s') return buildK8sDriver()
  if (choice === 'oci') return buildOciDriver()
  try {
    const driver = createProcessDriver({
      command: runnerCommand(),
      rootDir: agentWorkspaceDir,
      pathEnv: process.env.PATH,
      production: !isDev,
      allowInProduction: agentConfig.allowProcessInProduction,
      onOutput: logRunnerOutput,
    })
    return { ok: true, driver }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** `oci`：找到引擎的 socket（只看文件系统，不调 podman / docker CLI）；生产照常可用 */
function buildOciDriver(): BuiltDriver {
  const socket = findEngineSocket(agentConfig.ociSocket, process.env)
  if (!socket.ok) return { ok: false, reason: socket.reason }
  try {
    const driver = createOciDriver({
      engine: createEngineClient(socket.path),
      image: agentConfig.sandboxImage,
      instance: agentSandboxInstance,
      network: agentConfig.ociNetwork,
      ...(agentConfig.sandboxRuntime ? { runtime: agentConfig.sandboxRuntime } : {}),
      onOutput: logRunnerOutput,
    })
    return { ok: true, driver, oci: driver }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * `k8s`：连 API 的配置（集群内 = ServiceAccount，集群外 = 显式地址 / 文件，不读 kubeconfig）+ 驱动；生产照常可用。
 * 起 Pod 前先等第一次自检查完，没过就拒绝（原因同「未启用」）。
 */
function buildK8sDriver(): BuiltDriver {
  const k8s = agentConfig.k8s
  if (!agentConfig.gatewayUrl) {
    return {
      ok: false,
      reason:
        'k8s 沙箱要连回发起它的那个副本：Deployment 里用 Downward API 注入 POD_IP（fieldRef: status.podIP），或显式配 AGENT_GATEWAY_URL（docs/22 §7.5）',
    }
  }
  if (k8s.pullPolicy && !K8S_PULL_POLICIES.includes(k8s.pullPolicy as K8sPullPolicy)) {
    return { ok: false, reason: `AGENT_SANDBOX_K8S_PULL_POLICY=${k8s.pullPolicy} 不认识（可选 ${K8S_PULL_POLICIES.join(' / ')}）` }
  }
  const nodeSelector = parseK8sNodeSelector(k8s.nodeSelector)
  if (!nodeSelector.ok) return { ok: false, reason: nodeSelector.reason }
  const connection = kubeConnection({ apiUrl: k8s.apiUrl, tokenFile: k8s.tokenFile, caFile: k8s.caFile }, process.env)
  if (!connection.ok) return { ok: false, reason: connection.reason }
  try {
    const driver = createK8sDriver({
      kube: createKubeClient(connection.value),
      image: agentConfig.sandboxImage,
      instance: agentSandboxInstance,
      ...(k8s.namespace ? { namespace: k8s.namespace } : {}),
      ...(k8s.runtimeClass ? { runtimeClassName: k8s.runtimeClass } : {}),
      ...(k8s.pullSecret ? { imagePullSecret: k8s.pullSecret } : {}),
      ...(k8s.pullPolicy ? { imagePullPolicy: k8s.pullPolicy as K8sPullPolicy } : {}),
      ...(Object.keys(nodeSelector.value).length > 0 ? { nodeSelector: nodeSelector.value } : {}),
      onOutput: logRunnerOutput,
    })
    const gated: SandboxDriver = {
      name: driver.name,
      reap: (live) => driver.reap(live),
      async start(spec) {
        await ensureSandboxChecked(driver)
        if (sandboxProblem !== null) throw new Error(sandboxProblem)
        return driver.start(spec)
      },
    }
    return { ok: true, driver: gated, k8s: driver }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

function buildRuntime(): AgentRuntime {
  const gateway = {
    url: agentGatewayUrl,
    secret: agentConfig.tokenSecret,
    // 模型参数完全由服务端定（docs/22 §4.3）：输出 token 上限可配
    ...(agentConfig.maxOutputTokens !== undefined ? { maxOutputTokens: agentConfig.maxOutputTokens } : {}),
  }
  const disabled = (reason: string) => {
    console.warn(`[agent] 未启用：${reason}`)
    return createAgentRuntime({ model: null, disabled: reason, models: agentModels, driver: NO_DRIVER, gateway, ...agentHostOptions })
  }

  // 模型表的 default（docs/26 §3.4）：AGENT_PROVIDER / AGENT_MODEL / …；其余的项在 models.ts（启动时已读、已解析）
  // AGENT_THINKING 写错了不让 agent 整个关掉（思考是锦上添花）：警告，当没配
  let defaultThinking: AgentThinkingLevel | undefined
  if (agentConfig.thinking !== undefined) {
    if (isAgentThinkingLevel(agentConfig.thinking)) defaultThinking = agentConfig.thinking
    else console.warn(`[agent] AGENT_THINKING=${agentConfig.thinking} 不认识（只认 ${AGENT_THINKING_LEVELS.join(' / ')}），当作没配`)
  }
  const apiKey = agentConfig.apiKey || agentProviderApiKey(agentConfig.provider)
  const defaultModel = resolveAgentModel({
    provider: agentConfig.provider,
    model: agentConfig.model,
    baseUrl: agentConfig.baseUrl,
    api: agentConfig.api,
    apiKey,
    ...(agentConfig.imageInput !== undefined ? { imageInput: agentConfig.imageInput } : {}),
    ...(agentConfig.contextWindow !== undefined ? { contextWindow: agentConfig.contextWindow } : {}),
    ...(agentConfig.maxTokens !== undefined ? { maxTokens: agentConfig.maxTokens } : {}),
    ...(defaultThinking !== undefined ? { thinking: defaultThinking } : {}),
  })
  // 入口 agent（canvas）的模型不可用 = agent 没开（同以前没配模型）；别的 agent 的不可用到 run_agent 点名它时才报
  const entryKey = agentModelKey(agentDefinitions.entry)
  const resolved = entryKey === DEFAULT_AGENT_MODEL ? defaultModel : agentModels[entryKey]!
  if (!resolved.ok) {
    return disabled(
      entryKey === DEFAULT_AGENT_MODEL
        ? resolved.reason
        : `入口 agent ${agentDefinitions.entry.name} 的模型「${entryKey}」不可用：${resolved.reason}`,
    )
  }

  const built = sandboxDriver()
  if (!built.ok) return disabled(built.reason)
  if (sandboxProblem !== null) return disabled(sandboxProblem)

  const created = createAgentRuntime({
    model: defaultModel.ok ? defaultModel.value : null,
    ...(defaultModel.ok ? {} : { disabledReason: defaultModel.reason }),
    models: agentModels,
    driver: built.driver,
    gateway,
    mediaTool: agentConfig.sandboxExec,
    // 看图只读本服务的对象存储：没配 S3 就不接（工具也就不给模型）；还要模型吃图片，由编排层判
    ...(s3Enabled ? { mediaReader: agentMediaReader } : {}),
    sandbox: { image: agentConfig.sandboxImage, resources: agentConfig.sandboxResources },
    // 空闲上限（docs/20 §3.10.8）：网关上既没有在途请求、也这么久没有新请求就停下这一轮；
    // 总时长上限（§3.10.11）：含被调用的 agent 的墙钟上限，沙箱硬期限与 Grant 的绝对过期按它算
    limits: { idleTimeoutMs: agentConfig.runIdleTimeoutMs, totalTimeoutMs: agentConfig.runTotalTimeoutMs },
    // 会话标题（docs/20 §3.9）：不放进 agentHostOptions —— 测试复用那份接线，脚本化上游按顺序出步，多一次请求会打乱脚本
    ...(agentConfig.titleModel !== undefined ? { titleModel: agentConfig.titleModel } : {}),
    ...agentHostOptions,
  })
  if (!created.enabled) return disabled(created.disabledReason ?? '模型不可用')
  console.info(
    `[agent] 已启用：${resolved.value.model.provider}/${resolved.value.model.id}，沙箱驱动 ${built.driver.name}` +
      `（runner 经 ${agentGatewayUrl}）${agentConfig.sandboxExec ? '，媒体工具（ffmpeg / ffprobe）已开启' : ''}` +
      `${s3Enabled && resolved.value.model.input.includes('image') ? '，看图（view_node_media）已开启' : ''}`,
  )
  if (built.driver.name === 'process') {
    console.warn('[agent] process 沙箱驱动不是强隔离：runner 和服务端同一个用户、同一个文件系统、可以出网（docs/22 §4.2）')
  }
  return created
}

/** 清孤儿容器的间隔（和 Grant 的定时对账同一个节奏） */
export const SANDBOX_REAP_INTERVAL_MS = 10 * 60_000

/**
 * 启动时调（index.ts）：`oci` 驱动先自检（引擎、镜像、网络 → 日志 / 告警，docs/22 §10 验收 7），
 * 再清一次孤儿容器（上一个进程崩溃 / 被 SIGKILL 时留下的），之后每 10 分钟清一次（删除失败漏下的）。
 * `k8s` 驱动同理，但每次清之前都重查自检（准入兜底被拿掉也要停用），没过就不清（多半是连不上 / 没权限）。
 * `process` 驱动的 `reap` 是空操作；驱动建不起来（没配 / 生产拒绝 process）就什么也不做 —— 原因由 runtime 那边报。
 * 不阻塞启动；返回停止定时器的函数。
 */
export function startAgentSandboxReaper(intervalMs = SANDBOX_REAP_INTERVAL_MS): () => void {
  const built = sandboxDriver()
  if (!built.ok) {
    // 配了 oci / k8s 却建不起来（找不到 socket、不在集群里…）：启动时就说，不等第一次有人打开 agent 面板
    if (agentConfig.sandbox === 'oci' || agentConfig.sandbox === 'k8s') {
      console.warn(`[agent] ${agentConfig.sandbox} 沙箱不可用（agent 未启用）：${built.reason}`)
    }
    return () => {}
  }
  if (built.driver.name === 'process') return () => {}
  const { driver, oci, k8s } = built
  const reap = () =>
    driver.reap(runtime?.liveRunIds() ?? new Set()).catch((err: unknown) => {
      console.error(`[agent] 清理孤儿沙箱失败：${err instanceof Error ? err.message : String(err)}`)
    })
  let ticking = false
  const tick = async () => {
    // 上一轮还没完（API 很慢）就跳过这一轮，免得两次自检交错着改结论
    if (ticking) return
    ticking = true
    try {
      // k8s：每一轮都先重查自检 —— 没过的看它好了没有；过了的看兜底还在不在
      // （VAP / Role 被删、命名空间的 Pod Security 标签被摘掉，要在这一轮就停用，不能等到重启）。没过就不清孤儿
      if (k8s && !(await checkK8s(k8s))) return
      await reap()
    } finally {
      ticking = false
    }
  }
  void (async () => {
    if (oci) await checkOci(oci)
    if (k8s) {
      await ensureSandboxChecked(k8s)
      if (sandboxProblem !== null) return
    }
    await reap()
  })()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

function ensureSandboxChecked(driver: K8sSandboxDriver): Promise<void> {
  firstSandboxCheck ??= checkK8s(driver).then(() => undefined)
  return firstSandboxCheck
}

/** 自检至少跑完过一次（之后的定时重查只在结论变化时打日志） */
let sandboxCheckedOnce = false

/**
 * `k8s` 自检：API、权限、命名空间、Pod 规格能否过准入、准入兜底在不在 → 日志；结论写进 {@link sandboxProblem}。返回是否通过。
 * 启动时一次，之后每次清孤儿之前一次；详情（版本、告警）只在第一次和结论变化时打 —— 每 10 分钟一组同样的告警只是噪音
 */
async function checkK8s(driver: K8sSandboxDriver): Promise<boolean> {
  let problem: string | null = null
  let details = () => {}
  try {
    const check = await driver.check()
    details = () => {
      console.info(
        `[agent] k8s 沙箱：Kubernetes ${check.version}（${check.server}），命名空间 ${check.namespace}，镜像 ${check.image}，` +
          `RuntimeClass ${check.runtimeClassName ?? '（节点默认）'}，网关 ${agentGatewayUrl}`,
      )
      for (const warning of check.warnings) console.warn(`[agent] k8s 沙箱：${warning}`)
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
        console.warn(`[agent] k8s 沙箱：服务端只听 ${host}，沙箱 Pod 连不上 ${agentGatewayUrl}（Deployment 里设 HOST=0.0.0.0）`)
      }
    }
    if (check.problems.length > 0) problem = check.problems.join('；')
  } catch (err) {
    problem = `k8s 沙箱自检失败：${err instanceof Error ? err.message : String(err)}`
  }
  const first = !sandboxCheckedOnce
  sandboxCheckedOnce = true
  const changed = problem !== sandboxProblem
  if (first || changed) {
    details()
    if (problem !== null) console.error(`[agent] k8s 沙箱不可用（agent 未启用）：${problem}`)
    else if (!first) console.info('[agent] k8s 沙箱自检通过，agent 恢复启用')
  }
  sandboxProblem = problem
  // 已经建好的 runtime 和新结论对不上：没有在跑的轮次就扔掉，下次访问按新结论重建（有在跑的轮次说明它起得来，留着）
  if (changed && runtime && runtime.liveRunIds().size === 0) runtime = null
  return problem === null
}

async function checkOci(driver: OciSandboxDriver) {
  try {
    const check = await driver.check()
    console.info(
      `[agent] oci 沙箱：${check.engine.name} ${check.engine.version}（API ${check.engine.apiVersion}，${check.socketPath}），` +
        `镜像 ${check.image.name}，网络 ${check.network.name}，网关 ${agentGatewayUrl}`,
    )
    if (!check.image.present) {
      console.warn(`[agent] oci 沙箱镜像 ${check.image.name} 不存在：先 pnpm build:sandbox-image（或检查 AGENT_SANDBOX_IMAGE），否则每一轮都会起不来`)
    }
    if (!check.network.exists) {
      console.warn(`[agent] oci 沙箱网络 ${check.network.name} 不存在（AGENT_SANDBOX_OCI_NETWORK），每一轮都会起不来`)
    } else if (!check.network.internal) {
      console.warn(
        `[agent] oci 沙箱可以出网：网络 ${check.network.name} 不是 internal，容器除了网关还能访问外网和宿主上监听的端口（docs/22 §7.4）`,
      )
    }
  } catch (err) {
    console.error(`[agent] oci 沙箱自检失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

export function agentRuntime(): AgentRuntime {
  runtime ??= buildRuntime()
  return runtime
}

/** 测试用：换成一个用假模型驱动的 runtime；传 null 回到按环境变量构造 */
export function replaceAgentRuntime(next: AgentRuntime | null): void {
  runtime = next
}

/**
 * 进程退出前：中止所有在跑的轮次（杀掉它们的沙箱），并等它们收尾 —— 对话落库、运行日志写完、画布连接关掉。
 * 已经写进画布的改动保留，房间照常落库。**要在关数据库之前 await**（index.ts 的 shutdown 给了上限）。
 */
export function abortAgentRuns(reason: string): Promise<void> {
  return runtime?.abortAll(reason) ?? Promise.resolve()
}
