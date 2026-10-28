/**
 * 执行沙箱的抽象（REQ-AGENT §3.1「手」、§3.9 ④）。
 *
 * 编排器（「大脑」，持有 LLM key 和画布访问能力）**不执行不可信的东西**；ffmpeg 解析
 * 别人上传的媒体、将来跑代码，都派给沙箱。沙箱只有自己的工作目录，没有任何凭据。
 *
 * 一张画布一个项目：工作目录按 `flowId / runId` 归属，每个 run 一个，用完即毁
 * （不跨 run、不跨画布复用 —— docs/20 §3.9 ④）。
 *
 * 实现可以换：本期只有 {@link import('./local.ts').LocalSandboxProvider}（本机子进程），
 * 之后的 docker / k8s Job（gVisor）实现同样满足这个接口，编排器一行不用改。
 */

export interface ExecOptions {
  /** 超时即强杀 */
  timeoutMs: number
  /** stdout / stderr 各自最多留多少字节，超出截断 */
  maxOutputBytes: number
}

export interface ExecResult {
  /** 正常退出的退出码；被信号杀掉时为 null */
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** stdout 或 stderr 有没有被截断 */
  truncated: boolean
}

export interface Sandbox {
  /** 工作目录的绝对路径（本地实现里是真实路径；容器实现里是容器内路径） */
  readonly workdir: string
  /** 写工作目录里的文件；路径必须是工作目录内的相对路径 */
  writeFile(relativePath: string, content: string | Uint8Array): Promise<void>
  readFile(relativePath: string): Promise<Uint8Array>
  /** 在工作目录里跑一个白名单内的命令；不经 shell */
  exec(command: string, args: readonly string[], options: ExecOptions): Promise<ExecResult>
  /** 销毁：删掉工作目录（容器实现里是删 Pod / Job）。可重复调用 */
  dispose(): Promise<void>
}

export interface SandboxProvider {
  create(flowId: string, runId: string): Promise<Sandbox>
}
