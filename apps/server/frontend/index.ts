import type { ServerType } from '@hono/node-server'
import type { HttpServer } from 'vite'
import type { ServerApp } from '../app.ts'
import { isDev } from '../config.ts'
import { attachStaticFrontend } from './static.ts'

/** 返回值是清理函数（dev 下用来关掉 Vite 的 watcher） */
export type DisposeFrontend = (() => Promise<void> | void) | undefined

/**
 * 前端由后端统一承载：
 * - dev  → Vite 中间件（HMR 走同一个端口）
 * - prod → dist 静态文件 + SPA fallback
 */
export async function attachFrontend(
  app: ServerApp,
  server: ServerType,
): Promise<DisposeFrontend> {
  if (!isDev) return attachStaticFrontend(app)

  // 只有 dev 才加载 vite，生产环境不需要把它拉进进程
  const { attachViteDevServer } = await import('./dev.ts')
  // ServerType 是 http/http2 的联合，Vite 只要 http.Server 这一支
  return attachViteDevServer(app, server as unknown as HttpServer)
}
