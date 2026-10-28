/**
 * 本地 `pnpm start`（在仓库根直接跑 output/server/index.js）专用：给裸包名的解析加一层兜底。
 *
 * 为什么需要：产物是 ESM，`import 'hono'` 只会从**产物文件所在位置**往上找 node_modules
 * （output/server → output → 仓库根），cwd、NODE_PATH 都不管用。单包时代运行时依赖声明在
 * 仓库根，根 node_modules 里就有；改成 pnpm workspace 之后它们只链接在 apps/server/node_modules
 * 下，根目录找不到，产物一启动就 ERR_MODULE_NOT_FOUND。
 *
 * 做法：在主解析失败时，**以 apps/server/package.json 为起点重试一次** —— 也就是「后端包声明了
 * 什么，产物就能用什么」，依赖清单的唯一来源仍是 apps/server/package.json，不用在根目录再抄一份。
 *
 * 只给本地用：容器 / `docker build ./output` 里产物旁边有自己 `npm install` 出来的 node_modules，
 * 第一次解析就成功，根本走不到这里，也不会加载这个文件。
 */
import { register } from 'node:module'

register('./local-start-hooks.mjs', import.meta.url)
