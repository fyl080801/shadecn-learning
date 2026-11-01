import { createServer } from 'node:http'
import { afterEach, vi } from 'vitest'
import { app } from '@shadecn/server-core/app'
import { assemble, prepare } from '@shadecn/server-core/server'
import { modules } from '../modules.ts'

/*
 * 装配整个平台（和生产同一套：同一份模块清单、配置段、入口声明），只是不 listen —— 用例直接 `app.request(...)`。
 * 测试进程扮演全部角色（单进程形态）：登录、画布、存储、协同、agent、笔记都 setup 过，模块的路由都挂上了；
 * 它同时也是 agent 副本：`POST …/agent/messages` 经总线派发，本进程登记了处理函数就交给本进程（docs/28 §3.6）。
 * 每个测试文件一份模块图、一个总线，所以每个文件装配一次。
 */
await prepare(modules)
await assemble({ app, server: createServer() })

/**
 * 测试必须是密闭的：不允许任何一条真实网络请求跑出去。
 * 谁要用 fetch（OIDC discovery / token / JWKS），自己 vi.stubGlobal('fetch', ...)。
 */
const forbiddenFetch: typeof fetch = (input) => {
  const url = typeof input === 'string' ? input : String(input)
  return Promise.reject(
    new Error(`[test] 真实网络请求被拦截：${url}\n请用 vi.stubGlobal('fetch', ...) 打桩`),
  )
}

globalThis.fetch = forbiddenFetch

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  // 会把 fetch 还原成上面那个 forbiddenFetch（stubGlobal 记的是打桩前的值）
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
