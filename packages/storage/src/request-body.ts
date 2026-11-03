import type { Readable } from 'node:stream'
import { HttpException } from '@nestjs/common'

/** 控制器要的那点请求：Fastify 的 `request.raw` 是 Node 的流，解析器没动过它（`asset-body-parsers.ts`） */
export interface UploadRequest {
  headers: Record<string, string | string[] | undefined>
  raw: Readable
}

/** 声明的长度已经超过上限：不读就能拦 */
export function declaredTooLarge(request: UploadRequest, limit: number): boolean {
  const declared = Number(request.headers['content-length'])
  return Number.isFinite(declared) && declared > limit
}

/**
 * 边读边数，超过上限回 null。`Content-Length` 可以不带（分块编码），所以光看 {@link declaredTooLarge} 不够。
 * 不能用默认的流迭代：提前退出时它会销毁请求，连接跟着断，413 就发不出去了；剩下的字节丢弃。
 * 请求体被别的解析器读过（content-type 写成 JSON）时流已经结束，这里读到的就是空的。
 */
export async function readBody(request: UploadRequest, limit: number): Promise<Buffer<ArrayBuffer> | null> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request.raw.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > limit) break
      chunks.push(chunk)
    }
  } catch {
    // 客户端中途断开：这个响应已经没人收了
    throw new HttpException({ error: 'Bad Request', message: '请求体没有传完' }, 400)
  }
  if (size > limit) {
    request.raw.resume()
    return null
  }
  return Buffer.concat(chunks, size)
}

/** 拿整个请求体解 `multipart/form-data`（`Response` 是 Node 自带的实现）。不是合法表单回 null */
export async function parseForm(body: Buffer<ArrayBuffer>, contentType: string): Promise<FormData | null> {
  try {
    return await new Response(body, { headers: { 'content-type': contentType } }).formData()
  } catch {
    return null
  }
}
