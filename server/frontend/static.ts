import fs from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { ServerApp } from '../app.ts'
import { isApiPath, staticDir } from '../config.ts'
import { LOGIN_PATH } from './guard.ts'

/**
 * 生产模式：后端直接吐静态资源目录（`vite build` 的产物，默认 output/public），
 * 路由未命中时回落到 HTML 入口。
 *
 * **入口有两个**（见 vite.config.ts 的 MPA 配置）：`/login` 落到 `login.html`，
 * 其余一律 `index.html`（SPA history 模式）。
 */
export function attachStaticFrontend(app: ServerApp) {
  const indexHtml = path.join(staticDir, 'index.html')
  const loginHtml = path.join(staticDir, 'login.html')
  for (const entry of [indexHtml, loginHtml]) {
    if (!fs.existsSync(entry)) console.warn(`[frontend] 没找到 ${entry}，先跑 \`pnpm build\``)
  }

  // serveStatic 的 root 只认相对 cwd 的路径
  const root = path.relative(process.cwd(), staticDir) || '.'
  app.use('*', serveStatic({ root }))

  app.get('*', async (c) => {
    if (isApiPath(c.req.path)) return c.notFound()
    const entry = c.req.path === LOGIN_PATH ? loginHtml : indexHtml
    const html = await fs.promises.readFile(entry, 'utf8')
    // 登录页带着 ?error= / ?redirect= 渲染，别让它被缓存住
    return c.html(html, 200, { 'cache-control': 'no-store' })
  })

  return undefined
}
