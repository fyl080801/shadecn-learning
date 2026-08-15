import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 运行形态：源码（tsx / vitest）还是构建产物（output/server/index.js）。
 *
 * `__APP_BUNDLE__` 由 scripts/build-server.mjs 用 esbuild 的 define 注入，
 * 源码运行时这个全局压根不存在，所以要用 typeof 兜一层。
 */
declare const __APP_BUNDLE__: boolean
export const isBundle = typeof __APP_BUNDLE__ !== 'undefined' && __APP_BUNDLE__

/** 当前模块所在目录：源码是 server/，构建产物是 output/server/ */
export const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * 应用根目录 —— .env、data/ 这些「运行时的东西」都以它为准。
 *
 * - 源码运行：server/ 的上一级，也就是仓库根目录；
 * - 构建产物：进程 cwd（本地是仓库根，容器里是 /app）。产物自己躺在 output/ 下，
 *   拿 output/ 当根会让 data/ 和 prisma CLI（在应用根目录跑迁移）对不上。
 */
export const appRoot = isBundle ? process.cwd() : path.resolve(moduleDir, '..')
