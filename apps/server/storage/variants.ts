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
): Promise<AssetVariant[]> {
  if (!wantsVariants(contentType)) return []
  const done: AssetVariant[] = []
  for (const variant of ASSET_VARIANTS) {
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
  return storeAssetVariants(storage, key, got.body, contentType)
}
