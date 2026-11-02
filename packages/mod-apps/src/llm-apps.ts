import type { LlmModelDef, LlmProviderTable } from '@shadecn/server-kit/llm'
import { isRecord } from './driver.ts'

/**
 * 语言服务提供方自动成为 text 类应用（docs/29 §3.3）：配了 `llm.providers`，画布的文本节点就能选它生成，不用再抄一遍进 `modules.apps`。
 *
 * 这是**配置层的事**，在解析之前把原始数据补全（纯函数）：`models` 非空的每个提供方多一个提供方实例 `llm-<id>`（驱动 `llm`），
 * **每个模型一条应用**（id 随之是 `llm-<id>:<model>`）。之后走 `buildCatalog` 的全部校验和 `checkModel` 的不可用标记，执行层不知道它们是合成的。
 * 不吃图的模型只在同一提供方别的模型吃图时才要 `images: null`（驱动的 `images` 默认看「提供方任一模型吃图」，否则本来就不给这个参数）。
 */

/** 合成的提供方实例的 id 前缀 */
export const LLM_APP_PREFIX = 'llm-'
/** 提供方 id 最长 48，减去前缀 */
const MAX_SYNTHESIZED_ID = 48 - LLM_APP_PREFIX.length

const eatsImages = (model: LlmModelDef) => model.input?.includes('image') ?? false

/**
 * 把带模型的提供方合成进原始配置（不改入参），应用追加在 `apps` 末尾。提供方 id 撞车 → 抛（启动失败）：
 * 悄悄盖掉任何一边都是最难查的那种配置错误；应用撞车由 `buildCatalog` 的重复检查报。
 * `providers` / `apps` 本身形状不对的原样交回去，由 `buildCatalog` 报。
 */
export function withLlmProviderApps(data: Record<string, unknown>, table: LlmProviderTable, where: string): Record<string, unknown> {
  const entries = Object.entries(table).filter(([, def]) => def.models.length > 0)
  if (entries.length === 0) return data
  const configuredProviders = data.providers === undefined || data.providers === null ? {} : isRecord(data.providers) ? data.providers : null
  const configuredApps = data.apps === undefined || data.apps === null ? [] : Array.isArray(data.apps) ? (data.apps as unknown[]) : null
  if (!configuredProviders || !configuredApps) return data

  const providers: Record<string, unknown> = { ...configuredProviders }
  const apps: unknown[] = [...configuredApps]
  for (const [id, def] of entries) {
    if (id.length > MAX_SYNTHESIZED_ID) {
      throw new Error(`${where}：语言服务提供方 ${id} 的 id 太长，要成为 text 类应用最长 ${MAX_SYNTHESIZED_ID}`)
    }
    const providerId = `${LLM_APP_PREFIX}${id}`
    if (Object.hasOwn(providers, providerId)) throw new Error(`${where}.providers.${providerId} 和语言服务提供方 ${id} 自动生成的提供方撞名，换个 id`)
    providers[providerId] = { type: 'llm', provider: id }
    const anyImage = def.models.some(eatsImages)
    for (const model of def.models) {
      apps.push({
        provider: providerId,
        model: model.id,
        type: 'text',
        title: model.name ?? model.id,
        ...(anyImage && !eatsImages(model) ? { params: { images: null } } : {}),
      })
    }
  }
  return { ...data, providers, apps }
}
