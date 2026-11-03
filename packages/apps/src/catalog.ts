import { APP_CATEGORIES, type AppInfo, type ParamSchema } from './contract.js'
import { Fields, isRecord, type AnyProviderDriver, type DriverEnv, type PreparedApp } from './driver.js'
import { withLlmProviderApps } from './llm-apps.js'
import { applyParamPatch, assertDefaults, assertParamSchema, publicParams, readParamPatch } from './params.js'

/**
 * 应用表（docs/29 §3.3）。写在 config.yaml 的 `apps` 段（`options.ts` 读），和语言服务一个形状：
 *
 * ```yaml
 * apps:
 *   providers:          # 对接服务的实例：同一种驱动可以有多个实例（两套 ComfyUI、两个方舟账号）
 *     ark:   { type: ark, apiKey: $ARK_API_KEY }
 *     comfy: { type: comfyui, baseUrl: http://127.0.0.1:8188 }
 *   apps:               # 平铺的数组，每项 = 一个提供方 + 一个模型；type 是类别，也就是驱动的操作
 *     - provider: ark
 *       model: doubao-seedream-5-0-pro-260628
 *       type: image
 *       title: Seedream 5.0 pro
 *       defaults: { size: 2K }
 *       params: { image: { maxLength: 10 }, maxImages: null }   # 这个模型和驱动基础表的差异（null = 没有这个参数）
 *     - { provider: comfy, id: sdxl, type: image, options: { workflow: data/comfy/sdxl.json, inputs: { … } } }   # 模型在工作流里的操作写 id
 * ```
 *
 * 应用 id 自动生成：`<provider>:<model>`，不要模型的操作是 `<provider>:<id>`。
 * 模型的参数差异是**配置**，不在驱动代码里：参数表 = 驱动的基础表 → 条目的 `params`。
 *
 * 两类错误分开（同 agent 模型表）：**形状不对 → 启动失败**（不认识的字段、类型、引用了不存在的提供方 / 操作、明文密钥、重复的应用）；
 * **配置对但现在用不了**（缺环境变量、模型解析不了）→ 应用标成不可用，启动打警告，执行回 `unavailable`。
 */

/** 配置段的位置：报错都从这里说起 */
export const APPS_CONFIG_PATH = 'apps'

/** 提供方的 id、不要模型的操作写的 `id`：小写字母开头，小写字母、数字、`-`（没有 `:`，所以应用 id 拆得开） */
const ID_REGEX = /^[a-z][a-z0-9-]{0,47}$/
const ID_RULE = '小写字母开头，只能有小写字母、数字、-，最长 48'

export interface CatalogEntry {
  info: AppInfo
  prepared: PreparedApp
  /** 这一项的参数表（驱动的基础表 + 条目的 `params`） */
  schema: ParamSchema
  /** 条目的 `defaults` */
  defaults: Readonly<Record<string, unknown>>
  /** 这一项的模型；不要模型的操作没有 */
  model?: string
  timeoutMs: number
}

export interface Catalog {
  readonly apps: ReadonlyMap<string, CatalogEntry>
}

export interface CatalogOptions {
  drivers: readonly AnyProviderDriver[]
  env: DriverEnv
  /** 条目没写 `timeoutMs` 时的时限 */
  defaultTimeoutMs: number
}

interface ProviderEntry {
  driver: AnyProviderDriver
  value: unknown
  problems: readonly string[]
}

/** 解析应用表的内容（`{ providers, apps }`）。形状不对抛 Error（带位置，不带值：里面可能有密钥） */
export function buildCatalog(data: unknown, where: string, options: CatalogOptions): Catalog {
  const byType = new Map<string, AnyProviderDriver>()
  for (const driver of options.drivers) {
    if (byType.has(driver.type)) throw new Error(`驱动类型 ${driver.type} 注册了两次`)
    byType.set(driver.type, driver)
  }
  const root = new Fields(data, where, options.env)
  const providersRaw = root.object('providers') ?? {}
  const appsRaw = root.value('apps') ?? []
  root.done()
  if (!Array.isArray(appsRaw)) throw new Error(`${where}.apps 必须是数组（每项一个提供方 + 一个模型）`)

  const providers = new Map<string, ProviderEntry>()
  for (const [id, raw] of Object.entries(providersRaw)) {
    const at = `${where}.providers.${id}`
    if (!ID_REGEX.test(id)) throw new Error(`${at}：id 不合法（${ID_RULE}）`)
    if (!isRecord(raw)) throw new Error(`${at}：必须是对象`)
    const { type, ...rest } = raw
    const driver = typeof type === 'string' ? byType.get(type) : undefined
    if (!driver) throw new Error(`${at}：type 必须是 ${[...byType.keys()].join(' / ')} 之一`)
    const fields = new Fields(rest, at, options.env)
    const value = driver.parseProvider(fields, options.env)
    fields.done()
    providers.set(id, { driver, value, problems: fields.problems })
  }

  const apps = new Map<string, CatalogEntry>()
  const positions = new Map<string, number>()
  appsRaw.forEach((raw: unknown, index) => {
    const at = `${where}.apps[${index}]`
    if (!isRecord(raw)) throw new Error(`${at}：必须是对象`)
    const entry = buildEntry(raw, at, providers, options)
    const previous = positions.get(entry.info.id)
    if (previous !== undefined) throw new Error(`${at}：应用 ${entry.info.id} 和 apps[${previous}] 重复（同一个提供方的同一个模型只写一项）`)
    positions.set(entry.info.id, index)
    apps.set(entry.info.id, entry)
  })
  return { apps }
}

/** `apps` 的一项：一个提供方 + 一个模型（模型在别处的操作写 `id`） */
function buildEntry(raw: Record<string, unknown>, at: string, providers: ReadonlyMap<string, ProviderEntry>, options: CatalogOptions): CatalogEntry {
  const app = new Fields(raw, at, options.env)
  const providerId = app.string('provider', { required: true })
  const category = app.oneOf('type', APP_CATEGORIES, { required: true })
  if (Array.isArray(raw.model)) throw new Error(`${at}：model 只能是一个模型 id，每个模型写一项`)
  const model = app.string('model')
  const localId = app.string('id')
  const title = app.string('title')
  const description = app.string('description')
  const timeoutMs = app.integer('timeoutMs', { default: options.defaultTimeoutMs })!
  const defaults = app.object('defaults') ?? {}
  const patch = readParamPatch(app.nested('params'))
  const appOptions = app.nested('options')

  const provider = providers.get(providerId)
  if (!provider) throw new Error(`${at}：provider ${providerId} 不在 providers 里`)
  const { type: driverType, operations } = provider.driver
  const operation = operations[category]
  if (!operation) throw new Error(`${at}：${driverType} 不能做 type ${category}（只有 ${Object.keys(operations).join(' / ')}）`)
  if (operation.requiresModel ?? true) {
    if (!model) throw new Error(`${at}：缺少 model`)
    if (localId) throw new Error(`${at}：${driverType} 的 ${category} 要写 model，应用 id 自动生成（<provider>:<model>），不要写 id`)
  } else {
    if (model) throw new Error(`${at}：${driverType} 的 ${category} 不用 model（模型在它自己的配置里），写 id`)
    if (!localId) throw new Error(`${at}：缺少 id（${driverType} 的 ${category} 不用 model，应用 id 是 <provider>:<id>）`)
    if (!ID_REGEX.test(localId)) throw new Error(`${at}：id 不合法（${ID_RULE}）`)
  }

  const prepared = operation.prepare(appOptions, provider.value, options.env)
  app.done()
  // `model` 是保留的参数名：模型由条目定（驱动的第三个入参），调用方传了算不认识的参数
  if ('model' in prepared.params) throw new Error(`${at}：驱动的参数表里不能有 model（模型写在条目上）`)
  assertParamSchema(prepared.params, at)
  const schema = applyParamPatch(prepared.params, patch, at)
  if ('model' in schema) throw new Error(`${at}：params 里不能有 model（模型写在条目上）`)
  assertParamSchema(schema, at)
  assertDefaults(schema, defaults, at)

  const problems = [...provider.problems.map((problem) => `提供方 ${providerId}：${problem}`), ...appOptions.problems]
  const modelProblem = model ? (prepared.checkModel?.(model) ?? null) : null
  if (modelProblem) problems.push(`模型 ${model}：${modelProblem}`)
  return {
    info: {
      id: `${providerId}:${model ?? localId}`,
      title: title ?? model ?? localId!,
      ...(description ? { description } : {}),
      category,
      driver: driverType,
      ...(model ? { model } : {}),
      params: publicParams(schema, defaults),
      ...(problems.length > 0 ? { unavailable: problems.join('；') } : {}),
    },
    prepared,
    schema,
    defaults,
    ...(model ? { model } : {}),
    timeoutMs,
  }
}

/** 配置段 → 应用表：先把语言服务提供方合成进去（`llm-apps.ts`），再一起解析 */
export function catalogFromConfig(section: { providers?: unknown; apps?: unknown }, options: CatalogOptions): Catalog {
  return buildCatalog(withLlmProviderApps({ ...section }, options.env.llmProviders, APPS_CONFIG_PATH), APPS_CONFIG_PATH, options)
}
