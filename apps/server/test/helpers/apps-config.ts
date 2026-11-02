import { vi } from 'vitest'

/**
 * 集成测试用的应用（docs/29 §3.3）：全局的 test.env 里没有应用（模块不加载），要测应用接口的用例调 {@link stubAppsConfig}，
 * **之后再重建 app**（`importFreshApp()`）。上游请求都被测试里的 fetch 截住，不会真的发出去。
 */
export const CHAT_APP = 'local-llm:qwen3'
export const IMAGE_APP = 'ark:doubao-seedream-5-0-pro-260628'
export const VIDEO_APP = 'ark:doubao-seedance-2-0-260128'

const PROVIDERS = {
  'local-llm': { type: 'ollama' },
  ark: { type: 'ark', apiKey: '$TEST_APPS_ARK_KEY', pollIntervalMs: 20 },
}

const APPS = [
  { provider: 'local-llm', type: 'text', model: 'qwen3', title: '测试对话' },
  { provider: 'ark', type: 'image', model: 'doubao-seedream-5-0-pro-260628', title: '测试文生图' },
  { provider: 'ark', type: 'video', model: 'doubao-seedance-2-0-260128', title: '测试视频' },
]

export function stubAppsConfig(): void {
  vi.stubEnv('MODULES_APPS_PROVIDERS', JSON.stringify(PROVIDERS))
  vi.stubEnv('MODULES_APPS_APPS', JSON.stringify(APPS))
}
