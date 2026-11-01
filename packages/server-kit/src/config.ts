import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * 配置层（REQ-MODULES，docs/28 §3.3）：一份 JSON / YAML 配置文件 + 环境变量，按各段自己声明的 schema 校验。
 *
 * - **schema 归各自的主人**：底座的段（端口、数据库、共享层、日志、鉴权…）在宿主，每个能力的段在它的包（`@shadecn/mod-*\/config`）。
 *   schema 的每一项同时声明了文件里的路径和**对应的环境变量名**：环境变量是同一个配置项的另一种写法，不是另一套配置。
 * - **优先级**：环境变量（真实环境，以及宿主读进 `process.env` 的 `.env`）> 环境分层文件 > 基础文件 > 宿主代码里的默认值。
 *   设了环境变量就以它为准，**空串也算设了**（`DATABASE_URL=` 在命令行上临时盖掉文件里的值，回到默认）。
 * - 文件里出现 schema 没有的项、或者类型不对 → 直接抛（进程不监听端口）。拼错的键悄悄不生效是最难查的那种配置错误。
 *
 * 这里只做「读文件 + 校验 + 合层」，取出来的是**原样的字符串**（和环境变量同形），默认值和语义解析仍在宿主的配置模块里：
 * 同一项从文件来还是从环境变量来，走的是同一条解析路径，行为不会分叉。
 *
 * 这个文件不读 `process.env`：环境变量表由调用方传进来。
 */

/** 配置项的取值类型。文件里按这个类型校验；环境变量永远是字符串 */
export type SettingType = 'string' | 'number' | 'boolean' | 'list' | 'map'

export interface Setting {
  readonly kind: 'setting'
  /** 对应的环境变量名 */
  readonly env: string
  readonly type: SettingType
  /** 一句话说明（报错时带上） */
  readonly description?: string
}

/** 一棵配置 schema：叶子是 {@link Setting}，中间是分组 */
export interface ConfigSchema {
  readonly [key: string]: Setting | ConfigSchema
}

/**
 * 声明一个配置项。
 *
 * - `list`：文件里写数组（或逗号分隔的字符串），取出来是逗号连接的字符串 —— 和环境变量 `a,b,c` 同形；
 * - `map`：文件里写对象（值是字符串 / 数字 / 布尔），取出来是 `k=v,k2=v2`；
 * - `boolean` 取出来是 `true` / `false`，`number` 是十进制字符串。
 */
export function setting(env: string, type: SettingType, description?: string): Setting {
  return { kind: 'setting', env, type, ...(description ? { description } : {}) }
}

function isSetting(node: Setting | ConfigSchema): node is Setting {
  return (node as Setting).kind === 'setting'
}

// ---------------------------------------------------------------- 读文件

/** 支持的扩展名，按这个顺序找；同一层同时有两个算配置错误 */
export const CONFIG_EXTENSIONS = ['.yaml', '.yml', '.json'] as const

export interface ConfigFiles {
  /** 读到的文件（绝对路径），按合并顺序 */
  readonly files: readonly string[]
  /** 合并后的内容 */
  readonly data: Record<string, unknown>
}

export interface FindConfigOptions {
  /** 找文件的目录（应用根目录），相对路径也按它算 */
  readonly dir: string
  /** 文件名主干，默认 `server.config` */
  readonly basename?: string
  /** 环境名（`production` / `development` / `test`…）：在基础文件之上再叠 `<basename>.<环境名>.<ext>` */
  readonly mode: string
  /**
   * 显式指定的文件（宿主从 `SERVER_CONFIG` 拿）：逗号分隔，按顺序合并，后面的盖前面的；**给了就不再自动找**。
   * `undefined` = 没指定（自动找）；空串 = 明确不用配置文件（测试就这么配，免得开发者自己的文件漏进来）。
   * 指定了却不存在 → 抛：说要用某个文件却没读到，比静默回落到默认值好查。
   */
  readonly explicit?: string
}

/** 找到并读入配置文件，深合并（对象逐键合并，数组和标量整个替换） */
export function readConfigFiles(options: FindConfigOptions): ConfigFiles {
  const files = locateConfigFiles(options)
  let data: Record<string, unknown> = {}
  for (const file of files) data = deepMerge(data, parseConfigFile(file))
  return { files, data }
}

function locateConfigFiles({ dir, basename = 'server.config', mode, explicit }: FindConfigOptions): string[] {
  if (explicit !== undefined) {
    return explicit
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const file = path.isAbsolute(item) ? item : path.join(dir, item)
        if (!existsSync(file)) throw new Error(`[config] 指定的配置文件不存在：${file}`)
        return file
      })
  }
  const layer = (stem: string) => {
    const found = CONFIG_EXTENSIONS.map((ext) => path.join(dir, stem + ext)).filter((file) => existsSync(file))
    if (found.length > 1) {
      throw new Error(`[config] 同一层有多个配置文件，只能留一个：${found.map((file) => path.basename(file)).join('、')}`)
    }
    return found
  }
  return [...layer(basename), ...(mode ? layer(`${basename}.${mode}`) : [])]
}

/** 按扩展名解析一个文件。JSON 用 `JSON.parse`（严格）；YAML 用 `yaml`。顶层必须是对象，空文件当空对象 */
export function parseConfigFile(file: string): Record<string, unknown> {
  const text = readFileSync(file, 'utf8')
  let value: unknown
  try {
    value = path.extname(file).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text)
  } catch (err) {
    throw new Error(`[config] ${file} 解析失败：${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  if (value === null || value === undefined) return {}
  if (!isPlainObject(value)) throw new Error(`[config] ${file} 的顶层必须是对象`)
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key]
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value
  }
  return out
}

// ---------------------------------------------------------------- 校验 + 合层

/** 一个配置项的值从哪来 */
export type SettingOrigin = 'env' | 'file' | 'default'

export interface ConfigSource {
  /** 读到的配置文件（启动日志用） */
  readonly files: readonly string[]
  /**
   * 按环境变量名取值：设了环境变量取它（空串也算），否则取文件里的值（已转成和环境变量同形的字符串），都没有 = `undefined`。
   * 名字不在 schema 里 → 抛：配置模块里读一个没声明的名字，等于这一项在文件里永远配不了。
   */
  get(env: string): string | undefined
  /** 这一项的值从哪来 */
  origin(env: string): SettingOrigin
}

/**
 * 按 schema 校验文件内容，再和环境变量合成一个 {@link ConfigSource}。
 * 文件里的问题一次全报出来（每条带路径），而不是改一个报一个。
 */
export function resolveConfig(
  schema: ConfigSchema,
  files: ConfigFiles,
  env: Readonly<Record<string, string | undefined>>,
  options: {
    /**
     * 先不校验的顶层段（原样放过）：底座在 import 时只认得自己的段，`modules` 要等模块清单交进来才知道长什么样 ——
     * 那时再用完整的 schema 解析一遍（`@shadecn/server-core` 的 `prepare`）
     */
    deferred?: readonly string[]
  } = {},
): ConfigSource {
  const declared = new Map<string, string>()
  collectEnvNames(schema, [], declared)

  const fromFile = new Map<string, string>()
  const problems: string[] = []
  const deferred = new Set(options.deferred ?? [])
  const data = isPlainObject(files.data)
    ? Object.fromEntries(Object.entries(files.data).filter(([key]) => !deferred.has(key)))
    : files.data
  walk(schema, data, [], fromFile, problems)
  if (problems.length > 0) {
    const where = files.files.length ? `（${files.files.join(' + ')}）` : ''
    throw new Error(`[config] 配置文件有误${where}：\n  - ${problems.join('\n  - ')}`)
  }

  const assertDeclared = (name: string) => {
    if (!declared.has(name)) throw new Error(`[config] ${name} 不在配置 schema 里（先在对应的段里声明它）`)
  }
  return {
    files: files.files,
    get(name) {
      assertDeclared(name)
      return env[name] !== undefined ? env[name] : fromFile.get(name)
    },
    origin(name) {
      assertDeclared(name)
      return env[name] !== undefined ? 'env' : fromFile.has(name) ? 'file' : 'default'
    },
  }
}

/** 环境变量名在整棵 schema 里必须唯一：两项共用一个变量名，文件里配了其中一项就会悄悄改到另一项 */
function collectEnvNames(schema: ConfigSchema, at: string[], into: Map<string, string>) {
  for (const [key, node] of Object.entries(schema)) {
    const here = [...at, key]
    if (isSetting(node)) {
      const prev = into.get(node.env)
      if (prev) throw new Error(`[config] schema 里 ${prev} 和 ${here.join('.')} 用了同一个环境变量 ${node.env}`)
      into.set(node.env, here.join('.'))
    } else {
      collectEnvNames(node, here, into)
    }
  }
}

function walk(schema: ConfigSchema, data: unknown, at: string[], out: Map<string, string>, problems: string[]) {
  if (data === undefined || data === null) return
  const where = at.join('.') || '（顶层）'
  if (!isPlainObject(data)) {
    problems.push(`${where} 应该是对象`)
    return
  }
  for (const [key, value] of Object.entries(data)) {
    const node = Object.hasOwn(schema, key) ? schema[key] : undefined
    const here = [...at, key]
    if (!node) {
      problems.push(`${here.join('.')} 不是认得的配置项（${where} 下可配：${Object.keys(schema).join(' / ')}）`)
      continue
    }
    if (isSetting(node)) {
      // null = 写了键没写值，当没配（YAML 里 `apiKey:` 就是 null）
      if (value === null) continue
      const text = toSettingString(node, value)
      if (text === null) problems.push(`${here.join('.')} 应该是 ${describeType(node.type)}（对应环境变量 ${node.env}）`)
      else out.set(node.env, text)
    } else {
      walk(node, value, here, out, problems)
    }
  }
}

function describeType(type: SettingType): string {
  switch (type) {
    case 'string':
      return '字符串'
    case 'number':
      return '数字'
    case 'boolean':
      return 'true / false'
    case 'list':
      return '字符串数组（或逗号分隔的字符串）'
    case 'map':
      return '键值对象（值是字符串 / 数字 / 布尔）'
  }
}

/** 文件里的值 → 和环境变量同形的字符串；类型不对 = null */
function toSettingString(node: Setting, value: unknown): string | null {
  const scalar = (item: unknown) =>
    typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)) || typeof item === 'boolean'
  switch (node.type) {
    case 'string':
      // 数字也收：YAML 里 `region: 1` / `apiKey: 123` 这种不加引号的写法太常见
      return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : null
    case 'list':
      if (typeof value === 'string') return value
      return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.join(',') : null
    case 'map':
      if (!isPlainObject(value) || !Object.values(value).every(scalar)) return null
      return Object.entries(value)
        .map(([key, item]) => `${key}=${String(item)}`)
        .join(',')
  }
}
