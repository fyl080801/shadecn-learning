import type { ImageContent, TextContent } from '@mariozechner/pi-ai'

/**
 * 节点素材的读取接口与图片内容的处理 —— `view_node_media` 工具（docs/20 §3.10.7）用。
 *
 * **本包不认识对象存储**：素材在哪个桶、地址怎么反解成对象键、凭据是什么，全是宿主的事
 * （apps/server 的 `agent/media.ts`，按 key 经 `storage/` 读）。这里只定接口、限额与「字节到底是不是图」的判断。
 * 这个文件 runner 也会 import（经 `tools.ts` / `protocol.ts`），所以只能有纯函数和类型。
 */

/** 一个素材对象的内容 */
export interface MediaAsset {
  data: Uint8Array
  /** 对象存储记的类型（上传时定的，不可信：以 {@link sniffImageType} 嗅出来的为准） */
  contentType: string
}

/**
 * 读不到的原因 —— 工具按它给模型一句话，宿主的细节（桶名、S3 错误码）不进模型上下文：
 * - `foreign`：地址不是本项目对象存储里的素材（外部链接、别的桶 / 前缀、形状不对）。**宿主对它不发任何请求**；
 * - `not_found`：对象不存在；
 * - `too_large`：超过给的 `maxBytes`（宿主不把整个对象读进内存）；
 * - `unavailable`：没配对象存储 / 存储出错。
 */
export type MediaReadFailure = 'foreign' | 'not_found' | 'too_large' | 'unavailable'

export class MediaReadError extends Error {
  readonly kind: MediaReadFailure
  constructor(kind: MediaReadFailure, message: string) {
    super(message)
    this.name = 'MediaReadError'
    this.kind = kind
  }
}

/** 宿主注入的素材读取：**只读宿主自己对象存储里的对象**，任何别的地址都抛 `foreign`、不发请求（防 SSRF） */
export interface MediaReader {
  read(url: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<MediaAsset>
}

/** 交给模型的图片类型（各家多模态接口都认的这四种） */
export const VIEWABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ViewableImageType = (typeof VIEWABLE_IMAGE_TYPES)[number]

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte)

/**
 * 按文件头认图片类型；认不出（或不是那四种）返回 null。
 * 对象存储记的 content-type 是上传时客户端给的：把一段不是图的字节标成 `image/png` 交给模型，
 * 上游会拒掉**整个**模型请求（这一轮就失败了），所以宁可在工具里拒掉这一张。
 */
export function sniffImageType(bytes: Uint8Array): ViewableImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return null
}

/**
 * 图片块在**对话历史**里换成的那句话。
 *
 * 图片只在**这一轮**的模型上下文里（runner 里 pi 的内存）：上报的事件、落库的模型上下文、给前端的工具结果
 * 一律把图片块换成这句话（`protocol.ts` 两端都换）。否则一张 5MB 的图要 base64 成 6.7MB 塞进事件上报
 * （请求体上限 4MB）、落进会话表、之后每一轮都整段重发给模型。代价是下一轮模型看不到上一轮看过的图 ——
 * 话里写明了，要看就再调一次。
 */
export function imagePlaceholder(mimeType: string, base64Length: number): TextContent {
  const kb = Math.max(1, Math.round((base64Length * 3) / 4 / 1024))
  return {
    type: 'text',
    text: `[图片 ${mimeType}，约 ${kb} KB：已在当时交给模型查看，对话记录里不保留图片内容；需要再看请重新调用 view_node_media]`,
  }
}

function isImageBlock(value: unknown): value is ImageContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'image'
  )
}

/** 一组内容块里的图片块换成文字占位；没有图片块时原样返回同一个数组 */
export function withoutImages<T>(content: readonly T[]): T[] {
  if (!content.some(isImageBlock)) return content as T[]
  return content.map((part) => {
    if (!isImageBlock(part)) return part
    const mimeType = typeof part.mimeType === 'string' ? part.mimeType.slice(0, 64) : '未知类型'
    const length = typeof part.data === 'string' ? part.data.length : 0
    return imagePlaceholder(mimeType, length) as T
  })
}
