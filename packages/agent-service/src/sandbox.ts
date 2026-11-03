import { createHash } from 'node:crypto'
import { AGENT_GATEWAY_PATH } from '@learning/agent-core/protocol'
import { createEngineClient, findEngineSocket } from '@learning/agent-core/sandbox/drivers/engine'
import { createOciDriver, type OciSandboxDriver } from '@learning/agent-core/sandbox/drivers/oci'
import { createProcessDriver } from '@learning/agent-core/sandbox/drivers/process'
import type { AgentRuntime, AgentRuntimeOptions } from '@learning/agent-core/session'
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { AGENT_OPTIONS, type AgentOptions } from './options.js'
import { runnerCommand } from './runner-command.js'

export const SANDBOX_DRIVER = Symbol('SANDBOX_DRIVER')
/** `runtime.ts` 要 import 这里的 `agentGatewayUrl`，token 放这里免得成环 */
export const AGENT_RUNTIME = Symbol('AGENT_RUNTIME')

export type BuiltDriver = { ok: true; driver: AgentRuntimeOptions['driver']; oci?: OciSandboxDriver } | { ok: false; reason: string }

/** 清孤儿容器的间隔（和 Grant 的定时对账同一个节奏） */
export const SANDBOX_REAP_INTERVAL_MS = 10 * 60_000

/** 沙箱里看到的网关地址 */
export function agentGatewayUrl(options: Pick<AgentOptions, 'gatewayUrl'>): string {
  return `${options.gatewayUrl}${AGENT_GATEWAY_PATH}`
}

/**
 * 这个实例在容器引擎上的标识（`oci` 容器的 `instance` label，`reap` 只清这个值的）：网关地址的哈希。
 * 一轮只能连回发起它的实例，同一个网关地址的旧容器在重启之后就是孤儿；同一个引擎上别的实例的容器不受影响。
 */
export function agentSandboxInstance(options: Pick<AgentOptions, 'gatewayUrl'>): string {
  return createHash('sha256').update(agentGatewayUrl(options)).digest('hex').slice(0, 16)
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]']

/**
 * `oci` 的网关地址在这台机器上连不回来的情况（`docs/31` §6.4）。不拒绝启动：地址对不对只有引擎知道，要到第一轮 runner 连不上才报，所以启动时先说。
 * podman machine 实测 `host.docker.internal` 经 gvproxy 转回 Mac 的回环；Linux 上没有这一层。
 */
export function ociGatewayProblem(gatewayUrl: string, platform: NodeJS.Platform = process.platform): string | null {
  // `shadecn:3100` 也解析得过（协议是 shadecn:），所以看协议，不只看抛不抛
  const url = URL.canParse(gatewayUrl) ? new URL(gatewayUrl) : null
  if (!url || !/^https?:$/.test(url.protocol)) return `网关地址 ${gatewayUrl} 不是一个完整的地址（要带 http://；agent.gatewayUrl）`
  const { hostname } = url
  if (LOOPBACK_HOSTS.includes(hostname)) return `网关地址 ${gatewayUrl} 指向回环，容器里的回环是容器自己，runner 连不回来（agent.gatewayUrl）`
  if (hostname === 'host.docker.internal' && platform === 'linux') {
    return `网关地址 ${gatewayUrl} 在 Linux 上多半连不回来：Docker 要显式配这个主机名，Podman 指向宿主的网卡地址、只听回环的平台收不到（agent.gatewayUrl、server.host）`
  }
  return null
}

const logRunnerOutput = (runId: string, stream: 'stdout' | 'stderr', line: string) => {
  if (stream === 'stderr') console.warn(`[agent-runner] run=${runId} ${line}`)
  else console.info(`[agent-runner] run=${runId} ${line}`)
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * `SANDBOX_DRIVER` 的工厂。建不了（生产拒绝 `process`、找不到引擎 socket、写了这个服务没有的驱动）是「agent 未启用」的原因，不是启动失败。
 * `PATH`、找 socket 读的 `process.env` 是本进程的运行环境，不是配置，所以这个包只有这里碰它。
 */
export function buildSandboxDriver(options: AgentOptions): BuiltDriver {
  const choice = options.sandbox
  if (typeof choice === 'object') {
    const hint =
      choice.unknown === 'k8s'
        ? '这个服务没有 k8s 驱动（docs/31 §3.2：k8s 跑通后再议），可选 process / oci'
        : '不认识这个沙箱驱动，可选 process / oci'
    return { ok: false, reason: `agent.sandbox.driver=${choice.unknown}：${hint}` }
  }
  // 不等监听后再算：地址要进 runtime 的网关配置，`oci` 容器的 instance 标识也由它算，都在建 provider 时就定了。一个端口要到监听时才知道的进程，只有配了地址才知道怎么连回来
  if (options.gatewayUnknown) return { ok: false, reason: 'server.port 是 0，端口要到监听时才知道，runner 连不回来：写一个固定端口，或配 agent.gatewayUrl' }
  try {
    if (choice === 'oci') {
      const socket = findEngineSocket(options.ociSocket, process.env)
      if (!socket.ok) return { ok: false, reason: socket.reason }
      const driver = createOciDriver({
        engine: createEngineClient(socket.path),
        image: options.sandboxImage,
        instance: agentSandboxInstance(options),
        network: options.ociNetwork,
        ...(options.sandboxRuntime ? { runtime: options.sandboxRuntime } : {}),
        onOutput: logRunnerOutput,
      })
      return { ok: true, driver, oci: driver }
    }
    const driver = createProcessDriver({
      command: runnerCommand(),
      rootDir: options.workspaceDir,
      pathEnv: process.env.PATH,
      production: options.production,
      allowInProduction: options.allowProcessInProduction,
      onOutput: logRunnerOutput,
    })
    return { ok: true, driver }
  } catch (err) {
    return { ok: false, reason: messageOf(err) }
  }
}

/**
 * `oci` 驱动：启动时自检（引擎、镜像、网络 → 日志 / 告警），清一次孤儿容器（上一个进程崩溃留下的），之后每 10 分钟清一次。不阻塞启动。
 * `process` 驱动的 `reap` 是空操作，这里什么也不做，也不碰任何容器引擎。
 */
@Injectable()
export class AgentSandboxReaper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined

  constructor(
    @Inject(SANDBOX_DRIVER) private readonly built: BuiltDriver,
    @Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime,
    @Inject(AGENT_OPTIONS) private readonly options: AgentOptions,
  ) {}

  onModuleInit(): void {
    const { built } = this
    if (!built.ok) {
      // 配了 oci 却建不起来：启动时就说，不等第一次有人打开面板
      if (this.options.sandbox === 'oci') console.warn(`[agent] oci 沙箱不可用（agent 未启用）：${built.reason}`)
      return
    }
    if (!built.oci) return
    const { oci, driver } = built
    const reap = () =>
      driver.reap(this.runtime.liveRunIds()).catch((err: unknown) => {
        console.error(`[agent] 清理孤儿沙箱失败：${messageOf(err)}`)
      })
    void this.checkOci(oci).then(reap)
    this.timer = setInterval(() => void reap(), SANDBOX_REAP_INTERVAL_MS)
    this.timer.unref()
  }

  onModuleDestroy(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  private async checkOci(driver: OciSandboxDriver): Promise<void> {
    const gateway = agentGatewayUrl(this.options)
    try {
      const check = await driver.check()
      console.info(`[agent] oci 沙箱：${check.engine.name} ${check.engine.version}（API ${check.engine.apiVersion}，${check.socketPath}），镜像 ${check.image.name}，网络 ${check.network.name}，网关 ${gateway}`)
      const gatewayProblem = ociGatewayProblem(gateway)
      if (gatewayProblem) console.warn(`[agent] oci 沙箱：${gatewayProblem}`)
      if (!check.image.present) console.warn(`[agent] oci 沙箱镜像 ${check.image.name} 不存在（agent.sandbox.image；pnpm build:agent-runner-image），否则每一轮都会起不来`)
      if (!check.network.exists) {
        console.warn(`[agent] oci 沙箱网络 ${check.network.name} 不存在（agent.sandbox.oci.network），每一轮都会起不来`)
      } else if (!check.network.internal) {
        console.warn(`[agent] oci 沙箱可以出网：网络 ${check.network.name} 不是 internal，容器除了网关还能访问外网和宿主上监听的端口（docs/22 §7.4）`)
      }
    } catch (err) {
      console.error(`[agent] oci 沙箱自检失败：${messageOf(err)}`)
    }
  }
}
