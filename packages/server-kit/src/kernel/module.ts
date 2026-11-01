import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Hono, MiddlewareHandler } from 'hono'
import type { ConfigSchema } from '../config.ts'
import type { Platform, RuntimeInfo } from '../platform.ts'
import type { RouteDeclaration } from './routes.ts'
import type { ServerRole } from './roles.ts'

/**
 * 模块的集成协议（REQ-MODULES，docs/28 §3.1.2）。
 *
 * 底座（HTTP 管线、身份与会话、数据库、共享层、配置、日志、前端托管）不是模块；业务能力（画布、协同、对象存储、agent）都是。
 * 一个能力包**默认导出一份声明**，宿主只把它写进模块清单（`apps/server/modules.ts`），其余全由内核按声明完成：
 *
 * - `config`：本模块的配置段 schema + 解析。挂到配置文件的 `modules.<name>` 下（自动带 `enabled` 开关），解析结果是 `ctx.config`；
 * - `entities`：本模块的表。**不论开关、角色都注册**（关掉模块不能让它的表「消失」，否则 `db:push` 判成有损变更）；
 * - `routes`：本模块的 HTTP / WebSocket 入口 —— 路径、归哪个角色、要不要登录。路由归属表（ingress / dev:cluster 分流、
 *   不归本进程的路由 404）和免登录名单都从这里推出；`setup` 里只能挂这里声明过的路径；
 * - `setup(ctx)`：挂路由（`ctx.http`）、注册服务（`ctx.provide`）、起定时器。返回句柄交给内核收尾。
 *
 * 模块之间只经 `ctx.service()`（对方 `provides` 里声明的）、对方的契约入口（`./contract`、`./entities`）和总线说话，
 * **不 import 对方的内部文件**；**永远不 import `apps/server`**，也不读 `process.env`（`.claude/rules/server-modules.md`）。
 */
export interface ServerModule<Config = unknown> {
  /** 唯一名：配置文件里的 `modules.<name>`、`/api/features` 里的键、`<NAME>_ENABLED` 开关 */
  readonly name: string
  /** 随哪些角色加载：当前进程的角色集和它有交集才加载 */
  readonly roles: readonly ServerRole[]
  /**
   * 硬依赖：没加载就启动失败。`{ module, roles }` = 只在本进程扮演这些角色时才要求
   * （agent 只在执行角色上要 collab 的活房间，web 上的只读接口不要）。
   */
  readonly dependsOn?: readonly ModuleDependency[]
  /** 软依赖：没加载时 `ctx.service()` 返回 undefined，模块自己退化。只影响装配顺序 */
  readonly optional?: readonly string[]
  /** 本模块注册给别人的服务名（`ctx.provide`） */
  readonly provides?: readonly string[]
  /** 本模块的配置段 */
  readonly config?: ModuleConfig<Config>
  /** 本模块的 MikroORM 实体（`defineEntity` 的产物） */
  readonly entities?: readonly unknown[]
  /** 本模块的 HTTP / WebSocket 入口声明 */
  readonly routes?: readonly RouteDeclaration[]
  /**
   * 开关：`true` 开；`false` 或一段原因 = 关（原因进启动日志和 `/api/features`）。默认开。
   * 配置里的 `enabled: false` 在这之前就把模块关了，不会再问它。
   */
  enabled?(config: Config): boolean | string
  /** 装配。返回的句柄交给内核按逆序收尾 */
  setup(ctx: ModuleContext<Config>): Promise<ModuleHandle | void> | ModuleHandle | void
}

export type ModuleDependency = string | { readonly module: string; readonly roles: readonly ServerRole[] }

/**
 * 模块的配置段。
 *
 * `schema` 声明文件里的键和对应的环境变量（`setting('AGENT_MODEL', 'string')`）；`parse` 拿到的 `read(envName)` 是合并好的值
 * （环境变量优先，其次配置文件，取出来是和环境变量同形的字符串，都没有 = undefined），默认值和校验在 `parse` 里 —— 一处解析。
 * `parse` 抛错 = 配置错，进程不监听端口。**关掉的模块也会解析**（别的进程形态要读它的配置，比如 web 上 agent 的只读接口）。
 */
export interface ModuleConfig<Config> {
  readonly schema: ConfigSchema
  parse(read: (envName: string) => string | undefined, runtime: RuntimeInfo): Config
}

/** HTTP 注册口：只能挂本模块声明过的入口；声明的角色不在本进程时，挂载是空操作（返回 false） */
export interface ModuleHttp {
  /** 挂一个 Hono 子应用。`path` 必须和本模块某条 `kind: 'http'` 声明的路径一致 */
  route(path: string, app: Hono<any, any, any>): boolean
  /** 在某条已声明的路径上挂中间件（排在本模块路由之前，供别的模块复用的守卫不走这里，走服务） */
  use(path: string, middleware: MiddlewareHandler): boolean
  /**
   * 认领一条 WebSocket 入口（`kind: 'upgrade'` 声明的路径）：路径匹配的 upgrade 交给 `handler`。
   * 宿主统一监听 node 的 `upgrade` 事件，按路径分发；没人认领的在生产直接断开，dev 下留给 Vite HMR。
   */
  upgrade(path: string, handler: UpgradeHandler): boolean
}

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void

/** `setup` 交给模块的东西 */
export interface ModuleContext<Config = unknown> {
  readonly name: string
  /** 这个进程启用的角色 */
  readonly roles: ReadonlySet<ServerRole>
  readonly isDev: boolean
  /** 本模块解析好的配置 */
  readonly config: Config
  readonly platform: Platform
  readonly http: ModuleHttp
  /** 原始的 node server（只给确实要碰它的场景：dev 下 Vite 共用端口这类宿主自己的事；模块用 `http.upgrade`） */
  readonly server: Server
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

/** 收尾的默认上限。整条链要落在 k8s 的 60 秒宽限期内 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

/** 只做类型约束，让模块定义处拿到完整的提示 */
export function defineModule<Config = undefined>(module: ServerModule<Config>): ServerModule<Config> {
  return module
}

/** 清单里混着配置类型各不相同的模块：内核只按 unknown 看待 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyServerModule = ServerModule<any>
