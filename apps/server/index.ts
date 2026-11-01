import '@shadecn/server-core/env'
// 必须排在这个位置（.env 之后、其余一切之前）：它接管 console，之后仓库里既有的
// `console.log('[模块] …')` 就自动变成结构化日志。装晚了会漏掉启动阶段那些行
import '@shadecn/server-core/logger/install'
import { boot } from '@shadecn/server-core/boot'
import { attachStaticFrontend } from '@shadecn/server-core/frontend/static'
import { modules } from './modules.ts'

/**
 * 生产入口（`pnpm start` 跑它的打包产物）：底座 + 这个产物的模块清单 + 静态前端。
 *
 * **这里一行都不能引用 `@shadecn/server-core/frontend/dev`**，静态还是动态都不行：
 * 开发用的 Vite 中间件只存在于 `dev.ts` 入口，`scripts/build-server.mjs` 断言产物里没有它（docs/28 §3.8）。
 */
await boot({ modules, frontend: (app) => attachStaticFrontend(app) })
