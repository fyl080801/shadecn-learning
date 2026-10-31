import sharp from 'sharp'
import { ASSET_VARIANTS, ASSET_VARIANT_SPECS, assetVariantPath, type AssetVariant } from '@shadecn/shared/canvas'
import type { S3Client } from './s3.ts'

/**
 * 上传时生成缩略图（docs/27）：`icon` / `low` 两档 webp，和原图同目录（键由 `assetVariantPath` 推）。
 *
 * MinIO 没有图片处理能力，所以在上传接口里同步做 —— 回包之前缩略图就已经在桶里了，别的协作者看到节点时能直接取。
 * **从不抛错**：原图已经存好，缩略图只是锦上添花；失败只记日志、回已经写成的那几档，前端取不到会退回原图。
 */

/** 生成缩略图的类型；SVG（矢量）、HEIC 等不在其中 */
const VARIANT_SOURCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])

/** 分片上传的图片超过这个大小不读回来生成（读回来要整个进内存） */
export const VARIANT_SOURCE_MAX_BYTES = 32 * 1024 * 1024

/** 原图像素上限（约 8000×8000）：防解压炸弹 —— 几 KB 的文件也能声明几十亿像素 */
export const VARIANT_SOURCE_MAX_PIXELS = 64_000_000

// 服务端进程里不需要 libvips 的操作缓存，一直占着内存反而碍事
sharp.cache(false)

export function wantsVariants(contentType: string): boolean {
  return VARIANT_SOURCE_TYPES.has((contentType.split(';')[0] ?? '').trim().toLowerCase())
}

/** 按规格缩一档：只缩不放、按 EXIF 转正、保留比例 */
async function render(body: Uint8Array, variant: AssetVariant): Promise<Uint8Array> {
  const spec = ASSET_VARIANT_SPECS[variant]
  const image = sharp(body, { animated: spec.animated, limitInputPixels: VARIANT_SOURCE_MAX_PIXELS })
  const out = await image
    .autoOrient()
    .resize({ width: spec.maxEdge, height: spec.maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: spec.quality })
    .toBuffer()
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

/**
 * 给原图 `key` 生成并写入各档缩略图，回成功写入的那几档（按 `ASSET_VARIANTS` 的顺序）。
 * 类型不在名单里、键推不出档位（比如 `.svg`）→ 空数组，不做任何事。
 */
export async function storeAssetVariants(
  storage: S3Client,
  key: string,
  body: Uint8Array,
  contentType: string,
  variants: readonly AssetVariant[] = ASSET_VARIANTS,
): Promise<AssetVariant[]> {
  if (!wantsVariants(contentType)) return []
  const done: AssetVariant[] = []
  for (const variant of variants) {
    const variantKey = assetVariantPath(key, variant)
    if (!variantKey) return done
    try {
      const out = await render(body, variant)
      await storage.putObject(variantKey, out, 'image/webp')
      done.push(variant)
    } catch (err) {
      // 解码失败 / 超像素上限对每一档都一样，不必再试下一档
      console.warn(`[assets] 生成缩略图失败 key=${key} variant=${variant}:`, err instanceof Error ? err.message : err)
      return done
    }
  }
  return done
}

/**
 * 分片上传完成后用：对象已经拼在 S3 上了，是要生成的图片且不太大就读回来生成。
 * 读失败同样只记日志、回空数组。
 */
export async function storeVariantsFromStorage(
  storage: S3Client,
  key: string,
  contentType: string,
  size: number,
  variants: readonly AssetVariant[] = ASSET_VARIANTS,
): Promise<AssetVariant[]> {
  if (!wantsVariants(contentType) || !assetVariantPath(key, 'icon')) return []
  if (size > VARIANT_SOURCE_MAX_BYTES) {
    console.info(`[assets] 原图 ${size}B 超过 ${VARIANT_SOURCE_MAX_BYTES}B，不生成缩略图 key=${key}`)
    return []
  }
  let got
  try {
    got = await storage.getObject(key, { maxBytes: VARIANT_SOURCE_MAX_BYTES })
  } catch (err) {
    console.warn(`[assets] 读回原图失败，不生成缩略图 key=${key}:`, err instanceof Error ? err.message : err)
    return []
  }
  if (got.status !== 'ok') return []
  return storeAssetVariants(storage, key, got.body, contentType, variants)
}


// —— 补档（docs/27 §3.3）——

/** 同时最多几张图在补档：老画布一打开几十张没缩略图的图，别一下子全读进内存解码 */
const BACKFILL_CONCURRENCY = 2

/**
 * 补不出来的原图（类型不对、太大、图片损坏）记一阵，别每个人每次打开都读一遍原图再失败一次。
 * 只记一阵而不是永远：写 S3 偶尔失败也会落到这里，过了这段时间就再试。
 */
const UNBACKFILLABLE_TTL_MS = 10 * 60 * 1000
const UNBACKFILLABLE_MAX = 5000

/** 同一张原图正在补：多人同时打开、同一画布里重复用一张图，都等同一次 */
const inFlight = new Map<string, Promise<AssetVariant[]>>()
/** 原图键 → 到什么时候之前不再试 */
const unbackfillable = new Map<string, number>()
let running = 0
const waiting: (() => void)[] = []

async function withSlot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= BACKFILL_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve))
  running += 1
  try {
    return await run()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

/**
 * 补生成原图 `key` 缺的那几档，回补完之后**桶里有的**档（按 `ASSET_VARIANTS` 的顺序）。
 *
 * 先逐档 HEAD：都在就什么都不做（别人刚补过、或者前端只是图片加载失败）。缺的才读回原图、只生成缺的那几档，
 * 规则同分片上传完成后（类型名单、大小上限、像素上限）。原图不存在、补不出来 → 只回已有的。
 * 生成失败只记日志（同上传）；**HEAD / 读 S3 出错照常抛**，由路由回 502 —— 那是存储的问题，不是这张图的。
 */
export function backfillAssetVariants(storage: S3Client, key: string): Promise<AssetVariant[]> {
  const pending = inFlight.get(key)
  if (pending) return pending
  const task = backfill(storage, key).finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

/** 测试用：清掉「补不出来」的记忆和进行中的任务 */
export function resetVariantBackfill(): void {
  inFlight.clear()
  unbackfillable.clear()
}

async function backfill(storage: S3Client, key: string): Promise<AssetVariant[]> {
  const present: AssetVariant[] = []
  const missing: AssetVariant[] = []
  for (const variant of ASSET_VARIANTS) {
    const variantKey = assetVariantPath(key, variant)
    if (!variantKey) return []
    if (await storage.headObject(variantKey)) present.push(variant)
    else missing.push(variant)
  }
  if (missing.length === 0) return present
  const retryAt = unbackfillable.get(key)
  if (retryAt !== undefined) {
    if (Date.now() < retryAt) return present
    unbackfillable.delete(key)
  }

  const source = await storage.headObject(key)
  if (!source) return present
  const made = await withSlot(() => storeVariantsFromStorage(storage, key, source.contentType, source.size, missing))
  if (made.length === 0) {
    if (unbackfillable.size >= UNBACKFILLABLE_MAX) unbackfillable.clear()
    unbackfillable.set(key, Date.now() + UNBACKFILLABLE_TTL_MS)
  } else {
    console.info(`[assets] 已补生成缩略图 ${key}（${made.join('/')}）`)
  }
  return ASSET_VARIANTS.filter((variant) => present.includes(variant) || made.includes(variant))
}
