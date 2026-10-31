import { afterEach, beforeAll, vi } from 'vitest'
import { handleRunDispatch } from '@shadecn/mod-agent/dispatch'
// 装配协同模块的端口（画布表存取、会话鉴权）：不起服务端也能直接调协同的落库 / REST 写入
import '../modules/collab.ts'
// 装配 agent 模块的端口（配置、落库、成员判定），顺带校验 agent 定义和模型表
import '../modules/agent.ts'

/*
 * 测试进程同时也是 agent 副本（和单进程全角色的生产形态一样）：`POST …/agent/messages` 经总线派发，
 * 本进程登记了处理函数就交给本进程，事件经派发日志（内存实现）回到路由（docs/28 §3.6）。
 * 每个测试文件一份模块图、一个总线，所以每个文件登记一次
 */
beforeAll(async () => {
  await handleRunDispatch()
})

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
