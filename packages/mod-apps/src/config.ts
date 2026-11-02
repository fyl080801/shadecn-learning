import path from 'node:path'
import { setting, type ConfigPath } from '@shadecn/server-kit/config'
import { defineModuleConfig, moduleEnvName } from '@shadecn/server-kit/kernel'
import { loadCatalog, type Catalog } from './catalog.ts'
import { DRIVERS } from './drivers/index.ts'

/**
 * 应用执行模块的配置段：`modules.apps`（docs/29 §3.3）。
 *
 * - `MODULES_APPS_FILE`：应用表文件（YAML / JSON），默认 `<dataDir>/apps.yaml`；相对路径按应用根目录算。
 *   **文件不存在 = 没有应用**（模块关掉，原因进启动日志和 `/api/features`），不是错误；文件不合法 → 起不来；
 * - `MODULES_APPS_TIMEOUT_MS`：应用没写 `timeoutMs` 时一次执行的时限，默认 600000（10 分钟：视频 / 3D 任务常要几分钟）。
 *
 * 应用表在这里（`parse`）就读进来、解析好：配置坏了在 `prepare` 就失败，不等到第一个请求。
 * 表里的 `$ENV`（密钥）经平台的 `envVar` 读 —— 名字是写表的人定的，不在 schema 里。
 */
export interface AppsConfig {
  catalog: Catalog
  /** 解析时用的文件路径（日志用） */
  file: string
}

const DEFAULT_TIMEOUT_MS = 600_000

const schema = {
  file: setting('string', '应用表文件（docs/29 §3.3）'),
  timeoutMs: setting('number', '一次执行的默认时限（毫秒）'),
}

/** 模块名：配置段 `modules.apps`、`/api/features` 的键 */
export const APPS_MODULE = 'apps'

/** 这一项对应的环境变量名（报错 / 提示文案用，别手写） */
function appsEnv(path: ConfigPath<typeof schema>): string {
  return moduleEnvName(APPS_MODULE, path)
}

export const appsConfig = defineModuleConfig({
  schema,
  parse(read, runtime): AppsConfig {
    const fileSetting = read('file')?.trim()
    const file = fileSetting ? path.resolve(runtime.appRoot, fileSetting) : path.join(runtime.dataDir, 'apps.yaml')
    const timeoutRaw = read('timeoutMs')?.trim()
    const defaultTimeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) throw new Error(`${appsEnv('timeoutMs')} 必须是正整数：${timeoutRaw}`)
    const catalog = loadCatalog(file, {
      drivers: DRIVERS,
      env: { envVar: (name) => runtime.envVar(name), appRoot: runtime.appRoot },
      defaultTimeoutMs,
    })
    return { catalog, file }
  },
})
