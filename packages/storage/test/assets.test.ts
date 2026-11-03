import { Readable } from 'node:stream'
import { ASSET_PART_SIZE, type AssetUploadSession, type UploadedAsset } from '@learning/contracts/canvas'
import { Flow } from '@learning/canvas'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { FlowAsset } from '../src/entities.js'
import { FlowAssets } from '../src/flow-assets.js'
import { type Actor, createFlow, createProject, describeOnBothDatabases, encodeForm, joinViaInvite } from './helpers.js'

/**
 * 画布资源上传：鉴权口径同画布、只收图片 / 视频、对象键进统一素材目录、按 uuid 分两级、回 S3 原始地址；
 * 超过一片的走分片上传（开始 → 逐片 → 完成 / 放弃），服务端不记会话、只认这张画布的键。
 */

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'cat.PNG', { type: 'image/png' })

const jpeg = async () =>
  new File([await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#3366cc' } }).jpeg().toBuffer()], 'a.jpg', { type: 'image/jpeg' })

describeOnBothDatabases('上传接口', (ctx) => {
  const records = () => ctx.app.get(FlowAssets)

  async function memberFlow(): Promise<{ alice: Actor; projectId: string; flowId: string }> {
    const alice = await ctx.actor('alice')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    return { alice, projectId, flowId }
  }

  describe('POST /api/flows/:flowId/assets（一次传完）', () => {
    it('成员上传图片 → 201，键在 canvas/assets/<uuid 两级目录>/ 下（不分项目、画布、类别）', async () => {
      const { alice, flowId } = await memberFlow()

      const res = await alice.upload(`/api/flows/${flowId}/assets`, png())
      expect(res.status).toBe(201)
      const body = res.json<UploadedAsset>()
      const dir = 'canvas/assets/'
      expect(body.key.startsWith(dir)).toBe(true)
      // 两级目录正是文件名 uuid 的开头
      const [a, b, file] = body.key.slice(dir.length).split('/') as [string, string, string]
      expect(file).toMatch(/^[0-9a-f-]{36}\.png$/)
      expect(file.startsWith(`${a}${b}`)).toBe(true)
      expect(body).toMatchObject({ url: ctx.s3.client.objectUrl(body.key), contentType: 'image/png', size: 4 })
      expect(ctx.s3.objects.get(body.key)).toEqual({ size: 4, contentType: 'image/png' })
    })

    it('真图片 → 同步生成 icon / low 两档 webp，和原图同目录，回包 variants 列出来', async () => {
      const { alice, flowId } = await memberFlow()

      const res = await alice.upload(`/api/flows/${flowId}/assets`, await jpeg())
      expect(res.status).toBe(201)
      const body = res.json<UploadedAsset>()
      expect(body.variants).toEqual(['icon', 'low'])
      const stem = body.key.replace(/\.jpg$/, '')
      expect(ctx.s3.objects.get(`${stem}@icon.webp`)?.contentType).toBe('image/webp')
      expect(ctx.s3.objects.get(`${stem}@low.webp`)?.contentType).toBe('image/webp')
    })

    it('缩略图生成失败（图片损坏）不算上传失败：201，variants 为空，归属照记', async () => {
      const { alice, flowId } = await memberFlow()
      const res = await alice.upload(`/api/flows/${flowId}/assets`, png())
      expect(res.status).toBe(201)
      const body = res.json<UploadedAsset>()
      expect(body.variants).toEqual([])
      expect([...ctx.s3.objects.keys()]).toEqual([body.key])
      expect(await records().findInFlow(flowId, [body.key])).toHaveLength(1)
    })

    it('上传成功即记下归属（键 → 这张画布 + 服务端看到的类型）；别的画布查不到它', async () => {
      const { alice, projectId, flowId } = await memberFlow()
      const other = await createFlow(alice, projectId)

      const body = (await alice.upload(`/api/flows/${flowId}/assets`, png())).json<UploadedAsset>()
      expect(await records().findInFlow(flowId, [body.key])).toEqual([{ key: body.key, contentType: 'image/png' }])
      expect(await records().findInFlow(other, [body.key])).toEqual([])
    })

    it('记不下归属 → 整个上传算失败（500）：回了地址却没有归属，之后拿它当附件会被当成别的画布的资源拒掉', async () => {
      const { alice, flowId } = await memberFlow()
      vi.spyOn(records(), 'record').mockRejectedValueOnce(new Error('写库失败'))
      expect((await alice.upload(`/api/flows/${flowId}/assets`, png())).status).toBe(500)
    })

    it('视频和图片进同一个素材目录', async () => {
      const { alice, flowId } = await memberFlow()
      const res = await alice.upload(`/api/flows/${flowId}/assets`, new File(['v'], 'a.mp4', { type: 'video/mp4' }))
      expect(res.json<UploadedAsset>().key.startsWith('canvas/assets/')).toBe(true)
    })

    it('匿名 → 401，非成员 → 404，什么都不写，也不读请求体', async () => {
      const { flowId } = await memberFlow()
      const bob = await ctx.actor('bob')

      expect((await ctx.anonymous(`/api/flows/${flowId}/assets`, { method: 'POST' })).status).toBe(401)
      expect((await bob.upload(`/api/flows/${flowId}/assets`, png())).status).toBe(404)
      expect(ctx.s3.objects.size).toBe(0)
      // 声明了超大的请求体，判权在 413 之前：不告诉外人这张画布存在
      const huge = await bob.request(`/api/flows/${flowId}/assets`, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(ASSET_PART_SIZE * 10) },
      })
      expect(huge.status).toBe(404)
    })

    it('画布被软删 → 成员也是 404，上传记录留着；画布真删时记录跟着级联', async () => {
      const { alice, flowId } = await memberFlow()
      const { key } = (await alice.upload(`/api/flows/${flowId}/assets`, png())).json<UploadedAsset>()

      expect((await alice.request(`/api/flows/${flowId}`, { method: 'DELETE' })).status).toBe(204)
      expect((await alice.upload(`/api/flows/${flowId}/assets`, png())).status).toBe(404)
      expect(await records().exists(key)).toBe(true)

      await ctx.dataAccess.em().nativeDelete(Flow, { id: flowId })
      expect(await records().exists(key)).toBe(false)
      expect(await ctx.dataAccess.em().count(FlowAsset, { key })).toBe(0)
    })

    it('不是图片或视频 → 415', async () => {
      const { alice, flowId } = await memberFlow()
      const res = await alice.upload(`/api/flows/${flowId}/assets`, new File(['hi'], 'a.txt', { type: 'text/plain' }))
      expect(res.status).toBe(415)
      expect(res.json()).toEqual({ error: 'Unsupported Media Type', message: '只支持图片或视频' })
      expect(ctx.s3.objects.size).toBe(0)
    })

    it('缺 file 字段 → 400；不是表单、表单是坏的 → 400', async () => {
      const { alice, flowId } = await memberFlow()
      const empty = await alice.request(`/api/flows/${flowId}/assets`, { method: 'POST', ...(await encodeForm(new FormData())) })
      expect(empty.status).toBe(400)
      const text = new FormData()
      text.set('file', 'not-a-file')
      expect((await alice.request(`/api/flows/${flowId}/assets`, { method: 'POST', ...(await encodeForm(text)) })).status).toBe(400)
      expect((await alice.json(`/api/flows/${flowId}/assets`, 'POST', { file: 'x' })).status).toBe(400)
      const broken = await alice.request(`/api/flows/${flowId}/assets`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: 'garbage' })
      expect(broken.status).toBe(400)
      expect((await alice.request(`/api/flows/${flowId}/assets`, { method: 'POST' })).status).toBe(400)
    })

    it('超过一片大小 → 413，提示走分片', async () => {
      const { alice, flowId } = await memberFlow()
      const big = new File([new Uint8Array(ASSET_PART_SIZE + 1)], 'big.png', { type: 'image/png' })
      const res = await alice.upload(`/api/flows/${flowId}/assets`, big)
      expect(res.status).toBe(413)
      expect(res.json<{ message: string }>().message).toContain('分片')
      expect(ctx.s3.objects.size).toBe(0)
    })

    it('声明的长度超限 → 413，不读请求体；不声明长度（分块编码）边读边数，同样 413，字节不进 S3', async () => {
      const { alice, flowId } = await memberFlow()
      const declared = await alice.request(`/api/flows/${flowId}/assets`, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(ASSET_PART_SIZE * 2) },
      })
      expect(declared.status).toBe(413)

      const chunks = Array.from({ length: 4 }, () => Buffer.alloc(4 * 1024 * 1024))
      const streamed = await alice.request(`/api/flows/${flowId}/assets`, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
        body: Readable.from(chunks),
      })
      expect(streamed.status).toBe(413)
      expect(ctx.s3.objects.size).toBe(0)
    })

    it('S3 写失败 → 502', async () => {
      const { alice, flowId } = await memberFlow()
      vi.spyOn(ctx.s3.client, 'putObject').mockRejectedValueOnce(new Error('boom'))
      const res = await alice.upload(`/api/flows/${flowId}/assets`, png())
      expect(res.status).toBe(502)
      expect(res.json()).toEqual({ error: 'Bad Gateway', message: '上传到对象存储失败' })
    })
  })

  describe('分片上传 /api/flows/:flowId/assets/multipart', () => {
    const start = (alice: Actor, flowId: string, body: Record<string, unknown>) => alice.json(`/api/flows/${flowId}/assets/multipart`, 'POST', body)

    function putPart(alice: Actor, flowId: string, session: AssetUploadSession, partNumber: number, bytes: number) {
      return alice.request(`/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}/parts/${partNumber}?key=${encodeURIComponent(session.key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(bytes),
      })
    }

    const session10 = async (alice: Actor, flowId: string) => (await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4', size: 10 })).json<AssetUploadSession>()

    it('开始 → 逐片 → 完成：大小与类型以 S3 实际拼出来的为准', async () => {
      const { alice, flowId } = await memberFlow()
      const size = ASSET_PART_SIZE * 2 + 10

      const res = await start(alice, flowId, { filename: 'clip.MP4', contentType: 'video/mp4', size })
      expect(res.status).toBe(201)
      const session = res.json<AssetUploadSession>()
      expect(session).toMatchObject({ partSize: ASSET_PART_SIZE, partCount: 3 })
      expect(session.key.startsWith('canvas/assets/')).toBe(true)
      expect(session.key.endsWith('.mp4')).toBe(true)

      const sizes = [ASSET_PART_SIZE, ASSET_PART_SIZE, 10]
      const parts: unknown[] = []
      for (const [index, bytes] of sizes.entries()) {
        const partRes = await putPart(alice, flowId, session, index + 1, bytes)
        expect(partRes.status).toBe(200)
        parts.push(partRes.json())
      }
      expect(parts[0]).toEqual({ partNumber: 1, etag: '"etag-1"' })

      const done = await alice.json(`/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}/complete`, 'POST', { key: session.key, parts })
      expect(done.status).toBe(201)
      expect(done.json()).toEqual({ url: ctx.s3.client.objectUrl(session.key), key: session.key, contentType: 'video/mp4', size, variants: [] })
      // 完成时才记归属，类型取 S3 拼完后 HEAD 回来的
      expect(await records().findInFlow(flowId, [session.key])).toEqual([{ key: session.key, contentType: 'video/mp4' }])
    })

    it('拼出来的是图片：读回原图生成缩略图', async () => {
      const { alice, flowId } = await memberFlow()
      const { key, uploadId } = (await start(alice, flowId, { filename: 'a.jpg', contentType: 'image/jpeg', size: 10 })).json<AssetUploadSession>()
      const original = new Uint8Array(await (await jpeg()).arrayBuffer())
      // 假 S3 的分片不留字节，补上读回来要用的那份
      vi.spyOn(ctx.s3.client, 'completeMultipartUpload').mockImplementationOnce(async (k) => ctx.s3.client.putObject(k, original, 'image/jpeg'))

      const done = await alice.json(`/api/flows/${flowId}/assets/multipart/${encodeURIComponent(uploadId)}/complete`, 'POST', { key, parts: [{ partNumber: 1, etag: '"x"' }] })
      expect(done.status).toBe(201)
      expect(done.json<UploadedAsset>().variants).toEqual(['icon', 'low'])
      expect(ctx.s3.reads).toEqual([key])
    })

    it('开始时：类型不对 415、超过总上限 413、参数缺失 400', async () => {
      const { alice, flowId } = await memberFlow()
      expect((await start(alice, flowId, { filename: 'a.txt', contentType: 'text/plain', size: 10 })).status).toBe(415)
      const large = await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4', size: 101 * 1024 * 1024 })
      expect(large.status).toBe(413)
      expect(large.json<{ message: string }>().message).toBe('文件不能超过 100MB')
      expect((await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4' })).status).toBe(400)
      expect(ctx.s3.uploads.size).toBe(0)
    })

    it('键不是素材目录里我们拼出的形状 → 400（不能借自己画布的权限往桶里别处写）', async () => {
      const { alice, flowId } = await memberFlow()
      const session = await session10(alice, flowId)

      expect((await putPart(alice, flowId, { ...session, key: `../${session.key}` }, 1, 10)).status).toBe(400)
      expect((await putPart(alice, flowId, { ...session, key: 'canvas/other/x.mp4' }, 1, 10)).status).toBe(400)
      // 缩略图键也不行：否则能借分片上传覆盖别人的缩略图
      expect((await putPart(alice, flowId, { ...session, key: session.key.replace(/\.mp4$/, '@icon.webp') }, 1, 10)).status).toBe(400)
      expect((await alice.json(`/api/flows/${flowId}/assets/multipart/x/complete`, 'POST', { key: 'canvas/other/x.mp4', parts: [{ partNumber: 1, etag: '"x"' }] })).status).toBe(400)
      expect((await alice.request(`/api/flows/${flowId}/assets/multipart/x?key=canvas/other/x.mp4`, { method: 'DELETE' })).status).toBe(400)
    })

    it('非成员 → 404，每一步都是', async () => {
      const { alice, flowId } = await memberFlow()
      const session = await session10(alice, flowId)
      const bob = await ctx.actor('bob')
      expect((await start(bob, flowId, { filename: 'a.mp4', contentType: 'video/mp4', size: 10 })).status).toBe(404)
      expect((await putPart(bob, flowId, session, 1, 10)).status).toBe(404)
      expect((await bob.json(`/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}/complete`, 'POST', { key: session.key, parts: [{ partNumber: 1, etag: '"x"' }] })).status).toBe(404)
      expect((await bob.request(`/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}?key=${encodeURIComponent(session.key)}`, { method: 'DELETE' })).status).toBe(404)
      expect(ctx.s3.uploads.get(session.uploadId)?.parts.size).toBe(0)
      expect(ctx.s3.aborted).toEqual([])
    })

    it('片号越界 400、空片 400、超过一片大小 413', async () => {
      const { alice, flowId } = await memberFlow()
      const session = (await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4', size: ASSET_PART_SIZE * 2 })).json<AssetUploadSession>()

      expect((await putPart(alice, flowId, session, 0, 10)).status).toBe(400)
      expect((await putPart(alice, flowId, session, 10_001, 10)).status).toBe(400)
      expect((await putPart(alice, flowId, session, 1, 0)).status).toBe(400)
      expect((await putPart(alice, flowId, session, 1, ASSET_PART_SIZE + 1)).status).toBe(413)
    })

    it('uploadId 里的特殊字符解码后原样交给 S3', async () => {
      const { alice, flowId } = await memberFlow()
      const session = await session10(alice, flowId)
      expect(session.uploadId).toContain('/')
      expect((await putPart(alice, flowId, session, 1, 10)).status).toBe(200)
      expect(ctx.s3.uploads.get(session.uploadId)?.parts.get(1)).toBe(10)
    })

    it('完成时片号必须从 1 起连续 → 否则 400', async () => {
      const { alice, flowId } = await memberFlow()
      const session = await session10(alice, flowId)
      const res = await alice.json(`/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}/complete`, 'POST', { key: session.key, parts: [{ partNumber: 2, etag: '"x"' }] })
      expect(res.status).toBe(400)
    })

    it('片数超过总上限折算的片数 → 413：声明的大小不可信，完成时兜底', async () => {
      const { alice, flowId } = await memberFlow()
      const session = await session10(alice, flowId)
      const parts = Array.from({ length: 14 }, (_, index) => ({ partNumber: index + 1, etag: '"x"' }))
      const res = await alice.json(`/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}/complete`, 'POST', { key: session.key, parts })
      expect(res.status).toBe(413)
    })

    it('放弃 → 204，S3 收到 abort', async () => {
      const { alice, flowId } = await memberFlow()
      const session = await session10(alice, flowId)

      const res = await alice.request(`/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}?key=${encodeURIComponent(session.key)}`, { method: 'DELETE' })
      expect(res.status).toBe(204)
      expect(ctx.s3.aborted).toEqual([`${session.key}|${session.uploadId}`])
    })

    it('JSON 写坏 → 400，一句人话；S3 出错 → 502', async () => {
      const { alice, flowId } = await memberFlow()
      const bad = await alice.request(`/api/flows/${flowId}/assets/multipart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
      expect(bad.status).toBe(400)
      expect(bad.json()).toEqual({ error: '请求体不是合法 JSON' })

      vi.spyOn(ctx.s3.client, 'createMultipartUpload').mockRejectedValueOnce(new Error('boom'))
      expect((await start(alice, flowId, { filename: 'a.mp4', contentType: 'video/mp4', size: 10 })).status).toBe(502)
    })
  })

  describe('补缩略图 POST /api/flows/:flowId/assets/variants', () => {
    const upload = async (alice: Actor, flowId: string, file: File) => (await alice.upload(`/api/flows/${flowId}/assets`, file)).json<UploadedAsset>()
    const backfill = (actor: Actor, flowId: string, src: unknown) => actor.json(`/api/flows/${flowId}/assets/variants`, 'POST', { src })

    it('缺一档 → 读回原图、只补缺的那档，回补完之后有的档', async () => {
      const { alice, flowId } = await memberFlow()
      const asset = await upload(alice, flowId, await jpeg())
      const stem = asset.key.replace(/\.jpg$/, '')
      const icon = ctx.s3.bytes.get(`${stem}@icon.webp`)
      ctx.s3.objects.delete(`${stem}@low.webp`)

      const res = await backfill(alice, flowId, asset.url)
      expect(res.status).toBe(200)
      expect(res.json()).toEqual({ variants: ['icon', 'low'] })
      expect(ctx.s3.objects.get(`${stem}@low.webp`)?.contentType).toBe('image/webp')
      expect(ctx.s3.bytes.get(`${stem}@icon.webp`)).toBe(icon)
      expect(ctx.s3.reads).toEqual([asset.key])
    })

    it('各档都在 → 什么都不做，不读原图', async () => {
      const { alice, flowId } = await memberFlow()
      const asset = await upload(alice, flowId, await jpeg())

      expect((await backfill(alice, flowId, asset.url)).json()).toEqual({ variants: ['icon', 'low'] })
      expect(ctx.s3.reads).toEqual([])
    })

    it('补不出来（图片损坏）→ 空数组；一阵子之内再请求不再读原图', async () => {
      const { alice, flowId } = await memberFlow()
      const asset = await upload(alice, flowId, png())

      expect((await backfill(alice, flowId, asset.url)).json()).toEqual({ variants: [] })
      expect((await backfill(alice, flowId, asset.url)).json()).toEqual({ variants: [] })
      expect(ctx.s3.reads).toEqual([asset.key])
    })

    it('同时来的请求都等同一次：原图只读一遍', async () => {
      const { alice, flowId } = await memberFlow()
      const asset = await upload(alice, flowId, await jpeg())
      ctx.s3.objects.delete(asset.key.replace(/\.jpg$/, '@low.webp'))

      const results = await Promise.all([backfill(alice, flowId, asset.url), backfill(alice, flowId, asset.url), backfill(alice, flowId, asset.url)])
      expect(results.map((res) => res.json())).toEqual(Array.from({ length: 3 }, () => ({ variants: ['icon', 'low'] })))
      expect(ctx.s3.reads).toEqual([asset.key])
    })

    it('同项目另一张画布（比如复制出来的）引用这张图也能补；复制不动对象也不动记录', async () => {
      const { alice, flowId } = await memberFlow()
      const asset = await upload(alice, flowId, await jpeg())
      ctx.s3.objects.delete(asset.key.replace(/\.jpg$/, '@icon.webp'))

      const objects = ctx.s3.objects.size
      const copy = (await alice.json(`/api/flows/${flowId}/duplicate`, 'POST')).json<{ id: string }>().id
      expect(ctx.s3.objects.size).toBe(objects)
      expect(await records().findInFlow(copy, [asset.key])).toEqual([])

      const res = await backfill(alice, copy, asset.url)
      expect(res.json()).toEqual({ variants: ['icon', 'low'] })
    })

    it('外部链接、档位地址、不是字符串 → 400；形状对但没经本服务上传过 → 404', async () => {
      const { alice, flowId } = await memberFlow()
      const asset = await upload(alice, flowId, await jpeg())

      for (const src of ['https://example.com/a.jpg', asset.url.replace(/\.jpg$/, '@low.webp'), 42]) {
        expect([src, (await backfill(alice, flowId, src)).status]).toEqual([src, 400])
      }
      const unknown = ctx.s3.client.objectUrl('canvas/assets/3f/a8/3fa85f64-5717-4562-b3fc-2c963f66afa6.jpg')
      expect((await backfill(alice, flowId, unknown)).status).toBe(404)
    })

    it('非成员 → 404，不读原图', async () => {
      const { alice, flowId } = await memberFlow()
      const asset = await upload(alice, flowId, await jpeg())
      ctx.s3.objects.delete(asset.key.replace(/\.jpg$/, '@low.webp'))
      const bob = await ctx.actor('bob')

      expect((await backfill(bob, flowId, asset.url)).status).toBe(404)
      expect(ctx.s3.reads).toEqual([])
    })

    it('HEAD 出错 → 502', async () => {
      const { alice, flowId } = await memberFlow()
      const asset = await upload(alice, flowId, await jpeg())
      vi.spyOn(ctx.s3.client, 'headObject').mockRejectedValueOnce(new Error('boom'))

      expect((await backfill(alice, flowId, asset.url)).status).toBe(502)
    })
  })

  describe('撤权', () => {
    it('成员被移除后，上传、分片、补缩略图当场都是 404；加入之前同样 404，加入之后能传', async () => {
      const { alice, projectId, flowId } = await memberFlow()
      const bob = await ctx.actor('bob')
      expect((await bob.upload(`/api/flows/${flowId}/assets`, png())).status).toBe(404)

      await joinViaInvite(alice, projectId, bob)
      const asset = (await bob.upload(`/api/flows/${flowId}/assets`, await jpeg())).json<UploadedAsset>()
      expect(asset.key).toBeTruthy()
      ctx.s3.objects.delete(asset.key.replace(/\.jpg$/, '@low.webp'))

      expect((await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })).status).toBe(204)

      expect((await bob.upload(`/api/flows/${flowId}/assets`, png())).status).toBe(404)
      expect((await bob.json(`/api/flows/${flowId}/assets/multipart`, 'POST', { filename: 'a.mp4', contentType: 'video/mp4', size: 10 })).status).toBe(404)
      expect((await bob.json(`/api/flows/${flowId}/assets/variants`, 'POST', { src: asset.url })).status).toBe(404)
      // 补缩略图是这个接口上唯一会读原图字节的路：被移除的人碰不到
      expect(ctx.s3.reads).toEqual([])

      // 图归画布不归上传的人：留下的成员照常
      expect((await alice.json(`/api/flows/${flowId}/assets/variants`, 'POST', { src: asset.url })).status).toBe(200)
    })
  })

  describe('上传记录的并发', () => {
    const KEY = 'canvas/assets/3f/a8/3fa85f64-5717-4562-b3fc-2c963f66afa6.png'
    const input = (flowId: string) => ({ flowId, key: KEY, contentType: 'image/png', createdById: 'u1' })

    it('同一个键同时记多次（complete 被重放）：只有一行，都算成功，判输赢靠唯一约束', async () => {
      const { flowId } = await memberFlow()
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => records().record(input(flowId))))
      expect(results.filter((result) => result.status === 'rejected')).toEqual([])
      expect(await ctx.dataAccess.em().count(FlowAsset, { key: KEY })).toBe(1)
    })

    it('两张画布抢同一个键：只有一张赢，归属不会被后来者改写', async () => {
      const { alice, projectId, flowId } = await memberFlow()
      const other = await createFlow(alice, projectId)
      const results = await Promise.allSettled([records().record(input(flowId)), records().record(input(other))])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(await ctx.dataAccess.em().count(FlowAsset, { key: KEY })).toBe(1)
      const winner = results[0].status === 'fulfilled' ? flowId : other
      const loser = winner === flowId ? other : flowId
      expect(await records().findInFlow(winner, [KEY])).toHaveLength(1)
      await expect(records().record(input(loser))).rejects.toThrow()
      expect(await records().findInFlow(loser, [KEY])).toEqual([])
    })

    it('同时上传多张图：各记各的', async () => {
      const { alice, flowId } = await memberFlow()
      const uploads = await Promise.all(Array.from({ length: 6 }, () => alice.upload(`/api/flows/${flowId}/assets`, png())))
      expect(uploads.map((res) => res.status)).toEqual(Array.from({ length: 6 }, () => 201))
      expect(await ctx.dataAccess.em().count(FlowAsset, { flow: flowId })).toBe(6)
    })
  })

  describe('别的路径', () => {
    it('文件和分片的字节只有上传接口收：别的路径上这两种类型照旧 415，也不会被当成空请求体放过去', async () => {
      const alice = await ctx.actor('alice')
      const form = await encodeForm(new FormData())
      expect((await alice.request('/api/projects', { method: 'POST', ...form })).status).toBe(415)
      expect((await alice.request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x' })).status).toBe(415)
      const { flowId } = await memberFlow()
      expect((await alice.request(`/api/flows/${flowId}/assets-other`, { method: 'POST', ...form })).status).toBe(415)
    })
  })
})
