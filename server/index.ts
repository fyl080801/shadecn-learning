import './env.ts'
import { createAdaptorServer } from '@hono/node-server'
import { app } from './app.ts'
import { authorizeUpgrade } from './auth/ws.ts'
import { sweepExpired } from './auth/session.ts'
import { attachCollabServer, COLLAB_PATH } from './collab/index.ts'
import { assertAuthConfig, authEnabled, host, isDev, port, staticDir } from './config.ts'
import { disconnectDb } from './db.ts'
import { attachFrontend } from './frontend/index.ts'

assertAuthConfig()

// 先建 server 但先不 listen：Vite 中间件要拿这个 server 挂 HMR 的 upgrade。
// overrideGlobalObjects: false —— 默认会把 global.Response 换成带缓存的实现，
// 那条快路径不认 RESPONSE_ALREADY_SENT 这个标记，前端中间件自己写完响应后会被重复 writeHead。
const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })

// dev 下 Vite 的 HMR 也走同一个 upgrade 事件，别把不认识的 socket 掐了
attachCollabServer(server, {
  destroyUnmatchedUpgrades: !isDev,
  authorize: authorizeUpgrade,
})

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
  console.log(`Yjs websocket        ws://${host}:${port}${COLLAB_PATH}/<room>`)
  console.log(`登录                 ${authEnabled ? 'Keycloak（/login）' : '未启用'}`)
})

async function shutdown() {
  clearInterval(sweepTimer)
  await disposeFrontend?.()
  await disconnectDb().catch(() => undefined)
  server.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
