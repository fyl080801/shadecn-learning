import { afterEach, vi } from 'vitest'

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
