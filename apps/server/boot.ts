import { createAdaptorServer } from '@hono/node-server'
import { COLLAB_PATH } from '@shadecn/shared/collab'
import { app } from './app.ts'
import { enabledProviders } from './auth/providers/index.ts'
import { sweepExpired } from './auth/session.ts'
import { closeCluster, initCluster } from './cluster/index.ts'
import {
  assertAuthConfig,
  assertClusterConfig,
  authEnabled,
  clusterMode,
  host,
  instanceId,
  isClustered,
  isDev,
  port,
  serverRoles,
  staticDir,
} from './config.ts'
import { disconnectDb } from './db.ts'
import { startModules } from './kernel/lifecycle.ts'
import type { ServerModule } from './kernel/module.ts'
import { recordFeatures } from './kernel/registry.ts'
import { resolveModules } from './kernel/resolve.ts'
import { assertRolesSupported } from './kernel/roles.ts'

/**
 * 底座的启动流程（docs/28 §3.1.3）。`index.ts`（生产）和 `dev.ts`（开发）都走这里，只是交进来的模块表不同。
 *
 * 1. 校验配置（鉴权、副本模式、角色集）；按角色和开关选出模块、按依赖排序 —— 这一步失败进程不会监听端口；
 * 2. 挑共享状态的实现（单副本 = 进程内存，多副本 = Redis）。必须在建协同服务端之前：那边要用同一个 Redis 连接参数，
 *    各模块顶层声明的共享表也是在这之后才第一次被真正取用；
 * 3. 建 server 但先不 listen：协同层要挂 `upgrade`，dev 下 Vite 要挂 HMR；
 * 4. 按顺序装配模块、`ready`，再 listen；
 * 5. SIGINT / SIGTERM：模块按逆序收尾（各自带上限），然后关共享层、断库、关 server。
 *
 * 返回 `shutdown`，给 `dev.ts` 的孤儿守卫用。
 */
export async function boot(options: { modules: readonly ServerModule[] }): Promise<() => Promise<void>> {
  assertAuthConfig()
  assertClusterConfig()
  assertRolesSupported(serverRoles, { clustered: isClustered })

  const resolved = resolveModules(options.modules, { roles: serverRoles })
  recordFeatures(resolved)

  await initCluster()

  // overrideGlobalObjects: false —— 默认会把 global.Response 换成带缓存的实现，
  // 那条快路径不认 RESPONSE_ALREADY_SENT 这个标记，前端中间件自己写完响应后会被重复 writeHead
  const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })

  const loaded = await startModules(resolved.ordered, { roles: serverRoles, app, server, isDev })
  await loaded.ready()

  // 过期会话和没用掉的授权请求：启动清一次，之后每小时清一次（鉴权是底座的，不是模块）
  const sweep = () => {
    void sweepExpired()
      .then(({ sessions, authRequests, pendingLinks }) => {
        if (sessions || authRequests || pendingLinks) {
          console.log(
            `[auth] 清理过期数据：会话 ${sessions} 条，授权请求 ${authRequests} 条，待确认关联 ${pendingLinks} 条`,
          )
        }
      })
      .catch((err: unknown) => console.error('[auth] 清理过期数据失败', err))
  }
  sweep()
  const sweepTimer = setInterval(sweep, 60 * 60 * 1000)
  sweepTimer.unref()

  server.listen(port, host, () => {
    const loadedNames = new Set(loaded.modules.map((module) => module.name))
    const mode = isDev ? 'dev（Vite 中间件）' : `prod（静态资源 ${staticDir}）`
    console.log(`${mode} 服务已启动  http://${host}:${port}`)
    if (loadedNames.has('collab')) {
      console.log(`Yjs websocket        ws://${host}:${port}${COLLAB_PATH}（房间名走消息）`)
    }
    const providers = enabledProviders()
      .map((provider) => provider.label)
      .join(' / ')
    console.log(`登录                 ${authEnabled ? `${providers}（/login）` : '未启用'}`)
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

    clearInterval(sweepTimer)
    await loaded.shutdown()
    await closeCluster().catch(() => undefined)
    await disconnectDb().catch(() => undefined)
    server.close()
    process.exit(0)
  }

  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())

  return shutdown
}
