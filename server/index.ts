import './env.ts'
import { createAdaptorServer } from '@hono/node-server'
import { app } from './app.ts'
import { sweepExpired } from './auth/session.ts'
import {
  attachCollabServer,
  COLLAB_PATH,
  flushAllRoomsToDatabase,
  flushCollabWrites,
} from './collab/index.ts'
import { closeCluster, initCluster } from './cluster/index.ts'
import {
  assertAuthConfig,
  assertClusterConfig,
  authEnabled,
  clusterMode,
  host,
  instanceId,
  isDev,
  port,
  staticDir,
} from './config.ts'
import { disconnectDb } from './db.ts'
import { attachFrontend } from './frontend/index.ts'

assertAuthConfig()
assertClusterConfig()

// 挑共享状态的实现（单副本= 进程内存，多副本= Redis）。
// 必须在建协同服务端之前：那边要用同一个 Redis 连接参数，
// 而各模块顶层声明的共享表也是在这之后才第一次被真正取用
await initCluster()

// 先建 server 但先不 listen：Vite 中间件要拿这个 server 挂 HMR 的 upgrade。
// overrideGlobalObjects: false —— 默认会把 global.Response 换成带缓存的实现，
// 那条快路径不认 RESPONSE_ALREADY_SENT 这个标记，前端中间件自己写完响应后会被重复 writeHead。
const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })

// 协同服务端。dev 下 Vite 的 HMR 也走同一个 upgrade 事件，别把不认识的 socket 掐了
const collab = await attachCollabServer(server, { destroyUnmatchedUpgrades: !isDev })

const disposeFrontend = await attachFrontend(app, server)

// 过期会话和没用掉的授权请求：启动清一次，之后每小时清一次
const sweep = () => {
  void sweepExpired()
    .then(({ sessions, authRequests }) => {
      if (sessions || authRequests) {
        console.log(`[auth] 清理过期数据：会话 ${sessions} 条，授权请求 ${authRequests} 条`)
      }
    })
    .catch((err: unknown) => console.error('[auth] 清理过期数据失败', err))
}
sweep()
const sweepTimer = setInterval(sweep, 60 * 60 * 1000)
sweepTimer.unref()

server.listen(port, host, () => {
  const mode = isDev ? 'dev（Vite 中间件）' : `prod（静态资源 ${staticDir}）`
  console.log(`${mode} 服务已启动  http://${host}:${port}`)
  console.log(`Yjs websocket        ws://${host}:${port}${COLLAB_PATH}（房间名走消息）`)
  console.log(`登录                 ${authEnabled ? 'Keycloak（/login）' : '未启用'}`)
  console.log(
    `副本模式             ${clusterMode === 'redis' ? `多副本（Redis 共享，实例 ${instanceId}）` : '单副本（状态在进程内存）'}`,
  )
})

async function shutdown() {
  clearInterval(sweepTimer)

  // 退出前把还开着的房间落库：内容的事实源是内存里的 Y.Doc，直接退等于丢掉
  // 最后一个防抖窗口内的改动。不靠 flushPendingStores() —— 它触发的落库要过一段
  // 微任务链才入队，同步往下走会在入队前就采样到空队列（见 flushAllRoomsToDatabase）。
  // 断连 → 逐房间直接落库并 await → 再把审计等剩余写库排空
  try {
    collab.closeConnections()
    await flushAllRoomsToDatabase()
    await flushCollabWrites()
  } catch (err) {
    console.error('[collab] 退出前保存失败', err)
  }

  await disposeFrontend?.()
  await closeCluster().catch(() => undefined)
  await disconnectDb().catch(() => undefined)
  server.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
