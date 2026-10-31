import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { S3Client } from '../../storage/s3.ts'
import {
  storeAssetVariants,
  storeVariantsFromStorage,
  VARIANT_SOURCE_MAX_BYTES,
  wantsVariants,
} from '../../storage/variants.ts'

/** 缩略图生成（docs/27）：两档规格、只缩不放、按 EXIF 转正、哪些类型生成、失败不抛 */

const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
const key = `canvas/assets/3f/a8/${id}.jpg`

/** 记得住字节的假 S3：只用到 putObject / getObject */
function memoryS3(options: { failPut?: boolean } = {}) {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>()
  const reads: string[] = []
  const client = {
    objectUrl: (k: string) => `https://s3.test/b/${k}`,
    async putObject(k: string, body: Uint8Array, contentType: string) {
      if (options.failPut) throw new Error('S3 PutObject 失败：500')
      objects.set(k, { body, contentType })
      return client.objectUrl(k)
    },
    async getObject(k: string) {
      reads.push(k)
      const found = objects.get(k)
      return found ? { status: 'ok' as const, ...found } : { status: 'not_found' as const }
    },
  } as unknown as S3Client
  return { client, objects, reads }
}

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#808080' } })

async function sizeOf(body: Uint8Array) {
  const meta = await sharp(body).metadata()
  return { width: meta.width, height: meta.height, format: meta.format }
}

describe('storeAssetVariants', () => {
  it('icon 长边 128、low 长边 768，比例不变，都是 webp，键是 <uuid>@<档>.webp', async () => {
    const s3 = memoryS3()
    const body = new Uint8Array(await solid(4000, 3000).jpeg().toBuffer())

    expect(await storeAssetVariants(s3.client, key, body, 'image/jpeg')).toEqual(['icon', 'low'])
    const icon = s3.objects.get(`canvas/assets/3f/a8/${id}@icon.webp`)!
    const low = s3.objects.get(`canvas/assets/3f/a8/${id}@low.webp`)!
    expect(icon.contentType).toBe('image/webp')
    expect(await sizeOf(icon.body)).toEqual({ width: 128, height: 96, format: 'webp' })
    expect(await sizeOf(low.body)).toEqual({ width: 768, height: 576, format: 'webp' })
  })

  it('原图比档位还小：只转格式、不放大', async () => {
    const s3 = memoryS3()
    const body = new Uint8Array(await solid(100, 50).png().toBuffer())
    await storeAssetVariants(s3.client, key.replace('.jpg', '.png'), body, 'image/png')
    expect(await sizeOf(s3.objects.get(`canvas/assets/3f/a8/${id}@low.webp`)!.body)).toMatchObject({
      width: 100,
      height: 50,
    })
  })

  it('按 EXIF 方向转正：竖拍（orientation 6）的横向像素出来是竖图', async () => {
    const s3 = memoryS3()
    const body = new Uint8Array(await solid(400, 200).jpeg().withMetadata({ orientation: 6 }).toBuffer())
    await storeAssetVariants(s3.client, key, body, 'image/jpeg')
    expect(await sizeOf(s3.objects.get(`canvas/assets/3f/a8/${id}@icon.webp`)!.body)).toMatchObject({
      width: 64,
      height: 128,
    })
  })

  it('SVG、视频、HEIC 不生成；推不出档位的键（老分层键）不生成', async () => {
    const s3 = memoryS3()
    const body = new Uint8Array(await solid(10, 10).png().toBuffer())
    expect(await storeAssetVariants(s3.client, key.replace('.jpg', '.svg'), body, 'image/svg+xml')).toEqual([])
    expect(await storeAssetVariants(s3.client, key.replace('.jpg', '.mp4'), body, 'video/mp4')).toEqual([])
    expect(await storeAssetVariants(s3.client, key, body, 'image/heic')).toEqual([])
    expect(await storeAssetVariants(s3.client, 'projects/p/flows/f/images/a.png', body, 'image/png')).toEqual([])
    expect(s3.objects.size).toBe(0)
    expect(wantsVariants('image/JPEG; charset=binary')).toBe(true)
  })

  it('图片损坏、写 S3 失败：不抛，回已经写成的档（空）', async () => {
    const broken = memoryS3()
    expect(await storeAssetVariants(broken.client, key, new Uint8Array([1, 2, 3]), 'image/jpeg')).toEqual([])
    const failing = memoryS3({ failPut: true })
    const body = new Uint8Array(await solid(10, 10).jpeg().toBuffer())
    expect(await storeAssetVariants(failing.client, key, body, 'image/jpeg')).toEqual([])
  })
})

describe('storeVariantsFromStorage（分片上传完成后）', () => {
  it('读回原图再生成', async () => {
    const s3 = memoryS3()
    const body = new Uint8Array(await solid(1000, 1000).png().toBuffer())
    await s3.client.putObject(key, body, 'image/png')
    expect(await storeVariantsFromStorage(s3.client, key, 'image/png', body.byteLength)).toEqual(['icon', 'low'])
  })

  it('超过 32MB、不是图片：不读回来', async () => {
    const s3 = memoryS3()
    expect(await storeVariantsFromStorage(s3.client, key, 'image/png', VARIANT_SOURCE_MAX_BYTES + 1)).toEqual([])
    expect(await storeVariantsFromStorage(s3.client, key, 'video/mp4', 10)).toEqual([])
    expect(s3.reads).toEqual([])
  })
})
