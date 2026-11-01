import type { Server } from 'node:http'
import type { Hono, MiddlewareHandler } from 'hono'
import type { Platform } from '../platform.ts'
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type AnyServerModule,
  type ModuleContext,
  type ModuleHandle,
  type ModuleHttp,
  type UpgradeHandler,
} from './module.ts'
import type { ServerRole } from './roles.ts'

/** 宿主的 HTTP 管线：内核核对完声明之后，真正的挂载交给它 */
export interface HttpHost {
  route(path: string, app: Hono<any, any, any>): void
  use(path: string, middleware: MiddlewareHandler): void
  upgrade(path: string, handler: UpgradeHandler): void
}

export interface StartContext {
  readonly roles: ReadonlySet<ServerRole>
  readonly isDev: boolean
  readonly platform: Platform
  readonly server: Server
  readonly http: HttpHost
  /** 各模块解析好的配置（模块名 → 值） */
  readonly configs: ReadonlyMap<string, unknown>
  /** 每注册一个服务通知一次（底座据此接上由模块提供的平台能力，如 `auth`） */
  readonly onProvide?: (name: string, value: unknown) => void
}

/** 装配完的一组模块 */
export interface LoadedModules {
  /** 按装配顺序 */
  readonly modules: readonly AnyServerModule[]
  /** 全部 `ready()`，按装配顺序串行 */
  ready(): Promise<void>
  /** 按装配的逆序收尾，每个带上限；可重入（第二次调直接返回同一个 Promise） */
  shutdown(): Promise<void>
}

/**
 * 按顺序装配模块（docs/28 §3.1.3 第 2～4 步）。
 *
 * - `setup` 串行：后面的模块可能要 `ctx.service()` 前面注册的服务；
 * - 任一 `setup` 抛错就整体失败 —— 那是配置错，不是运行时故障，进程不该带着半套模块监听端口；
 * - 收尾逆序、每个带上限：超时只记一笔不阻断后面的。一个模块收尾卡死不能拖着别的模块落不了库。
 */
export async function startModules(ordered: readonly AnyServerModule[], context: StartContext): Promise<LoadedModules> {
  const services = new Map<string, unknown>()
  const handles: { module: AnyServerModule; handle: ModuleHandle }[] = []

  for (const module of ordered) {
    const ctx: ModuleContext<unknown> = {
      name: module.name,
      roles: context.roles,
      isDev: context.isDev,
      config: context.configs.get(module.name),
      platform: context.platform,
      server: context.server,
      http: moduleHttp(module, context),
      service: <T>(name: string) => services.get(name) as T | undefined,
      provide: (name, value) => {
        if (!module.provides?.includes(name)) {
          throw new Error(`[kernel] 模块 ${module.name} 注册了没在 provides 里声明的服务 ${name}`)
        }
        if (services.has(name)) throw new Error(`[kernel] 服务 ${name} 已经被注册过`)
        services.set(name, value)
        context.onProvide?.(name, value)
      },
    }
    const handle = await module.setup(ctx)
    for (const name of module.provides ?? []) {
      if (!services.has(name)) throw new Error(`[kernel] 模块 ${module.name} 声明了 provides ${name} 却没有注册`)
    }
    handles.push({ module, handle: handle ?? {} })
  }

  let closing: Promise<void> | undefined

  return {
    modules: ordered,
    async ready() {
      for (const { handle } of handles) await handle.ready?.()
    },
    shutdown() {
      closing ??= (async () => {
        for (const { module, handle } of [...handles].reverse()) {
          if (!handle.shutdown) continue
          await withDeadline(
            Promise.resolve().then(() => handle.shutdown?.()),
            handle.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
            `模块 ${module.name} 收尾`,
          )
        }
      })()
      return closing
    },
  }
}

/**
 * 一个模块的 HTTP 注册口：路径必须是本模块声明过的（同 kind、同写法），声明的角色不在本进程就不挂。
 * 不在声明里的挂载直接抛 —— 那条路由会绕过角色闸门、登录闸门和分流表，是写代码时的错。
 */
function moduleHttp(module: AnyServerModule, context: StartContext): ModuleHttp {
  const claim = (path: string, kind: 'http' | 'upgrade'): boolean => {
    const declared = module.routes?.find((route) => route.path === path && (route.kind ?? 'http') === kind)
    if (!declared) {
      throw new Error(`[kernel] 模块 ${module.name} 挂了没在 routes 里声明的${kind === 'upgrade' ? ' WebSocket ' : ''}入口 ${path}`)
    }
    return declared.role === 'any' || context.roles.has(declared.role)
  }
  return {
    route(path, app) {
      if (!claim(path, 'http')) return false
      context.http.route(path, app)
      return true
    },
    use(path, middleware) {
      if (!claim(path, 'http')) return false
      context.http.use(path, middleware)
      return true
    },
    upgrade(path, handler) {
      if (!claim(path, 'upgrade')) return false
      context.http.upgrade(path, handler)
      return true
    },
  }
}

/**
 * 给一段收尾工作加个上限；超时或抛错都只记一笔，不阻断后面的步骤。
 *
 * **必须有上限**：数据库要是进了网络黑洞，一个 `await` 就永远回不来 —— 然后 k8s 到点 SIGKILL，
 * 连后面的清理都没跑。卡死等来的是最糟的结局。
 */
export async function withDeadline(task: Promise<unknown>, ms: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[shutdown] ${label}超过 ${ms}ms 仍未完成，不再等待`)
      resolve()
    }, ms)
  })

  try {
    await Promise.race([task.catch((err: unknown) => console.error(`[shutdown] ${label}失败`, err)), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
