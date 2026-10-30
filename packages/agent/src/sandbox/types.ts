/**
 * 执行沙箱的抽象（REQ-AGENT §3.1「手」、§3.9 ④）。
 *
 * 编排器（「大脑」，持有 LLM key 和画布访问能力）**不执行不可信的东西**；ffmpeg 解析
 * 别人上传的媒体、将来跑代码，都派给沙箱。沙箱只有自己的工作目录，没有任何凭据。
 *
 * 一张画布一个项目：工作目录按 `flowId / runId` 归属，每个 run 一个，用完即毁
 * （不跨 run、不跨画布复用 —— docs/20 §3.9 ④）。
 *
 * 二期起 runner 本身就在沙箱里（`sandbox/driver.ts` 的驱动起的），媒体工具在 runner 自己的工作目录上开一个
 * {@link import('./local.ts').openLocalSandbox}；隔离强度由驱动决定（`process` / `oci` / `k8s`），不在这一层。
 * `SandboxProvider` / `LocalSandboxProvider`（按 flowId / runId 建目录）留给直接用这一层的场景和测试。
 */

export interface ExecOptions {
  /** 超时即强杀 */
  timeoutMs: number
  /** stdout / stderr 各自最多留多少字节，超出截断 */
  maxOutputBytes: number
  /**
   * 掐掉即强杀（SIGKILL）子进程 —— 一轮被中止时不等命令跑完（docs/22 §10 验收 5）。
   * 调用前就已掐掉的：不启动，直接拒绝
   */
  signal?: AbortSignal
}

export interface ExecResult {
  /** 正常退出的退出码；被信号杀掉时为 null */
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** 因为 `signal` 被掐掉而强杀 */
  aborted: boolean
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
  /**
   * 销毁：**先杀掉还在跑的命令**，再删掉工作目录（容器实现里是删 Pod / Job）。可重复调用。
   * 不先杀的话，一个还在写文件的 ffmpeg 会在目录删掉之后把它重新建出来，或者一直占着 CPU 跑完
   */
  dispose(): Promise<void>
}

export interface SandboxProvider {
  create(flowId: string, runId: string): Promise<Sandbox>
}
