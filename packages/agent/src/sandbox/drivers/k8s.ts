import { randomBytes } from 'node:crypto'
import { RUNNER_ENV } from '../../protocol.ts'
import { BOOTSTRAP_TOKEN_TTL_MS } from '../../token.ts'
import type { SandboxDriver, SandboxExit, SandboxHandle, SandboxResources, SandboxSpec } from '../driver.ts'
import { SAFE_SEGMENT } from '../local.ts'
import { isKubeNotFound, KubeError, KubeUnavailableError, type KubeClient, type KubeStream } from './kube.ts'
import { KILL_CONFIRM_MS, OCI_LABELS, OCI_RUN_WORKDIR, OCI_TMP_MIB, OCI_WORKDIR } from './oci.ts'
import { OUTPUT_LINE_CHARS, OUTPUT_LINE_LIMIT } from './process.ts'

/**
 * `k8s` 驱动：每一轮一个 Pod 跑 runner（docs/22 §7.5，第四期）。直接调 Kubernetes API（`kube.ts`，`node:https`），
 * 镜像、runner、协议和 `oci` 驱动是同一份，差别只在隔离由谁执行：
 *
 * 1. **直接建 Pod，不用 Job**：Job 的价值是「失败了重来」和「控制器替你建 Pod」，这里两样都不要 ——
 *    runner 失败重跑会拿同一个**一次性** bootstrap token 再兑换一次（必然 401），一轮的结局只由服务端判；
 *    多一层控制器只多一段建 Pod 的延迟、多一种资源要授权（jobs）、删的时候还要管级联（propagationPolicy）。
 *    裸 Pod + `restartPolicy: Never` 正好是「跑一次、我们自己删」。节点挂了 Pod 不会被重建，也正是想要的。
 * 2. **Pod 规格固定收紧**（{@link k8sPodSpec}）：环境变量只有 `RUNNER_ENV` 那三个；不挂 ServiceAccount token、
 *    不注入 Service 环境变量、不共享宿主的网络 / PID / IPC；非 root（10001）、`seccompProfile: RuntimeDefault`、
 *    `allowPrivilegeEscalation: false`、只读根文件系统、`capabilities.drop: [ALL]`；`/work` 和 `/tmp` 是内存型
 *    `emptyDir`（对应 `oci` 的 tmpfs，计入内存上限）；requests = limits（Guaranteed）；`activeDeadlineSeconds`
 *    来自 `deadlineMs`；可选 `runtimeClassName`（gVisor）、`imagePullSecrets`、`imagePullPolicy`、`nodeSelector`。
 *    这套规格满足 Pod Security 的 `restricted`，也满足共用命名空间时的 ValidatingAdmissionPolicy
 *    （`k8s/variants/agent-sandbox-vap.yaml`）—— 集群按其中一种强制它，启动自检会验证强制确实生效（见 `check`）。
 * 3. **生命周期**：建 Pod → 跟着它的状态（GET 一次，再从那个 resourceVersion 起 watch；watch 断了 / 过期就重新 GET，
 *    所以不会漏变化）→ 容器起来后跟随 `pods/log?follow=true` 逐行转发（行数 / 行长上限同 `process` / `oci`）→
 *    进入终态后读退出码与原因（OOMKilled、DeadlineExceeded、Evicted…）→ 删 Pod（`gracePeriodSeconds: 0` + uid 前提）
 *    → 确认它不在了，`wait()` 才兑现。
 * 4. **起不来要能收尾**：Pending 超过 {@link K8S_START_TIMEOUT_MS}（比 bootstrap token 的 60 秒有效期短 ——
 *    过了那个点起来也兑换不了）就删掉，原因写明卡在哪（调度不了 / 镜像拉不下来 / …）；
 *    `InvalidImageName`、`ErrImageNeverPull`、`CreateContainerConfigError` 这类不会自己好的当场收尾。
 * 5. **杀 = 编排层先作废令牌，驱动再删 Pod（grace 0）**：API 层面立即删除对象，节点上的容器由 kubelet 随后结束
 *    （kubelet 的最短宽限 2 秒：runner 是 1 号进程、不处理 SIGTERM，于是 2 秒后 SIGKILL）；这段尾巴里令牌已经无效，
 *    沙箱什么也做不了。API 失联时杀完最多再等 `killConfirmMs` 确认，之后放弃（留给 `reap`），一轮不会卡死；
 *    `deadlineMs` 和起不来的超时都走同一条杀的路，所以任何一种等待都有上限。
 * 6. **孤儿清理**（`reap`）：本实例（`instance` label）的 Pod 里，不在 `liveRunIds`、也不是本驱动正在管的删掉
 *    （服务端容器在同一个 Pod 里重启，Pod IP 不变 → 实例标识不变）；**别的实例的 Pod 只在过了它自己的时长上限之后才删**
 *    —— 实例标识是网关地址（Pod IP）的哈希，服务端 Pod 被替换后 IP 就变了，它留下的 Pod 再也不会有「本实例」来认领；
 *    而一个过了 `activeDeadlineSeconds` 的 Pod 不可能还属于哪个在跑的轮次（每个实例的驱动到点都会删它）。
 *
 * **生产可用**（不像 `process` 那样拒绝 `production`）。网络隔离不在 Pod 规格里：选中沙箱 Pod 的 NetworkPolicy
 * 拒绝入站、出站只放行服务端 Pod 的网关端口（需要 CNI 支持 NetworkPolicy），见 docs/22 §7.5。
 */

/** Pod 上的 label：和 `oci` 的容器 label 同一组键（`reap` 靠它们认领） */
export const K8S_LABELS = OCI_LABELS
/** 不配命名空间时用的：一个只放沙箱 Pod 的独立命名空间 */
export const K8S_DEFAULT_NAMESPACE = 'shadecn-agent-sandbox'
/** Pod 里唯一的容器 */
export const K8S_CONTAINER = 'runner'
/** 工作目录 / runner 的工作目录 / `/tmp` 的大小：和 `oci` 同一组（挂载点本身删不掉，所以 runner 用下一层） */
export const K8S_WORKDIR = OCI_WORKDIR
export const K8S_RUN_WORKDIR = OCI_RUN_WORKDIR
export const K8S_TMP_MIB = OCI_TMP_MIB
/** 沙箱镜像里的 `sandbox` 用户；Pod 规格显式指定，镜像忘了写 USER 也不会以 root 跑（`runAsNonRoot` 再兜一层） */
export const K8S_USER_ID = 10001
/**
 * `ephemeral-storage` 的 requests = limits。根文件系统只读、工作目录在内存里，节点磁盘上只剩**容器日志**会涨 ——
 * 这个上限就是日志量的上限，超了 kubelet 驱逐这个 Pod（结局写明「被节点驱逐」）
 */
export const K8S_EPHEMERAL_STORAGE_MIB = 128
/** Pending 最多等这么久：bootstrap token 只有 60 秒，再晚起来的 runner 也兑换不了 */
export const K8S_START_TIMEOUT_MS = BOOTSTRAP_TOKEN_TTL_MS - 10_000
/** 别的实例留下的 Pod：过了它自己的时长上限再多等这么久才算孤儿（容忍时钟偏差、对方驱动正在删） */
export const K8S_ORPHAN_GRACE_MS = 5 * 60_000

/** watch 一次最多挂多久（API 到点主动结束，我们重新 GET 再 watch） */
const WATCH_TIMEOUT_SECONDS = 60
/** 这么久没收到任何字节就当 watch 连接死了 */
const WATCH_IDLE_MS = (WATCH_TIMEOUT_SECONDS + 30) * 1000
/** API 请求失败（连不上、5xx）后隔多久重试 */
const RETRY_MS = 1000
/** Pod 终止之后最多再等日志流收尾多久 */
const LOG_DRAIN_MS = 2000
/** 一轮的日志最多从 API 拉这么多字节（行数上限之外的又一道闸：一行没换行的海量输出也拉不爆） */
const LOG_LIMIT_BYTES = 4 * 1024 * 1024
/** 错误信息里引用 API 的 message 最多多长 */
const MESSAGE_CHARS = 300

/** 等不到就当场收尾的等待原因（kubelet 不会自己把它们修好） */
const HOPELESS_WAITING = new Set(['InvalidImageName', 'ErrImageNeverPull', 'CreateContainerConfigError'])
const PULL_WAITING = new Set(['ErrImagePull', 'ImagePullBackOff'])

export type K8sPullPolicy = 'Always' | 'IfNotPresent' | 'Never'
export const K8S_PULL_POLICIES: readonly K8sPullPolicy[] = ['Always', 'IfNotPresent', 'Never']

export interface K8sDriverOptions {
  kube: KubeClient
  /** 沙箱镜像（宿主的 `AGENT_SANDBOX_IMAGE`；集群里要写节点拉得到的完整引用） */
  image: string
  /**
   * 这个服务端实例的标识，打在 Pod 的 `instance` label 上（宿主用「沙箱看到的网关地址」的哈希，
   * k8s 下就是本 Pod 的 IP：一轮只能连回发起它的副本）
   */
  instance: string
  /** 沙箱 Pod 建在哪个命名空间（默认 {@link K8S_DEFAULT_NAMESPACE}） */
  namespace?: string
  /** RuntimeClass（如装了 gVisor 的 `gvisor`）；不给用节点默认的运行时 */
  runtimeClassName?: string
  /** 拉镜像用的 Secret 名（在沙箱命名空间里，kubelet 用；服务端不需要读 Secret 的权限） */
  imagePullSecret?: string
  /** 不给用 k8s 的默认（`:latest` = Always，其余 IfNotPresent） */
  imagePullPolicy?: K8sPullPolicy
  /**
   * 沙箱 Pod 只调度到带这些 label 的节点（宿主的 `AGENT_SANDBOX_K8S_NODE_SELECTOR`，{@link parseK8sNodeSelector} 解析）。
   * 典型用途：镜像只构建了一种架构（`kubernetes.io/arch: arm64`），落到别的架构的节点上会拉不到镜像
   */
  nodeSelector?: Readonly<Record<string, string>>
  /** 覆盖镜像的入口（测试用：探针脚本代替 runner）；不给用镜像的 ENTRYPOINT */
  command?: readonly string[]
  /** 默认 {@link K8S_EPHEMERAL_STORAGE_MIB} */
  ephemeralStorageMiB?: number
  /** runner 的输出，逐行（k8s 的日志接口不分 stdout / stderr，一律按 stdout 交） */
  onOutput?: (runId: string, stream: 'stdout' | 'stderr', line: string) => void
  /** 杀了之后最多等多久确认 Pod 删掉（默认 {@link KILL_CONFIRM_MS}；测试调短） */
  killConfirmMs?: number
  /** Pending 最多等多久（默认 {@link K8S_START_TIMEOUT_MS}；测试调短） */
  startTimeoutMs?: number
  /** API 失败后的重试间隔（默认 1 秒；测试调短） */
  retryMs?: number
}

export interface K8sSandboxHandle extends SandboxHandle {
  readonly podName: string
  readonly namespace: string
}

/** 启动自检的结果：`problems` 非空 = 沙箱不可用（宿主据此把 agent 标成未启用），`warnings` 只打日志 */
export interface K8sCheck {
  server: string
  version: string
  namespace: string
  image: string
  runtimeClassName: string | null
  /** 驱动要用的每一项权限（SelfSubjectAccessReview 的结论） */
  permissions: { verb: string; resource: string; allowed: boolean }[]
  problems: string[]
  warnings: string[]
}

export interface K8sSandboxDriver extends SandboxDriver {
  readonly namespace: string
  /**
   * API 连不连得上、有没有权限、沙箱 Pod 的规格能不能过准入（dry-run）、准入兜底在不在（privileged 的反例
   * {@link k8sPrivilegedPodSpec} 必须被拒）；连不上 / 凭据被拒就抛
   */
  check(): Promise<K8sCheck>
}

// —— 只取驱动要读的那几个字段 ——

interface ContainerState {
  waiting?: { reason?: string; message?: string }
  running?: { startedAt?: string }
  terminated?: { exitCode?: number; signal?: number; reason?: string; message?: string; startedAt?: string }
}

export interface PodObject {
  metadata?: {
    name?: string
    uid?: string
    resourceVersion?: string
    labels?: Record<string, string>
    creationTimestamp?: string
    deletionTimestamp?: string
  }
  spec?: { activeDeadlineSeconds?: number }
  status?: {
    phase?: string
    reason?: string
    message?: string
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[]
    containerStatuses?: { name?: string; state?: ContainerState }[]
  }
}

/** label 值：1～63 字，字母数字开头结尾，中间可以有 `-_.`（拆成三个简单的正则：没有嵌套量词） */
function isLabelValue(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,63}$/.test(value) && /^[A-Za-z0-9]/.test(value) && /[A-Za-z0-9]$/.test(value)
}

/** 命名空间名（DNS-1123 label）：1～63 个小写字母数字或 `-`，字母数字开头结尾 */
function isNamespaceName(value: string): boolean {
  return /^[a-z0-9-]{1,63}$/.test(value) && /^[a-z0-9]/.test(value) && /[a-z0-9]$/.test(value)
}

/** label 键：可选的前缀（DNS-1123 子域名，≤ 253 字，按 `.` 分段每段都是 DNS label）+ `/` + 名字（语法同 label 值） */
function isLabelKey(key: string): boolean {
  const slash = key.indexOf('/')
  if (slash === -1) return isLabelValue(key)
  const prefix = key.slice(0, slash)
  if (prefix.length === 0 || prefix.length > 253 || !prefix.split('.').every(isNamespaceName)) return false
  return isLabelValue(key.slice(slash + 1))
}

/**
 * `AGENT_SANDBOX_K8S_NODE_SELECTOR` 的值 → nodeSelector：逗号分隔的 `key=value`（如 `kubernetes.io/arch=arm64`），
 * 前后空白忽略；空串 = 不限节点。键 / 值不合法、空项、空值、重复的键都算格式错（宿主据此把 agent 标成未启用，原因写明）。
 * 本包不读 `process.env`：值由宿主传进来。
 */
export function parseK8sNodeSelector(text: string): { ok: true; value: Record<string, string> } | { ok: false; reason: string } {
  const value: Record<string, string> = {}
  if (!text.trim()) return { ok: true, value }
  for (const item of text.split(',')) {
    const entry = item.trim()
    const where = `AGENT_SANDBOX_K8S_NODE_SELECTOR 的「${entry}」`
    const eq = entry.indexOf('=')
    if (eq <= 0) return { ok: false, reason: `${where}不是 key=value（多项用逗号分隔，如 kubernetes.io/arch=arm64）` }
    const key = entry.slice(0, eq).trim()
    const label = entry.slice(eq + 1).trim()
    if (!isLabelKey(key)) return { ok: false, reason: `${where}：${key} 不是合法的 label 键（[前缀/]名字）` }
    if (!isLabelValue(label)) {
      return { ok: false, reason: `${where}：值「${label}」不是合法的 label 值（1～63 个字母数字或 - _ .，字母数字开头结尾）` }
    }
    if (Object.hasOwn(value, key)) return { ok: false, reason: `AGENT_SANDBOX_K8S_NODE_SELECTOR 里 ${key} 出现了不止一次` }
    value[key] = label
  }
  return { ok: true, value }
}

/** Pod 名：runId 转成 DNS-1123（小写、`_` → `-`）。runId 由服务端的 `createId` 生成，本来就是小写 base36 */
export function k8sPodName(runId: string): string {
  const slug = runId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `shadecn-agent-${slug}`
}

/** 容器的环境变量 —— **只有这三个**（`PATH` 由镜像给）。导出给测试直接断言 */
export function k8sRunnerEnv(spec: SandboxSpec): { name: string; value: string }[] {
  return [
    { name: RUNNER_ENV.gatewayUrl, value: spec.gatewayUrl },
    { name: RUNNER_ENV.bootstrapToken, value: spec.credential.token },
    { name: RUNNER_ENV.workdir, value: K8S_RUN_WORKDIR },
  ]
}

/** CPU 核数 → millicores；内存 MiB → `Mi` */
export function k8sResources(resources: SandboxResources, ephemeralStorageMiB = K8S_EPHEMERAL_STORAGE_MIB): Record<string, string> {
  return {
    cpu: `${Math.max(1, Math.round(resources.cpu * 1000))}m`,
    memory: `${Math.max(16, Math.floor(resources.memoryMiB))}Mi`,
    'ephemeral-storage': `${Math.max(1, Math.floor(ephemeralStorageMiB))}Mi`,
  }
}

/** `POST /api/v1/namespaces/{ns}/pods` 的请求体。导出给测试（和 `k8s/` 下的清单测试）直接断言安全字段 */
export function k8sPodSpec(
  spec: SandboxSpec,
  options: Pick<
    K8sDriverOptions,
    'image' | 'instance' | 'namespace' | 'runtimeClassName' | 'imagePullSecret' | 'imagePullPolicy' | 'nodeSelector' | 'command' | 'ephemeralStorageMiB'
  >,
  name = k8sPodName(spec.runId),
): Record<string, unknown> {
  const resources = k8sResources(spec.resources, options.ephemeralStorageMiB)
  const sizeMi = (mib: number) => `${Math.max(1, Math.floor(mib))}Mi`
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: options.namespace ?? K8S_DEFAULT_NAMESPACE,
      labels: {
        [K8S_LABELS.managed]: 'true',
        [K8S_LABELS.run]: spec.runId,
        [K8S_LABELS.flow]: spec.flowId,
        [K8S_LABELS.grant]: spec.grantId,
        [K8S_LABELS.instance]: options.instance,
      },
    },
    spec: {
      // 跑一次：runner 失败了重跑也兑换不了那个一次性 token，结局由服务端判
      restartPolicy: 'Never',
      // 沙箱命名空间的 default ServiceAccount 的 token 不进沙箱（它看不到也调不了 k8s API）
      automountServiceAccountToken: false,
      // 不往环境里注入同命名空间 Service 的地址（kubelet 无条件注入的 KUBERNETES_SERVICE_* 去不掉，那不是密钥）
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      // 宽限期对 runner 没意义（1 号进程不处理 SIGTERM）；给 1 而不是 0：0 会让不带参数的 `kubectl delete` 也变成强制删除
      terminationGracePeriodSeconds: 1,
      activeDeadlineSeconds: Math.max(1, Math.ceil(spec.resources.deadlineMs / 1000)),
      ...(options.runtimeClassName ? { runtimeClassName: options.runtimeClassName } : {}),
      ...(options.nodeSelector && Object.keys(options.nodeSelector).length > 0 ? { nodeSelector: { ...options.nodeSelector } } : {}),
      ...(options.imagePullSecret ? { imagePullSecrets: [{ name: options.imagePullSecret }] } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: K8S_USER_ID,
        runAsGroup: K8S_USER_ID,
        fsGroup: K8S_USER_ID,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: K8S_CONTAINER,
          image: options.image,
          ...(options.imagePullPolicy ? { imagePullPolicy: options.imagePullPolicy } : {}),
          ...(options.command ? { command: [...options.command], args: [] } : {}),
          env: k8sRunnerEnv(spec),
          workingDir: K8S_WORKDIR,
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            privileged: false,
            capabilities: { drop: ['ALL'] },
          },
          resources: { requests: { ...resources }, limits: { ...resources } },
          volumeMounts: [
            { name: 'work', mountPath: K8S_WORKDIR },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        { name: 'work', emptyDir: { medium: 'Memory', sizeLimit: sizeMi(spec.resources.diskMiB) } },
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: sizeMi(K8S_TMP_MIB) } },
      ],
    },
  }
}

/**
 * 自检用的**反例**：和 {@link k8sPodSpec} 一样，只把容器改成 privileged（API 的校验要求 privileged 时不能
 * `allowPrivilegeEscalation: false`，所以一起改成 true，否则会先被 422 挡掉、测不到准入）。集群的准入兜底
 * （Pod Security restricted / ValidatingAdmissionPolicy）在的话它必然被拒；被放行 = 服务端的 pods create 等于节点 root。
 */
export function k8sPrivilegedPodSpec(...args: Parameters<typeof k8sPodSpec>): Record<string, unknown> {
  const pod = k8sPodSpec(...args)
  const spec = pod.spec as { containers: { securityContext: Record<string, unknown> }[] }
  for (const container of spec.containers) {
    container.securityContext = { ...container.securityContext, privileged: true, allowPrivilegeEscalation: true }
  }
  return pod
}

/** 定时器不拖住进程退出（确认删除、日志收尾这类等待用不完就被放弃） */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref())
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const clip = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CHARS)

function runnerStatus(pod: PodObject | undefined) {
  return pod?.status?.containerStatuses?.find((status) => status.name === K8S_CONTAINER) ?? pod?.status?.containerStatuses?.[0]
}

const isTerminal = (pod: PodObject | undefined) => pod?.status?.phase === 'Succeeded' || pod?.status?.phase === 'Failed'

/** 容器起来过（日志接口在这之前会回 400） */
function containerStarted(pod: PodObject | undefined): boolean {
  const state = runnerStatus(pod)?.state
  return Boolean(state?.running || state?.terminated?.startedAt)
}

const hasStarted = (pod: PodObject | undefined) => pod?.status?.phase === 'Running' || isTerminal(pod) || containerStarted(pod)

/** 不会自己好的等待原因 → 当场收尾的说明；其余 null */
function hopeless(pod: PodObject | undefined): string | null {
  const waiting = runnerStatus(pod)?.state?.waiting
  if (!waiting?.reason || !HOPELESS_WAITING.has(waiting.reason)) return null
  const hint =
    waiting.reason === 'CreateContainerConfigError'
      ? '（常见原因：镜像以 root 运行而 Pod 要求 runAsNonRoot，或引用的 Secret / ConfigMap 不存在）'
      : waiting.reason === 'ErrImageNeverPull'
        ? '（imagePullPolicy 是 Never，而节点上没有这个镜像）'
        : '（检查 AGENT_SANDBOX_IMAGE）'
  return `沙箱 Pod 起不来（${waiting.reason}）：${clip(waiting.message)}${hint}`
}

/** Pending 卡在哪：调度不了 / 镜像拉不下来 / 别的等待原因 */
function describePending(pod: PodObject | undefined, image: string): string {
  const scheduled = pod?.status?.conditions?.find((condition) => condition.type === 'PodScheduled')
  if (scheduled?.status === 'False') return `调度不了（${scheduled.reason ?? 'Unschedulable'}）：${clip(scheduled.message)}`
  const waiting = runnerStatus(pod)?.state?.waiting
  if (waiting?.reason && PULL_WAITING.has(waiting.reason)) {
    return `镜像 ${image} 拉不下来（${waiting.reason}）：${clip(waiting.message)}；检查 AGENT_SANDBOX_IMAGE、节点到镜像仓库的网络和 AGENT_SANDBOX_K8S_PULL_SECRET`
  }
  if (waiting?.reason) return `${waiting.reason}${waiting.message ? `：${clip(waiting.message)}` : ''}`
  return `还在 ${pod?.status?.phase ?? 'Pending'}`
}

/** 终态的 Pod → 结局（和 `oci` 的措辞对齐） */
export function k8sPodExit(pod: PodObject, resources: SandboxResources): SandboxExit {
  const status = pod.status ?? {}
  if (status.reason === 'DeadlineExceeded') {
    return { exitCode: null, reason: `超过沙箱时长上限 ${Math.round(resources.deadlineMs / 1000)} 秒（activeDeadlineSeconds）` }
  }
  if (status.reason === 'Evicted') return { exitCode: null, reason: `沙箱 Pod 被节点驱逐：${clip(status.message)}` }
  const terminated = runnerStatus(pod)?.state?.terminated
  if (terminated && typeof terminated.exitCode === 'number') {
    const code = terminated.exitCode
    if (terminated.reason === 'OOMKilled') {
      return { exitCode: code, reason: `内存超过上限 ${resources.memoryMiB} MiB，被 OOM 结束` }
    }
    // 128 + 信号：被别人（kubelet / 运行时 / 运维）用信号结束的
    if (code > 128 && code < 160) return { exitCode: null, reason: `被信号 ${code - 128} 结束（退出码 ${code}）` }
    if (terminated.reason === 'ContainerCannotRun' || terminated.reason === 'StartError') {
      return { exitCode: code, reason: `容器起不来（${terminated.reason}）：${clip(terminated.message)}` }
    }
    return { exitCode: code }
  }
  const detail = [status.reason, clip(status.message)].filter(Boolean).join('：')
  return { exitCode: null, reason: `沙箱 Pod ${status.phase ?? '结束'}${detail ? `（${detail}）` : ''}` }
}

function startFailure(err: unknown, namespace: string): string {
  if (err instanceof KubeUnavailableError) return err.message
  if (err instanceof KubeError) {
    const api = clip(err.apiMessage)
    if (err.status === 401) return `k8s API 不认服务端的凭据（401）：检查 ServiceAccount token（AGENT_SANDBOX_K8S_TOKEN_FILE）`
    if (err.status === 404 && /namespace/i.test(err.apiMessage)) {
      return `沙箱命名空间 ${namespace} 不存在（AGENT_SANDBOX_K8S_NAMESPACE；清单见 k8s/variants/agent-sandbox.yaml）：${api}`
    }
    if (err.status === 403 && /exceeded quota/i.test(err.apiMessage)) {
      return `沙箱命名空间 ${namespace} 的配额已满（同时在跑的沙箱太多，稍后再试）：${api}`
    }
    if (err.status === 403 && /is forbidden: User/i.test(err.apiMessage)) {
      return `服务端的 ServiceAccount 没有在 ${namespace} 建 Pod 的权限（Role 见 k8s/agent-sandbox.yaml）：${api}`
    }
    if (err.status === 403) return `沙箱 Pod 被集群的准入拒绝：${api}`
    if (err.status === 409) return `同名的沙箱 Pod 已经存在：${api}`
    if (err.status === 422) return `沙箱 Pod 的规格不合法：${api}`
    return `沙箱 Pod 建不起来（${err.status}）：${api}`
  }
  return `沙箱 Pod 建不起来：${message(err)}`
}

/** Pod 的最新状态 + 等它满足某个条件 */
class PodTracker {
  pod: PodObject
  gone = false
  private readonly waiters = new Set<() => void>()

  constructor(initial: PodObject) {
    this.pod = initial
  }

  update(next: PodObject) {
    this.pod = next
    this.notify()
  }

  markGone() {
    this.gone = true
    this.notify()
  }

  /** 条件满足 → true；`interrupt` 先到 → 当时条件是否满足 */
  until(check: () => boolean, interrupt: Promise<unknown>): Promise<boolean> {
    if (check()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter = () => {
        if (!check()) return
        this.waiters.delete(waiter)
        resolve(true)
      }
      this.waiters.add(waiter)
      void interrupt.then(() => {
        if (this.waiters.delete(waiter)) resolve(check())
      })
    })
  }

  private notify() {
    for (const waiter of [...this.waiters]) waiter()
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

const REQUIRED_PERMISSIONS = [
  { verb: 'create', resource: 'pods' },
  { verb: 'get', resource: 'pods' },
  { verb: 'list', resource: 'pods' },
  { verb: 'watch', resource: 'pods' },
  { verb: 'delete', resource: 'pods' },
  { verb: 'get', resource: 'pods/log' },
] as const
/** 用不着、有了说明 Role 给大了的权限（只告警） */
const EXCESS_PERMISSIONS = [
  { verb: 'get', resource: 'secrets' },
  { verb: 'create', resource: 'pods/exec' },
] as const

export function createK8sDriver(options: K8sDriverOptions): K8sSandboxDriver {
  const { kube } = options
  const namespace = options.namespace ?? K8S_DEFAULT_NAMESPACE
  if (!options.image) throw new Error('k8s 沙箱驱动没有配置镜像（AGENT_SANDBOX_IMAGE）')
  if (!isLabelValue(options.instance)) throw new Error(`实例标识 ${options.instance} 不能做 label 值`)
  if (!isNamespaceName(namespace)) throw new Error(`AGENT_SANDBOX_K8S_NAMESPACE=${namespace} 不是合法的命名空间名`)
  for (const [key, value] of Object.entries(options.nodeSelector ?? {})) {
    if (!isLabelKey(key) || !isLabelValue(value)) throw new Error(`nodeSelector 的 ${key}=${value} 不是合法的 label`)
  }
  const retryMs = options.retryMs ?? RETRY_MS
  const killConfirmMs = options.killConfirmMs ?? KILL_CONFIRM_MS
  const startTimeoutMs = options.startTimeoutMs ?? K8S_START_TIMEOUT_MS
  const podsPath = `/api/v1/namespaces/${namespace}/pods`
  const podPath = (name: string) => `${podsPath}/${encodeURIComponent(name)}`
  /** 本驱动正在管的 Pod（建了、还没删完）：`reap` 不碰它们，哪怕调用方给的 liveRunIds 漏了 */
  const active = new Set<string>()

  async function deletePod(name: string, uid: string | undefined) {
    await kube.json('DELETE', podPath(name), {
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      gracePeriodSeconds: 0,
      ...(uid ? { preconditions: { uid } } : {}),
    })
  }

  return {
    name: 'k8s',
    namespace,

    async start(spec): Promise<K8sSandboxHandle> {
      for (const value of [spec.runId, spec.flowId, spec.grantId]) {
        if (!SAFE_SEGMENT.test(value) || !isLabelValue(value)) throw new Error('runId / flowId / grantId 含有不能做 Pod 名 / label 的字符')
      }
      const name = k8sPodName(spec.runId)
      const scrub = (text: string) => (spec.credential.token ? text.split(spec.credential.token).join('***') : text)
      // 先登记再建：建好到登记之间的空当里来一次 reap 也删不到它
      active.add(name)
      let created: PodObject
      try {
        created = (await kube.json<PodObject>('POST', podsPath, k8sPodSpec(spec, options, name))) ?? {}
      } catch (err) {
        active.delete(name)
        // API 的错误信息理论上不会回显 env，保险起见把 token 抹掉再往上抛（它会进日志和前端）
        throw new Error(scrub(startFailure(err, namespace)), { cause: err })
      }
      const uid = created.metadata?.uid
      const state = new PodTracker(created)
      const stopTracking = new AbortController()
      let warnedUnavailable = false
      const noteFailure = (err: unknown) => {
        if (warnedUnavailable) return
        warnedUnavailable = true
        console.warn(`[agent] run=${spec.runId} 沙箱 Pod ${namespace}/${name} 的状态暂时读不到，重试中：${message(err)}`)
      }
      /** 等一会儿再重试；不再跟踪了就立刻醒（监听器用完即摘：API 长时间失联时这里会转很多圈） */
      const pause = (ms: number) =>
        new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            stopTracking.signal.removeEventListener('abort', done)
            resolve()
          }
          const timer = setTimeout(done, ms)
          stopTracking.signal.addEventListener('abort', done, { once: true })
        })

      /** 一次 watch：DELETED → 'gone'；其余结束（到点 / 过期 / 断开）→ 'ended'，外层重新 GET */
      async function watchFrom(resourceVersion: string): Promise<'gone' | 'ended'> {
        let gone = false
        const selector = encodeURIComponent(`metadata.name=${name}`)
        const stream: KubeStream = kube.lines(
          `${podsPath}?watch=true&fieldSelector=${selector}&resourceVersion=${encodeURIComponent(resourceVersion)}&timeoutSeconds=${WATCH_TIMEOUT_SECONDS}`,
          (line) => {
            if (!line.trim()) return
            let event: { type?: string; object?: PodObject }
            try {
              event = JSON.parse(line) as typeof event
            } catch {
              return false
            }
            if (event.type === 'DELETED') {
              gone = true
              return false
            }
            // ERROR = 410 Gone（resourceVersion 太旧）之类：结束这次 watch，外层重新 GET
            if (event.type === 'ERROR') return false
            if ((event.type === 'ADDED' || event.type === 'MODIFIED') && event.object) state.update(event.object)
          },
          { idleTimeoutMs: WATCH_IDLE_MS },
        )
        const onStop = () => stream.close()
        stopTracking.signal.addEventListener('abort', onStop)
        try {
          await stream.done
        } finally {
          stopTracking.signal.removeEventListener('abort', onStop)
        }
        return gone ? 'gone' : 'ended'
      }

      /** 跟着 Pod 的状态直到它消失或不再需要：GET → 从那个版本 watch → 断了就重新 GET（不会漏掉断开期间的变化） */
      async function track() {
        let resourceVersion = created.metadata?.resourceVersion
        while (!stopTracking.signal.aborted && !state.gone) {
          if (resourceVersion === undefined) {
            try {
              const pod = await kube.json<PodObject>('GET', podPath(name))
              if (stopTracking.signal.aborted) return
              if (uid && pod?.metadata?.uid && pod.metadata.uid !== uid) {
                // 同名的已经是别的 Pod 了：我们的那个不在了
                state.markGone()
                return
              }
              state.update(pod)
              resourceVersion = pod?.metadata?.resourceVersion ?? ''
              warnedUnavailable = false
            } catch (err) {
              if (isKubeNotFound(err)) {
                state.markGone()
                return
              }
              noteFailure(err)
              await pause(retryMs)
              continue
            }
          }
          try {
            if ((await watchFrom(resourceVersion)) === 'gone') {
              state.markGone()
              return
            }
          } catch (err) {
            noteFailure(err)
            await pause(retryMs)
          }
          resourceVersion = undefined
        }
      }
      // 意外的异常（不该有）也只记一笔：跟踪停了，时长上限的计时器照样会收尾这一轮
      void track().catch((err: unknown) => noteFailure(err))

      let killReason: string | null = null
      const killed = deferred()
      let killRequested = false
      /** 删除最晚确认到什么时候（杀的那一刻起算；正常收尾从开始删起算） */
      let confirmBy = 0
      const requestKill = (reason: string) => {
        killReason ??= reason
        if (killRequested) return
        killRequested = true
        confirmBy = Date.now() + killConfirmMs
        killed.resolve()
      }

      const deadline = setTimeout(
        () => requestKill(`超过沙箱时长上限 ${Math.round(spec.resources.deadlineMs / 1000)} 秒`),
        spec.resources.deadlineMs,
      )
      deadline.unref()
      const startLimitMs = Math.min(startTimeoutMs, spec.resources.deadlineMs)
      const startTimer = setTimeout(() => {
        if (!hasStarted(state.pod) && !state.gone) {
          requestKill(`沙箱 Pod ${Math.round(startLimitMs / 1000)} 秒内没有起来：${describePending(state.pod, options.image)}`)
        }
      }, startLimitMs)
      startTimer.unref()

      function followLogs(): KubeStream {
        let lines = 0
        const stream = kube.lines(
          `${podPath(name)}/log?container=${K8S_CONTAINER}&follow=true&limitBytes=${LOG_LIMIT_BYTES}`,
          (line) => {
            lines += 1
            if (lines > OUTPUT_LINE_LIMIT) return false
            const text = lines === OUTPUT_LINE_LIMIT ? '（输出太多，之后的不再转发）' : line
            try {
              options.onOutput?.(spec.runId, 'stdout', text)
            } catch {
              // 打日志失败不影响沙箱
            }
            // 到上限就断开：不再从 API 拉下去（被攻破的 runner 刷屏也只花这么多流量）
            return lines < OUTPUT_LINE_LIMIT
          },
          { maxLineChars: OUTPUT_LINE_CHARS },
        )
        // 日志只是诊断：拉不到（容器没起来就结束了、API 断了）不影响结局
        stream.done.catch(() => undefined)
        return stream
      }

      /** 删掉 Pod 并确认它不在了；`confirmBy` 之前确认不了就放弃（留给 reap） */
      async function remove(): Promise<'deleted' | 'unconfirmed'> {
        for (;;) {
          try {
            await deletePod(name, uid)
            break
          } catch (err) {
            // 404 = 已经没了；409 = uid 前提不成立（同名的是别的 Pod）：我们的那个也不在了
            if (err instanceof KubeError && (err.status === 404 || err.status === 409)) {
              state.markGone()
              return 'deleted'
            }
            const left = confirmBy - Date.now()
            if (left <= 0) return 'unconfirmed'
            await sleep(Math.min(retryMs, left))
          }
        }
        const confirmed = await state.until(() => state.gone, sleep(Math.max(0, confirmBy - Date.now())))
        return confirmed ? 'deleted' : 'unconfirmed'
      }

      const exited: Promise<SandboxExit> = (async () => {
        // 1. 等它起来（或直接终止 / 消失 / 不会好了 / 被杀 / 起不来的超时）
        await state.until(() => state.gone || hasStarted(state.pod) || hopeless(state.pod) !== null, killed.promise)
        clearTimeout(startTimer)
        const fatal = !killRequested && !state.gone && !hasStarted(state.pod) ? hopeless(state.pod) : null
        if (fatal) requestKill(fatal)

        // 2. 容器起来了：跟随日志
        const logs = !killRequested && !state.gone && containerStarted(state.pod) ? followLogs() : null
        // 3. 等它终止
        if (!killRequested) await state.until(() => state.gone || isTerminal(state.pod), killed.promise)
        clearTimeout(deadline)
        const last = state.pod
        // 4. 日志收尾（被杀就不等了），再删
        if (logs) {
          if (!killRequested) await Promise.race([logs.done.catch(() => undefined), sleep(LOG_DRAIN_MS)])
          logs.close()
        }
        if (!killRequested) confirmBy = Date.now() + killConfirmMs
        const removal = state.gone ? 'deleted' : await remove()
        stopTracking.abort()
        // 这一轮结束了：不管删没删掉，都不再归本驱动管，之后的 reap 可以清它
        active.delete(name)
        if (removal === 'unconfirmed') {
          console.warn(`[agent] run=${spec.runId} 沙箱 Pod ${namespace}/${name} 没能确认删除（k8s API 不可达或删除未生效，留给孤儿清理）`)
        }
        if (killReason !== null) return { exitCode: null, reason: killReason }
        if (isTerminal(last)) return k8sPodExit(last, spec.resources)
        return { exitCode: null, reason: '沙箱 Pod 已不存在（被外部删除）' }
      })()

      return {
        id: `k8s:${namespace}/${name}`,
        podName: name,
        namespace,
        wait: () => exited,
        async kill(reason) {
          requestKill(reason)
          await exited
        },
      }
    },

    async reap(liveRunIds) {
      const selector = encodeURIComponent(`${K8S_LABELS.managed}=true`)
      const list = await kube.json<{ items?: PodObject[] }>('GET', `${podsPath}?labelSelector=${selector}`)
      const now = Date.now()
      for (const pod of list?.items ?? []) {
        const name = pod.metadata?.name
        if (!name) continue
        const labels = pod.metadata?.labels ?? {}
        const runId = labels[K8S_LABELS.run] ?? ''
        const own = labels[K8S_LABELS.instance] === options.instance
        if (own) {
          if (active.has(name) || liveRunIds.has(runId)) continue
        } else if (!expired(pod, now)) {
          continue
        }
        try {
          await deletePod(name, pod.metadata?.uid)
          const whose = own ? '本实例' : `实例 ${labels[K8S_LABELS.instance] ?? '?'}，已过时长上限`
          console.info(`[agent] 清理孤儿沙箱 Pod ${namespace}/${name}（run=${runId || '?'}，${whose}，状态 ${pod.status?.phase ?? '?'}）`)
        } catch (err) {
          if (isKubeNotFound(err) || (err instanceof KubeError && err.status === 409)) continue
          console.warn(`[agent] 孤儿沙箱 Pod ${namespace}/${name} 没能清理：${message(err)}`)
        }
      }
    },

    async check() {
      let version: { gitVersion?: string } | null
      try {
        version = await kube.json<{ gitVersion?: string }>('GET', '/version')
      } catch (err) {
        if (err instanceof KubeError && err.status === 401) {
          throw new Error(`k8s API 不认服务端的凭据（401）：检查 ServiceAccount token（AGENT_SANDBOX_K8S_TOKEN_FILE）`, { cause: err })
        }
        throw err
      }
      const problems: string[] = []
      const warnings: string[] = []

      const review = async (verb: string, resource: string) => {
        const [base, subresource] = resource.split('/')
        const result = await kube.json<{ status?: { allowed?: boolean } }>('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
          apiVersion: 'authorization.k8s.io/v1',
          kind: 'SelfSubjectAccessReview',
          spec: { resourceAttributes: { namespace, verb, resource: base, ...(subresource ? { subresource } : {}) } },
        })
        return result?.status?.allowed === true
      }
      let permissions: K8sCheck['permissions'] = []
      try {
        permissions = await Promise.all(REQUIRED_PERMISSIONS.map(async (p) => ({ ...p, allowed: await review(p.verb, p.resource) })))
        const missing = permissions.filter((p) => !p.allowed).map((p) => `${p.verb} ${p.resource}`)
        if (missing.length > 0) {
          problems.push(`服务端的 ServiceAccount 在命名空间 ${namespace} 缺少权限：${missing.join('、')}（Role 见 k8s/agent-sandbox.yaml）`)
        }
        const excess = (await Promise.all(EXCESS_PERMISSIONS.map(async (p) => ((await review(p.verb, p.resource)) ? `${p.verb} ${p.resource}` : null))))
          .filter((entry): entry is string => entry !== null)
        if (excess.length > 0) {
          warnings.push(`服务端的 ServiceAccount 在沙箱命名空间 ${namespace} 的权限多于需要：${excess.join('、')}（只需要 pods 的 create/get/list/watch/delete 和 pods/log 的 get）`)
        }
      } catch (err) {
        if (err instanceof KubeUnavailableError) throw err
        warnings.push(`没法自查权限（SelfSubjectAccessReview：${message(err)}）`)
      }

      // 沙箱 Pod 的规格能不能过集群的准入（命名空间在不在、Pod Security、LimitRange、RuntimeClass…）：dry-run 建一个，不落库
      if (!permissions.some((p) => p.verb === 'create' && p.resource === 'pods' && !p.allowed)) {
        const probe: SandboxSpec = {
          runId: 'selfcheck',
          flowId: 'selfcheck',
          ownerId: 'selfcheck',
          grantId: 'selfcheck',
          image: options.image,
          resources: { cpu: 1, memoryMiB: 512, pids: 128, diskMiB: 512, deadlineMs: 60_000 },
          gatewayUrl: 'http://dry-run.invalid/api/agent-gateway',
          credential: { kind: 'bootstrap', token: 'dry-run' },
        }
        const suffix = randomBytes(3).toString('hex')
        let admitted = false
        try {
          await kube.json('POST', `${podsPath}?dryRun=All`, k8sPodSpec(probe, options, `shadecn-agent-selfcheck-${suffix}`))
          admitted = true
        } catch (err) {
          if (err instanceof KubeUnavailableError) throw err
          const api = err instanceof KubeError ? err.apiMessage : message(err)
          if (err instanceof KubeError && err.status === 404 && /namespace/i.test(api)) {
            problems.push(`沙箱命名空间 ${namespace} 不存在（AGENT_SANDBOX_K8S_NAMESPACE；清单见 k8s/variants/agent-sandbox.yaml）`)
          } else if (/exceeded quota/i.test(api)) {
            warnings.push(`沙箱命名空间 ${namespace} 的配额此刻已满：${clip(api)}`)
          } else if (/dry.?run/i.test(api)) {
            warnings.push(`集群里有准入 webhook 不支持 dry-run，没能预检沙箱 Pod 的规格：${clip(api)}`)
          } else {
            problems.push(`沙箱 Pod 的规格过不了集群的准入：${clip(api)}`)
          }
        }
        // 准入兜底在不在：同一个 Pod 换成 privileged 必须被拒。服务端有 pods create，被攻破时能建的 Pod 只受准入约束 ——
        // 独立命名空间靠 Pod Security restricted，和别的服务共用命名空间（dev）靠 ValidatingAdmissionPolicy。
        // 放行了 = 那道闸不在（标签没打 / VAP 没 apply / 绑定没匹配上这个 ServiceAccount），宁可不启用
        if (admitted) {
          try {
            await kube.json('POST', `${podsPath}?dryRun=All`, k8sPrivilegedPodSpec(probe, options, `shadecn-agent-selfcheck-guard-${suffix}`))
            problems.push(
              `命名空间 ${namespace} 的准入放行了 privileged 的沙箱 Pod（dry-run）：服务端的 pods create 等于节点 root。` +
                '独立命名空间要强制 Pod Security restricted（k8s/variants/agent-sandbox.yaml），和别的服务共用命名空间要 apply ' +
                'k8s/variants/agent-sandbox-vap.yaml（docs/22 §7.5）',
            )
          } catch (err) {
            if (err instanceof KubeUnavailableError) throw err
            const api = err instanceof KubeError ? err.apiMessage : message(err)
            // 被拒就是兜底在；只有配额满了说明不了什么
            if (/exceeded quota/i.test(api)) warnings.push(`没能确认准入兜底（配额此刻已满）：${clip(api)}`)
          }
        }
      }

      // 节点按镜像引用去拉：不带仓库地址的名字会被当成 docker.io 上的
      const firstSegment = options.image.split('/')[0] ?? ''
      if (!options.image.includes('/') || !/[.:]|^localhost$/.test(firstSegment)) {
        warnings.push(`沙箱镜像 ${options.image} 没写仓库地址，节点会去 docker.io 拉；集群里请给完整引用（AGENT_SANDBOX_IMAGE）`)
      }
      if (!options.runtimeClassName) {
        warnings.push('没有配 RuntimeClass（AGENT_SANDBOX_K8S_RUNTIME_CLASS）：沙箱用节点默认的运行时，不是 gVisor')
      }
      return {
        server: kube.server,
        version: version?.gitVersion ?? '?',
        namespace,
        image: options.image,
        runtimeClassName: options.runtimeClassName ?? null,
        permissions,
        problems,
        warnings,
      }
    },
  }
}

/** 过了它自己的时长上限（+ 宽限）的 Pod：不可能还属于哪个在跑的轮次 */
function expired(pod: PodObject, now: number): boolean {
  const created = Date.parse(pod.metadata?.creationTimestamp ?? '')
  const deadlineSeconds = pod.spec?.activeDeadlineSeconds
  if (!Number.isFinite(created) || typeof deadlineSeconds !== 'number') return false
  return now > created + deadlineSeconds * 1000 + K8S_ORPHAN_GRACE_MS
}
