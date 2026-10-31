import type { Server } from 'node:http'
import type { ServerRole } from './roles.ts'

/**
 * 能力模块的契约（REQ-MODULES，docs/28 §3.1.2）。
 *
 * 底座（HTTP、鉴权、数据库、共享层、日志）不是模块；协同、对象存储、agent 这些**可开关、可按角色拆开部署**的能力才是。
 * 模块之间只经 `ctx.service()` 拿对方声明过的服务，**不 import 对方的内部文件**（`.claude/rules/server-modules.md`）。
 *
 * **`App` 是宿主的 Hono 应用类型**：这个包不认识宿主的会话变量、bindings，所以只做类型参数 ——
 * 宿主（apps/server）用自己的 `ServerApp` 实例化，模块包需要挂路由时在自己的工厂函数上约束它。
 *
 * 模块只经两条路拿底座的东西：构造时宿主交进来的端口（`createXxxModule(ports)`），和 `setup(ctx)` 的 `ctx`。
 * 模块包**永远不 import `apps/server`**（docs/28 §3.1.2）。
 */
export interface ServerModule<App = unknown> {
  /** 唯一名，也是 `/api/features` 里的键 */
  readonly name: string
  /** 随哪些角色启动：当前进程的角色集和它有交集才加载 */
  readonly roles: readonly ServerRole[]
  /** 硬依赖：这些模块没加载就启动失败 */
  readonly dependsOn?: readonly string[]
  /** 软依赖：没加载时 `ctx.service()` 返回 undefined，模块自己退化。只影响装配顺序 */
  readonly optional?: readonly string[]
  /** 本模块注册给别人的服务名（`ctx.provide`） */
  readonly provides?: readonly string[]
  /**
   * 开关：`true` 开；`false` 或一段原因 = 关（原因进启动日志和 `/api/features`）。
   * 默认开。关掉的模块不加载、不占角色；别人硬依赖它就启动失败。
   */
  enabled?(): boolean | string
  /** 装配：挂路由、挂 upgrade、注册服务、起定时器。返回的句柄交给内核按逆序收尾 */
  setup(ctx: ModuleContext<App>): Promise<ModuleHandle | void> | ModuleHandle | void
}

/** `setup` 交给模块的东西。模块不读 `process.env`：环境相关的决定在配置层做 */
export interface ModuleContext<App = unknown> {
  /** 这个进程启用的角色 */
  readonly roles: ReadonlySet<ServerRole>
  readonly app: App
  /** 原始的 node server：协同层要挂 `upgrade` 事件 */
  readonly server: Server
  readonly isDev: boolean
  /** 拿别的模块注册的服务；没加载（软依赖）= undefined */
  service<T>(name: string): T | undefined
  /** 注册服务，名字必须在本模块的 `provides` 里 */
  provide<T>(name: string, value: T): void
}

/** 模块装配后交回的句柄 */
export interface ModuleHandle {
  /** 全部模块 setup 完、开始 listen 之前调一次 */
  ready?(): Promise<void> | void
  /** 收尾。内核按装配的逆序调，每个带上限（超时记一笔，不阻断后面的） */
  shutdown?(): Promise<void> | void
  /** `shutdown` 的上限，默认 {@link DEFAULT_SHUTDOWN_TIMEOUT_MS} */
  readonly shutdownTimeoutMs?: number
}

/** 收尾的默认上限。整条链要落在 k8s 的 60 秒宽限期内（index.ts 的注释） */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

/** 只做类型约束，让模块定义处拿到完整的提示 */
export function defineModule<App = unknown>(module: ServerModule<App>): ServerModule<App> {
  return module
}
