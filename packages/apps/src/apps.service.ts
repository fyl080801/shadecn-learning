import type { Catalog, CatalogEntry } from './catalog.js'
import { AppError, type AppInfo, type AppResult, type ExecuteOptions, type TaskHandle } from './contract.js'
import { isRecord, type RunContext, type RunOutput } from './driver.js'
import { sleep } from './http.js'
import { resolveParams } from './params.js'

export interface AppsServiceOptions {
  /** 发上游请求用的 fetch（测试注入） */
  fetch?: typeof fetch
  /** 驱动没给 `pollIntervalMs` 时两次查询之间等多久 */
  defaultPollIntervalMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 2_000
/** 撤销上游任务最多等多久（尽力而为） */
const CANCEL_TIMEOUT_MS = 15_000

/**
 * 统一的执行层（docs/29 §3.5）：查应用 → 判可用 → 校验参数、补默认值 → 合并中止信号与时限 → 交给驱动 `submit` →
 * 任务型的交出句柄、按间隔 `poll` 到结束（轮询的循环只写在这里）→ 错误归一。
 * 驱动抛出的非 `AppError`（驱动的 bug、上游回包形状意外）一律归成 `upstream`，原始错误进日志不进回包。
 *
 * **不判权**：判权是入口的事（路由的守卫、任务的执行身份）。别的模块注入它调 {@link executeApp}。
 */
export class AppsService {
  private readonly doFetch: typeof fetch
  private readonly defaultInterval: number

  constructor(
    private readonly catalog: Catalog,
    options: AppsServiceOptions = {},
  ) {
    // 不在这里抓住全局 fetch：测试（和以后的代理设置）在装配之后才换它
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.defaultInterval = options.defaultPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  list(): AppInfo[] {
    return [...this.catalog.apps.values()].map((entry) => entry.info)
  }

  get(appId: string): AppInfo | undefined {
    return this.catalog.apps.get(appId)?.info
  }

  /**
   * 只校验不执行：应用在、可用、参数合它的参数表（同 {@link executeApp} 执行前的那一步）。回这个应用的模型；不对抛 {@link AppError}。
   * 画布入口在建任务之前调，参数错了当场 400，不建任务
   */
  validate(appId: string, params: Record<string, unknown>): { model: string | undefined } {
    if (!isRecord(params)) throw new AppError('invalid_params', '参数必须是对象')
    const entry = this.entryOf(appId)
    resolveParams(entry.schema, entry.defaults, params)
    return { model: entry.model }
  }

  /** 执行一个应用（提交 → 任务型的按间隔查到结束）。失败一律抛 {@link AppError} */
  async executeApp(appId: string, params: Record<string, unknown>, execute: ExecuteOptions = {}): Promise<AppResult> {
    const entry = this.entryOf(appId)
    if (!isRecord(params)) throw new AppError('invalid_params', '参数必须是对象')
    const values = resolveParams(entry.schema, entry.defaults, params)
    return this.guarded(appId, entry, execute, async (ctx) => {
      const submission = await entry.prepared.submit(values, ctx, entry.model)
      if (submission.done) return submission.output
      await execute.onSubmitted?.(submission.handle)
      const output = await this.pollUntilDone(entry, submission.handle, ctx, execute)
      return { upstreamId: submission.handle.upstreamId, ...output }
    })
  }

  /** 拿续查句柄接着查到结束（进程重启后接手任务）。应用不在了 / 驱动不支持续查抛 {@link AppError} */
  async resumeApp(appId: string, handle: TaskHandle, execute: Omit<ExecuteOptions, 'onSubmitted'> = {}): Promise<AppResult> {
    const entry = this.entryOf(appId)
    return this.guarded(appId, entry, execute, async (ctx) => ({
      upstreamId: handle.upstreamId,
      ...(await this.pollUntilDone(entry, handle, ctx, execute)),
    }))
  }

  /** 尽力撤销上游任务（驱动有 `cancel` 才做）；从不抛，失败只打日志 */
  async cancelUpstream(appId: string, handle: TaskHandle): Promise<void> {
    const cancel = this.catalog.apps.get(appId)?.prepared.cancel
    if (!cancel) return
    try {
      await cancel(handle, { signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS), fetch: this.doFetch })
    } catch (err) {
      console.warn(`[apps] ${appId} 撤销上游任务 ${handle.upstreamId} 失败（忽略）`, err)
    }
  }

  private entryOf(appId: string): CatalogEntry {
    const entry = this.catalog.apps.get(appId)
    if (!entry) throw new AppError('not_found', `没有应用 ${appId}`)
    if (entry.info.unavailable) throw new AppError('unavailable', `应用 ${appId} 现在用不了：${entry.info.unavailable}`)
    return entry
  }

  /** 按间隔查到结束；每次没完报一次进度 */
  private async pollUntilDone(entry: CatalogEntry, handle: TaskHandle, ctx: RunContext, execute: ExecuteOptions): Promise<RunOutput> {
    const poll = entry.prepared.poll
    if (!poll) throw new AppError('upstream', `应用 ${entry.info.id} 的驱动交出了任务句柄，却不支持查状态`)
    const interval = entry.prepared.pollIntervalMs ?? this.defaultInterval
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
  private async guarded(appId: string, entry: CatalogEntry, execute: ExecuteOptions, body: (ctx: RunContext) => Promise<RunOutput>): Promise<AppResult> {
    const startedAt = execute.startedAt ?? Date.now()
    const remaining = startedAt + entry.timeoutMs - Date.now()
    // 续查时可能早已过了时限：不再发请求，直接超时
    if (remaining <= 0) throw new AppError('timeout', `应用 ${appId} 超过 ${Math.round(entry.timeoutMs / 1000)} 秒没有完成`)
    const timeout = AbortSignal.timeout(remaining)
    const signal = execute.signal ? AbortSignal.any([execute.signal, timeout]) : timeout
    const ctx: RunContext = { signal, fetch: this.doFetch }
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
}

function normalizeError(err: unknown, appId: string, timeout: AbortSignal, timeoutMs: number, caller?: AbortSignal): AppError {
  // 先看信号：中止时驱动手里的 fetch 抛的是 AbortError / TimeoutError，不是 AppError
  if (caller?.aborted) return new AppError('aborted', `应用 ${appId} 已中止`)
  if (timeout.aborted) return new AppError('timeout', `应用 ${appId} 超过 ${Math.round(timeoutMs / 1000)} 秒没有完成`)
  if (err instanceof AppError) return err
  return new AppError('upstream', `应用 ${appId} 执行出错：${err instanceof Error ? err.message : String(err)}`)
}
