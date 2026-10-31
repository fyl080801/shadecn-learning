import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  ASSET_MAX_PARTS,
  ASSET_PART_SIZE,
  type AssetUploadPart,
  type AssetUploadSession,
  type UploadedAsset,
} from '@shadecn/shared/canvas'
import type { AuthVariables } from '../auth/middleware.ts'
import { currentUserId, type ProjectVariables } from '../auth/project.ts'
import { s3Config } from '../config.ts'
import { assetStorage } from '../storage/index.ts'
import { flowAssets } from '../store/assets.ts'
import { assetCategory, buildAssetKey, isAssetKey } from '../storage/keys.ts'
import { storeAssetVariants, storeVariantsFromStorage } from '../storage/variants.ts'
import type { S3Client } from '../storage/s3.ts'
import { INVALID_JSON, readJson } from './params.ts'

type Env = { Variables: AuthVariables & ProjectVariables }

const MB = 1024 * 1024
/** multipart 编码 / 请求头的余量：请求体上限 = 一片 + 这点 */
const ENVELOPE = 64 * 1024

/** 整个文件最多几片：按总上限折算，完成时据此兜底（分片上传不记会话，声明的大小不可信） */
const maxPartsForLimit = () => Math.min(ASSET_MAX_PARTS, Math.ceil(s3Config.maxUploadBytes / ASSET_PART_SIZE))

const badRequest = (message: string) => ({ error: 'Bad Request', message })
const tooLarge = (message = `文件不能超过 ${Math.round(s3Config.maxUploadBytes / MB)}MB`) => ({
  error: 'Payload Too Large',
  message,
})
const UNSUPPORTED = { error: 'Unsupported Media Type', message: '只支持图片或视频' } as const
const UNAVAILABLE = { error: 'Service Unavailable', message: '未配置对象存储，不能上传' } as const
const BAD_GATEWAY = { error: 'Bad Gateway', message: '上传到对象存储失败' } as const
const FOREIGN_KEY = badRequest('key 不是本服务拼出的素材键')

/**
 * 记下「这个键是在这张画布上传的」（`FlowAsset`）：对象已经在 S3 了、回包之前写。
 * 写不进去就整个上传算失败（500）—— 回了地址却没有归属记录，之后拿它当 agent 附件会被当成别的画布的资源拒掉。
 */
async function recordAsset(c: Context<Env>, key: string, contentType: string): Promise<void> {
  await flowAssets.record({
    flowId: c.req.param('flowId')!,
    key,
    contentType,
    createdById: (await currentUserId(c)) ?? '',
  })
}

/** 拿存储；没配就直接给出 503 响应，调用方 `instanceof Response` 判一下原样返回 */
function withStorage(c: Context<Env>): S3Client | Response {
  return assetStorage() ?? c.json(UNAVAILABLE, 503)
}

/** 调 S3 出错一律 502 并记一条日志；成功原样返回 */
async function viaS3<T>(c: Context<Env>, what: string, run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run()
  } catch (err) {
    console.error(`[assets] ${what}失败:`, err)
    return c.json(BAD_GATEWAY, 502)
  }
}

function parsePartNumber(raw: string | undefined): number | null {
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

/**
 * 画布资源上传，挂在 `flows` 的 `/:flowId/*` 之下（鉴权口径同画布：非成员 404）。
 * 文件经后端转存到 S3（浏览器不碰 AK/SK），对象键的目录分层见 `storage/keys.ts`。
 * 只负责「存下来、记下归属、给地址」；把地址写进哪个节点是前端经 `store.mutate` 的事。
 * 每次成功的上传都在回包之前记一行 `FlowAsset`（键 → 这张画布 + 服务端看到的类型），见 {@link recordAsset}。
 * 图片在记录之前同步生成 `icon` / `low` 两档缩略图（`storage/variants.ts`，docs/27）；生成失败不影响上传结果。
 *
 * **不超过一片（`ASSET_PART_SIZE`）的文件一次传完**（`POST /`）；**更大的分片上传**：
 *
 * 1. `POST /multipart` `{ filename, contentType, size }` → 开 S3 分片上传，回 `{ uploadId, key, partSize, partCount }`；
 * 2. `PUT /multipart/:uploadId/parts/:partNumber?key=` 请求体是这一片的原始字节 → `{ partNumber, etag }`；
 * 3. `POST /multipart/:uploadId/complete` `{ key, parts }` → 拼成对象，回 `UploadedAsset`；
 * 4. 中途失败 `DELETE /multipart/:uploadId?key=` 放弃，S3 删掉已传的片。
 *
 * **服务端不记会话**：`uploadId` + `key` 每一步由客户端带回来，键先过 `isAssetKey`（在素材目录里、
 * 是我们拼出来的形状），S3 再校验 uploadId 和键配不配。所以多副本下每一步落到哪个实例都行。
 * 客户端半路消失留下的残片要靠桶的生命周期规则（AbortIncompleteMultipartUpload）清。
 */
export const assets = new Hono<Env>()
  .post(
    '/',
    // 先按 Content-Length / 流式计数拦超大请求，别等整个 multipart 读进内存才发现
    bodyLimit({
      maxSize: ASSET_PART_SIZE + ENVELOPE,
      onError: (c) => c.json(tooLarge(`超过 ${ASSET_PART_SIZE / MB}MB 的文件请分片上传`), 413),
    }),
    async (c) => {
      const storage = withStorage(c)
      if (storage instanceof Response) return storage

      const form = await c.req.parseBody().catch(() => null)
      const file = form?.file
      if (!(file instanceof File)) return c.json(badRequest('缺少文件（字段 file）'), 400)
      if (!assetCategory(file.type)) return c.json(UNSUPPORTED, 415)
      if (file.size > ASSET_PART_SIZE) {
        return c.json(tooLarge(`超过 ${ASSET_PART_SIZE / MB}MB 的文件请分片上传`), 413)
      }

      const key = buildAssetKey(s3Config.keyPrefix, { name: file.name, contentType: file.type })
      const body = new Uint8Array(await file.arrayBuffer())
      const url = await viaS3(c, `上传 ${key} `, () => storage.putObject(key, body, file.type))
      if (url instanceof Response) return url
      // 缩略图在记录、回包之前写好：别人看到节点时就能取到（docs/27 §3.2）
      const variants = await storeAssetVariants(storage, key, body, file.type)
      await recordAsset(c, key, file.type)

      console.info(`[assets] 已上传 ${key}（${file.type}，${file.size}B，缩略图 ${variants.join('/') || '无'}）`)
      return c.json({ url, key, contentType: file.type, size: file.size, variants } satisfies UploadedAsset, 201)
    },
  )

  .post('/multipart', async (c) => {
    const storage = withStorage(c)
    if (storage instanceof Response) return storage

    const payload = await readJson<{ filename?: unknown; contentType?: unknown; size?: unknown }>(c.req)
    if (!payload) return c.json(badRequest(INVALID_JSON), 400)
    const { filename, contentType, size } = payload
    if (typeof filename !== 'string' || typeof contentType !== 'string') {
      return c.json(badRequest('filename、contentType 必须是字符串'), 400)
    }
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
      return c.json(badRequest('size 必须是正整数'), 400)
    }
    if (!assetCategory(contentType)) return c.json(UNSUPPORTED, 415)
    if (size > s3Config.maxUploadBytes) return c.json(tooLarge(), 413)

    const key = buildAssetKey(s3Config.keyPrefix, { name: filename, contentType })
    const uploadId = await viaS3(c, `开始分片上传 ${key} `, () => storage.createMultipartUpload(key, contentType))
    if (uploadId instanceof Response) return uploadId

    const session: AssetUploadSession = {
      uploadId,
      key,
      partSize: ASSET_PART_SIZE,
      partCount: Math.ceil(size / ASSET_PART_SIZE),
    }
    return c.json(session, 201)
  })

  .put(
    '/multipart/:uploadId/parts/:partNumber',
    bodyLimit({
      maxSize: ASSET_PART_SIZE + ENVELOPE,
      onError: (c) => c.json(tooLarge(`每片不能超过 ${ASSET_PART_SIZE / MB}MB`), 413),
    }),
    async (c) => {
      const storage = withStorage(c)
      if (storage instanceof Response) return storage

      const key = c.req.query('key') ?? ''
      if (!isAssetKey(s3Config.keyPrefix, key)) return c.json(FOREIGN_KEY, 400)
      const partNumber = parsePartNumber(c.req.param('partNumber'))
      if (partNumber === null) return c.json(badRequest(`partNumber 必须是 1..${ASSET_MAX_PARTS} 的整数`), 400)

      const body = new Uint8Array(await c.req.arrayBuffer())
      if (body.byteLength === 0) return c.json(badRequest('分片不能为空'), 400)
      if (body.byteLength > ASSET_PART_SIZE) return c.json(tooLarge(`每片不能超过 ${ASSET_PART_SIZE / MB}MB`), 413)

      const uploadId = c.req.param('uploadId')
      const etag = await viaS3(c, `上传分片 ${key}#${partNumber} `, () =>
        storage.uploadPart(key, uploadId, partNumber, body),
      )
      if (etag instanceof Response) return etag
      return c.json({ partNumber, etag } satisfies AssetUploadPart)
    },
  )

  .post('/multipart/:uploadId/complete', async (c) => {
    const storage = withStorage(c)
    if (storage instanceof Response) return storage

    const payload = await readJson<{ key?: unknown; parts?: unknown }>(c.req)
    if (!payload) return c.json(badRequest(INVALID_JSON), 400)
    const key = typeof payload.key === 'string' ? payload.key : ''
    if (!isAssetKey(s3Config.keyPrefix, key)) return c.json(FOREIGN_KEY, 400)
    const parts = parseParts(payload.parts)
    if (!parts) return c.json(badRequest('parts 必须是从 1 起连续的 { partNumber, etag } 列表'), 400)
    if (parts.length > maxPartsForLimit()) return c.json(tooLarge(), 413)

    const uploadId = c.req.param('uploadId')
    const done = await viaS3(c, `完成分片上传 ${key} `, async () => {
      const url = await storage.completeMultipartUpload(key, uploadId, parts)
      // 大小、类型以 S3 上实际拼出来的为准 —— 客户端开始时声明的数不可信
      const head = await storage.headObject(key)
      return { url, head }
    })
    if (done instanceof Response) return done

    const size = done.head?.size ?? 0
    const contentType = done.head?.contentType ?? ''
    const variants = await storeVariantsFromStorage(storage, key, contentType, size)
    await recordAsset(c, key, contentType)
    console.info(
      `[assets] 已分片上传 ${key}（${contentType}，${size}B，${parts.length} 片，缩略图 ${variants.join('/') || '无'}）`,
    )
    return c.json({ url: done.url, key, contentType, size, variants } satisfies UploadedAsset, 201)
  })

  .delete('/multipart/:uploadId', async (c) => {
    const storage = withStorage(c)
    if (storage instanceof Response) return storage

    const key = c.req.query('key') ?? ''
    if (!isAssetKey(s3Config.keyPrefix, key)) return c.json(FOREIGN_KEY, 400)
    const uploadId = c.req.param('uploadId')
    const aborted = await viaS3(c, `放弃分片上传 ${key} `, () => storage.abortMultipartUpload(key, uploadId))
    if (aborted instanceof Response) return aborted
    return c.body(null, 204)
  })
