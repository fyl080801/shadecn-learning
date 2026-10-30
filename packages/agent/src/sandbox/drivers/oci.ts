import { RUNNER_ENV } from '../../protocol.ts'
import type { SandboxDriver, SandboxExit, SandboxHandle, SandboxSpec } from '../driver.ts'
import { SAFE_SEGMENT } from '../local.ts'
import { EngineError, EngineUnavailableError, isNotFound, type EngineClient, type EngineVersion } from './engine.ts'
import { OUTPUT_LINE_CHARS, OUTPUT_LINE_LIMIT } from './process.ts'

/**
 * `oci` 驱动：每一轮一个容器跑 runner（docs/22 §7，第三期）。直接调 Docker Engine API（`engine.ts`，unix socket），
 * Docker 与 Podman（compat API）通用。和 `process` 驱动同一套协议、同一份 runner，差别只在隔离：
 *
 * 1. **环境只有三个变量**（{@link ociRunnerEnv}）：网关地址、一次性 bootstrap token、工作目录；`PATH` 由镜像决定
 *    （沙箱镜像是 `FROM scratch` 拼出来的，镜像自己只带 `PATH`）。引擎自己还会加 `HOSTNAME` / `HOME`
 *    （Podman 另加 `container=podman`），都不是密钥。服务端进程的环境一个都不传进去；
 * 2. **容器配置固定收紧**（{@link ociContainerConfig}）：非 root 用户、只读根文件系统、工作目录和 `/tmp` 是
 *    `noexec,nosuid,nodev` 的 tmpfs（容器一停内容就没了，即「工作目录清理」）、`CapDrop: ALL`、`no-new-privileges`、
 *    引擎默认的 seccomp（不传任何 seccomp 选项）、内存（不给 swap）/ CPU / PIDs 上限来自 `spec.resources`、
 *    不挂任何卷和 socket；可选 `runtime`（Linux 上有 gVisor 时 `runsc`）；
 * 3. **杀 = 编排层先作废令牌，驱动再 SIGKILL 容器**；`wait()` 在容器确实退出、**删掉之后**才兑现；
 *    `resources.deadlineMs` 到点兜底杀。引擎失联时最多再等 {@link KILL_CONFIRM_MS} 就放弃确认（留给 `reap`），
 *    不让一轮卡死；
 * 4. **输出**：容器日志（stdout / stderr）逐行转给 `onOutput`，行数 / 行长上限和 `process` 驱动同一组；
 * 5. **孤儿清理**（`reap`）：服务端崩溃时容器还在（runner 的「父进程没了就自尽」在容器里不成立），
 *    启动时（之后定时）按 label 列出**本实例**（`instance`）的容器，删掉不在 `liveRunIds`、也不是本驱动正在管的那些。
 *
 * **生产可用**：不像 `process` 驱动那样拒绝 `production`（隔离靠容器，不靠「同一台机器上的用户」）。
 *
 * 网络（docs/22 §4.2）：容器进 `network`（默认引擎的 `bridge`）。runner 只需要到网关，但**只有 `internal` 网络
 * 才真的出不去**——那要求网关（服务端）本身也在这个网络里（单机部署：服务端容器同时接入一个 `--internal` 网络）。
 * 本地开发（podman machine、服务端跑在宿主上）做不到，宿主据 {@link OciSandboxDriver.check} 的结果启动时告警「沙箱可出网」。
 */

/** 容器上的 label（`reap` 靠它们认领；镜像上也有 `managed`） */
export const OCI_LABELS = {
  /** 我们建的（容器 / 测试网络 / 镜像都打） */
  managed: 'shadecn.agent/managed',
  run: 'shadecn.agent/run',
  flow: 'shadecn.agent/flow',
  grant: 'shadecn.agent/grant',
  /** 哪个服务端实例起的：`reap` 只清自己的，同一个引擎上的别的实例不受影响 */
  instance: 'shadecn.agent/instance',
} as const

/** 容器里的工作目录（tmpfs 挂载点）；runner 的工作目录是它下面的 `run/`（挂载点本身删不掉） */
export const OCI_WORKDIR = '/work'
export const OCI_RUN_WORKDIR = `${OCI_WORKDIR}/run`
/** `/tmp` 的 tmpfs 大小 */
export const OCI_TMP_MIB = 64
/** 默认的容器用户：和沙箱镜像里建的 `sandbox` 用户一致；显式给，镜像忘了写 USER 也不会以 root 跑 */
export const OCI_DEFAULT_USER = '10001:10001'
export const OCI_DEFAULT_NETWORK = 'bridge'
/** 引擎内置的默认网络名（Docker 的 bridge；Podman compat 也认） */
const BUILTIN_NETWORKS = new Set(['bridge', 'default'])

/** 杀了之后最多等这么久确认容器退出；过了就放弃（容器留给 reap） */
export const KILL_CONFIRM_MS = 10_000
/** 等退出的请求失败（引擎重启、连接断了）后隔多久重试 */
const WAIT_RETRY_MS = 1000
/** 容器停了之后最多再等日志流收尾多久 */
const LOG_DRAIN_MS = 2000
/** 删除容器最多试几次 */
const REMOVE_ATTEMPTS = 2

export interface OciDriverOptions {
  engine: EngineClient
  /** 沙箱镜像（宿主的 `AGENT_SANDBOX_IMAGE`） */
  image: string
  /**
   * 这个服务端实例的标识，打在容器的 `instance` label 上，`reap` 只清这个值的容器。
   * 宿主用「沙箱看到的网关地址」的哈希：一轮只能连回发起它的实例，同一个网关地址的旧容器在重启后就是孤儿。
   */
  instance: string
  /** 容器进哪个网络；默认引擎的 `bridge`。`host` / `none` 拒绝 */
  network?: string
  /** OCI 运行时（如 gVisor 的 `runsc`）；不给用引擎默认 */
  runtime?: string
  /** 容器用户 `uid:gid`，默认 {@link OCI_DEFAULT_USER} */
  user?: string
  /** 覆盖镜像的入口（测试用：探针脚本代替 runner）；不给用镜像的 ENTRYPOINT */
  command?: readonly string[]
  /** runner 的 stdout / stderr，逐行（宿主拿去打日志） */
  onOutput?: (runId: string, stream: 'stdout' | 'stderr', line: string) => void
  /** 杀了之后最多等多久确认退出（默认 {@link KILL_CONFIRM_MS}；测试调短） */
  killConfirmMs?: number
}

export interface OciSandboxHandle extends SandboxHandle {
  readonly containerId: string
  readonly name: string
}

/** 启动自检的结果（宿主据此打日志 / 告警） */
export interface OciCheck {
  socketPath: string
  engine: EngineVersion
  image: { name: string; present: boolean }
  network: { name: string; exists: boolean; internal: boolean }
}

export interface OciSandboxDriver extends SandboxDriver {
  /** 引擎连不连得上、镜像在不在、网络是不是 internal；连不上就抛 */
  check(): Promise<OciCheck>
}

export function containerName(runId: string): string {
  return `shadecn-agent-${runId}`
}

/** 容器的环境变量 —— **只有这三个**（`PATH` 由镜像给）。导出给测试直接断言 */
export function ociRunnerEnv(spec: SandboxSpec): string[] {
  return [
    `${RUNNER_ENV.gatewayUrl}=${spec.gatewayUrl}`,
    `${RUNNER_ENV.bootstrapToken}=${spec.credential.token}`,
    `${RUNNER_ENV.workdir}=${OCI_RUN_WORKDIR}`,
  ]
}

/** `POST /containers/create` 的请求体。导出给测试直接断言安全选项 */
export function ociContainerConfig(
  spec: SandboxSpec,
  options: Pick<OciDriverOptions, 'image' | 'instance' | 'network' | 'runtime' | 'user' | 'command'>,
): Record<string, unknown> {
  const MiB = 1024 * 1024
  // Docker 要求内存上限至少 6 MiB
  const memory = Math.max(6, Math.floor(spec.resources.memoryMiB)) * MiB
  const tmpfs = (sizeMiB: number) => `rw,noexec,nosuid,nodev,size=${Math.max(1, Math.floor(sizeMiB))}m,mode=1777`
  return {
    Image: options.image,
    ...(options.command ? { Entrypoint: [...options.command], Cmd: [] } : {}),
    Env: ociRunnerEnv(spec),
    User: options.user ?? OCI_DEFAULT_USER,
    WorkingDir: OCI_WORKDIR,
    Labels: {
      [OCI_LABELS.managed]: 'true',
      [OCI_LABELS.run]: spec.runId,
      [OCI_LABELS.flow]: spec.flowId,
      [OCI_LABELS.grant]: spec.grantId,
      [OCI_LABELS.instance]: options.instance,
    },
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    OpenStdin: false,
    Tty: false,
    HostConfig: {
      ReadonlyRootfs: true,
      Tmpfs: { [OCI_WORKDIR]: tmpfs(spec.resources.diskMiB), '/tmp': tmpfs(OCI_TMP_MIB) },
      CapDrop: ['ALL'],
      // 只加这一项：seccomp 用引擎默认的配置（不传 seccomp=… 就是默认），AppArmor / SELinux 同理
      SecurityOpt: ['no-new-privileges'],
      Privileged: false,
      Memory: memory,
      // 和 Memory 相等 = 不给 swap
      MemorySwap: memory,
      NanoCpus: Math.max(1, Math.round(spec.resources.cpu * 1e9)),
      PidsLimit: Math.max(1, Math.floor(spec.resources.pids)),
      NetworkMode: options.network ?? OCI_DEFAULT_NETWORK,
      RestartPolicy: { Name: 'no' },
      // 显式删除：要先等退出、收完日志、拿到退出码（AutoRemove 会和这几步赛跑）
      AutoRemove: false,
      ...(options.runtime ? { Runtime: options.runtime } : {}),
    },
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function startFailure(err: unknown, image: string, network: string): string {
  if (err instanceof EngineUnavailableError) return err.message
  if (err instanceof EngineError && err.status === 404) {
    if (/network/i.test(err.message)) return `沙箱网络 ${network} 不存在（AGENT_SANDBOX_OCI_NETWORK）：${err.message}`
    return `沙箱镜像 ${image} 不存在：先构建（pnpm build:sandbox-image）或检查 AGENT_SANDBOX_IMAGE（${err.message}）`
  }
  return `沙箱容器建不起来：${message(err)}`
}

export function createOciDriver(options: OciDriverOptions): OciSandboxDriver {
  const { engine } = options
  const network = options.network ?? OCI_DEFAULT_NETWORK
  if (network === 'host' || network === 'none') {
    throw new Error(
      network === 'host'
        ? 'oci 沙箱不能用 host 网络（等于和宿主共用网卡与回环地址）'
        : 'oci 沙箱不能用 none 网络（runner 连不上网关）',
    )
  }
  if (!options.image) throw new Error('oci 沙箱驱动没有配置镜像（AGENT_SANDBOX_IMAGE）')
  /** 本驱动正在管的容器（起了、还没删完）：`reap` 不碰它们，哪怕调用方给的 liveRunIds 漏了 */
  const active = new Set<string>()

  return {
    name: 'oci',

    async start(spec): Promise<OciSandboxHandle> {
      if (!SAFE_SEGMENT.test(spec.flowId) || !SAFE_SEGMENT.test(spec.runId)) {
        throw new Error('flowId / runId 含有不能做容器名 / label 的字符')
      }
      const name = containerName(spec.runId)
      let containerId: string
      try {
        containerId = await engine.createContainer(name, ociContainerConfig(spec, options))
      } catch (err) {
        throw new Error(startFailure(err, options.image, network), { cause: err })
      }
      active.add(containerId)
      try {
        await engine.startContainer(containerId)
      } catch (err) {
        await engine.removeContainer(containerId).catch(() => undefined)
        active.delete(containerId)
        throw new Error(`沙箱容器起不来：${message(err)}`, { cause: err })
      }

      let lines = 0
      const logs = engine.followLogs(containerId, (stream, line) => {
        lines += 1
        if (lines > OUTPUT_LINE_LIMIT) return
        const text = lines === OUTPUT_LINE_LIMIT ? '（输出太多，之后的不再转发）' : line.slice(0, OUTPUT_LINE_CHARS)
        try {
          options.onOutput?.(spec.runId, stream, text)
        } catch {
          // 打日志失败不影响沙箱
        }
      })

      let killReason: string | null = null
      let confirmTimer: ReturnType<typeof setTimeout> | undefined
      let giveUp!: () => void
      const gaveUp = new Promise<'gave-up'>((resolve) => (giveUp = () => resolve('gave-up')))
      const waitAbort = new AbortController()

      /** 等到容器不在运行：引擎暂时连不上就重试；杀了之后迟迟确认不了就放弃 */
      async function waitForExit(): Promise<{ code: number | null; oom: boolean; note?: string; unconfirmed?: true }> {
        const unconfirmed = { code: null, oom: false, note: '容器引擎不可达，没能确认容器已退出（留给孤儿清理）', unconfirmed: true as const }
        for (;;) {
          try {
            const result = await Promise.race([engine.waitContainer(containerId, waitAbort.signal), gaveUp])
            if (result === 'gave-up') return unconfirmed
            const state = await engine.inspectContainer(containerId).catch(() => null)
            return { code: result >= 0 ? result : (state?.exitCode ?? null), oom: state?.oomKilled ?? false }
          } catch (err) {
            if (isNotFound(err)) return { code: null, oom: false, note: '容器已不存在（被外部删除）' }
            if ((await Promise.race([sleep(WAIT_RETRY_MS), gaveUp])) === 'gave-up') return unconfirmed
          }
        }
      }

      async function remove() {
        for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt += 1) {
          try {
            await engine.removeContainer(containerId)
            return
          } catch (err) {
            if (attempt === REMOVE_ATTEMPTS) {
              console.warn(`[agent] run=${spec.runId} 沙箱容器 ${name} 没能删除（留给孤儿清理）：${message(err)}`)
            } else {
              await sleep(500)
            }
          }
        }
      }

      async function killNow() {
        if (confirmTimer === undefined) {
          confirmTimer = setTimeout(giveUp, options.killConfirmMs ?? KILL_CONFIRM_MS)
          confirmTimer.unref()
        }
        try {
          await engine.killContainer(containerId)
        } catch (err) {
          console.warn(`[agent] run=${spec.runId} 杀沙箱容器 ${name} 失败：${message(err)}`)
        }
      }

      const deadline = setTimeout(() => {
        killReason ??= `超过沙箱时长上限 ${Math.round(spec.resources.deadlineMs / 1000)} 秒`
        void killNow()
      }, spec.resources.deadlineMs)
      deadline.unref()

      const exited: Promise<SandboxExit> = (async () => {
        const outcome = await waitForExit()
        clearTimeout(deadline)
        clearTimeout(confirmTimer)
        waitAbort.abort()
        // 日志跟随在容器停下时自己结束；给它一点时间把最后几行交出来，再删容器
        await Promise.race([logs.done, sleep(LOG_DRAIN_MS)])
        logs.close()
        // 引擎失联（放弃确认）时删也删不掉：不再试，留给孤儿清理
        if (outcome.unconfirmed) console.warn(`[agent] run=${spec.runId} 沙箱容器 ${name} 状态未知（${outcome.note}）`)
        else await remove()
        // 这一轮结束了：不管删没删掉，都不再归本驱动管，之后的 reap 可以清它
        active.delete(containerId)
        if (killReason !== null) return { exitCode: null, reason: killReason }
        if (outcome.oom) {
          return { exitCode: outcome.code, reason: `内存超过上限 ${spec.resources.memoryMiB} MiB，被 OOM 结束` }
        }
        if (outcome.code === null) return { exitCode: null, reason: outcome.note ?? '容器已不存在' }
        // 128 + 信号：被别人（引擎 / 运维）用信号结束的
        if (outcome.code > 128 && outcome.code < 160) {
          return { exitCode: null, reason: `被信号 ${outcome.code - 128} 结束（退出码 ${outcome.code}）` }
        }
        return { exitCode: outcome.code }
      })()

      return {
        id: `oci:${containerId.slice(0, 12)}`,
        containerId,
        name,
        wait: () => exited,
        async kill(reason) {
          killReason ??= reason
          // 不等杀的请求本身（引擎卡住时它要等到请求超时）：确认计时在 killNow 里同步开始，等的是退出
          void killNow()
          await exited
        },
      }
    },

    async reap(liveRunIds) {
      const containers = await engine.listContainers([`${OCI_LABELS.managed}=true`, `${OCI_LABELS.instance}=${options.instance}`])
      for (const container of containers) {
        const runId = container.Labels?.[OCI_LABELS.run] ?? ''
        if (active.has(container.Id) || liveRunIds.has(runId)) continue
        const label = container.Names?.[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12)
        try {
          // 先 SIGKILL：Podman 的强制删除会先发 SIGTERM 再等 10 秒（runner 是 1 号进程，不理 SIGTERM）
          if (container.State === 'running') await engine.killContainer(container.Id)
          await engine.removeContainer(container.Id)
          console.info(`[agent] 清理孤儿沙箱容器 ${label}（run=${runId || '?'}，状态 ${container.State ?? '?'}）`)
        } catch (err) {
          console.warn(`[agent] 孤儿沙箱容器 ${label} 没能清理：${message(err)}`)
        }
      }
    },

    async check() {
      const version = await engine.version()
      const present = await engine.imageExists(options.image)
      let net: { exists: boolean; internal: boolean }
      if (BUILTIN_NETWORKS.has(network)) net = { exists: true, internal: false }
      else {
        const found = await engine.network(network)
        net = found ? { exists: true, internal: found.internal } : { exists: false, internal: false }
      }
      return { socketPath: engine.socketPath, engine: version, image: { name: options.image, present }, network: { name: network, ...net } }
    },
  }
}
