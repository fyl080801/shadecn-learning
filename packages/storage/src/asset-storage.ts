import { Inject, Injectable } from '@nestjs/common'
import { FlowAssets, type FlowAssetRecord } from './flow-assets.js'
import { assetCategory, assetKeyOfUrl, buildAssetKey } from './keys.js'
import { STORAGE_OPTIONS, type StorageOptions } from './options.js'
import { S3_CLIENT } from './s3-client.provider.js'
import type { S3Client } from './s3.js'
import { storeAssetVariants } from './variants.js'

export interface SaveFlowAssetInput {
  flowId: string
  createdById: string
  data: Uint8Array
  contentType: string
  /** 文件名（只取扩展名，给人看的） */
  name?: string
}

export interface SavedFlowAsset {
  url: string
  key: string
  contentType: string
  size: number
}

/**
 * {@link AssetStorage.readByUrl} 的结果。S3 本身出错（连不上、5xx）不在这里，会 reject：调用方要分得清「不是我们的」和「现在读不了」。
 * - `unavailable`：没配对象存储；
 * - `foreign`：不是本桶素材目录里的地址，**一个请求都没发**；
 * - `not_found`：对象没了；
 * - `too_large`：超过 `maxBytes`，没读完就掐断了。
 */
export type AssetReadResult =
  | { status: 'ok'; data: Uint8Array; contentType: string }
  | { status: 'unavailable' | 'foreign' | 'not_found' | 'too_large' }

const EXTENSION_OF: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
}

/**
 * 别的模块（生成节点、agent）读写画布资源的入口，不碰 S3 客户端和键规则。没配对象存储时 {@link available} 是 false，调用方按「没有对象存储」退化。
 *
 * - **存**：和浏览器上传同一套 —— 键由 `buildAssetKey` 拼、图片同步出缩略图、记一行 `FlowAsset`（归这张画布）；
 * - **读**：只读**这张画布自己的**资源。地址先经 `assetKeyOfUrl` 反解成本桶素材键（字符串比对，不发请求），
 *   再查 `FlowAsset` 归属；任何一步对不上都是 null —— 调用方据此知道「不是我们的资源」，**绝不去请求那个地址**（防 SSRF）；
 * - **按地址读**（{@link readByUrl}）：只判「是不是本桶的素材」，不查归属。复制画布只带地址、不带记录（`docs/30` §7），复制出来的画布上 {@link read} 读不到。
 *   防 SSRF 的规则不变：同一个 `assetKeyOfUrl`，请求按反解出的键发，从不请求传进来的地址。
 *
 * 这里不判「谁在要」：判权归调用方（路由的 `FlowMemberGuard`、agent 的 Grant）。
 */
@Injectable()
export class AssetStorage {
  /** 对象键的根目录（`storage.keyPrefix`） */
  readonly keyPrefix: string

  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client | null,
    @Inject(STORAGE_OPTIONS) options: StorageOptions,
    @Inject(FlowAssets) private readonly assets: FlowAssets,
  ) {
    this.keyPrefix = options.keyPrefix
  }

  get available(): boolean {
    return this.client !== null
  }

  /** 对象的公开地址（写进节点、浏览器直接读的那个）。没配对象存储 → null */
  objectUrl(key: string): string | null {
    return this.client ? this.client.objectUrl(key) : null
  }

  /** 这些键里**属于这张画布**的那些，按 `keys` 的顺序；条数对不上 = 有不属于这张画布的 */
  findInFlow(flowId: string, keys: readonly string[]): Promise<FlowAssetRecord[]> {
    return this.assets.findInFlow(flowId, keys)
  }

  /** 服务端产出的字节存成这张画布的资源。只收图片 / 视频（同上传接口），别的类型、没配对象存储都抛错 */
  async save(input: SaveFlowAssetInput): Promise<SavedFlowAsset> {
    if (!assetCategory(input.contentType)) throw new Error(`不支持的资源类型：${input.contentType}`)
    if (!this.client) throw new Error('服务端没有配置对象存储')
    const name = input.name ?? `generated${EXTENSION_OF[input.contentType] ?? ''}`
    const key = buildAssetKey(this.keyPrefix, { name, contentType: input.contentType })
    const url = await this.client.putObject(key, input.data, input.contentType)
    // 缩略图在记录之前写好（同上传接口，docs/27 §3.2）；生成失败不影响结果
    const variants = await storeAssetVariants(this.client, key, input.data, input.contentType)
    await this.assets.record({ flowId: input.flowId, key, contentType: input.contentType, createdById: input.createdById })
    console.info(`[assets] 已存入生成结果 ${key}（${input.contentType}，${input.data.byteLength}B，缩略图 ${variants.join('/') || '无'}）`)
    return { url, key, contentType: input.contentType, size: input.data.byteLength }
  }

  /** 读这张画布自己的资源字节。不是本桶的地址、不属于这张画布、对象没了 → null；超过 `maxBytes` 抛错 */
  async read(flowId: string, url: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<{ data: Uint8Array; contentType: string } | null> {
    if (!this.client) return null
    const key = assetKeyOfUrl(url, this.client.objectUrl(''), this.keyPrefix)
    if (!key) return null
    const [owned] = await this.assets.findInFlow(flowId, [key])
    if (!owned) return null
    const got = await this.client.getObject(key, options)
    if (got.status === 'not_found') return null
    if (got.status === 'too_large') throw new Error(`资源超过 ${options.maxBytes} 字节`)
    return { data: got.body, contentType: owned.contentType }
  }

  /**
   * 按地址读本桶的素材，**不查归属**：只要键在素材目录里、是我们拼出来的形状就读，类型以 S3 记的为准（没有记录可查）。
   * 这里不判「谁在要」，调用方必须已经判过这个人能看这个地址所在的节点（agent 的 `flow:read`）。
   */
  async readByUrl(url: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<AssetReadResult> {
    if (!this.client) return { status: 'unavailable' }
    const key = assetKeyOfUrl(url, this.client.objectUrl(''), this.keyPrefix)
    if (!key) return { status: 'foreign' }
    const got = await this.client.getObject(key, options)
    if (got.status !== 'ok') return got
    return { status: 'ok', data: got.body, contentType: got.contentType }
  }
}
