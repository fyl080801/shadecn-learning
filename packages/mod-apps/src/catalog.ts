import {
  APP_CATEGORIES,
  AppError,
  type AppInfo,
  type ParamSchema,
  type AppResult,
  type AppsService,
  type ExecuteOptions,
  type TaskHandle,
} from './contract.ts'
import { Fields, isRecord, type AnyProviderDriver, type DriverEnv, type PreparedApp, type RunContext, type RunOutput } from './driver.ts'
import { sleep } from './http.ts'
import { withLlmProviderApps } from './llm-apps.ts'
import { applyParamPatch, assertDefaults, assertParamSchema, publicParams, readParamPatch, resolveParams } from './params.ts'

/**
 * 应用表与执行层（docs/29 §3.3 / §3.5）。
 *
 * 应用表是配置段 `modules.apps`（`server.config`，`config.ts` 读），和语言服务一个形状：
 *
 * ```yaml
 * modules:
 *   apps:
 *     providers:          # 对接服务的实例：同一种驱动可以有多个实例（两套 ComfyUI、两个方舟账号）
 *       ark:   { type: ark, apiKey: $ARK_API_KEY }
 *       comfy: { type: comfyui, baseUrl: http://127.0.0.1:8188 }
 *     apps:               # 平铺的数组，每项 = 一个提供方 + 一个模型；type 是类别，也就是驱动的操作
 *       - provider: ark
 *         model: doubao-seedream-5-0-pro-260628
 *         type: image
 *         title: Seedream 5.0 pro
 *         defaults: { size: 2K }
 *         params: { image: { maxLength: 10 }, maxImages: null }   # 这个模型和驱动基础表的差异（null = 没有这个参数）
 *       - { provider: comfy, id: sdxl, type: image, options: { workflow: data/comfy/sdxl.json, inputs: { … } } }   # 模型在工作流里的操作写 id
 * ```
 *
 * 应用 id 自动生成：`<provider>:<model>`，不要模型的操作是 `<provider>:<id>`。
 * 模型的参数差异是**配置**，不在驱动代码里：参数表 = 驱动的基础表 → 条目的 `params`。
 *
 * 两类错误分开（同 agent 模型表）：**形状不对 → 启动失败**（不认识的字段、类型、引用了不存在的提供方 / 操作、明文密钥、重复的应用）；
 * **配置对但现在用不了**（缺环境变量、模型解析不了）→ 应用标成不可用，启动打警告，执行回 `unavailable`。
 */

/** 配置段的位置：报错都从这里说起 */
export const APPS_CONFIG_PATH = 'modules.apps'

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
      console.info(`[apps] ${appId} 完成：${output.outputs.length} 个产物，${durationMs}ms${execute.userId ? `（${execute.userId}）` : ''}`)
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
      const entry = entryOf(appId)
      resolveParams(entry.schema, entry.defaults, params)
      return { model: entry.model }
    },
    async executeApp(appId, params, execute: ExecuteOptions = {}): Promise<AppResult> {
      const entry = entryOf(appId)
      if (!isRecord(params)) throw new AppError('invalid_params', '参数必须是对象')
      const values = resolveParams(entry.schema, entry.defaults, params)
      return guarded(appId, entry, execute, async (ctx) => {
        const submission = await entry.prepared.submit(values, ctx, entry.model)
        if (submission.done) return submission.output
        await execute.onSubmitted?.(submission.handle)
        const output = await pollUntilDone(entry, submission.handle, ctx, execute)
        return { upstreamId: submission.handle.upstreamId, ...output }
      })
    },
    async resumeApp(appId, handle, execute = {}): Promise<AppResult> {
      const entry = entryOf(appId)
      return guarded(appId, entry, execute, async (ctx) => ({
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

function normalizeError(err: unknown, appId: string, timeout: AbortSignal, timeoutMs: number, caller?: AbortSignal): AppError {
  // 先看信号：中止时驱动手里的 fetch 抛的是 AbortError / TimeoutError，不是 AppError
  if (caller?.aborted) return new AppError('aborted', `应用 ${appId} 已中止`)
  if (timeout.aborted) return new AppError('timeout', `应用 ${appId} 超过 ${Math.round(timeoutMs / 1000)} 秒没有完成`)
  if (err instanceof AppError) return err
  return new AppError('upstream', `应用 ${appId} 执行出错：${err instanceof Error ? err.message : String(err)}`)
}
