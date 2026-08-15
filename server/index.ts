import { createAdaptorServer } from '@hono/node-server'
import { app } from './app.ts'
import { attachCollabServer, COLLAB_PATH } from './collab/index.ts'
import { host, isDev, port } from './config.ts'
import { attachFrontend } from './frontend/index.ts'

// 先建 server 但先不 listen：Vite 中间件要拿这个 server 挂 HMR 的 upgrade。
// overrideGlobalObjects: false —— 默认会把 global.Response 换成带缓存的实现，
// 那条快路径不认 RESPONSE_ALREADY_SENT 这个标记，前端中间件自己写完响应后会被重复 writeHead。
const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })

// dev 下 Vite 的 HMR 也走同一个 upgrade 事件，别把不认识的 socket 掐了
attachCollabServer(server, { destroyUnmatchedUpgrades: !isDev })

const disposeFrontend = await attachFrontend(app, server)

server.listen(port, host, () => {
  const mode = isDev ? 'dev（Vite 中间件）' : 'prod（dist 静态资源）'
  console.log(`${mode} 服务已启动  http://${host}:${port}`)
  console.log(`Yjs websocket        ws://${host}:${port}${COLLAB_PATH}/<room>`)
})

async function shutdown() {
  await disposeFrontend?.()
  server.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
