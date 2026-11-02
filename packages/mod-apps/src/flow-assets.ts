import type { StorageService } from '@shadecn/mod-storage/contract'
import type { AppInfo, AppOutput, AppResult } from './contract.ts'
import { requestBytes } from './http.ts'

/**
 * 画布执行（docs/29 §3.8）和对象存储之间的那一段：
 *
 * - **进**：图片参数里**属于这张画布**的资源地址（上游节点的 `src`）换成 data URL —— 字节由存储模块按键读（`storage.assets.read`），
 *   从不请求那个地址；不是本画布资源的地址原样留着，交给驱动自己的规则（方舟收地址，ComfyUI / LLM 只收 data URL 会拒）；
 * - **出**：图片 / 视频产物存成这张画布的资源（`storage.assets.save`），回包里的 `url` 换成本服务的地址 ——
 *   上游地址会过期（方舟 24 小时）、或者浏览器到不了（ComfyUI）。存失败的那一个保留原样并打日志，不让整次生成失败。
 *
 * 没有对象存储（模块没加载）时两头都原样，画布节点拿到的就是上游地址。
 */

/** 一张参考图最多读多少（方舟单张 30MB） */
const MAX_INPUT_BYTES = 30 * 1024 * 1024
/** 取一个上游产物最多读多少、等多久 */
const MAX_OUTPUT_BYTES = 200 * 1024 * 1024
const OUTPUT_FETCH_TIMEOUT_MS = 120_000

const isImageParam = (app: AppInfo, name: string) => {
  const type = app.params[name]?.type
  return type === 'image' || type === 'images'
}

export async function inlineFlowAssets(
  storage: StorageService | undefined,
  flowId: string,
  app: AppInfo,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!storage) return params
  const toDataUrl = async (value: unknown): Promise<unknown> => {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value
    const asset = await storage.assets.read(flowId, value, { maxBytes: MAX_INPUT_BYTES, signal })
    return asset ? `data:${asset.contentType};base64,${Buffer.from(asset.data).toString('base64')}` : value
  }
  const out: Record<string, unknown> = { ...params }
  for (const [name, value] of Object.entries(params)) {
    if (!isImageParam(app, name)) continue
    out[name] = Array.isArray(value) ? await Promise.all(value.map(toDataUrl)) : await toDataUrl(value)
  }
  return out
}

const STORABLE = (output: AppOutput) =>
  (output.kind === 'image' || output.kind === 'video') && (output.data !== undefined || (output.url !== undefined && /^https:\/\//i.test(output.url)))

export async function persistFlowOutputs(
  storage: StorageService | undefined,
  input: { flowId: string; userId: string; result: AppResult },
): Promise<AppResult> {
  if (!storage) return input.result
  const outputs = await Promise.all(
    input.result.outputs.map(async (output): Promise<AppOutput> => {
      if (!STORABLE(output)) return output
      try {
        let data = output.data
        let contentType = output.mimeType
        if (!data) {
          // 地址来自管理员配置的上游（不是调用方给的）；只收 https，字节有上限
          const fetched = await requestBytes(
            { signal: AbortSignal.timeout(OUTPUT_FETCH_TIMEOUT_MS), fetch: (url, init) => globalThis.fetch(url, init) },
            '取生成结果',
            output.url!,
            { maxBytes: MAX_OUTPUT_BYTES },
          )
          data = fetched.data
          contentType ??= fetched.contentType.split(';')[0]!.trim()
        }
        contentType ??= output.kind === 'image' ? 'image/png' : 'video/mp4'
        const saved = await storage.assets.save({ flowId: input.flowId, createdById: input.userId, data, contentType })
        return { kind: output.kind, url: saved.url, mimeType: saved.contentType, meta: { ...output.meta, assetKey: saved.key, size: saved.size } }
      } catch (err) {
        console.warn(`[apps] ${input.result.appId} 的产物没能存进画布资源，保留上游地址`, err)
        return output
      }
    }),
  )
  return { ...input.result, outputs }
}
