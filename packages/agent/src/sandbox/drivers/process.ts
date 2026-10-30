import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { RUNNER_ENV } from '../../protocol.ts'
import type { SandboxDriver, SandboxExit, SandboxHandle, SandboxSpec } from '../driver.ts'
import { SAFE_SEGMENT } from '../local.ts'

/**
 * `process` 驱动：runner 跑在本机的一个 `node` 子进程里（docs/22 §7 / §7.1）。**它不是强隔离** ——
 * 同一个用户、同一个文件系统、同一张网卡，被攻破的 runner 照样能读这个用户读得到的文件、照样能出网。
 * 它守住的是：
 *
 * 1. **环境从零造**（{@link runnerEnv}）：只有网关地址、一次性 bootstrap token、工作目录、`PATH`。
 *    服务端进程里的 LLM key、`DATABASE_URL`、`SESSION_SECRET`、`REDIS_URL` 一个都不继承（docs/22 §10 验收 1）；
 * 2. **杀就是整组杀**：子进程以 `detached` 起（自己是进程组组长），`kill` 给整个组发 SIGKILL ——
 *    runner 和它正在跑的 ffmpeg 一起没，然后删工作目录（验收 5）。runner 自然退出后也补一刀，清掉漏网的孙进程；
 * 3. **时长兜底**：`resources.deadlineMs` 到点即杀（编排层自己的时长上限通常先到）。
 *
 * **`NODE_ENV=production` 时拒绝**（{@link createProcessDriver} 直接抛），除非宿主显式放行
 * （apps/server 的 `AGENT_SANDBOX_ALLOW_PROCESS=1`）。本包不读 `process.env`：生产与否、放不放行都由宿主传进来。
 *
 * 跑哪个入口由宿主决定（`command`）：源码态 `node --import tsx packages/agent/src/runner/main.ts`，
 * 产物态 `node output/server/agent-runner.js`。工作目录 `<rootDir>/<flowId>/<runId>`，也是 runner 的 cwd。
 * `reap` 是空操作：服务端崩了，runner 发现父进程变了会连同自己的进程组自尽（`runner/main.ts`）。
 */

export interface ProcessDriverOptions {
  /** 起 runner 的命令：`[可执行文件, ...参数]` */
  command: readonly [string, ...string[]]
  /** 每一轮工作目录的根 */
  rootDir: string
  /** runner（以及它起的 ffmpeg）的 `PATH`；不给用一份保守的系统默认值 */
  pathEnv?: string
  /** 宿主是不是生产环境 */
  production: boolean
  /** 生产环境也放行（宿主显式配置；不建议） */
  allowInProduction?: boolean
  /** runner 的 stdout / stderr，逐行（宿主拿去打日志） */
  onOutput?: (runId: string, stream: 'stdout' | 'stderr', line: string) => void
}

/** 这个进程沙箱的句柄：多一个 `pid`（测试、排查用） */
export interface ProcessSandboxHandle extends SandboxHandle {
  readonly pid: number
  readonly workdir: string
}

export const PROCESS_DRIVER_REFUSED_IN_PRODUCTION =
  'process 沙箱驱动不是强隔离，生产环境（NODE_ENV=production）拒绝启用；确需使用请显式放行（AGENT_SANDBOX_ALLOW_PROCESS=1）'

const DEFAULT_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
/** 一轮最多转发多少行输出：被攻破的 runner 不该能把服务端日志刷爆（`oci` 驱动用同一组上限） */
export const OUTPUT_LINE_LIMIT = 500
export const OUTPUT_LINE_CHARS = 2000

/**
 * runner 进程的完整环境 —— **只有这四个变量**。导出给测试直接断言。
 */
export function runnerEnv(spec: SandboxSpec, workdir: string, pathEnv: string): Record<string, string> {
  return {
    PATH: pathEnv,
    [RUNNER_ENV.gatewayUrl]: spec.gatewayUrl,
    [RUNNER_ENV.bootstrapToken]: spec.credential.token,
    [RUNNER_ENV.workdir]: workdir,
  }
}

/** 给整个进程组发 SIGKILL；组已经没了就算了 */
function killGroup(child: ChildProcess) {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill('SIGKILL')
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    // ESRCH：已经没了
  }
}

export function createProcessDriver(options: ProcessDriverOptions): SandboxDriver {
  if (options.production && !options.allowInProduction) throw new Error(PROCESS_DRIVER_REFUSED_IN_PRODUCTION)
  const [file, ...baseArgs] = options.command
  const pathEnv = options.pathEnv ?? DEFAULT_PATH

  return {
    name: 'process',

    async start(spec): Promise<ProcessSandboxHandle> {
      if (!SAFE_SEGMENT.test(spec.flowId) || !SAFE_SEGMENT.test(spec.runId)) {
        throw new Error('flowId / runId 含有不能做目录名的字符')
      }
      const dir = path.join(options.rootDir, spec.flowId, spec.runId)
      await mkdir(dir, { recursive: true })
      // 存真实路径：macOS 的 /var 是 /private/var 的链接，runner 里的沙箱按 realpath 比较
      const workdir = await realpath(dir)

      const child = spawn(file, baseArgs, {
        cwd: workdir,
        env: runnerEnv(spec, workdir, pathEnv),
        // 自己当进程组组长：kill 一个组，ffmpeg 跟着一起没
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
      } catch (err) {
        await rm(workdir, { recursive: true, force: true })
        throw new Error(`沙箱进程起不来：${err instanceof Error ? err.message : String(err)}`, { cause: err })
      }
      const pid = child.pid!

      let lines = 0
      for (const [stream, source] of [
        ['stdout', child.stdout],
        ['stderr', child.stderr],
      ] as const) {
        createInterface({ input: source }).on('line', (line) => {
          lines += 1
          if (lines > OUTPUT_LINE_LIMIT) return
          const text = lines === OUTPUT_LINE_LIMIT ? '（输出太多，之后的不再转发）' : line.slice(0, OUTPUT_LINE_CHARS)
          try {
            options.onOutput?.(spec.runId, stream, text)
          } catch {
            // 打日志失败不影响沙箱
          }
        })
      }

      let killReason: string | null = null
      const exited = new Promise<SandboxExit>((resolve) => {
        child.once('exit', (code, signal) => {
          // 漏网的孙进程（runner 自然退出时还没收拾的）一并清掉，再删工作目录
          killGroup(child)
          clearTimeout(deadline)
          void rm(workdir, { recursive: true, force: true })
            .catch((err: unknown) => console.warn(`[agent] run=${spec.runId} 沙箱工作目录没能清理`, err))
            .then(() =>
              resolve(
                killReason !== null
                  ? { exitCode: null, reason: killReason }
                  : { exitCode: code, ...(signal ? { reason: `被信号 ${signal} 结束` } : {}) },
              ),
            )
        })
      })
      const deadline = setTimeout(() => {
        killReason ??= `超过沙箱时长上限 ${Math.round(spec.resources.deadlineMs / 1000)} 秒`
        killGroup(child)
      }, spec.resources.deadlineMs)
      deadline.unref()

      return {
        id: `process:${pid}`,
        pid,
        workdir,
        wait: () => exited,
        async kill(reason) {
          killReason ??= reason
          killGroup(child)
          await exited
        },
      }
    },

    async reap() {},
  }
}
