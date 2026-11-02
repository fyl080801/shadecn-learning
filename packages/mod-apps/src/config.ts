import { setting, type ConfigPath } from '@shadecn/server-kit/config'
import { defineModuleConfig, moduleEnvName } from '@shadecn/server-kit/kernel'
import { APPS_CONFIG_PATH, catalogFromConfig, type Catalog } from './catalog.ts'
import { DRIVERS } from './drivers/index.ts'

/**
 * 应用执行模块的配置段：`modules.apps`（docs/29 §3.3），和别的配置在同一个 `server.config` 里。
 *
 * - `providers`（`MODULES_APPS_PROVIDERS`）：对接服务的实例，提供方 id → 配置；
 * - `apps`（`MODULES_APPS_APPS`）：应用的平铺数组，每项一个 provider + 一个 model；
 * - `timeoutMs`（`MODULES_APPS_TIMEOUT_MS`）：条目没写 `timeoutMs` 时一次执行的时限，默认 600000（10 分钟：视频 / 3D 任务常要几分钟）。
 *
 * `providers` / `apps` 是 `setting('json')` 叶子（同 `llm.providers`）：文件里写结构，环境变量是同形的 JSON，设了就整段盖掉文件里的。
 * JSON 不合法、形状不对 = 起不来；一个应用都没有（`llm.providers` 里也没有带模型的提供方）= 模块关掉，原因进启动日志和 `/api/features`。
 *
 * 在这里（`parse`）就解析好：配置坏了在 `prepare` 就失败，不等到第一个请求。
 * 里面的 `$ENV`（密钥）经平台的 `envVar` 读 —— 名字是写配置的人定的，不在 schema 里。
 */
export interface AppsConfig {
  catalog: Catalog
}

const DEFAULT_TIMEOUT_MS = 600_000

const schema = {
  timeoutMs: setting('number', '一次执行的默认时限（毫秒）'),
  providers: setting('json', '提供方 id → { type, ... }（docs/29 §3.3）'),
  apps: setting('json', '应用数组：[{ provider, type, model, ... }]（docs/29 §3.3）'),
}

/** 模块名：配置段 `modules.apps`、`/api/features` 的键 */
export const APPS_MODULE = 'apps'

/** 这一项对应的环境变量名（报错 / 提示文案用，别手写） */
function appsEnv(path: ConfigPath<typeof schema>): string {
  return moduleEnvName(APPS_MODULE, path)
}

/** 不带 cause：JSON.parse 的报错会回显一段原文，里面可能有密钥 */
function fail(message: string): never {
  throw new Error(`[config] ${message}`)
}

function parseJsonSetting(text: string | undefined, key: 'providers' | 'apps'): unknown {
  if (!text?.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    fail(`${APPS_CONFIG_PATH}.${key}（环境变量 ${appsEnv(key)}）不是合法的 JSON`)
  }
}

export const appsConfig = defineModuleConfig({
  schema,
  parse(read, runtime): AppsConfig {
    const timeoutRaw = read('timeoutMs')?.trim()
    const defaultTimeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) throw new Error(`${appsEnv('timeoutMs')} 必须是正整数：${timeoutRaw}`)
    const catalog = catalogFromConfig(
      { providers: parseJsonSetting(read('providers'), 'providers'), apps: parseJsonSetting(read('apps'), 'apps') },
      {
        drivers: DRIVERS,
        env: { envVar: (name) => runtime.envVar(name), appRoot: runtime.appRoot, llmProviders: runtime.llmProviders },
        defaultTimeoutMs,
      },
    )
    return { catalog }
  },
})
