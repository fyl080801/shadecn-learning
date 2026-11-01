import type { Server } from 'node:http'
import { createAdaptorServer } from '@hono/node-server'
import { configureBus, bus } from '@shadecn/server-kit/bus'
import { closeCluster, initCluster } from '@shadecn/server-kit/cluster'
import { COLLAB_PATH } from '@shadecn/shared/collab'
import { app, type ServerApp } from './app.ts'
import {
  assertClusterConfig,
  clusterMode,
  host,
  instanceId,
  isClustered,
  isDev,
  port,
  redisKeyPrefix,
  redisUrl,
  serverRoles,
  configFiles,
  staticDir,
} from './config.ts'
import { disconnectDb } from './db.ts'
import { assertRolesSupported, type AnyServerModule } from '@shadecn/server-kit/kernel'
import { assemble, prepare } from './server.ts'

/**
 * 前端托管：返回收尾函数（dev 下关 Vite）。生产 = 静态资源（`frontend/static.ts`），开发 = Vite 中间件（`frontend/dev.ts`，只有 `dev.ts` 入口引用）。
 * 前端不是能力模块：它是底座的一部分，且必须挂在所有接口之后（SPA 的兜底路由）。
 */
export type FrontendHost = (app: ServerApp, server: Server) => Promise<(() => Promise<void>) | void> | void

/**
 * 底座的启动流程（docs/28 §3.1.3）。`apps/server` 的 `index.ts`（生产）和 `dev.ts`（开发）都走这里，交进来同一份模块清单，只是前端的托管方式不同。
 *
 * 1. 收下模块清单（`prepare`：完整校验配置、解析各模块的配置段、建 ORM、建路由归属表），校验副本模式和角色集 —— 这一步失败进程不会监听端口；
 * 2. 挑共享状态的实现（单副本 = 进程内存，多副本 = Redis）。必须在装配模块之前：协同要用同一个 Redis 连接参数，
 *    各模块顶层声明的共享表也是在这之后才第一次被真正取用；
 * 3. 建 server 但先不 listen：模块认领的 WebSocket 入口要挂 `upgrade`，dev 下 Vite 要挂 HMR；
 * 4. 按角色和开关选出模块、按依赖排序、逐个 setup（模块自己挂路由，`server.ts` 的 `assemble`），再挂前端、`ready`，然后 listen；
 * 5. SIGINT / SIGTERM：模块按逆序收尾（各自带上限），然后关共享层、断库、关 server。
 *
 * 返回 `shutdown`，给 `dev.ts` 的孤儿守卫用。
 */
export async function boot(options: {
  /** 模块清单（入口的 `modules.ts`）：底座不认识任何模块，全靠它交进来 */
  modules: readonly AnyServerModule[]
  frontend: FrontendHost
}): Promise<() => Promise<void>> {
  // 模块清单 → 配置段（登录模块的校验也在这里：生产缺登录配置直接抛）、ORM、路由归属表
  await prepare(options.modules)
  assertClusterConfig()
  assertRolesSupported(serverRoles, { clustered: isClustered })

  await initCluster(isClustered ? { mode: 'redis', url: redisUrl, prefix: redisKeyPrefix } : { mode: 'single' })
  // 跨角色 / 跨副本的请求-应答（docs/28 §3.7）。实例身份和共享层的一致；订阅要在 initCluster 之后
  configureBus({ instanceId })

  // overrideGlobalObjects: false —— 默认会把 global.Response 换成带缓存的实现，
  // 那条快路径不认 RESPONSE_ALREADY_SENT 这个标记，前端中间件自己写完响应后会被重复 writeHead
  const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })

  // ServerType 是 http/http2 的联合；createAdaptorServer 默认建的就是 http.Server
  const { resolved, loaded, attachUpgrades } = await assemble({ app, server: server as Server })
  attachUpgrades(server as Server)
  // 前端（静态 / Vite）只在 web 角色托管，且挂在所有接口之后
  const disposeFrontend = serverRoles.has('web') ? await options.frontend(app, server as Server) : undefined
  await loaded.ready()


  server.listen(port, host, () => {
    const loadedNames = new Set(loaded.modules.map((module) => module.name))
    console.log(`配置文件             ${configFiles.length ? configFiles.join(' + ') : '无（只用环境变量和默认值）'}`)
    const frontend = !serverRoles.has('web') ? '不托管前端' : isDev ? 'Vite 中间件' : `静态资源 ${staticDir}`
    const mode = `${isDev ? 'dev' : 'prod'}（${frontend}）`
    console.log(`${mode} 服务已启动  http://${host}:${port}`)
    // headless 的协同（只有 agent 角色）不接 WebSocket，不打这一行
    if (loadedNames.has('collab') && serverRoles.has('collab')) {
      console.log(`Yjs websocket        ws://${host}:${port}${COLLAB_PATH}（房间名走消息）`)
    }
    console.log(
      `副本模式             ${clusterMode === 'redis' ? `多副本（Redis 共享，实例 ${instanceId}）` : '单副本（状态在进程内存）'}`,
    )
    const skipped = resolved.skipped.map(({ module, reason, detail }) =>
      reason === 'role' ? `${module.name}（不随本角色启动）` : `${module.name}（关：${detail || '配置关闭'}）`,
    )
    console.log(
      `角色 / 能力模块      ${[...serverRoles].join(',')} → ${[...loadedNames].join(', ') || '无'}${skipped.length ? `；未加载 ${skipped.join('、')}` : ''}`,
    )
  })

  let shuttingDown = false

  async function shutdown() {
    // SIGINT 和 SIGTERM 可能前后脚都到，孤儿守卫也可能在退出过程中再触发一次
    if (shuttingDown) return
    shuttingDown = true

    await loaded.shutdown()
    await disposeFrontend?.()
    await bus().close()
    await closeCluster().catch(() => undefined)
    await disconnectDb().catch(() => undefined)
    server.close()
    process.exit(0)
  }

  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())

  return shutdown
}
