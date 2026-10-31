import type { HttpServer } from 'vite'
import { attachViteDevServer } from '../frontend/dev.ts'
import { defineModule } from '@shadecn/server-kit/kernel'
import type { ServerApp } from '../app.ts'

/**
 * 开发用的前端：Vite 以中间件形式挂到后端上，HMR 复用同一个端口（`frontend/dev.ts`）。
 *
 * **只有 `dev.ts` 入口可以 import 这个文件。** 生产入口 `index.ts` 用 `modules/frontend.ts`；
 * `scripts/build-server.mjs` 断言产物里既没有 `frontend/dev.ts` 也没有 `vite`。
 */
export const frontendDevModule = defineModule<ServerApp>({
  name: 'frontend',
  roles: ['web'],
  async setup(ctx) {
    // ServerType 是 http/http2 的联合，Vite 只要 http.Server 这一支
    const dispose = await attachViteDevServer(ctx.app, ctx.server as unknown as HttpServer)
    return {
      async shutdown() {
        await dispose?.()
      },
    }
  },
})
