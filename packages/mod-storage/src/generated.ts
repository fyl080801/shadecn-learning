import { flowAssets } from './assets.ts'
import { assetStorage } from './client.ts'
import type { SaveFlowAssetInput, SavedFlowAsset } from './contract.ts'
import { assetCategory, assetKeyOfUrl, buildAssetKey } from './keys.ts'
import { storeAssetVariants } from './variants.ts'

/**
 * 服务端自己读写画布资源（docs/29 §3.8，生成节点）：别的模块经 `storage` 服务调，不碰 S3 客户端和键规则。
 *
 * - **存**：和浏览器上传同一套 —— 键由 `buildAssetKey` 拼、图片同步出缩略图、记一行 `FlowAsset`（归这张画布）；
 * - **读**：只读**这张画布自己的**资源。地址先经 `assetKeyOfUrl` 反解成本桶素材键（字符串比对，不发请求），
 *   再查 `FlowAsset` 归属；任何一步对不上都是 null —— 调用方据此知道「不是我们的资源」，**绝不去请求那个地址**（防 SSRF）。
 */

const EXTENSION_OF: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
}

function requireStorage() {
  const storage = assetStorage()
  if (!storage) throw new Error('服务端没有配置对象存储')
  return storage
}

export async function saveFlowAsset(keyPrefix: string, input: SaveFlowAssetInput): Promise<SavedFlowAsset> {
  if (!assetCategory(input.contentType)) throw new Error(`不支持的资源类型：${input.contentType}`)
  const storage = requireStorage()
  const name = input.name ?? `generated${EXTENSION_OF[input.contentType] ?? ''}`
  const key = buildAssetKey(keyPrefix, { name, contentType: input.contentType })
  const url = await storage.putObject(key, input.data, input.contentType)
  // 缩略图在记录之前写好（同上传接口，docs/27 §3.2）；生成失败不影响结果
  const variants = await storeAssetVariants(storage, key, input.data, input.contentType)
  await flowAssets.record({ flowId: input.flowId, key, contentType: input.contentType, createdById: input.createdById })
  console.info(`[assets] 已存入生成结果 ${key}（${input.contentType}，${input.data.byteLength}B，缩略图 ${variants.join('/') || '无'}）`)
  return { url, key, contentType: input.contentType, size: input.data.byteLength }
}

export async function readFlowAsset(
  keyPrefix: string,
  flowId: string,
  url: string,
  options: { maxBytes: number; signal?: AbortSignal },
): Promise<{ data: Uint8Array; contentType: string } | null> {
  const storage = assetStorage()
  if (!storage) return null
  const key = assetKeyOfUrl(url, storage.objectUrl(''), keyPrefix)
  if (!key) return null
  const [owned] = await flowAssets.findInFlow(flowId, [key])
  if (!owned) return null
  const got = await storage.getObject(key, options)
  if (got.status === 'not_found') return null
  if (got.status === 'too_large') throw new Error(`资源超过 ${options.maxBytes} 字节`)
  return { data: got.body, contentType: owned.contentType }
}
