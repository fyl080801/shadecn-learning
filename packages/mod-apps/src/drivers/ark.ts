import { AppError, type AppCategory, type AppOutput, type AppUsage, type ParamSchema } from '../contract.ts'
import {
  defineDriver,
  type Fields,
  type Operation,
  type PollStep,
  type PreparedApp,
  type RunContext,
  type RunOutput,
  type Submission,
  type TaskHandle,
} from '../driver.ts'
import { requestJson, requestOk } from '../http.ts'

/**
 * 火山方舟（Ark，docs/29 §4.1）：
 * - `image`：图片生成 `POST /images/generations`（Seedream），同步返回；
 * - `video`：视频生成任务（Seedance），`POST /contents/generations/tasks` 建任务（`submit` 回句柄）、`GET …/tasks/{id}` 查状态（`poll`），
 *   产物 `content.video_url`；取消是 `DELETE …/tasks/{id}`（方舟只撤得掉排队中的）；
 * - `3d`：3D 生成任务（Seed3D），同一组任务接口，产物 `content.file_url`（zip）。
 *
 * 模型写在应用上（`model`，一个或多个，模型 id 或推理接入点 id）。这里的参数表是**各代模型的并集**（取最宽的上限）；
 * 某一代不支持的参数、更紧的上限写在应用表的 `models` 段（docs/29 §3.7，示例见仓库根的 `apps.example.yaml`）——
 * 上游出了新模型只改配置，不改代码。
 * 每个操作的 `options` 只有 `body`（原样并进请求体的固定字段，不常用的参数写进去就行；盖不掉 `model` 和已映射的参数）。
 * 产物地址 24 小时内有效（要长期留存得转存，docs/29 §5）。
 */

interface ArkProvider {
  baseUrl: string
  apiKey: string
  /** 任务型操作（视频、3D）多久问一次进度 */
  pollIntervalMs: number
}

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_POLL_INTERVAL_MS = 5_000

function headers(provider: ArkProvider) {
  return { authorization: `Bearer ${provider.apiKey}` }
}

interface ArkUsage {
  generated_images?: number
  output_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

function usageOf(usage: ArkUsage | undefined): AppUsage | undefined {
  if (!usage) return undefined
  const out: AppUsage = {}
  const outputTokens = usage.output_tokens ?? usage.completion_tokens
  if (outputTokens !== undefined) out.outputTokens = outputTokens
  if (usage.total_tokens !== undefined) out.totalTokens = usage.total_tokens
  if (usage.generated_images !== undefined) out.generatedImages = usage.generated_images
  return out
}

/** 只把给了值的参数放进请求体（没给 = 用方舟自己的默认） */
function pick(values: Readonly<Record<string, unknown>>, mapping: Readonly<Record<string, string>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [param, field] of Object.entries(mapping)) {
    if (values[param] !== undefined) out[field] = values[param]
  }
  return out
}

/** 每个操作的共同部分：读 `body`，组装成 PreparedApp；模型由执行层定 */
function arkOperation(
  description: string,
  category: AppCategory,
  params: ParamSchema,
  submit: (request: { provider: ArkProvider; model: string; body: Record<string, unknown> }, values: Readonly<Record<string, unknown>>, ctx: RunContext) => Promise<Submission>,
  task?: { label: string; outputsOf: TaskOutputs },
): Operation<ArkProvider> {
  return {
    description,
    prepare(options: Fields, provider): PreparedApp {
      const body = options.object('body') ?? {}
      return {
        category,
        params,
        submit: (values, ctx, model) => submit({ provider, model: model!, body }, values, ctx),
        ...(task
          ? {
              pollIntervalMs: provider.pollIntervalMs,
              poll: (handle: TaskHandle, ctx: RunContext) => pollTask(task.label, provider, handle, ctx, task.outputsOf),
              cancel: (handle: TaskHandle, ctx: RunContext) => cancelTask(task.label, provider, handle, ctx),
            }
          : {}),
      }
    },
  }
}

// ---------------------------------------------------------------- 图片


interface ArkImageResponse {
  data?: { url?: string; b64_json?: string; size?: string; error?: { code?: string; message?: string } }[]
  usage?: ArkUsage
  error?: { code?: string; message?: string }
}

const image = arkOperation(
  '图片生成（文生图 / 图生图 / 组图）',
  'image',
  {
    prompt: { type: 'string', required: true, description: '提示词', maxLength: 4000 },
    image: { type: 'images', description: '参考图（图生图），最多 14 张', maxLength: 14 },
    // 各代的并集：档位、像素范围取最宽；每一代的档位、常用宽高表、范围在应用表的模型档案里（apps.example.yaml）
    size: {
      type: 'size',
      description: '分辨率档位（比例由模型按提示词定），或 宽x高',
      tiers: ['1K', '1.5K', '2K', '3K', '4K'],
      minPixels: 921600,
      maxPixels: 16777216,
      maxAspect: 16,
    },
    maxImages: { type: 'integer', min: 1, max: 15, description: '组图最多生成几张；不给 = 只出一张' },
    watermark: { type: 'boolean', default: false, description: '加「AI 生成」水印' },
    outputFormat: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式' },
  },
  async ({ provider, model, body }, values, ctx) => {
    const images = values.image as string[] | undefined
    const maxImages = values.maxImages as number | undefined
    const response = await requestJson<ArkImageResponse>(ctx, '火山方舟图片生成', `${provider.baseUrl}/images/generations`, {
      method: 'POST',
      headers: headers(provider),
      body: {
        ...body,
        model,
        ...pick(values, { prompt: 'prompt', size: 'size', watermark: 'watermark', outputFormat: 'output_format' }),
        ...(images ? { image: images.length === 1 ? images[0] : images } : {}),
        ...(maxImages && maxImages > 1
          ? { sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: maxImages } }
          : {}),
        response_format: 'url',
      },
    })
    if (response.error) throw new AppError('upstream', `火山方舟图片生成失败：${response.error.message ?? response.error.code}`, response.error)
    const outputs: AppOutput[] = []
    const failures: string[] = []
    for (const item of response.data ?? []) {
      if (item.url) outputs.push({ kind: 'image', url: item.url, ...(item.size ? { meta: { size: item.size } } : {}) })
      else if (item.error) failures.push(item.error.message ?? item.error.code ?? '未知错误')
    }
    // 组图里个别失败不影响其余的；一张都没有才算失败
    if (outputs.length === 0) throw new AppError('upstream', `火山方舟没有返回图片${failures.length ? `：${failures.join('；')}` : ''}`)
    const usage = usageOf(response.usage)
    return { done: true, output: { outputs, ...(usage ? { usage } : {}) } }
  },
)

// ---------------------------------------------------------------- 任务（视频、3D）

interface ArkTask {
  id?: string
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'expired' | 'cancelled'
  content?: { video_url?: string; last_frame_url?: string; file_url?: string }
  usage?: ArkUsage
  error?: { code?: string; message?: string } | null
}

/** 任务成功后从 `content` 取产物；`state` 是建任务时句柄里存的东西 */
type TaskOutputs = (content: NonNullable<ArkTask['content']>, state: Record<string, unknown>) => AppOutput[]

const taskUrl = (provider: ArkProvider, taskId: string) => `${provider.baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`

/** 建任务，回续查句柄（`state` 原样存进句柄，取产物时用） */
async function createTask(label: string, provider: ArkProvider, body: Record<string, unknown>, ctx: RunContext, state?: Record<string, unknown>): Promise<Submission> {
  const created = await requestJson<ArkTask>(ctx, label, `${provider.baseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers: headers(provider),
    body,
  })
  if (!created.id) throw new AppError('upstream', `${label}：建任务没有返回 id`)
  return { done: false, handle: { upstreamId: created.id, ...(state ? { state } : {}) } }
}

/** 查一次任务：成功取产物，排队 / 运行中报进度，失败 / 过期 / 取消都是 upstream */
async function pollTask(label: string, provider: ArkProvider, handle: TaskHandle, ctx: RunContext, outputsOf: TaskOutputs): Promise<PollStep<RunOutput>> {
  const taskId = handle.upstreamId
  const current = await requestJson<ArkTask>(ctx, label, taskUrl(provider, taskId), { headers: headers(provider) })
  switch (current.status) {
    case 'succeeded': {
      const outputs = outputsOf(current.content ?? {}, handle.state ?? {})
      if (outputs.length === 0) throw new AppError('upstream', `${label}：任务成功但没有产物地址`, { taskId })
      const usage = usageOf(current.usage)
      return { done: true, value: { outputs, upstreamId: taskId, ...(usage ? { usage } : {}) } }
    }
    case 'queued':
    case 'running':
      return { done: false, status: current.status }
    default:
      throw new AppError('upstream', `${label}：任务 ${current.status ?? '状态未知'}${current.error?.message ? `：${current.error.message}` : ''}`, {
        taskId,
        error: current.error,
      })
  }
}

/** 撤销任务：方舟只撤得掉排队中的，运行中的会回错（调用方只打日志） */
async function cancelTask(label: string, provider: ArkProvider, handle: TaskHandle, ctx: RunContext): Promise<void> {
  await requestOk(ctx, `${label}（取消）`, taskUrl(provider, handle.upstreamId), { method: 'DELETE', headers: headers(provider) })
}

const VIDEO_LABEL = '火山方舟视频生成'
const MODEL3D_LABEL = '火山方舟 3D 生成'

const video = arkOperation(
  '视频生成（文生视频 / 首帧 / 首尾帧 / 参考图）',
  'video',
  {
    prompt: { type: 'string', description: '提示词', maxLength: 4000 },
    firstFrame: { type: 'image', description: '首帧图' },
    lastFrame: { type: 'image', description: '尾帧图（要同时给首帧）' },
    referenceImages: { type: 'images', description: '参考图（和首帧 / 尾帧互斥）', maxLength: 30 },
    resolution: { type: 'string', enum: ['480p', '720p', '1080p', '4k'] },
    ratio: { type: 'string', enum: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] },
    duration: { type: 'integer', min: -1, max: 30, description: '时长（秒）；-1 = 模型自定' },
    generateAudio: { type: 'boolean', description: '同时生成音频（部分模型支持）' },
    watermark: { type: 'boolean', default: false },
    seed: { type: 'integer', min: -1 },
  },
  async ({ provider, model, body }, values, ctx) => {
    const firstFrame = values.firstFrame as string | undefined
    const lastFrame = values.lastFrame as string | undefined
    const references = (values.referenceImages as string[] | undefined) ?? []
    if (!values.prompt && !firstFrame && references.length === 0) throw new AppError('invalid_params', 'prompt、firstFrame、referenceImages 至少给一个')
    if (lastFrame && !firstFrame) throw new AppError('invalid_params', '给了 lastFrame 就要同时给 firstFrame')
    if (references.length > 0 && firstFrame) throw new AppError('invalid_params', 'referenceImages 和 firstFrame / lastFrame 不能同时用')
    const imageItem = (url: string, role: string) => ({ type: 'image_url', image_url: { url }, role })
    const content = [
      ...(values.prompt ? [{ type: 'text', text: values.prompt }] : []),
      ...(firstFrame ? [imageItem(firstFrame, 'first_frame')] : []),
      ...(lastFrame ? [imageItem(lastFrame, 'last_frame')] : []),
      ...references.map((url) => imageItem(url, 'reference_image')),
    ]
    return createTask(
      VIDEO_LABEL,
      provider,
      {
        ...body,
        model,
        content,
        ...pick(values, {
          resolution: 'resolution',
          ratio: 'ratio',
          duration: 'duration',
          generateAudio: 'generate_audio',
          watermark: 'watermark',
          seed: 'seed',
        }),
      },
      ctx,
    )
  },
  {
    label: VIDEO_LABEL,
    outputsOf: (result) => [
      ...(result.video_url ? [{ kind: 'video' as const, url: result.video_url, mimeType: 'video/mp4' }] : []),
      ...(result.last_frame_url ? [{ kind: 'image' as const, url: result.last_frame_url, meta: { role: 'last_frame' } }] : []),
    ],
  },
)

const model3d = arkOperation(
  '3D 生成（图生 3D）',
  '3d',
  {
    image: { type: 'image', required: true, description: '主体图片' },
    fileFormat: { type: 'string', enum: ['glb', 'obj', 'usd', 'usdz'], default: 'glb' },
    subdivisionLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: '面数档位（10 万 / 50 万 / 100 万）' },
  },
  async ({ provider, model, body }, values, ctx) =>
    createTask(
      MODEL3D_LABEL,
      provider,
      {
        ...body,
        model,
        content: [{ type: 'image_url', image_url: { url: values.image } }],
        ...pick(values, { fileFormat: 'file_format', subdivisionLevel: 'subdivision_level' }),
      },
      ctx,
      // 取产物时要标格式：存进句柄（进程重启后续查也拿得到）
      { fileFormat: values.fileFormat },
    ),
  {
    label: MODEL3D_LABEL,
    // 产物是一个 zip，里面是所选格式的模型文件
    outputsOf: (result, state) =>
      result.file_url ? [{ kind: '3d', url: result.file_url, mimeType: 'application/zip', meta: { fileFormat: state.fileFormat } }] : [],
  },
)

export const arkDriver = defineDriver<ArkProvider>({
  type: 'ark',
  description: '火山方舟（图片 / 视频 / 3D 生成）',
  parseProvider(fields) {
    return {
      baseUrl: fields.url('baseUrl', { default: DEFAULT_BASE_URL }),
      apiKey: fields.secret('apiKey', { required: true }) ?? '',
      pollIntervalMs: fields.integer('pollIntervalMs', { default: DEFAULT_POLL_INTERVAL_MS })!,
    }
  },
  operations: { image, video, '3d': model3d },
})
