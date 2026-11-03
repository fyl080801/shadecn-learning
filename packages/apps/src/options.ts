import type { ConfigService } from '@learning/config'
import { APPS_CONFIG_PATH, type Catalog, catalogFromConfig } from './catalog.js'
import { DRIVERS } from './drivers/index.js'
import { parseLlmProviders } from '@learning/llm/llm-config'

export const APPS_CATALOG = Symbol('APPS_CATALOG')

const DEFAULT_TIMEOUT_MS = 600_000
const KNOWN_FIELDS = ['timeoutMs', 'providers', 'apps']

/**
 * config.yaml 的 `apps` 段（docs/29 §3.3、docs/30 §8）和 `llm.providers`。校验和默认值都在这里（`@learning/config` 只管文件）。
 *
 * - **形状不对拒绝启动**，报错不回显值：不认识的字段、明文密钥（`apiKey` 只认 `"$环境变量名"`）、引用不存在的提供方……
 * - **配置对但现在用不了**（`$ENV` 没设、模型解析不了）只标这个应用不可用；
 * - **一个应用都没有**：模块照样加载，`GET /api/apps` 回空数组，别的功能不受影响。
 *
 * `$ENV` 经 `ConfigService.env` 读（运行目录的 `.env` 合上进程环境变量），驱动不碰 `process.env`。
 */
export function resolveAppsCatalog(config: ConfigService): Catalog {
  const section = config.mapping('apps')
  const unknown = Object.keys(section).filter((field) => !KNOWN_FIELDS.includes(field))
  if (unknown.length > 0) throw new Error(`[apps] ${APPS_CONFIG_PATH}：不认识的字段 ${unknown.join('、')}（只认 ${KNOWN_FIELDS.join(' / ')}）`)
  const timeoutMs = section.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`[apps] ${APPS_CONFIG_PATH}.timeoutMs 必须是正整数`)

  return catalogFromConfig(
    { providers: section.providers, apps: section.apps },
    {
      drivers: DRIVERS,
      env: {
        envVar: (name) => config.env(name),
        appRoot: config.rootDir,
        llmProviders: parseLlmProviders(config.mapping('llm').providers),
      },
      defaultTimeoutMs: timeoutMs,
    },
  )
}
