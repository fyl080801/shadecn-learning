/**
 * 沙箱驱动的抽象（docs/22 §7）：每一轮起一个沙箱，里面跑 runner（`runner/main.ts`）。
 *
 * 编排层（`session.ts`）只认这三个接口：`start` 起一个、`wait` 等它退出、`kill` 立即杀掉。
 * 实现可以换：`process`（本机子进程，**不是强隔离**，生产拒绝）、`oci`（每轮一个 Docker / Podman 容器，第三期），
 * 之后是 `k8s`（每轮一个 Pod，gVisor）。驱动之间的差别只在「隔离多强、凭证怎么注入」，协议（`protocol.ts`）一样。
 *
 * 杀的语义（docs/22 §5 stop、§10 验收 5）：**立即、整个沙箱**（含它起的 ffmpeg），之后工作目录清理。
 * `wait()` 在沙箱确实退出、工作目录清掉之后才兑现，编排层据此收尾。
 */

/** 沙箱的资源上限。`process` 驱动只执行 `deadlineMs`（其余要容器才做得到）；`oci` 全部执行（`diskMiB` = 工作目录 tmpfs 的大小） */
export interface SandboxResources {
  cpu: number
  memoryMiB: number
  pids: number
  diskMiB: number
  /** 沙箱存活的硬上限（编排层自己的时长上限先到；这是兜底） */
  deadlineMs: number
}

/**
 * 沙箱拿什么证明「我是哪个 run」（docs/22 §4.1）。`process` / `oci` 注入一次性 bootstrap token；
 * `k8s` 将来是 projected ServiceAccount token（由 kubelet 注入，这里只描述它的配置）。
 */
export type WorkloadCredential = { kind: 'bootstrap'; token: string }

export interface SandboxSpec {
  runId: string
  flowId: string
  ownerId: string
  grantId: string
  /** 沙箱镜像（`oci` / `k8s` 用；`process` 忽略） */
  image: string
  resources: SandboxResources
  /** 沙箱里看到的网关地址（含 `AGENT_GATEWAY_PATH`） */
  gatewayUrl: string
  credential: WorkloadCredential
}

export interface SandboxExit {
  /** 正常退出的退出码；被杀 / 被信号结束为 null */
  exitCode: number | null
  /** 被杀的原因，或异常结束的说明 */
  reason?: string
}

export interface SandboxHandle {
  readonly id: string
  /** 沙箱退出、工作目录清掉之后兑现；只兑现一次，可以反复 await */
  wait(): Promise<SandboxExit>
  /** 立即杀（撤销 / 中止 / 超时）。幂等；返回时沙箱已经退出 */
  kill(reason: string): Promise<void>
}

export interface SandboxDriver {
  /** 驱动名（日志用） */
  readonly name: string
  start(spec: SandboxSpec): Promise<SandboxHandle>
  /**
   * 清理服务端崩溃留下的孤儿（`liveRunIds` 之外的）。`process` 驱动是空操作：runner 发现父进程没了会自尽；
   * `oci` 驱动按 label 删掉本实例的旧容器（宿主启动时调一次，之后定时调）
   */
  reap(liveRunIds: ReadonlySet<string>): Promise<void>
}
