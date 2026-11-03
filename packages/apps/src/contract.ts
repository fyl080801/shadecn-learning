/**
 * 应用执行的类型和错误（docs/29）。别的模块注入 `AppsService`，调 `executeApp(appId, params)`；调用方不认识任何驱动（火山方舟 / ComfyUI / ollama…）。
 * 这个文件只有类型和错误类，不 import 实现。
 */

// 线上形状（应用列表、参数表）是前后端共用的契约，在 `@learning/contracts/apps`（`@shadecn/shared/apps` 的逐字复制）；这里转出去，包内统一从本文件取
export {
  APP_CATEGORIES,
  PARAM_TYPES,
  type AppCategory,
  type AppErrorCode,
  type AppInfo,
  type ParamSchema,
  type ParamSpec,
  type ParamType,
} from '@learning/contracts/apps'
import type { AppCategory, AppErrorCode } from '@learning/contracts/apps'

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
   * 任务型上游建好任务时调一次，交出续查句柄（任务表把它存下来，进程重启后用 `AppsService.resumeApp` 接着查）。
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
