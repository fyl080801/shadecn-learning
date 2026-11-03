import { AppError } from './contract.js'
import type { RunContext } from './driver.js'

/**
 * 驱动共用的上游请求（轮询的循环在执行层，`catalog.ts`）。驱动里不写 `fetch` + 判状态码 + 解析 JSON + 截报文这一套：
 * 上游的失败一律变成 `AppError('upstream')`，报文截短进 `detail`（不把一整页 HTML 错误页塞进日志和回包）。
 */

/** 上游报文进错误信息时最多留多少字 */
const ERROR_EXCERPT_CHARS = 500

function excerpt(text: string): string {
  return text.length > ERROR_EXCERPT_CHARS ? `${text.slice(0, ERROR_EXCERPT_CHARS)}…` : text
}

/** 从上游的错误回包里挑一句人话：常见的 `{ error: { message } }` / `{ error: "..." }` / `{ message }` */
function upstreamMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
    const error = parsed.error
    if (typeof error === 'string') return error
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message
    }
    if (typeof parsed.message === 'string') return parsed.message
  } catch {
    // 不是 JSON：用原文
  }
  return excerpt(body)
}

async function send(ctx: RunContext, label: string, url: string, init: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await ctx.fetch(url, { ...init, signal: ctx.signal })
  } catch (err) {
    // 中止由执行层按哪个信号触发的归成 timeout / aborted；这里只把网络错误归成 upstream
    if (ctx.signal.aborted) throw err
    throw new AppError('upstream', `${label}：连不上上游（${err instanceof Error ? err.message : String(err)}）`)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new AppError('upstream', `${label}：上游返回 ${response.status}：${upstreamMessage(body)}`, {
      status: response.status,
      body: excerpt(body),
    })
  }
  return response
}

/** 请求上游并解析 JSON 回包。`body` 是对象时按 JSON 发 */
export async function requestJson<T>(
  ctx: RunContext,
  label: string,
  url: string,
  init: Omit<RequestInit, 'body' | 'signal'> & { body?: unknown } = {},
): Promise<T> {
  const { body, headers, ...rest } = init
  const isJsonBody = body !== undefined && !(body instanceof FormData) && typeof body !== 'string'
  const response = await send(ctx, label, url, {
    ...rest,
    headers: { ...(isJsonBody ? { 'content-type': 'application/json' } : {}), accept: 'application/json', ...headers },
    ...(body !== undefined ? { body: isJsonBody ? JSON.stringify(body) : (body as string | FormData) } : {}),
  })
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AppError('upstream', `${label}：上游回包不是 JSON`, { body: excerpt(text) })
  }
}

/** 只要上游回 2xx，不读回包（撤销任务这类回包可能为空的请求）。`body` 是对象时按 JSON 发 */
export async function requestOk(
  ctx: RunContext,
  label: string,
  url: string,
  init: Omit<RequestInit, 'body' | 'signal'> & { body?: unknown } = {},
): Promise<void> {
  const { body, headers, ...rest } = init
  const response = await send(ctx, label, url, {
    ...rest,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  await response.body?.cancel()
}

/** 读上游的二进制产物，超过 `maxBytes` 就不再读（不把一个超大文件整个读进内存） */
export async function requestBytes(
  ctx: RunContext,
  label: string,
  url: string,
  options: { maxBytes: number; headers?: Record<string, string> },
): Promise<{ data: Uint8Array; contentType: string }> {
  const response = await send(ctx, label, url, { ...(options.headers ? { headers: options.headers } : {}) })
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    await response.body?.cancel()
    throw new AppError('upstream', `${label}：产物 ${declared} 字节，超过上限 ${options.maxBytes}`)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > options.maxBytes) throw new AppError('upstream', `${label}：产物超过上限 ${options.maxBytes} 字节`)
      chunks.push(chunk)
    }
  }
  const data = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { data, contentType: response.headers.get('content-type') ?? 'application/octet-stream' }
}

/** 可中止的等待 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 按扩展名猜产物类别和类型（ComfyUI 这类只给文件名的上游用） */
const EXTENSION_TYPES: Record<string, { kind: 'image' | 'video' | '3d' | 'audio'; mimeType: string }> = {
  png: { kind: 'image', mimeType: 'image/png' },
  jpg: { kind: 'image', mimeType: 'image/jpeg' },
  jpeg: { kind: 'image', mimeType: 'image/jpeg' },
  webp: { kind: 'image', mimeType: 'image/webp' },
  gif: { kind: 'image', mimeType: 'image/gif' },
  mp4: { kind: 'video', mimeType: 'video/mp4' },
  webm: { kind: 'video', mimeType: 'video/webm' },
  mov: { kind: 'video', mimeType: 'video/quicktime' },
  glb: { kind: '3d', mimeType: 'model/gltf-binary' },
  gltf: { kind: '3d', mimeType: 'model/gltf+json' },
  obj: { kind: '3d', mimeType: 'model/obj' },
  usdz: { kind: '3d', mimeType: 'model/vnd.usdz+zip' },
  wav: { kind: 'audio', mimeType: 'audio/wav' },
  mp3: { kind: 'audio', mimeType: 'audio/mpeg' },
  flac: { kind: 'audio', mimeType: 'audio/flac' },
}

export function fileTypeOf(filename: string): { kind: 'image' | 'video' | '3d' | 'audio' | 'file'; mimeType?: string } {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? ''
  return EXTENSION_TYPES[ext] ?? { kind: 'file' }
}

/** 解开 `data:<type>;base64,<data>`；不是这个形状返回 null */
export function decodeDataUrl(value: string): { data: Uint8Array; mimeType: string } | null {
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value)
  if (!match) return null
  return { mimeType: match[1]!.toLowerCase(), data: new Uint8Array(Buffer.from(match[2]!, 'base64')) }
}
