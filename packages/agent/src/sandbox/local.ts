import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ExecOptions, ExecResult, Sandbox, SandboxProvider } from './types.ts'

/**
 * 本机子进程实现的沙箱 —— **它不是强隔离**。
 *
 * 子进程和服务端是同一个用户、同一个文件系统、同一张网卡：一个被攻破的 ffmpeg
 * 照样能读这个用户读得到的任何文件、照样能出网。这个实现只防两件事：
 *
 * 1. **凭据经环境变量泄露**：子进程的 env 是从零造的，只有 `PATH` / `HOME` / `TMPDIR`，
 *    服务端进程里的 LLM key、`DATABASE_URL`、`SESSION_SECRET`、`REDIS_URL` 一个都不继承。
 *    这是最容易犯、也最容易被注入利用的一条（「把环境变量打印到输出里」）。
 * 2. **误操作**：命令白名单（默认只有 `ffmpeg` / `ffprobe`）、不经 shell（参数里的 `;` `$()`
 *    没有意义）、超时强杀、输出截断、读写只限工作目录（路径穿越与符号链接逃逸都挡）。
 *
 * **生产要换成 docker / k8s Job 的实现**（gVisor `runsc` 或 Kata，非 root、只读根文件系统、
 * 默认拒绝的 NetworkPolicy、资源限额），见 docs/20 §3.9 ④。接口（`types.ts`）就是为那一步留的。
 *
 * 工作目录：`<rootDir>/<flowId>/<runId>` —— 一张画布一个项目目录，每个 run 一个子目录，
 * `dispose()` 删掉。
 */

export interface LocalSandboxOptions {
  /** 所有工作目录的根，例如 `<dataDir>/agent-workspaces` */
  rootDir: string
  /** 允许执行的命令（只认裸命令名，按 `pathEnv` 查找） */
  allowedCommands?: readonly string[]
  /**
   * 子进程的 `PATH`。由宿主传进来 —— 本包不读 `process.env`。
   * 不给就用一份保守的系统默认值。
   */
  pathEnv?: string
}

export const DEFAULT_SANDBOX_COMMANDS = ['ffmpeg', 'ffprobe'] as const

const DEFAULT_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'

/** 单个参数的长度上限；ffmpeg 的滤镜串再长也到不了这个量级 */
const MAX_ARG_LENGTH = 2000
const MAX_ARGS = 128

/** id 只允许做路径段的安全字符 —— flowId / runId 会直接拼进目录名 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,80}$/

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * 参数里明显是「工作目录之外」的东西直接拒：绝对路径、`..` 段、带协议前缀的 URL
 * （ffmpeg 能直接 `-i http://…`，那就是一条出网的路）。
 *
 * 这是**尽力而为**的过滤，不是安全边界 —— ffmpeg 的参数语法太灵活（`concat:`、`subfile,,`、
 * 滤镜里的 `movie=`…），真正的边界是容器实现里的只读文件系统和默认拒绝的网络。
 */
function checkArg(arg: string): string | null {
  if (typeof arg !== 'string') return '参数必须是字符串'
  if (arg.length > MAX_ARG_LENGTH) return `参数超过 ${MAX_ARG_LENGTH} 字`
  if (arg.includes('\0')) return '参数里不能有 NUL'
  if (path.isAbsolute(arg)) return `不允许绝对路径：${arg.slice(0, 80)}`
  if (arg.split(/[\\/]/).includes('..')) return `不允许 .. 路径段：${arg.slice(0, 80)}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(arg) && !/^[a-z]:[\\/]/i.test(arg)) {
    return `不允许带协议前缀的参数：${arg.slice(0, 80)}`
  }
  return null
}

class LocalSandbox implements Sandbox {
  readonly workdir: string
  private readonly allowed: ReadonlySet<string>
  private readonly pathEnv: string
  private disposed = false

  constructor(workdir: string, allowed: ReadonlySet<string>, pathEnv: string) {
    this.workdir = workdir
    this.allowed = allowed
    this.pathEnv = pathEnv
  }

  /**
   * 相对路径 → 工作目录里的绝对路径；越界就抛。
   * 先做字面量检查（`../`、绝对路径），落盘读写时再按真实路径复查一次（符号链接）。
   */
  private resolve(relativePath: string): string {
    if (this.disposed) throw new Error('沙箱已销毁')
    if (typeof relativePath !== 'string' || relativePath === '' || relativePath.includes('\0')) {
      throw new Error('路径不合法')
    }
    if (path.isAbsolute(relativePath)) throw new Error(`只接受工作目录内的相对路径：${relativePath}`)
    const target = path.resolve(this.workdir, relativePath)
    if (!within(this.workdir, target)) throw new Error(`路径越出了工作目录：${relativePath}`)
    return target
  }

  async writeFile(relativePath: string, content: string | Uint8Array): Promise<void> {
    const target = this.resolve(relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    // 父目录可能是一条指向外面的符号链接（子进程可以自己造）：按真实路径复查
    const realParent = await realpath(path.dirname(target))
    if (realParent !== this.workdir && !within(this.workdir, realParent)) {
      throw new Error(`路径越出了工作目录：${relativePath}`)
    }
    // 目标本身是符号链接的话，writeFile 会顺着写到链接指向的地方
    const existing = await lstat(target).catch(() => null)
    if (existing?.isSymbolicLink()) throw new Error(`不写符号链接：${relativePath}`)
    await writeFile(target, content)
  }

  async readFile(relativePath: string): Promise<Uint8Array> {
    const target = this.resolve(relativePath)
    const real = await realpath(target)
    if (!within(this.workdir, real)) throw new Error(`路径越出了工作目录：${relativePath}`)
    return new Uint8Array(await readFile(real))
  }

  exec(command: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    if (this.disposed) return Promise.reject(new Error('沙箱已销毁'))
    // 只认裸命令名：`/tmp/evil/ffmpeg`、`./ffmpeg` 这种一律不算白名单里的那个
    if (!this.allowed.has(command) || command.includes('/') || command.includes('\\')) {
      return Promise.reject(new Error(`命令不在白名单里：${command}（允许：${[...this.allowed].join(', ')}）`))
    }
    if (args.length > MAX_ARGS) return Promise.reject(new Error(`参数超过 ${MAX_ARGS} 个`))
    for (const arg of args) {
      const problem = checkArg(arg)
      if (problem) return Promise.reject(new Error(problem))
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: this.workdir,
        // **从零造的环境**：不继承服务端进程的任何变量（LLM key、数据库连接串、会话密钥…）
        env: { PATH: this.pathEnv, HOME: this.workdir, TMPDIR: path.join(this.workdir, 'tmp') },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })

      const limit = options.maxOutputBytes
      const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], bytes: { stdout: 0, stderr: 0 } }
      let truncated = false
      const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
        const room = limit - out.bytes[stream]
        if (room <= 0) {
          truncated = true
          return
        }
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
        if (kept.length < chunk.length) truncated = true
        out[stream].push(kept)
        out.bytes[stream] += kept.length
      }
      child.stdout.on('data', collect('stdout'))
      child.stderr.on('data', collect('stderr'))

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, options.timeoutMs)

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`无法启动 ${command}：${err.message}`))
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        resolve({
          exitCode: code,
          signal,
          stdout: Buffer.concat(out.stdout).toString('utf8'),
          stderr: Buffer.concat(out.stderr).toString('utf8'),
          timedOut,
          truncated,
        })
      })
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await rm(this.workdir, { recursive: true, force: true })
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  private readonly options: LocalSandboxOptions
  private readonly allowed: ReadonlySet<string>
  private readonly pathEnv: string

  constructor(options: LocalSandboxOptions) {
    this.options = options
    this.allowed = new Set(options.allowedCommands ?? DEFAULT_SANDBOX_COMMANDS)
    this.pathEnv = options.pathEnv ?? DEFAULT_PATH
  }

  async create(flowId: string, runId: string): Promise<Sandbox> {
    if (!SAFE_SEGMENT.test(flowId) || !SAFE_SEGMENT.test(runId)) {
      throw new Error('flowId / runId 含有不能做目录名的字符')
    }
    const dir = path.join(this.options.rootDir, flowId, runId)
    await mkdir(path.join(dir, 'tmp'), { recursive: true })
    // 存真实路径：macOS 的 /var 是 /private/var 的链接，后面按 realpath 比较时两边要一致
    return new LocalSandbox(await realpath(dir), this.allowed, this.pathEnv)
  }
}
