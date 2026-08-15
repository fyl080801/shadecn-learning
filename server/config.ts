import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（server/ 的上一级）：Vite 的 root、index.html、dist 都以它为准 */
export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 生产构建产物目录 */
export const distDir = path.join(rootDir, 'dist')

/** 没显式设 NODE_ENV=production 就按开发处理（开发时由后端挂 Vite 中间件） */
export const isDev = (process.env.NODE_ENV ?? 'development') !== 'production'

export const port = Number(process.env.PORT ?? 3000)
export const host = process.env.HOST ?? '127.0.0.1'

/** /api 与 /api/* —— 这部分永远由 Hono 处理，不交给前端 */
export function isApiPath(pathname: string) {
  return pathname === '/api' || pathname.startsWith('/api/')
}
