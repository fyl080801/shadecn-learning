import { attachStaticFrontend } from '../frontend/static.ts'
import { defineModule } from '../kernel/module.ts'

/**
 * 静态前端（生产）：后端直接吐 `vite build` 的产物 + SPA fallback（`frontend/static.ts`）。
 *
 * 开发时换成 `modules/frontend-dev.ts`（Vite 中间件），**只有 `dev.ts` 入口引用它** ——
 * 生产入口 `index.ts` 一行都不碰 Vite，构建脚本据此断言产物里没有它（docs/28 §3.8）。
 *
 * 装配必须排在所有 `/api` 路由之后（catch-all），`app.ts` 静态挂的路由在它之前，内核再按顺序 setup 模块。
 */
export const frontendModule = defineModule({
  name: 'frontend',
  roles: ['web'],
  setup(ctx) {
    attachStaticFrontend(ctx.app)
  },
})
