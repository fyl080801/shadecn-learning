import { envNameOf, setting, type ConfigReader, type ConfigSchema, type ConfigSource } from '../config.ts'
import type { RuntimeInfo } from '../platform.ts'
import type { AnyServerModule } from './module.ts'

/**
 * 模块配置段的组装（docs/28 §3.3）：宿主把清单交进来，这里拼出 `modules.<name>` 那一整段 schema、
 * 再在读好配置之后逐个模块解析。
 *
 * 每个模块的段**自动带一项 `enabled`**：只能关、不能硬开 —— 关掉走内核的 `switchedOff`。
 */

/** 模块段里一项的完整路径：`moduleConfigPath('agent', 'sandbox.driver')` → `modules.agent.sandbox.driver` */
export function moduleConfigPath(name: string, path: string): string {
  return `modules.${name}.${path}`
}

/**
 * 模块段里一项对应的环境变量名（报错 / 提示文案用，别手写）：
 * `moduleEnvName('agent', 'sandbox.driver')` → `MODULES_AGENT_SANDBOX_DRIVER`
 */
export function moduleEnvName(name: string, path: string): string {
  return envNameOf(moduleConfigPath(name, path))
}

/** `modules` 段的 schema：每个模块一节（它自己的 schema + `enabled`） */
export function moduleConfigSchema(modules: readonly AnyServerModule[]): ConfigSchema {
  const schema: Record<string, ConfigSchema> = {}
  for (const module of modules) {
    const own = module.config?.schema ?? {}
    if (Object.hasOwn(own, 'enabled')) throw new Error(`[config] 模块 ${module.name} 的配置段不能自己声明 enabled（内核自动加）`)
    schema[module.name] = { enabled: setting('boolean', '关掉这个模块'), ...own }
  }
  return schema
}

export interface ModuleConfigs {
  /** 模块名 → 解析好的配置（没有配置段的模块 = undefined） */
  readonly values: ReadonlyMap<string, unknown>
  /** 配置里显式关掉的模块：模块名 → 原因（进启动日志和 `/api/features`） */
  readonly switchedOff: ReadonlyMap<string, string>
}

/** 逐个模块解析配置段、读开关。任何一个 `parse` 抛错就整体失败（配置错，进程不监听端口） */
export function parseModuleConfigs(
  modules: readonly AnyServerModule[],
  source: Pick<ConfigSource, 'get'>,
  runtime: RuntimeInfo,
): ModuleConfigs {
  const values = new Map<string, unknown>()
  const switchedOff = new Map<string, string>()
  for (const module of modules) {
    const enabledPath = moduleConfigPath(module.name, 'enabled')
    const flag = source.get(enabledPath)?.trim().toLowerCase()
    if (flag === 'false' || flag === '0' || flag === 'off' || flag === 'no') {
      switchedOff.set(module.name, `配置关闭（${enabledPath} / ${envNameOf(enabledPath)}）`)
    }
    if (module.config) {
      /** `parse` 里的路径相对本模块的段 */
      const read: ConfigReader = (path) => source.get(moduleConfigPath(module.name, path))
      values.set(module.name, module.config.parse(read, runtime))
    }
  }
  return { values, switchedOff }
}
