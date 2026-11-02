import type { AgentRuntimeOptions } from '@shadecn/agent/session'
import type { AgentConversationStore, AgentRunLog } from '@shadecn/agent/store'
import type { LlmProviderTable } from '@shadecn/server-kit/llm'
import type { AgentPaths } from './config.ts'

/**
 * agent 模块内部用的依赖（REQ-MODULES，docs/28 §3.1.2）。
 *
 * 由模块的 `setup(ctx)` 拼好、经 {@link configureAgent} 存一份（`./module.ts`）：配置来自本模块的配置段（`./config.ts`），
 * 实例身份 / 监听地址来自平台，成员判定来自 `canvas` 服务，看图开不开看 `storage` 服务在不在，会话 / 运行日志 / Grant 是本模块自己的表（`./stores.ts`）。
 * 这个包不 import `apps/server`、不读 `process.env`（沙箱子进程的 `PATH`、找容器引擎 socket 这类**本进程运行环境**除外 ——
 * 那不是配置，是运行时事实）。没装配就用 → 直接抛。
 */

/** 沙箱驱动的取值；认不出的原样带着，由装配点写成「未启用」的原因 */
export type AgentSandboxDriver = 'process' | 'oci' | 'k8s' | { unknown: string }

/** agent 的运行配置（`./config.ts` 解析，各项的含义和默认值见那里的注释） */
export interface AgentHostConfig {
  readonly provider: string
  readonly model: string
  readonly thinking: string | undefined
  readonly sandbox: AgentSandboxDriver
  readonly sandboxExec: boolean
  readonly allowProcessInProduction: boolean
  readonly sandboxImage: string
  readonly ociSocket: string
  readonly ociNetwork: string
  readonly sandboxRuntime: string
  readonly k8s: {
    readonly namespace: string
    readonly runtimeClass: string
    readonly pullSecret: string
    readonly pullPolicy: string
    readonly nodeSelector: string
    readonly apiUrl: string
    readonly tokenFile: string | undefined
    readonly caFile: string | undefined
  }
  readonly sandboxResources: {
    readonly cpu: number
    readonly memoryMiB: number
    readonly pids: number
    readonly diskMiB: number
  }
  readonly gatewayUrl: string
  readonly tokenSecret: string
  readonly grantMarginMs: number
  readonly leaseTtlMs: number
  readonly runIdleTimeoutMs: number
  readonly runTotalTimeoutMs: number
  readonly maxOutputTokens: number | undefined
  readonly titleModel: string | undefined
}

// ---------------------------------------------------------------- 委托授权（Grant，docs/22 §3）的落库

export interface NewGrantScope {
  scope: string
  resource: string
  onRevoke: string
  required: boolean
}

export interface NewGrant {
  userId: string
  runId: string
  flowId: string
  projectId: string
  projectKind: string
  personalOwnerId: string | null
  expiresAt: Date
  scopes: NewGrantScope[]
}

export interface GrantState {
  id: string
  expiresAt: Date
  revokedAt: Date | null
  revokeReason: string | null
}

/** `agent_grant` / `agent_grant_scope` 表上的几步（实现：`./stores.ts` 的 `agentGrants`） */
export interface AgentGrantStore {
  create(input: NewGrant): Promise<string>
  state(grantId: string): Promise<GrantState | null>
  /** 只写 `revokedAt` 还为空的（第一个原因留下）；返回是否真的撤了 */
  revoke(grantId: string, reason: string, at?: Date): Promise<boolean>
  revokeAllForUser(userId: string, reason: string, at?: Date): Promise<number>
  expireDue(reason: string, now?: Date): Promise<number>
}

/** 画布所在的项目（签发时的快照，也是每次判权时比对的对象） */
export interface FlowAccess {
  projectId: string
  kind: 'team' | 'personal'
  personalOwnerId: string | null
}

// ---------------------------------------------------------------- 汇总

export interface AgentPorts {
  config: AgentHostConfig
  /** 这个进程的身份（`SERVER_INSTANCE_ID`）：任务登记、节点占用的持有者，停止指令的频道 */
  instanceId: string
  /** 服务端监听的地址：k8s 自检据此提醒「只听回环，沙箱 Pod 连不上」 */
  host: string
  /** 开发环境：process 驱动在生产要显式放行 */
  isDev: boolean
  /**
   * 这个进程执行 agent 吗（有 `agent` 角色）。不执行的进程（web）也要 runtime —— 视图、会话列表、接回、中止都经它读共享登记 ——
   * 但发起只经派发（docs/28 §3.6），所以它的 runtime **不建沙箱驱动**：不白占一个驱动、不打「已启用 / 沙箱」那几行误导人的日志。
   */
  executesRuns: boolean
  paths: AgentPaths
  /** 语言服务提供方（平台的 `runtime.llmProviders`）：`default` 和模型表的 `provider` 都引用它 */
  llmProviders: LlmProviderTable
  /** 读 `$ENV` 引用的、按提供方退回的 key（平台的 `runtime.envVar`：名字由别处约定，不在配置 schema 里） */
  envVar(name: string): string | undefined
  storage: {
    /** 本进程加载了对象存储模块：只有开了才把看图（`view_node_media`）接给编排层 */
    enabled: boolean
    /** 画布素材的键前缀（`MODULES_STORAGE_KEY_PREFIX`）：看图时把 URL 反解回本服务的键 */
    keyPrefix: string
  }
  /** runner 怎么起：产物里是 `agent-runner.js`（和 index.js 同目录），源码里经 tsx 跑 `@shadecn/agent/runner/main` */
  runner: { isBundle: boolean; moduleDir: string }
  stores: {
    conversations: AgentConversationStore
    runLog: AgentRunLog
    userProfiles: AgentRuntimeOptions['userProfiles']
    grants: AgentGrantStore
    /** 和画布模块的 `flowGuard` 同口径：画布（及其项目）没被删，且这个人是项目成员（个人空间即所有者）；否则 null */
    flowAccess(flowId: string, userId: string): Promise<FlowAccess | null>
  }
}

let current: AgentPorts | undefined

export function configureAgent(ports: AgentPorts): void {
  current = ports
}

export function agentPorts(): AgentPorts {
  if (!current) {
    throw new Error('[agent] agent 模块还没装配（setup 时调 configureAgent）')
  }
  return current
}

/**
 * 惰性单例：第一次被访问时才按端口建出真实对象，之后一直是同一个。
 *
 * 这个包里原来那些「import 时就按环境变量建好」的单例（授权、节点占用、运行登记、agent 定义、模型表…）
 * 现在要等宿主装配完端口才建得出来，但调用方（编排层、路由、测试）照旧当普通对象用 —— 包一层透明代理就行。
 * 想在启动时就把校验跑掉（agent 定义不合法不启动），装配函数主动访问一次即可（`module.ts`）。
 */
export function lazySingleton<T extends object>(build: () => T): T {
  let real: T | undefined
  const target = (): T => (real ??= build())
  return new Proxy({} as T, {
    get: (_, key) => {
      const value = Reflect.get(target(), key) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target()) : value
    },
    has: (_, key) => Reflect.has(target(), key),
    ownKeys: () => Reflect.ownKeys(target()),
    getOwnPropertyDescriptor: (_, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target(), key)
      // 代理的「壳」上没有这些属性；声明成可配置，`Object.keys` / 展开 / `in` 才不会被 Proxy 不变式拦下
      return descriptor ? { ...descriptor, configurable: true } : undefined
    },
    set: (_, key, value) => Reflect.set(target(), key, value),
  })
}
