import { FlowMemberGuard } from '@learning/canvas'
import {
  ASSET_MAX_PARTS,
  ASSET_PART_SIZE,
  type AssetUploadPart,
  type AssetUploadSession,
  type AssetVariantBackfill,
  type UploadedAsset,
} from '@learning/contracts/canvas'
import { CurrentUser, type SessionUser } from '@learning/session'
import { Body, Controller, Delete, HttpCode, HttpException, Inject, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { FlowAssets } from './flow-assets.js'
import { assetCategory, assetKeyOfUrl, buildAssetKey, isAssetKey } from './keys.js'
import { STORAGE_OPTIONS, type StorageOptions } from './options.js'
import { declaredTooLarge, parseForm, readBody, type UploadRequest } from './request-body.js'
import { S3_CLIENT } from './s3-client.provider.js'
import type { S3Client } from './s3.js'
import { VariantBackfill, storeAssetVariants, storeVariantsFromStorage } from './variants.js'

const MB = 1024 * 1024
/** multipart 编码 / 请求头的余量：请求体上限 = 一片 + 这点 */
const ENVELOPE = 64 * 1024
const INVALID_JSON = '请求体不是合法 JSON'

const fail = (status: number, error: string, message: string) => new HttpException({ error, message }, status)
const badRequest = (message: string) => fail(400, 'Bad Request', message)
const tooLarge = (message: string) => fail(413, 'Payload Too Large', message)
const unsupported = () => fail(415, 'Unsupported Media Type', '只支持图片或视频')
const foreignKey = () => badRequest('key 不是本服务拼出的素材键')

function parsePartNumber(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= ASSET_MAX_PARTS ? n : null
}

/** 完成时交回的片号必须从 1 起连续升序 —— 漏了一片 S3 也会拼，拼出来就是坏文件 */
function parseParts(value: unknown): AssetUploadPart[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const parts: AssetUploadPart[] = []
  for (const [index, item] of value.entries()) {
    const { partNumber, etag } = (item ?? {}) as Record<string, unknown>
    if (partNumber !== index + 1 || typeof etag !== 'string' || etag === '' || etag.length > 256) return null
    parts.push({ partNumber, etag })
  }
  return parts
}

/** JSON 请求体。解析不了的由 Fastify 在路由之前拦下（`CanvasBodyErrorFilter` 给同一句话），这里挡 `null`、数字这些 */
function jsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) throw badRequest(INVALID_JSON)
  return raw as Record<string, unknown>
}

/** 查询参数和请求头：同名出现多次时取第一个 */
const firstText = (value: unknown): string => (Array.isArray(value) ? firstText(value[0]) : typeof value === 'string' ? value : '')

/**
 * 画布资源上传（docs/13 §3.7、docs/27）。挂在 `/api/flows/:flowId` 下，鉴权口径同画布：非成员 404。
 * 文件经后端转存到 S3（浏览器不碰密钥），对象键的目录分层见 `keys.ts`。只负责「存下来、记下归属、给地址」；把地址写进哪个节点是前端的事。
 * 每次成功的上传都在回包之前记一行 `FlowAsset`；图片在记录之前同步生成缩略图，失败不影响上传结果。
 *
 * **不超过一片（`ASSET_PART_SIZE`）的文件一次传完**（`POST /`）；**更大的分片上传**：开始 `POST /multipart` → 逐片 `PUT /multipart/:uploadId/parts/:partNumber?key=` → 完成 `POST /multipart/:uploadId/complete`，中途失败 `DELETE /multipart/:uploadId?key=`。
 * **服务端不记会话**：`uploadId` + `key` 每一步由客户端带回来，键先过 `isAssetKey`，S3 再校验 uploadId 和键配不配，所以多副本下每一步落到哪个实例都行。客户端半路消失留下的残片靠桶的生命周期规则清。
 *
 * 带文件字节的两个路由读 `req.raw`，不用 `@Body()`：见 `asset-body-parsers.ts`。
 */
@Controller('api/flows/:flowId/assets')
@UseGuards(FlowMemberGuard)
export class AssetsController {
  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client | null,
    @Inject(STORAGE_OPTIONS) private readonly options: StorageOptions,
    @Inject(FlowAssets) private readonly assets: FlowAssets,
    @Inject(VariantBackfill) private readonly backfill: VariantBackfill,
  ) {}

  /** 没配存储就是 503 */
  private storage(): S3Client {
    if (!this.client) throw fail(503, 'Service Unavailable', '未配置对象存储，不能上传')
    return this.client
  }

  /** 调 S3 出错一律 502 并记一条日志 */
  private async viaS3<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      console.error(`[assets] ${what}失败:`, err)
      throw fail(502, 'Bad Gateway', '上传到对象存储失败')
    }
  }

  private get keyPrefix(): string {
    return this.options.keyPrefix
  }

  /** 整个文件最多几片：按总上限折算，完成时据此兜底（分片上传不记会话，声明的大小不可信） */
  private get maxParts(): number {
    return Math.min(ASSET_MAX_PARTS, Math.ceil(this.options.maxUploadBytes / ASSET_PART_SIZE))
  }

  private get uploadLimitMessage(): string {
    return `文件不能超过 ${Math.round(this.options.maxUploadBytes / MB)}MB`
  }

  @Post()
  async upload(@CurrentUser() user: SessionUser, @Param('flowId') flowId: string, @Req() request: UploadRequest): Promise<UploadedAsset> {
    const singleLimit = () => tooLarge(`超过 ${ASSET_PART_SIZE / MB}MB 的文件请分片上传`)
    if (declaredTooLarge(request, ASSET_PART_SIZE + ENVELOPE)) throw singleLimit()
    const storage = this.storage()

    const body = await readBody(request, ASSET_PART_SIZE + ENVELOPE)
    if (!body) throw singleLimit()
    const contentType = firstText(request.headers['content-type'])
    const form = await parseForm(body, contentType)
    const file = form?.get('file')
    if (!(file instanceof File)) throw badRequest('缺少文件（字段 file）')
    if (!assetCategory(file.type)) throw unsupported()
    if (file.size > ASSET_PART_SIZE) throw singleLimit()

    const key = buildAssetKey(this.keyPrefix, { name: file.name, contentType: file.type })
    const bytes = new Uint8Array(await file.arrayBuffer())
    const url = await this.viaS3(`上传 ${key} `, () => storage.putObject(key, bytes, file.type))
    // 缩略图在记录、回包之前写好：别人看到节点时就能取到（docs/27 §3.2）
    const variants = await storeAssetVariants(storage, key, bytes, file.type)
    // 写不进去就整个上传算失败（500）：回了地址却没有归属记录，之后拿它当附件会被当成别的画布的资源拒掉
    await this.assets.record({ flowId, key, contentType: file.type, createdById: user.id })

    console.info(`[assets] 已上传 ${key}（${file.type}，${file.size}B，缩略图 ${variants.join('/') || '无'}）`)
    return { url, key, contentType: file.type, size: file.size, variants }
  }

  @Post('multipart')
  async startMultipart(@Body() raw: unknown): Promise<AssetUploadSession> {
    const storage = this.storage()
    const { filename, contentType, size } = jsonObject(raw)
    if (typeof filename !== 'string' || typeof contentType !== 'string') throw badRequest('filename、contentType 必须是字符串')
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) throw badRequest('size 必须是正整数')
    if (!assetCategory(contentType)) throw unsupported()
    if (size > this.options.maxUploadBytes) throw tooLarge(this.uploadLimitMessage)

    const key = buildAssetKey(this.keyPrefix, { name: filename, contentType })
    const uploadId = await this.viaS3(`开始分片上传 ${key} `, () => storage.createMultipartUpload(key, contentType))
    return { uploadId, key, partSize: ASSET_PART_SIZE, partCount: Math.ceil(size / ASSET_PART_SIZE) }
  }

  @Put('multipart/:uploadId/parts/:partNumber')
  async uploadPart(
    @Param('uploadId') uploadId: string,
    @Param('partNumber') rawPartNumber: string,
    @Query('key') rawKey: unknown,
    @Req() request: UploadRequest,
  ): Promise<AssetUploadPart> {
    const partLimit = () => tooLarge(`每片不能超过 ${ASSET_PART_SIZE / MB}MB`)
    if (declaredTooLarge(request, ASSET_PART_SIZE + ENVELOPE)) throw partLimit()
    const storage = this.storage()

    const key = firstText(rawKey)
    if (!isAssetKey(this.keyPrefix, key)) throw foreignKey()
    const partNumber = parsePartNumber(rawPartNumber)
    if (partNumber === null) throw badRequest(`partNumber 必须是 1..${ASSET_MAX_PARTS} 的整数`)

    const body = await readBody(request, ASSET_PART_SIZE)
    if (!body) throw partLimit()
    if (body.byteLength === 0) throw badRequest('分片不能为空')

    const etag = await this.viaS3(`上传分片 ${key}#${partNumber} `, () => storage.uploadPart(key, uploadId, partNumber, body))
    return { partNumber, etag }
  }

  @Post('multipart/:uploadId/complete')
  async completeMultipart(
    @CurrentUser() user: SessionUser,
    @Param('flowId') flowId: string,
    @Param('uploadId') uploadId: string,
    @Body() raw: unknown,
  ): Promise<UploadedAsset> {
    const storage = this.storage()
    const payload = jsonObject(raw)
    const key = typeof payload.key === 'string' ? payload.key : ''
    if (!isAssetKey(this.keyPrefix, key)) throw foreignKey()
    const parts = parseParts(payload.parts)
    if (!parts) throw badRequest('parts 必须是从 1 起连续的 { partNumber, etag } 列表')
    if (parts.length > this.maxParts) throw tooLarge(this.uploadLimitMessage)

    const done = await this.viaS3(`完成分片上传 ${key} `, async () => {
      const url = await storage.completeMultipartUpload(key, uploadId, parts)
      // 大小、类型以 S3 上实际拼出来的为准 —— 客户端开始时声明的数不可信
      const head = await storage.headObject(key)
      return { url, head }
    })

    const size = done.head?.size ?? 0
    const contentType = done.head?.contentType ?? ''
    const variants = await storeVariantsFromStorage(storage, key, contentType, size)
    await this.assets.record({ flowId, key, contentType, createdById: user.id })
    console.info(`[assets] 已分片上传 ${key}（${contentType}，${size}B，${parts.length} 片，缩略图 ${variants.join('/') || '无'}）`)
    return { url: done.url, key, contentType, size, variants }
  }

  /**
   * 补缩略图：`src` 是节点里存的原图地址。只认本服务桶里、素材目录下的键（外部链接 400），
   * 并且这个键**经本服务上传过**（`FlowAsset` 里有，哪张画布都算 —— 复制画布后节点仍指着原画布传的图；没有记录 404）。
   * 判权只到「是这张画布的成员」：缩略图是从原图推出来的，补不补不改变谁能看到什么。回补完之后有的档；已经齐了就什么都不做。
   */
  @Post('variants')
  @HttpCode(200)
  async backfillVariants(@Body() raw: unknown): Promise<AssetVariantBackfill> {
    const storage = this.storage()
    const { src } = jsonObject(raw)
    if (typeof src !== 'string') throw badRequest('src 必须是字符串')
    const key = assetKeyOfUrl(src, storage.objectUrl(''), this.keyPrefix)
    if (!key) throw badRequest('src 不是本服务的素材地址')
    if (!(await this.assets.exists(key))) throw fail(404, 'Not Found', '没有这个素材')

    const variants = await this.viaS3(`补缩略图 ${key} `, () => this.backfill.backfill(storage, key))
    return { variants }
  }

  @Delete('multipart/:uploadId')
  @HttpCode(204)
  async abortMultipart(@Param('uploadId') uploadId: string, @Query('key') rawKey: unknown): Promise<void> {
    const storage = this.storage()
    const key = firstText(rawKey)
    if (!isAssetKey(this.keyPrefix, key)) throw foreignKey()
    await this.viaS3(`放弃分片上传 ${key} `, () => storage.abortMultipartUpload(key, uploadId))
  }
}
