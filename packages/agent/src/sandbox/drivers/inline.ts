import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAgentRunner } from '../../runner/index.ts'
import type { SkillRegistry } from '../../skills/registry.ts'
import type { SandboxDriver, SandboxExit, SandboxHandle } from '../driver.ts'

/**
 * **测试专用**的进程内驱动：runner 就在当前进程里跑（`runAgentRunner`），但照样只经网关协议说话 ——
 * 换令牌、取输入、工具 RPC、事件上报、模型请求一样不少（打网关用的 fetch 由测试路由到 `gateway.handle`，
 * 不开端口），所以编排层看到的和 `process` 驱动逐帧相同，只是快得多。
 *
 * 它**不隔离任何东西**（同一个进程、同一份环境），所以只从 `@shadecn/agent/testing` 导出，
 * 宿主的配置（`AGENT_SANDBOX`）没有任何取值能选到它。「杀」= 掐掉 runner 的 AbortSignal（pi 中止、在途请求中断、
 * ffmpeg 随 pi 的 signal 被 SIGKILL），之后删工作目录。
 */

export interface InlineDriverOptions {
  /** 工作目录的根；不给用系统临时目录下的一个 */
  rootDir?: string
  pathEnv?: string
  /** runner 打网关用的 fetch；不给用调用那一刻的 `globalThis.fetch`（测试通常把它路由到网关） */
  fetch?: typeof fetch
  /** 覆盖 runner 报给网关的协议版本（`null` = 不带，模拟老镜像）；测试用它造「版本不一致的 runner」 */
  protocolVersion?: number | null
  /** 覆盖 runner 报给网关的构建 id */
  buildId?: string
  /** runner 用的技能注册表：测试注册了自己的技能时，必须和 `createAgentRuntime({ skills })` 是同一个 */
  skills?: SkillRegistry
}

/** kill 之后等 runner 停下的上限 */
const KILL_WAIT_MS = 5000

export function createInlineDriver(options: InlineDriverOptions = {}): SandboxDriver & { readonly started: SandboxHandle[] } {
  const root = options.rootDir ?? path.join(tmpdir(), `shadecn-agent-inline-${process.pid}`)
  const started: SandboxHandle[] = []
  return {
    name: 'inline',
    started,
    async start(spec) {
      const workdir = path.join(root, spec.flowId, spec.runId)
      await mkdir(workdir, { recursive: true })
      const controller = new AbortController()
      let killReason: string | null = null
      const done: Promise<SandboxExit> = runAgentRunner({
        gatewayUrl: spec.gatewayUrl,
        bootstrapToken: spec.credential.token,
        workdir,
        signal: controller.signal,
        ...(options.pathEnv ? { pathEnv: options.pathEnv } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.protocolVersion !== undefined ? { protocolVersion: options.protocolVersion } : {}),
        ...(options.buildId !== undefined ? { buildId: options.buildId } : {}),
        ...(options.skills ? { skills: options.skills } : {}),
      })
        .then(
          (): SandboxExit => ({ exitCode: 0 }),
          (err: unknown): SandboxExit => ({ exitCode: 1, reason: err instanceof Error ? err.message : String(err) }),
        )
        .then(async (exit) => {
          await rm(workdir, { recursive: true, force: true })
          return killReason !== null ? { exitCode: null, reason: killReason } : exit
        })
      const handle: SandboxHandle = {
        id: `inline:${spec.runId}`,
        wait: () => done,
        async kill(reason) {
          killReason ??= reason
          controller.abort(new Error(reason))
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([done, new Promise((resolve) => (timer = setTimeout(resolve, KILL_WAIT_MS)))])
          clearTimeout(timer)
        },
      }
      started.push(handle)
      return handle
    },
    async reap() {},
  }
}
