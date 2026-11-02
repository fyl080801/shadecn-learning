/**
 * 应用执行模块对外的契约（docs/29）：别的模块（以后的 agent 工具、画布节点的服务端动作）经
 * `ctx.service(APPS_SERVICE)` 拿 {@link AppsService}，调 `executeApp(appId, params)`。
 * 没加载本模块（关掉、没有配置应用）时拿到 undefined —— 调用方按「没有可用的应用」退化。
 *
 * 这个入口只有类型和常量，不 import 实现；调用方不认识任何驱动（火山方舟 / ComfyUI / ollama…）。
 */
export const APPS_SERVICE = 'apps'

// 线上形状（应用列表、参数表）是前后端共用的契约，在 `@shadecn/shared/apps`；这里转出去，服务端照旧从本文件取
export {
  APP_CATEGORIES,
  PARAM_TYPES,
  type AppCategory,
  type AppErrorCode,
  type AppInfo,
  type ParamSchema,
  type ParamSpec,
  type ParamType,
} from '@shadecn/shared/apps'
import type { AppCategory, AppErrorCode, AppInfo } from '@shadecn/shared/apps'

/** 一个产物。`url` 和 `data` 至少有一个 */
export interface AppOutput {
  kind: AppCategory | 'file'
  /** 文字产物 */
  text?: string
  /** 上游给的地址（火山方舟的产物 24 小时后失效 —— 要长期留存得转存，见 docs/29 §5） */
  url?: string
  /** 字节产物（上游的地址浏览器到不了时，如 ComfyUI 的 `/view`） */
  data?: Uint8Array
  mimeType?: string
  /** 驱动特有的附加信息（尺寸、种子、图层位置…），原样透出 */
  meta?: Record<string, unknown>
}

export interface AppUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** 驱动特有的计量（生成了几张图…） */
  [key: string]: number | undefined
}

export interface AppResult {
  appId: string
  outputs: AppOutput[]
  usage?: AppUsage
  /** 上游的任务 / 请求 id（排查用） */
  upstreamId?: string
  durationMs: number
}

export interface ExecuteOptions {
  signal?: AbortSignal
  /** 发起人（日志用）；不判权 —— 判权是入口（路由 / agent 工具）的事 */
  userId?: string | null
  /** 进度回调（任务型驱动每查一次报一次） */
  onProgress?: (progress: AppProgress) => void
  /**
   * 任务型上游建好任务时调一次，交出续查句柄（任务表把它存下来，进程重启后用 {@link AppsService.resumeApp} 接着查）。
   * 它抛错 = 这次执行失败（存不下句柄就没法续查）
   */
  onSubmitted?: (handle: TaskHandle) => void | Promise<void>
  /** 这次执行从什么时候开始算（UTC epoch 毫秒）：时限 = 它 + 应用的 `timeoutMs`。续查时传任务的开始时间，不重置时限；不给 = 现在 */
  startedAt?: number
}

/**
 * 任务型上游的续查句柄（docs/29 §3.2）：`upstreamId` + 驱动自己续查要的 `state`，能 JSON 序列化、不含密钥。
 * 只有驱动认识它的内容，执行层和任务表原样存取
 */
export interface TaskHandle {
  upstreamId: string
  state?: Record<string, unknown>
}

export interface AppProgress {
  status: string
  /** 0～1；上游不给就不带 */
  ratio?: number
}

/**
 * 统一的失败类型。路由按 `code` 映射 HTTP 状态，agent 工具按它给模型一句话；上游的原始报文只进日志和 `detail`。
 * - `not_found`：没有这个应用；
 * - `unavailable`：应用存在但现在用不了（缺密钥、提供方不可用）；
 * - `invalid_params`：参数不对（缺必填、类型、范围、枚举）；
 * - `upstream`：上游报错（HTTP 非 2xx、任务失败、回包形状不对）；
 * - `timeout` / `aborted`：超过应用的时限 / 调用方中止。
 */

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly detail?: unknown
  constructor(code: AppErrorCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

export interface AppsService {
  list(): AppInfo[]
  get(appId: string): AppInfo | undefined
  /**
   * 只校验不执行：应用在、可用、参数合它的参数表（同 `executeApp` 执行前的那一步）。回这个应用的模型；不对抛 {@link AppError}。
   * 画布入口在建任务之前调，参数错了当场 400，不建任务
   */
  validate(appId: string, params: Record<string, unknown>): { model: string | undefined }
  /** 执行一个应用（提交 → 任务型的按间隔查到结束）。失败一律抛 {@link AppError} */
  executeApp(appId: string, params: Record<string, unknown>, options?: ExecuteOptions): Promise<AppResult>
  /** 拿续查句柄接着查到结束（进程重启后接手任务）。应用不在了 / 驱动不支持续查抛 {@link AppError} */
  resumeApp(appId: string, handle: TaskHandle, options?: Omit<ExecuteOptions, 'onSubmitted'>): Promise<AppResult>
  /** 尽力撤销上游任务（驱动有 `cancel` 才做）；从不抛，失败只打日志 */
  cancelUpstream(appId: string, handle: TaskHandle): Promise<void>
}
