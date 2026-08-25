import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import type { HttpServer, ViteDevServer } from 'vite'
import { createServer as createViteServer } from 'vite'
import type { ServerApp } from '../app.ts'
import { isApiPath, rootDir } from '../config.ts'
import { LOGIN_PATH } from './guard.ts'

/** 请求 URL 只取路径部分（`/login?redirect=/x` → `/login`） */
function pathnameOf(url: string | undefined) {
  return (url ?? '/').split('?')[0]
}

/**
 * 开发模式：把 Vite 以中间件形式挂到后端上，前后端同一个端口（默认 3000）。
 *
 * - `appType: 'custom'`：Vite 不自己接管 HTML，SPA fallback 由下面的 sendIndexHtml 做，
 *   这样 /api/* 才能优先走 Hono。
 * - `hmr.server`：HMR 的 WebSocket 复用后端这个 http server（协议头 vite-hmr 的 upgrade
 *   由 Vite 自己的监听器接走），不另开 24678 端口，也不需要 Vite proxy。
 */
export async function attachViteDevServer(app: ServerApp, server: HttpServer) {
  const vite = await createViteServer({
    root: rootDir,
    appType: 'custom',
    server: {
      middlewareMode: true,
      hmr: { server },
    },
  })

  app.use('*', async (c, next) => {
    if (isApiPath(c.req.path)) return next()

    const { incoming, outgoing } = c.env
    try {
      await runViteMiddlewares(vite, incoming, outgoing)
    } catch (err) {
      // 响应已经开了头就没法再交给 Hono 的 onError 了，只能就地收尾
      if (!outgoing.headersSent) throw err
      console.error('[vite]', err)
      outgoing.end()
    }
    return RESPONSE_ALREADY_SENT
  })

  return () => vite.close()
}

/** connect 风格的中间件链 → Promise：中间件自己响应了就结束，没响应就走 SPA fallback */
function runViteMiddlewares(
  vite: ViteDevServer,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
) {
  return new Promise<void>((resolve, reject) => {
    const done = () => resolve()
    outgoing.once('finish', done)
    outgoing.once('close', done)

    vite.middlewares(incoming, outgoing, (err?: unknown) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      sendIndexHtml(vite, incoming, outgoing).then(resolve, reject)
    })
  })
}

async function sendIndexHtml(
  vite: ViteDevServer,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
) {
  if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
    outgoing.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    outgoing.end(JSON.stringify({ error: 'Not Found', path: incoming.url }))
    return
  }

  // 两个入口：`/login` 是它自己那一份 HTML，其余走 SPA fallback。
  // 只认精确路径 —— `/login` 底下没有子路由，`/loginXxx` 更不该命中
  const entry = pathnameOf(incoming.url) === LOGIN_PATH ? 'login.html' : 'index.html'
  const raw = await fs.readFile(path.join(rootDir, entry), 'utf8')
  const html = await vite.transformIndexHtml(incoming.url ?? '/', raw)
  outgoing.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  outgoing.end(incoming.method === 'HEAD' ? undefined : html)
}
