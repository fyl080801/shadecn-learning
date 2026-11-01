import { existsSync } from 'node:fs'
import { parseConfigFile } from '@shadecn/server-kit/config'
import {
  AppError,
  MODEL_PARAM,
  type AppInfo,
  type AppModelInfo,
  type ParamSchema,
  type AppResult,
  type AppsService,
  type ExecuteOptions,
  type TaskHandle,
} from './contract.ts'
import { Fields, isRecord, type AnyProviderDriver, type ParamPatch, type DriverEnv, type PreparedApp, type RunContext, type RunOutput } from './driver.ts'
import { sleep } from './http.ts'
import {
  applyParamPatch,
  assertDefaults,
  assertParamSchema,
  defaultsFor,
  publicParams,
  readParamPatch,
  resolveParams,
} from './params.ts'

/**
 * 应用表与执行层（docs/29 §3.3 / §3.5）。
 *
 * 应用表是一个 YAML / JSON 文件（`APPS_FILE`，默认 `<dataDir>/apps.yaml`），两段：
 *
 * ```yaml
 * models:               # 模型档案：各代模型的参数差异（null = 没有这个参数），所有应用共用，取第一条匹配的
 *   doubao-seedream-5-0*: { title: Seedream 5.0, params: { image: { maxLength: 10 }, maxImages: null } }
 * providers:            # 对接服务的实例：同一种驱动可以有多个实例（两套 ComfyUI、两个方舟账号）
 *   ark:      { type: ark, apiKey: $ARK_API_KEY }
 *   comfy:    { type: comfyui, baseUrl: http://127.0.0.1:8188 }
 *   ollama:   { type: ollama }
 * apps:                 # 应用 = 提供方实例 + 操作 + 模型（一个或多个）+ 驱动特有的 options + 参数默认值
 *   seedream:
 *     provider: ark
 *     operation: image
 *     model: [doubao-seedream-5-0-pro-260628, doubao-seedream-4-5-…]   # 多个 = 调用方可选（参数 `model`）
 *     models: { doubao-seedream-4-5-…: { title: 4.5, params: { size: { default: 4K } } } }   # 可选：补 / 改某个模型的参数差异
 *     defaults: { size: 2K }
 * ```
 *
 * 模型的参数差异是**配置**，不在驱动代码里：顶层 `models` 段是共用的模型档案（按 id / 前缀匹配），应用里的 `models.<id>` 再覆盖。
 * 每个模型的参数表 = 驱动的基础表 → 第一条匹配的模型档案 → 应用的 `models.<id>.params`。
 *
 * 两类错误分开（同 agent 模型表）：**文件形状不对 → 启动失败**（不认识的字段、类型、引用了不存在的提供方 / 操作、明文密钥）；
 * **配置对但现在用不了**（缺环境变量）→ 应用标成不可用，启动打警告，执行回 `unavailable`。
 */

/** 应用 / 提供方的 id：小写字母开头，小写字母、数字、`-` */
const ID_REGEX = /^[a-z][a-z0-9-]{0,47}$/

export interface CatalogEntry {
  info: AppInfo
  prepared: PreparedApp
  /** 应用表的 `defaults`（不含 `model`） */
  defaults: Readonly<Record<string, unknown>>
  /** 应用的模型，按应用表的顺序；不要模型的操作是空表 */
  models: ReadonlyMap<string, ModelEntry>
  defaultModel?: string
  timeoutMs: number
}

interface ModelEntry {
  info: AppModelInfo
  /** 这个模型的参数表（基础表 + 驱动的模型档案 + 应用表的覆盖） */
  schema: ParamSchema
}

export interface Catalog {
  /** 读的哪个文件；没有文件 = null */
  readonly file: string | null
  readonly apps: ReadonlyMap<string, CatalogEntry>
}

export interface CatalogOptions {
  drivers: readonly AnyProviderDriver[]
  env: DriverEnv
  /** 应用没写 `timeoutMs` 时的时限 */
  defaultTimeoutMs: number
}

interface ProviderEntry {
  driver: AnyProviderDriver
  value: unknown
  problems: readonly string[]
}

/** 解析应用表的内容。形状不对抛 Error（带文件和位置） */
export function buildCatalog(data: unknown, where: string, options: CatalogOptions): Catalog {
  const byType = new Map<string, AnyProviderDriver>()
  for (const driver of options.drivers) {
    if (byType.has(driver.type)) throw new Error(`驱动类型 ${driver.type} 注册了两次`)
    byType.set(driver.type, driver)
  }
  const root = new Fields(data, where, options.env)
  const providersRaw = root.object('providers') ?? {}
  const profiles = readModelProfiles(root.nested('models'))
  const appsRaw = root.object('apps') ?? {}
  root.done()

  const providers = new Map<string, ProviderEntry>()
  for (const [id, raw] of Object.entries(providersRaw)) {
    const at = `${where} 的 providers.${id}`
    if (!ID_REGEX.test(id)) throw new Error(`${at}：id 不合法（小写字母开头，只能有小写字母、数字、-，最长 48）`)
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
  for (const [id, raw] of Object.entries(appsRaw)) {
    const at = `${where} 的 apps.${id}`
    if (!ID_REGEX.test(id)) throw new Error(`${at}：id 不合法（小写字母开头，只能有小写字母、数字、-，最长 48）`)
    const app = new Fields(raw, at, options.env)
    const title = app.string('title', { default: id })
    const description = app.string('description')
    const providerId = app.string('provider', { required: true })
    const operationName = app.string('operation', { required: true })
    const timeoutMs = app.integer('timeoutMs', { default: options.defaultTimeoutMs })!
    const defaults = app.object('defaults') ?? {}
    const modelIds = readModelList(app)
    const overrides = app.nested('models')
    const appOptions = app.nested('options')

    const provider = providers.get(providerId)
    if (!provider) throw new Error(`${at}：provider ${providerId} 不在 providers 里`)
    const operation = provider.driver.operations[operationName]
    if (!operation) {
      throw new Error(`${at}：${provider.driver.type} 没有操作 ${operationName}（只有 ${Object.keys(provider.driver.operations).join(' / ')}）`)
    }
    const requiresModel = operation.requiresModel ?? true
    if (requiresModel && modelIds.length === 0) throw new Error(`${at}：缺少 model（一个模型 id，或模型 id 的数组）`)
    if (!requiresModel && modelIds.length > 0) throw new Error(`${at}：${provider.driver.type} 的 ${operationName} 不用 model（模型在它自己的配置里）`)

    const prepared = operation.prepare(appOptions, provider.value, options.env)
    if (MODEL_PARAM in prepared.params) throw new Error(`${at}：驱动的参数表里不能有 ${MODEL_PARAM}（它由执行层统一加）`)
    assertParamSchema(prepared.params, at)

    const models = new Map<string, ModelEntry>()
    for (const modelId of modelIds) {
      const modelAt = `${at} 的模型 ${modelId}`
      const override = overrides.raw[modelId] === undefined ? null : overrides.nested(modelId)
      const overrideTitle = override?.string('title')
      const overridePatch = override ? readParamPatch(override.nested('params')) : undefined
      const profile = profiles.find((rule) => profileMatches(rule.match, modelId))
      const schema = applyParamPatch(applyParamPatch(prepared.params, profile?.params, modelAt), overridePatch, modelAt)
      if (MODEL_PARAM in schema) throw new Error(`${modelAt}：参数表里不能有 ${MODEL_PARAM}`)
      assertParamSchema(schema, modelAt)
      const titleOf = overrideTitle ?? profile?.title
      const problem = prepared.checkModel?.(modelId) ?? null
      models.set(modelId, { info: { id: modelId, ...(titleOf ? { title: titleOf } : {}), params: schema, ...(problem ? { unavailable: problem } : {}) }, schema })
    }
    const strayOverride = Object.keys(overrides.raw).find((key) => !models.has(key))
    if (strayOverride) throw new Error(`${at}：models 里的 ${strayOverride} 不在 model 列表里`)
    app.done()

    // defaults：model 单独处理；其余每一项至少要是某个模型（或不要模型时的基础表）的参数，且对有它的模型类型都对
    const { [MODEL_PARAM]: defaultModelRaw, ...paramDefaults } = defaults
    const schemas = models.size > 0 ? [...models.values()].map((entry) => entry.schema) : [prepared.params]
    for (const [name, value] of Object.entries(paramDefaults)) {
      const owners = schemas.filter((schema) => name in schema)
      if (owners.length === 0) throw new Error(`${at}：defaults 里的 ${name} 不是这个应用的参数`)
      for (const schema of owners) assertDefaults(schema, { [name]: value }, at)
    }
    if (defaultModelRaw !== undefined && (typeof defaultModelRaw !== 'string' || !models.has(defaultModelRaw))) {
      throw new Error(`${at}：defaults.model 必须是 model 列表里的一个`)
    }
    const usable = [...models.values()].filter((entry) => !entry.info.unavailable).map((entry) => entry.info.id)
    const defaultModel = (defaultModelRaw as string | undefined) ?? usable[0] ?? modelIds[0]

    const problems = [...provider.problems.map((problem) => `提供方 ${providerId}：${problem}`), ...appOptions.problems]
    if (models.size > 0 && usable.length === 0) {
      problems.push([...models.values()].map((entry) => `模型 ${entry.info.id}：${entry.info.unavailable}`).join('；'))
    }
    const defaultSchema = defaultModel ? models.get(defaultModel)!.schema : prepared.params
    apps.set(id, {
      info: {
        id,
        title,
        ...(description ? { description } : {}),
        category: prepared.category,
        driver: provider.driver.type,
        params: publicParams(withModelParam(defaultSchema, modelIds, defaultModel), paramDefaults),
        models: [...models.values()].map((entry) => ({ ...entry.info, params: publicParams(entry.schema, paramDefaults) })),
        ...(defaultModel ? { defaultModel } : {}),
        ...(problems.length > 0 ? { unavailable: problems.join('；') } : {}),
      },
      prepared,
      defaults: paramDefaults,
      models,
      ...(defaultModel ? { defaultModel } : {}),
      timeoutMs,
    })
  }
  return { file: where, apps }
}

/**
 * 模型档案：应用表顶层的 `models` 段，key 是模型 id 或以 `*` 结尾的前缀，值是 `{ title?, params? }`。
 * 所有应用共用；**按文件里的顺序取第一条匹配的**，所以更具体的写在前面（`doubao-seedream-5-0-lite*` 在 `doubao-seedream-5-0*` 之前）。
 * 不匹配任何一条的模型用驱动的基础参数表。
 */
interface ModelProfile {
  match: string
  title?: string
  params?: ParamPatch
}

function readModelProfiles(section: Fields): ModelProfile[] {
  return Object.keys(section.raw).map((match) => {
    if (!/^[^*\s]+\*?$/.test(match)) throw new Error(`${section.at}：${match} 不合法（模型 id，或以 * 结尾的前缀；* 只能在最后）`)
    const fields = section.nested(match)
    const title = fields.string('title')
    const params = fields.raw.params === undefined ? undefined : readParamPatch(fields.nested('params'))
    return { match, ...(title ? { title } : {}), ...(params ? { params } : {}) }
  })
}

function profileMatches(match: string, model: string): boolean {
  return match.endsWith('*') ? model.startsWith(match.slice(0, -1)) : match === model
}

/** `model`：一个模型 id，或模型 id 的数组（不重复） */
function readModelList(app: Fields): string[] {
  const raw = app.value('model')
  if (raw === undefined || raw === null) return []
  const list = typeof raw === 'string' ? [raw] : raw
  if (!Array.isArray(list) || list.length === 0 || list.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${app.at}：model 必须是模型 id，或模型 id 的非空数组`)
  }
  const ids = list.map((item: string) => item.trim())
  const duplicate = ids.find((item, index) => ids.indexOf(item) !== index)
  if (duplicate) throw new Error(`${app.at}：model 里 ${duplicate} 写了两次`)
  return ids
}

/** 多模型的应用在参数表最前面加一个选模型的参数；单模型 / 不要模型的不加 */
function withModelParam(schema: ParamSchema, modelIds: readonly string[], defaultModel: string | undefined): ParamSchema {
  if (modelIds.length < 2) return schema
  return { [MODEL_PARAM]: { type: 'string', enum: [...modelIds], default: defaultModel, description: '模型' }, ...schema }
}

/** 读应用表文件：不存在 = 空表；读得到却不合法就抛 */
export function loadCatalog(file: string, options: CatalogOptions): Catalog {
  if (!existsSync(file)) return { file: null, apps: new Map() }
  return buildCatalog(parseConfigFile(file), `应用表 ${file}`, options)
}

// ---------------------------------------------------------------- 执行层

export interface ServiceOptions {
  /** 发上游请求用的 fetch（测试注入） */
  fetch?: typeof fetch
  /** 驱动没给 `pollIntervalMs` 时两次查询之间等多久 */
  defaultPollIntervalMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 2_000
/** 撤销上游任务最多等多久（尽力而为） */
const CANCEL_TIMEOUT_MS = 15_000

/**
 * 统一的执行层：查应用 → 判可用 → 校验参数、补默认值 → 合并中止信号与时限 → 交给驱动 `submit` →
 * 任务型的交出句柄、按间隔 `poll` 到结束（轮询的循环只写在这里）→ 错误归一。
 * 驱动抛出的非 `AppError`（驱动的 bug、上游回包形状意外）一律归成 `upstream`，原始错误进日志不进回包。
 */
export function createAppsService(catalog: Catalog, options: ServiceOptions = {}): AppsService {
  // 不在这里抓住全局 fetch：测试（和以后的代理设置）在装配之后才换它
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const defaultInterval = options.defaultPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const entryOf = (appId: string): CatalogEntry => {
    const entry = catalog.apps.get(appId)
    if (!entry) throw new AppError('not_found', `没有应用 ${appId}`)
    if (entry.info.unavailable) throw new AppError('unavailable', `应用 ${appId} 现在用不了：${entry.info.unavailable}`)
    return entry
  }

  /** 按间隔查到结束；每次没完报一次进度 */
  async function pollUntilDone(entry: CatalogEntry, handle: TaskHandle, ctx: RunContext, execute: ExecuteOptions): Promise<RunOutput> {
    const poll = entry.prepared.poll
    if (!poll) throw new AppError('upstream', `应用 ${entry.info.id} 的驱动交出了任务句柄，却不支持查状态`)
    const interval = entry.prepared.pollIntervalMs ?? defaultInterval
    for (;;) {
      const step = await poll(handle, ctx)
      if (step.done) return step.value
      try {
        execute.onProgress?.({ status: step.status, ...(step.ratio !== undefined ? { ratio: step.ratio } : {}) })
      } catch (err) {
        console.warn(`[apps] ${entry.info.id} 的进度回调抛错（忽略）`, err)
      }
      await sleep(interval, ctx.signal)
    }
  }

  /** 时限（从 `startedAt` 起算）+ 调用方中止 → 交给 `body` → 日志、错误归一 */
  async function guarded(
    appId: string,
    entry: CatalogEntry,
    model: string | undefined,
    execute: ExecuteOptions,
    body: (ctx: RunContext) => Promise<RunOutput>,
  ): Promise<AppResult> {
    const startedAt = execute.startedAt ?? Date.now()
    const remaining = startedAt + entry.timeoutMs - Date.now()
    // 续查时可能早已过了时限：不再发请求，直接超时
    if (remaining <= 0) throw new AppError('timeout', `应用 ${appId} 超过 ${Math.round(entry.timeoutMs / 1000)} 秒没有完成`)
    const timeout = AbortSignal.timeout(remaining)
    const signal = execute.signal ? AbortSignal.any([execute.signal, timeout]) : timeout
    const ctx: RunContext = { signal, fetch: doFetch }
    try {
      const output = await body(ctx)
      const durationMs = Date.now() - startedAt
      console.info(`[apps] ${appId}${model ? `（${model}）` : ''} 完成：${output.outputs.length} 个产物，${durationMs}ms${execute.userId ? `（${execute.userId}）` : ''}`)
      return { appId, ...output, durationMs }
    } catch (err) {
      const error = normalizeError(err, appId, timeout, entry.timeoutMs, execute.signal)
      console.warn(`[apps] ${appId} 失败（${error.code}）：${error.message}`, error === err ? '' : err)
      throw error
    }
  }

  return {
    list: () => [...catalog.apps.values()].map((entry) => entry.info),
    get: (appId) => catalog.apps.get(appId)?.info,
    validate(appId, params) {
      if (!isRecord(params)) throw new AppError('invalid_params', '参数必须是对象')
      return { model: pickModel(entryOf(appId), params).model }
    },
    async executeApp(appId, params, execute: ExecuteOptions = {}): Promise<AppResult> {
      const entry = entryOf(appId)
      if (!isRecord(params)) throw new AppError('invalid_params', '参数必须是对象')
      const { model, values } = pickModel(entry, params)
      return guarded(appId, entry, model, execute, async (ctx) => {
        const submission = await entry.prepared.submit(values, ctx, model)
        if (submission.done) return submission.output
        await execute.onSubmitted?.(submission.handle)
        const output = await pollUntilDone(entry, submission.handle, ctx, execute)
        return { upstreamId: submission.handle.upstreamId, ...output }
      })
    },
    async resumeApp(appId, handle, execute = {}): Promise<AppResult> {
      const entry = entryOf(appId)
      return guarded(appId, entry, undefined, execute, async (ctx) => ({
        upstreamId: handle.upstreamId,
        ...(await pollUntilDone(entry, handle, ctx, execute)),
      }))
    },
    async cancelUpstream(appId, handle) {
      const cancel = catalog.apps.get(appId)?.prepared.cancel
      if (!cancel) return
      try {
        await cancel(handle, { signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS), fetch: doFetch })
      } catch (err) {
        console.warn(`[apps] ${appId} 撤销上游任务 ${handle.upstreamId} 失败（忽略）`, err)
      }
    },
  }
}

/**
 * 定下这次用哪个模型，再按这个模型的参数表校验参数。`model` 只在多模型的应用里是参数（单模型的传了算不认识的参数，
 * 和列表里的参数表一致）；选了用不了的模型回 `unavailable`
 */
function pickModel(entry: CatalogEntry, params: Readonly<Record<string, unknown>>): { model: string | undefined; values: Record<string, unknown> } {
  if (entry.models.size === 0) return { model: undefined, values: resolveParams(entry.prepared.params, entry.defaults, params) }
  const ids = [...entry.models.keys()]
  const { [MODEL_PARAM]: requested, ...rest } = params
  let model = entry.defaultModel!
  if (ids.length > 1 && requested !== undefined && requested !== null && requested !== '') {
    if (typeof requested !== 'string' || !entry.models.has(requested)) {
      throw new AppError('invalid_params', `${MODEL_PARAM} 只能是 ${ids.join(' / ')}`)
    }
    model = requested
  }
  const chosen = entry.models.get(model)!
  if (chosen.info.unavailable) throw new AppError('unavailable', `模型 ${model} 现在用不了：${chosen.info.unavailable}`)
  const input = ids.length > 1 ? rest : params
  return { model, values: resolveParams(chosen.schema, defaultsFor(chosen.schema, entry.defaults), input) }
}

function normalizeError(err: unknown, appId: string, timeout: AbortSignal, timeoutMs: number, caller?: AbortSignal): AppError {
  // 先看信号：中止时驱动手里的 fetch 抛的是 AbortError / TimeoutError，不是 AppError
  if (caller?.aborted) return new AppError('aborted', `应用 ${appId} 已中止`)
  if (timeout.aborted) return new AppError('timeout', `应用 ${appId} 超过 ${Math.round(timeoutMs / 1000)} 秒没有完成`)
  if (err instanceof AppError) return err
  return new AppError('upstream', `应用 ${appId} 执行出错：${err instanceof Error ? err.message : String(err)}`)
}
