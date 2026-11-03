import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AssetStorage } from '@learning/storage'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { encodeS3Path, signS3Request } from '../../storage/src/s3.js'
import { type Actor, bootAppsApp, createActor, createFlow, createProject, IMAGE_APP, nodeRecord, nodeWithStatus, PNG, seedNodes, submit, taskDone } from './helpers.js'

/**
 * 对真的 S3 兼容服务跑一遍生成任务的两头（`PLATFORM_TEST_S3_URL=http://<ak>:<sk>@127.0.0.1:9000/<bucket>`，没配就跳过）：
 * 本画布的参考图经 `AssetStorage.read` 换成字节、产物经 `AssetStorage.save` 真的存进桶。桶名同时带 platform 和 test 才肯动，收尾时删掉自己写的对象。
 */
const s3Url = process.env.PLATFORM_TEST_S3_URL

describe.skipIf(!s3Url)('真的对象存储（PLATFORM_TEST_S3_URL）', () => {
  const url = new URL(s3Url ?? 'http://x')
  const bucket = url.pathname.slice(1)
  const accessKeyId = decodeURIComponent(url.username)
  const secretAccessKey = decodeURIComponent(url.password)
  const internal = `${url.protocol}//${url.host}`
  const keyPrefix = `test-${randomUUID()}/canvas`
  const realFetch = globalThis.fetch

  let dir: string
  let app: NestFastifyApplication
  let alice: Actor
  const written = new Set<string>()

  /** 客户端没有的动作（建桶、删对象），测试自己签 */
  async function signed(method: string, target: string) {
    const requestUrl = new URL(`${internal}/${bucket}${target}`)
    const headers = signS3Request({ method, url: requestUrl, headers: {}, payloadHash: createHash('sha256').update('').digest('hex'), region: 'us-east-1', accessKeyId, secretAccessKey, date: new Date() })
    delete headers.host
    return realFetch(requestUrl, { method, headers })
  }

  beforeAll(async () => {
    if (!/platform/.test(bucket) || !/test/.test(bucket)) throw new Error(`[apps 测试] PLATFORM_TEST_S3_URL 的桶名必须同时带 platform 和 test，收到的是 ${bucket}`)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const created = await signed('PUT', '')
    if (!created.ok && created.status !== 409) throw new Error(`[apps 测试] 建桶失败：${created.status} ${await created.text()}`)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-real-s3-'))
    app = await bootAppsApp({
      databaseUrl: `file:${path.join(dir, 'test.db')}`,
      values: { storage: { endpoint: internal, bucket, keyPrefix } },
      env: { PLATFORM_S3_ACCESS_KEY_ID: accessKeyId, PLATFORM_S3_SECRET_ACCESS_KEY: secretAccessKey },
    })
    alice = await createActor(app)
  }, 30_000)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  afterAll(async () => {
    for (const key of written) await signed('DELETE', `/${encodeS3Path(key)}`)
    await app?.close()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('参考图从桶里读成字节发给上游（不请求它的地址），产物存进桶、地址写回节点，读出来字节一样', async () => {
    const flowId = await createFlow(alice, await createProject(alice))
    await seedNodes(app, flowId, [nodeRecord('n', 'image')])
    const storage = app.get(AssetStorage, { strict: false })
    const reference = await storage.save({ flowId, createdById: alice.userId, data: new Uint8Array(Buffer.from('reference-bytes')), contentType: 'image/png' })
    written.add(reference.key)

    const output = new Uint8Array([...PNG, 9, 9, 9])
    const upstream: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const target = String(input)
      if (target.startsWith(internal)) return realFetch(input as string, init)
      upstream.push({ url: target, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
      if (target.endsWith('/images/generations')) return new Response(JSON.stringify({ data: [{ url: 'https://ark-cdn.example/out.png' }] }), { headers: { 'content-type': 'application/json' } })
      if (target === 'https://ark-cdn.example/out.png') return new Response(output, { headers: { 'content-type': 'image/png' } })
      throw new Error(`[test] 未打桩的出站请求：${target}`)
    })

    const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x', image: [reference.url] }, nodeId: 'n' })
    expect((await taskDone(app, task!.id)).status).toBe('succeeded')
    expect((upstream[0].body as { image: string }).image).toBe(`data:image/png;base64,${Buffer.from('reference-bytes').toString('base64')}`)

    const node = await nodeWithStatus(app, flowId, 'n', 'completed')
    const src = node.data.src as string
    expect(src.startsWith(`${internal}/${bucket}/${keyPrefix}/assets/`)).toBe(true)
    const key = src.slice(`${internal}/${bucket}/`.length)
    written.add(key)
    const stored = await storage.read(flowId, src, { maxBytes: 1024 })
    expect(Buffer.from(stored!.data).equals(Buffer.from(output))).toBe(true)
  }, 30_000)
})
