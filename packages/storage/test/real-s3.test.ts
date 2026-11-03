import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { ASSET_PART_SIZE, type AssetUploadPart, type AssetUploadSession, type UploadedAsset } from '@learning/contracts/canvas'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AssetStorage } from '../src/asset-storage.js'
import { S3_CLIENT } from '../src/s3-client.provider.js'
import { encodeS3Path, signS3Request, type S3Client } from '../src/s3.js'
import { type Actor, actorOf, bootStorageApp, createFlow, createProject } from './helpers.js'

/**
 * 对真的 S3 兼容服务跑一遍（`PLATFORM_TEST_S3_URL=http://<ak>:<sk>@127.0.0.1:9000/<bucket>`，没配就跳过）。
 * 假 S3 验不了的都在这里：手写的 SigV4 能不能过真服务的校验、分片的最小片限制、字节真的存下来了。
 * 桶名同时带 platform 和 test 才肯动。每次用独立的键前缀，收尾时删掉自己写的对象。
 */
const s3Url = process.env.PLATFORM_TEST_S3_URL

describe.skipIf(!s3Url)('真的对象存储（PLATFORM_TEST_S3_URL）', () => {
  const url = new URL(s3Url ?? 'http://x')
  const bucket = url.pathname.slice(1)
  const accessKeyId = decodeURIComponent(url.username)
  const secretAccessKey = decodeURIComponent(url.password)
  const internal = `${url.protocol}//${url.host}`
  // 公开地址和内网地址写成两个名字：存进节点的只能是公开的那个，服务端的请求只能发到内网的那个
  const publicEndpoint = `${url.protocol}//localhost:${url.port}`
  const keyPrefix = `test-${randomUUID()}/canvas`

  let dir: string
  let app: NestFastifyApplication
  let alice: Actor
  let flowId: string
  const written = new Set<string>()

  /** 客户端没有的动作（建桶、删对象、匿名读策略），测试自己签 */
  async function signed(method: string, target: string, query = '', body = '') {
    const requestUrl = new URL(`${internal}/${bucket}${target}${query}`)
    const headers = signS3Request({
      method,
      url: requestUrl,
      headers: {},
      payloadHash: createHash('sha256').update(body).digest('hex'),
      region: 'us-east-1',
      accessKeyId,
      secretAccessKey,
      date: new Date(),
    })
    delete headers.host
    return fetch(requestUrl, { method, headers, ...(body ? { body } : {}) })
  }

  beforeAll(async () => {
    if (!/platform/.test(bucket) || !/test/.test(bucket)) throw new Error(`[storage 测试] PLATFORM_TEST_S3_URL 的桶名必须同时带 platform 和 test，收到的是 ${bucket}`)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const created = await signed('PUT', '')
    if (!created.ok && created.status !== 409) throw new Error(`[storage 测试] 建桶失败：${created.status} ${await created.text()}`)

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-real-'))
    app = await bootStorageApp({
      databaseUrl: `file:${path.join(dir, 'test.db')}`,
      storage: { endpoint: publicEndpoint, internalEndpoint: internal, bucket, keyPrefix },
      env: { PLATFORM_S3_ACCESS_KEY_ID: accessKeyId, PLATFORM_S3_SECRET_ACCESS_KEY: secretAccessKey },
    })
    alice = await actorOf(app)
    flowId = await createFlow(alice, await createProject(alice))
  })

  afterAll(async () => {
    for (const key of written) await signed('DELETE', `/${encodeS3Path(key)}`)
    await app?.close()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const client = () => app.get<S3Client>(S3_CLIENT)
  const variantsOf = (key: string) => [key.replace(/\.\w+$/, '@icon.webp'), key.replace(/\.\w+$/, '@low.webp')]
  const remember = (key: string) => [key, ...variantsOf(key)].forEach((item) => written.add(item))

  async function read(key: string) {
    const got = await client().getObject(key, { maxBytes: 64 * 1024 * 1024 })
    if (got.status !== 'ok') throw new Error(`读不到 ${key}：${got.status}`)
    return got
  }

  const photo = async (width = 2000, height = 1000) =>
    new Uint8Array(await sharp({ create: { width, height, channels: 3, background: '#3366cc' }, limitInputPixels: false }).jpeg().toBuffer())

  it('一次传完：字节原样存下来，缩略图的尺寸、类型对，回包的地址是公开地址', async () => {
    const original = await photo()
    const res = await alice.upload(`/api/flows/${flowId}/assets`, new File([original], '猫 (1).JPG', { type: 'image/jpeg' }))
    expect(res.status).toBe(201)
    const asset = res.json<UploadedAsset>()
    remember(asset.key)
    expect(asset.variants).toEqual(['icon', 'low'])
    expect(asset.url).toBe(`${publicEndpoint}/${bucket}/${asset.key}`)

    const stored = await read(asset.key)
    expect(Buffer.from(stored.body).equals(Buffer.from(original))).toBe(true)
    expect(stored.contentType).toBe('image/jpeg')
    const [icon, low] = await Promise.all(variantsOf(asset.key).map(read))
    expect(icon.contentType).toBe('image/webp')
    expect(await sharp(icon.body).metadata()).toMatchObject({ width: 128, height: 64, format: 'webp' })
    expect(await sharp(low.body).metadata()).toMatchObject({ width: 768, height: 384, format: 'webp' })
  }, 30_000)

  it('分片上传：真的按 8MB 一片拼起来，字节和类型以 S3 为准，图片读回来出缩略图', async () => {
    // 一张没法压缩的大图，凑够两片。真服务要求除最后一片外每片至少 5MB，假 S3 验不出这个
    const noise = Buffer.alloc(3000 * 2000 * 3)
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) >>> 24
    const original = new Uint8Array(await sharp(noise, { raw: { width: 3000, height: 2000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer())
    expect(original.byteLength).toBeGreaterThan(ASSET_PART_SIZE)

    const start = await alice.json(`/api/flows/${flowId}/assets/multipart`, 'POST', { filename: 'big.png', contentType: 'image/png', size: original.byteLength })
    expect(start.status).toBe(201)
    const session = start.json<AssetUploadSession>()
    remember(session.key)
    expect(session.partCount).toBeGreaterThan(1)

    const base = `/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}`
    const parts: AssetUploadPart[] = []
    for (let index = 0; index < session.partCount; index += 1) {
      const chunk = original.subarray(index * session.partSize, (index + 1) * session.partSize)
      const res = await alice.request(`${base}/parts/${index + 1}?key=${encodeURIComponent(session.key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from(chunk),
      })
      expect(res.status).toBe(200)
      parts.push(res.json<AssetUploadPart>())
    }

    const done = await alice.json(`${base}/complete`, 'POST', { key: session.key, parts })
    expect(done.status).toBe(201)
    const asset = done.json<UploadedAsset>()
    expect(asset).toMatchObject({ contentType: 'image/png', size: original.byteLength, variants: ['icon', 'low'] })
    const stored = await read(session.key)
    expect(Buffer.from(stored.body).equals(Buffer.from(original))).toBe(true)
  }, 60_000)

  it('放弃分片：S3 删掉已传的片，再传这一片就是 502', async () => {
    const session = (await alice.json(`/api/flows/${flowId}/assets/multipart`, 'POST', { filename: 'a.mp4', contentType: 'video/mp4', size: 10 })).json<AssetUploadSession>()
    const base = `/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}`
    const key = encodeURIComponent(session.key)
    const part = () => alice.request(`${base}/parts/1?key=${key}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(10) })
    expect((await part()).status).toBe(200)
    expect((await alice.request(`${base}?key=${key}`, { method: 'DELETE' })).status).toBe(204)

    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined)
    expect((await part()).status).toBe(502)
    // 对象没有拼出来
    expect(await client().headObject(session.key)).toBeNull()
  })

  it('uploadId 对不上这个键：S3 拒绝，502，别人的上传不受影响', async () => {
    const first = (await alice.json(`/api/flows/${flowId}/assets/multipart`, 'POST', { filename: 'a.mp4', contentType: 'video/mp4', size: 10 })).json<AssetUploadSession>()
    const second = (await alice.json(`/api/flows/${flowId}/assets/multipart`, 'POST', { filename: 'b.mp4', contentType: 'video/mp4', size: 10 })).json<AssetUploadSession>()
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined)
    const res = await alice.request(`/api/flows/${flowId}/assets/multipart/${encodeURIComponent(first.uploadId)}/parts/1?key=${encodeURIComponent(second.key)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(10),
    })
    expect(res.status).toBe(502)
    for (const session of [first, second]) {
      await alice.request(`/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}?key=${encodeURIComponent(session.key)}`, { method: 'DELETE' })
    }
  })

  it('补缩略图：桶里缺一档就真的读回原图补上，另一档不动', async () => {
    const asset = (await alice.upload(`/api/flows/${flowId}/assets`, new File([await photo(1600, 1200)], 'a.jpg', { type: 'image/jpeg' }))).json<UploadedAsset>()
    remember(asset.key)
    const [iconKey, lowKey] = variantsOf(asset.key)
    expect((await signed('DELETE', `/${encodeS3Path(lowKey)}`)).ok).toBe(true)
    const iconBefore = (await read(iconKey)).body

    const res = await alice.json(`/api/flows/${flowId}/assets/variants`, 'POST', { src: asset.url })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ variants: ['icon', 'low'] })
    expect(await sharp((await read(lowKey)).body).metadata()).toMatchObject({ width: 768, height: 576 })
    expect(Buffer.from((await read(iconKey)).body).equals(Buffer.from(iconBefore))).toBe(true)
  }, 30_000)

  it('AssetStorage：存和读走真服务；读只认这张画布', async () => {
    const data = await photo(300, 200)
    const saved = await app.get(AssetStorage).save({ flowId, createdById: alice.userId, data, contentType: 'image/jpeg' })
    remember(saved.key)
    const got = await app.get(AssetStorage).read(flowId, saved.url, { maxBytes: 1024 * 1024 })
    expect(Buffer.from(got?.data ?? []).equals(Buffer.from(data))).toBe(true)
    expect(await app.get(AssetStorage).read('another-flow', saved.url, { maxBytes: 1024 * 1024 })).toBeNull()
    await expect(app.get(AssetStorage).read(flowId, saved.url, { maxBytes: 10 })).rejects.toThrow('资源超过 10 字节')
  })

  it('密钥不对：上传 502，服务不崩', async () => {
    const wrongDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-wrong-'))
    const wrong = await bootStorageApp({
      databaseUrl: `file:${path.join(wrongDir, 'test.db')}`,
      storage: { endpoint: publicEndpoint, internalEndpoint: internal, bucket, keyPrefix },
      env: { PLATFORM_S3_ACCESS_KEY_ID: accessKeyId, PLATFORM_S3_SECRET_ACCESS_KEY: 'wrong-secret-key' },
    })
    const bob = await actorOf(wrong, 'bob')
    const flow = await createFlow(bob, await createProject(bob))
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined)
    expect((await bob.upload(`/api/flows/${flow}/assets`, new File(['x'], 'a.png', { type: 'image/png' }))).status).toBe(502)
    await wrong.close()
    fs.rmSync(wrongDir, { recursive: true, force: true })
  })
})
