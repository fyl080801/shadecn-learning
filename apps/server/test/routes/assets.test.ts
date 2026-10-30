import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ASSET_PART_SIZE, type AssetUploadSession, type UploadedAsset } from '@shadecn/shared/canvas'
import type { S3Client } from '../../storage/s3.ts'
import { replaceAssetStorage } from '../../storage/index.ts'
import { resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, type Actor } from '../helpers/project.ts'

/**
 * 画布资源上传：鉴权口径同画布、只收图片 / 视频、对象键进统一素材目录、按 uuid 分两级、回 S3 原始地址；
 * 超过一片的走分片上传（开始 → 逐片 → 完成 / 放弃），服务端不记会话、只认这张画布的键。
 */

/** 一个记得住东西的假 S3：对象、进行中的分片上传 */
function fakeS3() {
  const objects = new Map<string, { size: number; contentType: string }>()
  const uploads = new Map<string, { key: string; contentType: string; parts: Map<number, number> }>()
  const aborted: string[] = []
  let seq = 0

  const client: S3Client = {
    objectUrl: (key) => `https://s3.example.test/canvas-bucket/${key}`,
    async putObject(key, body, contentType) {
      objects.set(key, { size: body.byteLength, contentType })
      return client.objectUrl(key)
    },
    async headObject(key) {
      return objects.get(key) ?? null
    },
    // 上传接口不读对象
    async getObject() {
      return { status: 'not_found' }
    },
    async createMultipartUpload(key, contentType) {
      seq += 1
      const uploadId = `up+${seq}/=`
      uploads.set(uploadId, { key, contentType, parts: new Map() })
      return uploadId
    },
    async uploadPart(key, uploadId, partNumber, body) {
      const upload = uploads.get(uploadId)
      if (!upload || upload.key !== key) throw new Error('NoSuchUpload')
      upload.parts.set(partNumber, body.byteLength)
      return `"etag-${partNumber}"`
    },
    async completeMultipartUpload(key, uploadId, parts) {
      const upload = uploads.get(uploadId)
      if (!upload || upload.key !== key) throw new Error('NoSuchUpload')
      const size = parts.reduce((sum, p) => sum + (upload.parts.get(p.partNumber) ?? 0), 0)
      objects.set(key, { size, contentType: upload.contentType })
      uploads.delete(uploadId)
      return client.objectUrl(key)
    },
    async abortMultipartUpload(key, uploadId) {
      aborted.push(`${key}|${uploadId}`)
      uploads.delete(uploadId)
    },
  }
  return { client, objects, uploads, aborted }
}

let s3 = fakeS3()

function form(file: File) {
  const data = new FormData()
  data.set('file', file)
  return { method: 'POST', body: data }
}

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'cat.PNG', { type: 'image/png' })

async function memberFlow(): Promise<{ alice: Actor; projectId: string; flowId: string }> {
  const alice = await actor('alice')
  const projectId = await createProject(alice)
  const flowId = await createFlow(alice, projectId)
  return { alice, projectId, flowId }
}

beforeEach(async () => {
  await resetDb()
  s3 = fakeS3()
  replaceAssetStorage(s3.client)
})

afterEach(() => replaceAssetStorage(undefined))

describe('POST /api/flows/:flowId/assets（一次传完）', () => {
  it('成员上传图片 → 201，键在 canvas/assets/<uuid 两级目录>/ 下（不分项目、画布、类别）', async () => {
    const { alice, flowId } = await memberFlow()

    const res = await alice.request(`/api/flows/${flowId}/assets`, form(png()))
    expect(res.status).toBe(201)
    const body = (await res.json()) as UploadedAsset
    const dir = 'canvas/assets/'
    expect(body.key.startsWith(dir)).toBe(true)
    // 两级目录正是文件名 uuid 的开头
    const [a, b, file] = body.key.slice(dir.length).split('/') as [string, string, string]
    expect(file).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(file.startsWith(`${a}${b}`)).toBe(true)
    expect(body).toMatchObject({ url: s3.client.objectUrl(body.key), contentType: 'image/png', size: 4 })
    expect(s3.objects.get(body.key)).toEqual({ size: 4, contentType: 'image/png' })
  })

  it('视频和图片进同一个素材目录', async () => {
    const { alice, flowId } = await memberFlow()
    const res = await alice.request(
      `/api/flows/${flowId}/assets`,
      form(new File(['v'], 'a.mp4', { type: 'video/mp4' })),
    )
    const body = (await res.json()) as UploadedAsset
    expect(body.key.startsWith('canvas/assets/')).toBe(true)
  })

  it('非成员 → 404，什么都不写', async () => {
    const { flowId } = await memberFlow()
    const bob = await actor('bob')

    const res = await bob.request(`/api/flows/${flowId}/assets`, form(png()))
    expect(res.status).toBe(404)
    expect(s3.objects.size).toBe(0)
  })

  it('不是图片或视频 → 415', async () => {
    const { alice, flowId } = await memberFlow()
    const res = await alice.request(
      `/api/flows/${flowId}/assets`,
      form(new File(['hi'], 'a.txt', { type: 'text/plain' })),
    )
    expect(res.status).toBe(415)
    expect(s3.objects.size).toBe(0)
  })

  it('缺 file 字段 → 400', async () => {
    const { alice, flowId } = await memberFlow()
    const res = await alice.request(`/api/flows/${flowId}/assets`, { method: 'POST', body: new FormData() })
    expect(res.status).toBe(400)
  })

  it('超过一片大小 → 413，提示走分片', async () => {
    const { alice, flowId } = await memberFlow()
    const big = new File([new Uint8Array(ASSET_PART_SIZE + 1)], 'big.png', { type: 'image/png' })
    const res = await alice.request(`/api/flows/${flowId}/assets`, form(big))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { message: string }).message).toContain('分片')
  })

  it('没配对象存储 → 503', async () => {
    replaceAssetStorage(null)
    const { alice, flowId } = await memberFlow()
    const res = await alice.request(`/api/flows/${flowId}/assets`, form(png()))
    expect(res.status).toBe(503)
  })

  it('S3 写失败 → 502', async () => {
    replaceAssetStorage({ ...s3.client, putObject: async () => Promise.reject(new Error('boom')) })
    const { alice, flowId } = await memberFlow()
    const res = await alice.request(`/api/flows/${flowId}/assets`, form(png()))
    expect(res.status).toBe(502)
  })
})

describe('分片上传 /api/flows/:flowId/assets/multipart', () => {
  async function start(alice: Actor, flowId: string, body: Record<string, unknown>) {
    return alice.json(`/api/flows/${flowId}/assets/multipart`, 'POST', body)
  }

  function putPart(alice: Actor, flowId: string, session: AssetUploadSession, partNumber: number, bytes: number) {
    return alice.request(
      `/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}/parts/${partNumber}?key=${encodeURIComponent(session.key)}`,
      { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes) },
    )
  }

  it('开始 → 逐片 → 完成：大小与类型以 S3 实际拼出来的为准', async () => {
    const { alice, flowId } = await memberFlow()
    const size = ASSET_PART_SIZE * 2 + 10

    const res = await start(alice, flowId, { filename: 'clip.MP4', contentType: 'video/mp4', size })
    expect(res.status).toBe(201)
    const session = (await res.json()) as AssetUploadSession
    expect(session).toMatchObject({ partSize: ASSET_PART_SIZE, partCount: 3 })
    expect(session.key.startsWith('canvas/assets/')).toBe(true)
    expect(session.key.endsWith('.mp4')).toBe(true)

    const sizes = [ASSET_PART_SIZE, ASSET_PART_SIZE, 10]
    const parts = []
    for (const [index, bytes] of sizes.entries()) {
      const partRes = await putPart(alice, flowId, session, index + 1, bytes)
      expect(partRes.status).toBe(200)
      parts.push(await partRes.json())
    }
    expect(parts[0]).toEqual({ partNumber: 1, etag: '"etag-1"' })

    const done = await alice.json(
      `/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}/complete`,
      'POST',
      { key: session.key, parts },
    )
    expect(done.status).toBe(201)
    expect(await done.json()).toEqual({
      url: s3.client.objectUrl(session.key),
      key: session.key,
      contentType: 'video/mp4',
      size,
    })
  })

  it('开始时：类型不对 415、超过总上限 413、参数缺失 400', async () => {
    const { alice, flowId } = await memberFlow()
    expect((await start(alice, flowId, { filename: 'a.txt', contentType: 'text/plain', size: 10 })).status).toBe(415)
    expect(
      (await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4', size: 101 * 1024 * 1024 })).status,
    ).toBe(413)
    expect((await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4' })).status).toBe(400)
    expect(s3.uploads.size).toBe(0)
  })

  it('键不是素材目录里我们拼出的形状 → 400（不能借自己画布的权限往桶里别处写）', async () => {
    const { alice, flowId } = await memberFlow()
    const session = (await (
      await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4', size: 10 })
    ).json()) as AssetUploadSession

    const forged = await putPart(alice, flowId, { ...session, key: `../${session.key}` }, 1, 10)
    expect(forged.status).toBe(400)
    const elsewhere = await putPart(alice, flowId, { ...session, key: 'canvas/other/x.mp4' }, 1, 10)
    expect(elsewhere.status).toBe(400)
  })

  it('非成员 → 404', async () => {
    const { alice, flowId } = await memberFlow()
    const session = (await (
      await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4', size: 10 })
    ).json()) as AssetUploadSession
    const bob = await actor('bob')
    expect((await putPart(bob, flowId, session, 1, 10)).status).toBe(404)
  })

  it('片号越界 400、空片 400、超过一片大小 413', async () => {
    const { alice, flowId } = await memberFlow()
    const session = (await (
      await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4', size: ASSET_PART_SIZE * 2 })
    ).json()) as AssetUploadSession

    expect((await putPart(alice, flowId, session, 0, 10)).status).toBe(400)
    expect((await putPart(alice, flowId, session, 10_001, 10)).status).toBe(400)
    expect((await putPart(alice, flowId, session, 1, 0)).status).toBe(400)
    expect((await putPart(alice, flowId, session, 1, ASSET_PART_SIZE + 1)).status).toBe(413)
  })

  it('完成时片号必须从 1 起连续 → 否则 400', async () => {
    const { alice, flowId } = await memberFlow()
    const session = (await (
      await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4', size: 10 })
    ).json()) as AssetUploadSession
    const res = await alice.json(
      `/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}/complete`,
      'POST',
      { key: session.key, parts: [{ partNumber: 2, etag: '"x"' }] },
    )
    expect(res.status).toBe(400)
  })

  it('放弃 → 204，S3 收到 abort', async () => {
    const { alice, flowId } = await memberFlow()
    const session = (await (
      await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4', size: 10 })
    ).json()) as AssetUploadSession

    const res = await alice.request(
      `/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}?key=${encodeURIComponent(session.key)}`,
      { method: 'DELETE' },
    )
    expect(res.status).toBe(204)
    expect(s3.aborted).toEqual([`${session.key}|${session.uploadId}`])
  })
})
