import fs from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { ServerApp } from '../app.ts'
import { distDir, isApiPath } from '../config.ts'

/**
 * 生产模式：后端直接吐 `vite build` 的产物，路由未命中时回落到 index.html（SPA history 模式）。
 */
export function attachStaticFrontend(app: ServerApp) {
  const indexHtml = path.join(distDir, 'index.html')
  if (!fs.existsSync(indexHtml)) {
    console.warn(`[frontend] 没找到 ${indexHtml}，先跑 \`pnpm build\``)
  }

  // serveStatic 的 root 只认相对 cwd 的路径
  const root = path.relative(process.cwd(), distDir) || '.'
  app.use('*', serveStatic({ root }))

  app.get('*', async (c) => {
    if (isApiPath(c.req.path)) return c.notFound()
    const html = await fs.promises.readFile(indexHtml, 'utf8')
    return c.html(html)
  })

  return undefined
}
