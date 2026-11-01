import type { AnyProviderDriver } from '../driver.ts'
import { arkDriver } from './ark.ts'
import { comfyuiDriver } from './comfyui.ts'
import { createLlmDriver } from './llm.ts'

/**
 * 驱动注册表（docs/29 §3.2）：应用表里 `providers.<id>.type` 认的就是这里的 `type`。
 * **接一种新的对接服务 = 在 `drivers/` 下加一个文件 + 这里加一行**；执行层、路由、参数校验、应用表解析都不用动。
 */
export const DRIVERS: readonly AnyProviderDriver[] = [
  arkDriver,
  comfyuiDriver,
  createLlmDriver({ type: 'ollama', description: 'ollama 的语言模型（同画布 agent 的 ollama 预设）', provider: 'ollama' }),
]
