/**
 * 应用执行（REQ-APPS，docs/29）前后端共用的契约：应用列表、参数表、执行结果的线上形状，
 * 以及「画布节点的输入 → 应用参数」的纯函数（前端节点运行器用，以后 agent 的工具也用这一份）。
 *
 * 服务端的执行层在 `@shadecn/mod-apps`（它的 `contract.ts` 从这里取类型）；这里不碰任何驱动。
 */

import { APP_TASKS_MESSAGE } from './collab.js'

/** 应用的类别：给调用方挑应用、给界面分组用。和驱动无关 —— ComfyUI 一个驱动能出图、出视频、出 3D */
export const APP_CATEGORIES = ['text', 'image', 'video', '3d', 'audio'] as const
export type AppCategory = (typeof APP_CATEGORIES)[number]

/**
 * 参数的类型。只有这几种，**所有驱动共用一套**：校验、默认值、给界面渲染表单都按它。
 * - `image` / `images`：一张 / 一组图片，值是 `https://` 地址或 `data:image/…;base64,…`；
 * - `size`：图片尺寸 —— 一个分辨率档位（`tiers` 里的一个，如 `2K`：比例由模型按提示词定），或 `宽x高`（像素总量、比例有上下限）；
 *   常用尺寸是 `presets`（比例 → 每个档位下的宽高），界面据此给出「分辨率 × 比例」的选择（docs/29 §3.9）；
 * - `json`：任意 JSON 值（驱动自己再解释），给「这一项太专门、不值得单独建类型」的参数留的口子。
 */
export const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'image', 'images', 'size', 'json'] as const
export type ParamType = (typeof PARAM_TYPES)[number]

export interface ParamSpec {
  type: ParamType
  /** 一句话说明（给人、给模型） */
  description?: string
  required?: boolean
  /** 调用方没给时用它；应用表的 `defaults` 会覆盖驱动给的 */
  default?: unknown
  /** 只能取这些值之一（`string` / `number` / `integer`） */
  enum?: readonly (string | number)[]
  /** `number` / `integer` 的闭区间 */
  min?: number
  max?: number
  /** `string` 的最大长度、`images` 的最多张数 */
  maxLength?: number
  /** `size`：分辨率档位（按顺序，`presets` 的每一列对应一档） */
  tiers?: readonly string[]
  /** `size`：常用比例 → 每个档位下的 `宽x高`（和 `tiers` 等长、同顺序）。是参考值，不是白名单 —— 别的宽高在范围内照样收 */
  presets?: Readonly<Record<string, readonly string[]>>
  /** `size`：`宽x高` 的像素总量（宽 × 高）范围 */
  minPixels?: number
  maxPixels?: number
  /** `size`：长边 / 短边的上限（方舟是 16） */
  maxAspect?: number
}

export type ParamSchema = Readonly<Record<string, ParamSpec>>

/** `GET /api/apps` 的一项：给调用方看的应用信息（不含提供方地址、密钥、驱动内部配置） */
export interface AppInfo {
  id: string
  title: string
  description?: string
  category: AppCategory
  /** 驱动类型（`ark` / `comfyui` / `ollama`…），给人看的 */
  driver: string
  /** 这个应用的模型（给人看的）；不要模型的操作（如 ComfyUI）没有 */
  model?: string
  /** 参数表：驱动的基础表 + 条目的 `params`，`default` 已合进条目的 `defaults` */
  params: ParamSchema
  /** 不可用的原因（缺密钥、模型解析不了…）；可用 = 不带 */
  unavailable?: string
}

export type AppErrorCode = 'not_found' | 'unavailable' | 'invalid_params' | 'upstream' | 'timeout' | 'aborted'

export type AppOutputKind = AppCategory | 'file'

/** 回包里的一个产物：`url` / `dataUrl` / `text` 至少有一个 */
export interface AppOutputView {
  kind: AppOutputKind
  text?: string
  /** 画布执行入口存进了画布资源时是本服务的地址（`meta.assetKey` 是它的键）；否则是上游给的地址（可能会过期） */
  url?: string
  /** 字节产物（没能存进画布资源时） */
  dataUrl?: string
  mimeType?: string
  meta?: Record<string, unknown>
}

export interface AppUsageView {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  [key: string]: number | undefined
}

/** `POST …/apps/:appId/execute` 的回包 */
export interface AppResultView {
  appId: string
  outputs: AppOutputView[]
  usage?: AppUsageView
  upstreamId?: string
  durationMs: number
}

/** 执行失败的回包 */
export interface AppErrorView {
  error: string
  code: AppErrorCode
}

// ---------------------------------------------------------------- 参数值校验（前后端同一份）

/** 图片参数接受的形状：http(s) 地址或 base64 的 data URL */
const IMAGE_VALUE = /^(https?:\/\/\S+|data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+)$/i
const SIZE_VALUE = /^(\d{1,5})x(\d{1,5})$/

/** `宽x高` → 数字；不是这个形状 → null */
export function parseSizeValue(value: string): { width: number; height: number } | null {
  const match = SIZE_VALUE.exec(value.trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : null
}

function checkSize(name: string, spec: ParamSpec, value: unknown): string | null {
  if (typeof value !== 'string') return `${name} 必须是字符串`
  if (spec.tiers?.includes(value)) return null
  const size = parseSizeValue(value)
  const tiers = spec.tiers?.length ? `${spec.tiers.join(' / ')}，或 ` : ''
  if (!size) return `${name} 只能是 ${tiers}宽x高（如 2048x2048）`
  const pixels = size.width * size.height
  if (spec.minPixels !== undefined && pixels < spec.minPixels) return `${name} 太小：宽 × 高至少 ${spec.minPixels} 像素（现在 ${pixels}）`
  if (spec.maxPixels !== undefined && pixels > spec.maxPixels) return `${name} 太大：宽 × 高最多 ${spec.maxPixels} 像素（现在 ${pixels}）`
  const aspect = Math.max(size.width, size.height) / Math.min(size.width, size.height)
  if (spec.maxAspect !== undefined && aspect > spec.maxAspect) return `${name} 太扁：长边最多是短边的 ${spec.maxAspect} 倍`
  return null
}

/** 一个参数值合不合它的说明；合 = null，不合 = 一句给人看的话。服务端的执行层和前端的表单都用它 */
export function checkParamValue(name: string, spec: ParamSpec, value: unknown): string | null {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return `${name} 必须是字符串`
      if (spec.maxLength !== undefined && value.length > spec.maxLength) return `${name} 最长 ${spec.maxLength} 字`
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} 必须是数字`
      if (spec.type === 'integer' && !Number.isInteger(value)) return `${name} 必须是整数`
      if (spec.min !== undefined && value < spec.min) return `${name} 不能小于 ${spec.min}`
      if (spec.max !== undefined && value > spec.max) return `${name} 不能大于 ${spec.max}`
      break
    case 'boolean':
      if (typeof value !== 'boolean') return `${name} 必须是 true / false`
      break
    case 'image':
      if (typeof value !== 'string' || !IMAGE_VALUE.test(value)) return `${name} 必须是图片地址（http(s)）或 data:image/…;base64,…`
      break
    case 'images':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !IMAGE_VALUE.test(item))) {
        return `${name} 必须是图片地址 / data URL 的数组`
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) return `${name} 最多 ${spec.maxLength} 张`
      break
    case 'size':
      return checkSize(name, spec, value)
    case 'json':
      break
  }
  if (spec.enum && !spec.enum.includes(value as string | number)) return `${name} 只能是 ${spec.enum.join(' / ')}`
  return null
}

/**
 * 一个 `size` 值落在「分辨率 × 比例」的哪一格：档位本身 → `{ tier, ratio: null }`（比例由模型定）；
 * `presets` 里的某个宽高 → `{ tier, ratio }`；都不是 → null（自定义宽高）
 */
export function sizeCellOf(spec: ParamSpec, value: string): { tier: string; ratio: string | null } | null {
  const tiers = spec.tiers ?? []
  if (tiers.includes(value)) return { tier: value, ratio: null }
  for (const [ratio, sizes] of Object.entries(spec.presets ?? {})) {
    const index = sizes.indexOf(value)
    if (index >= 0 && tiers[index]) return { tier: tiers[index]!, ratio }
  }
  return null
}

/** 「分辨率 × 比例」这一格的值：比例为 null = 档位本身；这一格没有参考值 → null */
export function sizeValueOf(spec: ParamSpec, tier: string, ratio: string | null): string | null {
  if (ratio === null) return (spec.tiers ?? []).includes(tier) ? tier : null
  const index = (spec.tiers ?? []).indexOf(tier)
  return index >= 0 ? (spec.presets?.[ratio]?.[index] ?? null) : null
}

/** 节点交给应用的输入：提示词 + 连进来的参考图（按连入顺序） */
export interface NodeAppInputs {
  prompt: string
  images: readonly string[]
}

export interface NodeAppParams {
  params: Record<string, unknown>
  /** 应用接不了的参考图张数（没有图片参数，或超过上限）—— 调用方据此提示「多余的图没用上」 */
  droppedImages: number
}

/**
 * 画布节点的输入 → 应用参数（docs/29 §3.8）。按参数表认，不按驱动认：
 * - 提示词进 `prompt`（参数表里有才放；空串不放，交给校验报「缺少参数」）；
 * - 参考图进参数表里**第一个** `images` 参数（截到 `maxLength`）；没有 `images` 就进第一个 `image` 参数（只放第一张）；
 * - `overrides`：节点上单独设的其余参数（`data` 里 `appParam.<名字>` 那些，如尺寸），只带这个应用有、值也合说明的。
 * 应用要求但节点给不了的参数（比如必填的图）不在这里补 —— 服务端的校验会给出准确的那句话。
 */
export function nodeAppParams(
  app: AppInfo,
  inputs: NodeAppInputs,
  overrides: Readonly<Record<string, unknown>> = {},
): NodeAppParams {
  const schema = app.params
  const params: Record<string, unknown> = {}
  // 节点上单独设的参数（尺寸…）：这个应用有这个参数、值也合它的说明才带上 —— 换了应用、旧值不合的，退回应用的默认
  for (const [name, value] of Object.entries(overrides)) {
    const spec = schema[name]
    if (spec && name !== 'prompt' && spec.type !== 'image' && spec.type !== 'images' && checkParamValue(name, spec, value) === null) {
      params[name] = value
    }
  }
  const prompt = inputs.prompt.trim()
  if (prompt && schema.prompt?.type === 'string') params.prompt = prompt

  let droppedImages = inputs.images.length
  const entries = Object.entries(schema)
  const multi = entries.find(([, spec]) => spec.type === 'images')
  const single = entries.find(([, spec]) => spec.type === 'image')
  if (inputs.images.length > 0 && multi) {
    const limit = multi[1].maxLength ?? inputs.images.length
    params[multi[0]] = inputs.images.slice(0, limit)
    droppedImages = Math.max(0, inputs.images.length - limit)
  } else if (inputs.images.length > 0 && single) {
    params[single[0]] = inputs.images[0]
    droppedImages = inputs.images.length - 1
  }
  return { params, droppedImages }
}

// ---------------------------------------------------------------- 生成任务（docs/29 §3.10）

/**
 * 一个画布生成任务的状态：`queued`（还没有执行副本接手）→ `running`（执行中，带进度）→ 三种结束态之一。
 * 节点上「生成中」的事实看节点 `runtime`（Y.Doc），任务表是生命周期的权威，进度只走推送。
 */
export const APP_TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const
export type AppTaskStatus = (typeof APP_TASK_STATUSES)[number]

/** 还没结束的状态：任务列表、推送、「同一节点只能有一个」都按它判 */
export const APP_TASK_ACTIVE_STATUSES: readonly AppTaskStatus[] = ['queued', 'running']

export function isAppTaskActive(status: AppTaskStatus): boolean {
  return APP_TASK_ACTIVE_STATUSES.includes(status)
}

/** 进度：上游给的状态词（`queued` / `running`…）+ 可选的 0～1 */
export interface AppTaskProgress {
  status: string
  ratio?: number
}

export interface AppTaskOwner {
  id: string
  name: string
  avatarUrl: string | null
}

/** 线上的一个任务（`GET …/apps/tasks`、提交的回包、`apps:tasks` 推送里的一项）。时间都是服务端时钟的 UTC epoch 毫秒 */
export interface AppTaskView {
  id: string
  flowId: string
  nodeId: string
  appId: string
  /** 应用标题（应用表里删掉了就是 id） */
  appTitle: string
  model?: string
  status: AppTaskStatus
  progress?: AppTaskProgress
  /** 失败原因（`failed`） */
  error?: string
  owner: AppTaskOwner
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

/** 画布生成任务的接口前缀（叠画布守卫） */
export function flowAppsPath(flowId: string): string {
  return `/api/flows/${encodeURIComponent(flowId)}/apps`
}

/** 推送载荷：这张画布进行中的任务全量（按创建时间升序），`now` 是发出时服务端的时钟 */
export interface AppTasksMessage {
  type: typeof APP_TASKS_MESSAGE
  flowId: string
  tasks: AppTaskView[]
  now: number
}

export function formatAppTasksMessage(flowId: string, tasks: readonly AppTaskView[], now: number = Date.now()): string {
  const message: AppTasksMessage = { type: APP_TASKS_MESSAGE, flowId, tasks: [...tasks], now }
  return JSON.stringify(message)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finiteOrUndefined = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** 解析一项任务；形状不对返回 null（只丢这一项）。只取认得的字段 */
export function parseAppTaskView(value: unknown): AppTaskView | null {
  if (!isPlainObject(value)) return null
  const { id, flowId, nodeId, appId, appTitle, status, createdAt } = value
  if (typeof id !== 'string' || !id || typeof flowId !== 'string' || typeof nodeId !== 'string' || !nodeId) return null
  if (typeof appId !== 'string' || typeof appTitle !== 'string') return null
  if (typeof status !== 'string' || !(APP_TASK_STATUSES as readonly string[]).includes(status)) return null
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
  const owner = value.owner
  if (!isPlainObject(owner) || typeof owner.id !== 'string' || typeof owner.name !== 'string') return null
  const progressRaw = value.progress
  const progress: AppTaskProgress | undefined =
    isPlainObject(progressRaw) && typeof progressRaw.status === 'string'
      ? {
          status: progressRaw.status,
          ...(typeof progressRaw.ratio === 'number' && progressRaw.ratio >= 0 && progressRaw.ratio <= 1 ? { ratio: progressRaw.ratio } : {}),
        }
      : undefined
  const startedAt = finiteOrUndefined(value.startedAt)
  const finishedAt = finiteOrUndefined(value.finishedAt)
  return {
    id,
    flowId,
    nodeId,
    appId,
    appTitle,
    ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
    status: status as AppTaskStatus,
    ...(progress ? { progress } : {}),
    ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
    owner: { id: owner.id, name: owner.name, avatarUrl: typeof owner.avatarUrl === 'string' ? owner.avatarUrl : null },
    createdAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  }
}

/**
 * 解析 `apps:tasks` 推送；不是这类消息（或整体形状不对）返回 null。防御着写（同 `parseAgentRunsMessage`）：
 * stateless 是通用旁路，读不懂的消息绝不能变成异常；个别项形状不对只丢那一项。
 */
export function parseAppTasksMessage(payload: string): { flowId: string; tasks: AppTaskView[]; now?: number } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isPlainObject(parsed) || parsed.type !== APP_TASKS_MESSAGE) return null
  if (typeof parsed.flowId !== 'string' || !Array.isArray(parsed.tasks)) return null
  const tasks: AppTaskView[] = []
  for (const item of parsed.tasks) {
    const task = parseAppTaskView(item)
    if (task) tasks.push(task)
  }
  const now = finiteOrUndefined(parsed.now)
  return { flowId: parsed.flowId, tasks, ...(now !== undefined ? { now } : {}) }
}
