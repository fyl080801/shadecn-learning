import { afterEach, vi } from "vitest"
import { enableAutoUnmount } from "@vue/test-utils"

/** 每个用例结束自动卸载挂载过的组件，避免 watcher/定时器泄漏到下一个用例 */
enableAutoUnmount(afterEach)

/** 前端同样禁掉真实网络：要测 /api/* 就自己打桩 fetch */
globalThis.fetch = ((input: RequestInfo | URL) =>
  Promise.reject(
    new Error(
      `[test] 真实网络请求被拦截：${String(input)}\n请用 vi.stubGlobal('fetch', ...) 打桩`
    )
  )) as typeof fetch

/** jsdom 没有 matchMedia，@vueuse/core 的 useMediaQuery 需要它 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
