import './env.ts'
// 必须排在这个位置（.env 之后、其余一切之前）：它接管 console，之后仓库里既有的
// `console.log('[模块] …')` 就自动变成结构化日志。装晚了会漏掉启动阶段那些行，
// 而写成副作用 import 而不是函数调用的理由见该文件
import './logger/install.ts'
import { boot } from './boot.ts'
import { agentModule } from './modules/agent.ts'
import { collabModule } from './modules/collab.ts'
import { frontendModule } from './modules/frontend.ts'
import { storageModule } from './modules/storage.ts'

/**
 * 生产入口（`pnpm start` 跑它的打包产物）。
 *
 * **这里一行都不能引用 `frontend/dev.ts` / `modules/frontend-dev.ts`**，静态还是动态都不行：
 * 开发用的 Vite 中间件只存在于 `dev.ts` 入口，`scripts/build-server.mjs` 断言产物里没有它（docs/28 §3.8）。
 * 模块表的顺序不重要 —— 内核按依赖排序（`kernel/resolve.ts`）。
 */
await boot({ modules: [storageModule, collabModule, agentModule, frontendModule] })
