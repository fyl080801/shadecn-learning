import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Options } from '@mikro-orm/core'
import { User } from '@shadecn/server-kit/identity'
import {
  parseModuleConfigs,
  recordFeatures,
  resolveModules,
  routeCovers,
  startModules,
  type AnyServerModule,
  type HttpHost,
  type LoadedModules,
  type ModuleConfigs,
  type ResolvedModules,
  type UpgradeHandler,
} from '@shadecn/server-kit/kernel'
import { resolveFullConfig } from './config-source.ts'
import { isDev, serverRoles } from './config.ts'
import { initDatabase } from './db.ts'
import { acceptProvidedService, platform, resetAuthProvider, runtime } from './platform.ts'
import { buildServerRouteTable, setRouteTable } from './routes-table.ts'

/**
 * 底座的两步（docs/28 §3.1.3）：`prepare(modules)` 收下入口交进来的模块清单、`assemble()` 把它们装起来。
 *
 * 底座不认识任何一个模块 —— 清单只从入口（`apps/server/index.ts` / `dev.ts`）交进来；底座按清单
 * 解析各模块的配置段、建 ORM（底座的表 + 每个模块的 `entities`）、建路由归属表，再按角色和开关逐个 `setup`。
 */

/** 底座自己的表：只有平台的 `User`（登录、会话那几张是登录模块的） */
export const coreEntities = [User]

/** 交给 MikroORM 的全部实体：底座的 + 清单里**每个**模块的（不论开关、角色 —— 关掉的模块的表不能「消失」，docs/28 §3.1.2） */
export function serverEntities(modules: readonly AnyServerModule[]): NonNullable<Options['entities']> {
  return [...coreEntities, ...modules.flatMap((module) => [...(module.entities ?? [])])] as NonNullable<Options['entities']>
}

export interface Prepared {
  readonly modules: readonly AnyServerModule[]
  readonly configs: ModuleConfigs
}

let prepared: Prepared | undefined

/**
 * 收下模块清单：整份配置按完整的 schema 再校验一遍、解析各模块的配置段、建 ORM、建路由归属表。
 * 任何一步抛错 = 配置错，进程不监听端口。同一个模块图里只做一次（再调返回同一份）。
 */
export async function prepare(modules: readonly AnyServerModule[]): Promise<Prepared> {
  if (prepared) {
    if (prepared.modules !== modules) throw new Error('[server] 同一个进程只能交一份模块清单')
    return prepared
  }
  const configs = parseModuleConfigs(modules, resolveFullConfig(modules), runtime)
  await initDatabase(serverEntities(modules))
  setRouteTable(buildServerRouteTable(modules))
  prepared = { modules, configs }
  return prepared
}

export function preparedState(): Prepared {
  if (!prepared) throw new Error('[server] 还没交模块清单（入口要先 prepare(modules)）')
  return prepared
}

/** 宿主的 Hono 应用里模块能用到的那部分 */
interface MountableApp {
  route(path: string, app: Parameters<HttpHost['route']>[1]): unknown
  use(path: string, middleware: Parameters<HttpHost['use']>[1]): unknown
}

export interface Assembled {
  readonly resolved: ResolvedModules
  readonly loaded: LoadedModules
  /** 把认领了的 WebSocket 入口挂到 server 的 `upgrade` 上（listen 之前调） */
  attachUpgrades(server: Server): void
}

/**
 * 选模块、按依赖排序、逐个 setup。模块的路由挂进 `app`，WebSocket 入口登记下来等 {@link Assembled.attachUpgrades}；
 * 某个模块注册了 `auth` 服务，平台的 `auth` 就转给它。
 *
 * 不 listen、不碰共享层的初始化（那是 `boot.ts` 的事）—— 测试的 setup 也调它，装出和生产同一套路由。
 */
export async function assemble(options: { app: MountableApp; server: Server }): Promise<Assembled> {
  const { modules, configs } = preparedState()
  const resolved = resolveModules(modules, {
    roles: serverRoles,
    switchedOff: configs.switchedOff,
    configs: configs.values,
  })
  recordFeatures(resolved)
  resetAuthProvider()

  const upgrades: { path: string; handler: UpgradeHandler }[] = []
  const http: HttpHost = {
    route: (path, app) => void options.app.route(path, app),
    use: (path, middleware) => {
      options.app.use(path, middleware)
      options.app.use(`${path}/*`, middleware)
    },
    upgrade: (path, handler) => void upgrades.push({ path, handler }),
  }

  const loaded = await startModules(resolved.ordered, {
    roles: serverRoles,
    isDev,
    platform,
    server: options.server,
    http,
    configs: configs.values,
    onProvide: acceptProvidedService,
  })

  return {
    resolved,
    loaded,
    attachUpgrades(server) {
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
        const claimed = upgrades.find((entry) => routeCovers(entry.path, pathname))
        if (claimed) return claimed.handler(req, socket, head)
        // 没人认领：dev 下留给 Vite 的 HMR 监听器（node 的 upgrade 是多监听器事件），prod 下没人要就断开
        if (!isDev) socket.destroy()
      })
    },
  }
}
