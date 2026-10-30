import { createHash } from 'node:crypto'
import { getEnvApiKey } from '@mariozechner/pi-ai'
import { resolveAgentModel } from '@shadecn/agent/model'
import { AGENT_GATEWAY_PATH } from '@shadecn/agent/protocol'
import {
  createEngineClient,
  createOciDriver,
  createProcessDriver,
  findEngineSocket,
  type OciSandboxDriver,
  type SandboxDriver,
} from '@shadecn/agent/sandbox/drivers'
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeOptions } from '@shadecn/agent/session'
import { agentConfig, agentWorkspaceDir, isDev, s3Enabled } from '../config.ts'
import { agentConversations, agentRunLog } from '../store/agent.ts'
import { users } from '../store/users.ts'
import { agentAuthority } from './authority.ts'
import { agentMediaReader } from './media.ts'
import { runnerCommand } from './runner-command.ts'
import { broadcastAgentRuns } from './runs-broadcast.ts'

/**
 * 画布 Agent 在本服务里的装配点：环境变量 → `@shadecn/agent` 的显式参数。
 *
 * 那个包不读 `process.env`（见 `@shadecn/agent/model`），所以「没给 `AGENT_API_KEY` 时退回
 * pi 自己的环境变量约定」「沙箱子进程的 PATH」「生产环境拒绝 process 驱动」这类环境相关的决定都在这里做。
 *
 * **二期 / 三期（docs/22 §9 第 2、3 项）**：pi 的推理循环跑在每轮一个的沙箱里（`process` 驱动 = 本机 node 子进程；
 * `oci` 驱动 = 每轮一个 Docker / Podman 容器），经网关（`routes/agent-gateway.ts`，挂在 `AGENT_GATEWAY_PATH`）说话。
 * 真实的 LLM key 只在这里交给网关的模型代理；沙箱的环境变量只有网关地址、一次性 bootstrap token、工作目录和 `PATH`。
 *
 * 驱动和 runtime 分开懒建：驱动在启动时就要用（{@link startAgentSandboxReaper}：`oci` 的启动自检 + 清孤儿容器），
 * runtime 等第一次有人访问 agent 接口。两边拿的是同一个驱动实例。
 *
 * **懒创建**：第一次有人访问 agent 接口时才解析模型。没配 key / 驱动不可用的进程里它只是一个
 * `enabled: false` 的空壳，不影响启动、也不打一行警告以外的东西。
 */

let runtime: AgentRuntime | null = null

/**
 * 宿主这一侧接给编排层的东西：落库、用户信息、任务列表变更时的房间广播（docs/20 §3.10.4）、
 * 每一轮的执行身份（Grant 签发 / 判权 / 对账，docs/22，`authority.ts`）。
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
} satisfies Pick<AgentRuntimeOptions, 'store' | 'runLog' | 'userProfiles' | 'onRunsChange' | 'authorities'>

/** 沙箱里看到的网关地址 */
export const agentGatewayUrl = `${agentConfig.gatewayUrl}${AGENT_GATEWAY_PATH}`

/**
 * 这个实例在容器引擎上的标识（`oci` 容器的 `instance` label，`reap` 只清这个值的）：沙箱看到的网关地址的哈希。
 * 一轮只能连回发起它的实例（令牌和登记在进程内存），同一个网关地址的旧容器在重启之后就是孤儿；
 * 同一个引擎上别的实例（别的端口 / 别的主机名）的容器不受影响。
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

type BuiltDriver = { ok: true; driver: SandboxDriver; oci?: OciSandboxDriver } | { ok: false; reason: string }
let builtDriver: BuiltDriver | null = null

/** 按 `AGENT_SANDBOX` 建驱动（只建一次）；建不了 → 未启用的原因 */
function sandboxDriver(): BuiltDriver {
  builtDriver ??= buildDriver()
  return builtDriver
}

function buildDriver(): BuiltDriver {
  const choice = agentConfig.sandbox
  if (typeof choice === 'object') {
    return { ok: false, reason: `不认识的沙箱驱动 AGENT_SANDBOX=${choice.unknown}（可选 process / oci；k8s 是后续分期）` }
  }
  if (choice === 'k8s') return { ok: false, reason: '沙箱驱动 k8s 还没实现（docs/22 §9 第 4 期）' }
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

function buildRuntime(): AgentRuntime {
  const gateway = { url: agentGatewayUrl, secret: agentConfig.tokenSecret }
  const disabled = (reason: string) => {
    console.warn(`[agent] 未启用：${reason}`)
    return createAgentRuntime({ model: null, disabledReason: reason, driver: NO_DRIVER, gateway, ...agentHostOptions })
  }

  const apiKey = agentConfig.apiKey || getEnvApiKey(agentConfig.provider) || ''
  const resolved = resolveAgentModel({
    provider: agentConfig.provider,
    model: agentConfig.model,
    baseUrl: agentConfig.baseUrl,
    api: agentConfig.api,
    apiKey,
    ...(agentConfig.imageInput !== undefined ? { imageInput: agentConfig.imageInput } : {}),
  })
  if (!resolved.ok) return disabled(resolved.reason)

  const built = sandboxDriver()
  if (!built.ok) return disabled(built.reason)

  const created = createAgentRuntime({
    model: resolved.value,
    driver: built.driver,
    gateway,
    mediaTool: agentConfig.sandboxExec,
    // 看图只读本服务的对象存储：没配 S3 就不接（工具也就不给模型）；还要模型吃图片，由编排层判
    ...(s3Enabled ? { mediaReader: agentMediaReader } : {}),
    sandbox: { image: agentConfig.sandboxImage, resources: agentConfig.sandboxResources },
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
 * `process` 驱动的 `reap` 是空操作；驱动建不起来（没配 / 生产拒绝 process）就什么也不做 —— 原因由 runtime 那边报。
 * 不阻塞启动；返回停止定时器的函数。
 */
export function startAgentSandboxReaper(intervalMs = SANDBOX_REAP_INTERVAL_MS): () => void {
  const built = sandboxDriver()
  if (!built.ok) {
    // 配了 oci 却建不起来（找不到 socket…）：启动时就说，不等第一次有人打开 agent 面板
    if (agentConfig.sandbox === 'oci') console.warn(`[agent] oci 沙箱不可用（agent 未启用）：${built.reason}`)
    return () => {}
  }
  if (built.driver.name === 'process') return () => {}
  const { driver, oci } = built
  const reap = () =>
    driver.reap(runtime?.liveRunIds() ?? new Set()).catch((err: unknown) => {
      console.error(`[agent] 清理孤儿沙箱失败：${err instanceof Error ? err.message : String(err)}`)
    })
  void (async () => {
    if (oci) await checkOci(oci)
    await reap()
  })()
  const timer = setInterval(() => void reap(), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
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
