import { Project } from '@learning/canvas'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AssetStorage } from '../src/asset-storage.js'
import { FlowAsset } from '../src/entities.js'
import { actorOf, bootStorageApp, createFlow, createProject, describeOnBothDatabases, encodeForm } from './helpers.js'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { DataAccess } from '@learning/data-access'

const jpeg = async () => new Uint8Array(await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#808080' } }).jpeg().toBuffer())

describeOnBothDatabases('AssetStorage（别的模块读写画布资源）', (ctx) => {
  const storage = () => ctx.app.get(AssetStorage)

  async function flow() {
    const alice = await ctx.actor('alice')
    const projectId = await createProject(alice)
    return { alice, projectId, flowId: await createFlow(alice, projectId) }
  }

  it('存：同一套键和缩略图，记一行归这张画布，回本服务的地址', async () => {
    const { alice, flowId } = await flow()
    const saved = await storage().save({ flowId, createdById: alice.userId, data: await jpeg(), contentType: 'image/jpeg' })

    expect(saved.key).toMatch(/^canvas\/assets\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f-]{36}\.jpg$/)
    expect(saved.url).toBe(ctx.s3.client.objectUrl(saved.key))
    expect(ctx.s3.objects.has(saved.key.replace(/\.jpg$/, '@icon.webp'))).toBe(true)
    expect(await storage().findInFlow(flowId, [saved.key])).toEqual([{ key: saved.key, contentType: 'image/jpeg' }])
    expect((await ctx.dataAccess.em().findOneOrFail(FlowAsset, { key: saved.key })).createdById).toBe(alice.userId)
  })

  it('存：不是图片或视频 → 抛错，什么都不写', async () => {
    const { alice, flowId } = await flow()
    await expect(storage().save({ flowId, createdById: alice.userId, data: new Uint8Array([1]), contentType: 'text/plain' })).rejects.toThrow('不支持的资源类型')
    expect(ctx.s3.objects.size).toBe(0)
  })

  it('读：这张画布自己的资源 → 字节和记录里的类型', async () => {
    const { alice, flowId } = await flow()
    const data = await jpeg()
    const saved = await storage().save({ flowId, createdById: alice.userId, data, contentType: 'image/jpeg' })
    expect(await storage().read(flowId, saved.url, { maxBytes: 10_000_000 })).toEqual({ data, contentType: 'image/jpeg' })
  })

  it('读：别的画布的资源、外部地址、内网地址、档位地址 → null，一个请求都不发（防 SSRF）', async () => {
    const { alice, projectId, flowId } = await flow()
    const other = await createFlow(alice, projectId)
    const saved = await storage().save({ flowId, createdById: alice.userId, data: await jpeg(), contentType: 'image/jpeg' })
    ctx.s3.reads.length = 0

    for (const url of ['https://evil.test/a.jpg', 'http://169.254.169.254/latest/meta-data', saved.url.replace(/\.jpg$/, '@low.webp')]) {
      expect(await storage().read(flowId, url, { maxBytes: 1000 })).toBeNull()
    }
    expect(await storage().read(other, saved.url, { maxBytes: 1000 })).toBeNull()
    expect(ctx.s3.reads).toEqual([])
  })

  it('读：对象没了 → null；超过上限 → 抛错', async () => {
    const { alice, flowId } = await flow()
    const saved = await storage().save({ flowId, createdById: alice.userId, data: await jpeg(), contentType: 'image/jpeg' })
    vi.spyOn(ctx.s3.client, 'getObject').mockResolvedValueOnce({ status: 'too_large' })
    await expect(storage().read(flowId, saved.url, { maxBytes: 1 })).rejects.toThrow('资源超过 1 字节')
    vi.spyOn(ctx.s3.client, 'getObject').mockResolvedValueOnce({ status: 'not_found' })
    expect(await storage().read(flowId, saved.url, { maxBytes: 1000 })).toBeNull()
  })
})

describe('没配对象存储', () => {
  let dir: string
  let app: NestFastifyApplication
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-off-'))
    app = await bootStorageApp({ databaseUrl: `file:${path.join(dir, 'test.db')}` })
  })
  afterAll(async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
    log.mockRestore()
  })

  it('服务照常启动，启动日志写明原因；上传的每条路都是 503，非成员仍然先 404', async () => {
    expect(log.mock.calls.some((call) => String(call[0]).includes('上传接口回 503'))).toBe(true)
    expect(app.get(AssetStorage).available).toBe(false)

    const alice = await actorOf(app)
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    const base = `/api/flows/${flowId}/assets`

    const form = new FormData()
    form.set('file', new File(['x'], 'a.png', { type: 'image/png' }))
    const upload = await alice.request(base, { method: 'POST', ...(await encodeForm(form)) })
    expect(upload.status).toBe(503)
    expect(upload.json()).toEqual({ error: 'Service Unavailable', message: '未配置对象存储，不能上传' })
    expect((await alice.json(`${base}/multipart`, 'POST', { filename: 'a.mp4', contentType: 'video/mp4', size: 10 })).status).toBe(503)
    expect((await alice.request(`${base}/multipart/u/parts/1?key=x`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'x' })).status).toBe(503)
    expect((await alice.json(`${base}/multipart/u/complete`, 'POST', { key: 'x', parts: [] })).status).toBe(503)
    expect((await alice.json(`${base}/variants`, 'POST', { src: 'x' })).status).toBe(503)
    expect((await alice.request(`${base}/multipart/u?key=x`, { method: 'DELETE' })).status).toBe(503)

    const bob = await actorOf(app, 'bob')
    expect((await bob.json(`${base}/variants`, 'POST', { src: 'x' })).status).toBe(404)
    await app.get(DataAccess).em().nativeDelete(Project, {})
  })

  it('AssetStorage 退化：读是 null，存抛错', async () => {
    const storage = app.get(AssetStorage)
    expect(await storage.read('f', 'https://s3.test/b/k', { maxBytes: 1 })).toBeNull()
    await expect(storage.save({ flowId: 'f', createdById: 'u', data: new Uint8Array([1]), contentType: 'image/png' })).rejects.toThrow('没有配置对象存储')
  })
})
