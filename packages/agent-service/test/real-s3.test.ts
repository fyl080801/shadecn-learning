import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MediaReadError } from '@learning/agent-core/media'
import { AssetStorage } from '@learning/storage'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentMediaReader } from '../src/media.js'
import { encodeS3Path, signS3Request } from '../../storage/src/s3.js'
import { bootAgentApp, createActor, createFlow, createProject, silenceConsole, type Actor } from './helpers.js'

/**
 * 对真的 S3 兼容服务跑 `AgentMediaReader`（`PLATFORM_TEST_S3_URL=http://<ak>:<sk>@127.0.0.1:9000/<bucket>`，没配就跳过）：真的读到字节、类型取自 S3、外部地址不发请求、密钥不对映射成 unavailable。
 * 桶名同时带 platform 和 test 才肯动，收尾时删掉自己写的对象。
 */
const s3Url = process.env.PLATFORM_TEST_S3_URL

describe.skipIf(!s3Url)('真的对象存储（PLATFORM_TEST_S3_URL）', () => {
  const url = new URL(s3Url ?? 'http://x')
  const bucket = url.pathname.slice(1)
  const accessKeyId = decodeURIComponent(url.username)
  const secretAccessKey = decodeURIComponent(url.password)
  const internal = `${url.protocol}//${url.host}`
  const keyPrefix = `test-${randomUUID()}/canvas`
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

  let dir: string
  let app: NestFastifyApplication
  let alice: Actor
  const written = new Set<string>()

  async function signed(method: string, target: string) {
    const requestUrl = new URL(`${internal}/${bucket}${target}`)
    const headers = signS3Request({ method, url: requestUrl, headers: {}, payloadHash: createHash('sha256').update('').digest('hex'), region: 'us-east-1', accessKeyId, secretAccessKey, date: new Date() })
    delete headers.host
    return fetch(requestUrl, { method, headers })
  }

  const boot = (name: string, secret: string) =>
    bootAgentApp({
      databaseUrl: `file:${path.join(dir, name)}`,
      values: { storage: { endpoint: internal, bucket, keyPrefix } },
      env: { PLATFORM_S3_ACCESS_KEY_ID: accessKeyId, PLATFORM_S3_SECRET_ACCESS_KEY: secret },
    })

  beforeAll(async () => {
    if (!/platform/.test(bucket) || !/test/.test(bucket)) throw new Error(`[agent 测试] PLATFORM_TEST_S3_URL 的桶名必须同时带 platform 和 test，收到的是 ${bucket}`)
    silenceConsole()
    const created = await signed('PUT', '')
    if (!created.ok && created.status !== 409) throw new Error(`[agent 测试] 建桶失败：${created.status} ${await created.text()}`)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-real-s3-'))
    app = await boot('test.db', secretAccessKey)
    alice = await createActor(app)
  }, 30_000)

  afterAll(async () => {
    for (const key of written) await signed('DELETE', `/${encodeS3Path(key)}`)
    await app?.close()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('本桶的素材读得到；外部地址不发请求；对象没了是 not_found；太大是 too_large', async () => {
    const flowId = await createFlow(alice, await createProject(alice))
    const saved = await app.get(AssetStorage, { strict: false }).save({ flowId, createdById: alice.userId, data: PNG, contentType: 'image/png', name: 'cat.png' })
    written.add(saved.key)
    const reader = app.get(AgentMediaReader, { strict: false })

    const got = await reader.read(saved.url, { maxBytes: 1024 })
    expect(new Uint8Array(got.data)).toEqual(PNG)
    expect(got.contentType).toBe('image/png')

    const failure = (target: string, maxBytes = 1024) => reader.read(target, { maxBytes }).then(() => null, (err: unknown) => err)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await failure('http://169.254.169.254/latest/meta-data/iam.png')).toMatchObject({ kind: 'foreign' })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()

    expect(await failure(saved.url.replace(saved.key.split('/').at(-1)!, `${randomUUID()}.png`))).toMatchObject({ kind: 'foreign' })
    expect(await failure(saved.url, 1)).toMatchObject({ kind: 'too_large' })
    const gone = await failure(saved.url.replace(/[^/]+\/[^/]+\/[^/]+$/, (tail) => {
      const id = randomUUID()
      return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}${path.extname(tail)}`
    }))
    expect(gone).toMatchObject({ kind: 'not_found' })
  }, 30_000)

  it('密钥不对：S3 拒绝（reject）映射成 unavailable，细节不进模型上下文', async () => {
    const flowId = await createFlow(alice, await createProject(alice))
    const saved = await app.get(AssetStorage, { strict: false }).save({ flowId, createdById: alice.userId, data: PNG, contentType: 'image/png', name: 'cat.png' })
    written.add(saved.key)
    const wrong = await boot('wrong.db', `${secretAccessKey}-wrong`)
    try {
      const err = await wrong.get(AgentMediaReader, { strict: false }).read(saved.url, { maxBytes: 1024 }).then(() => null, (error: unknown) => error)
      expect(err).toBeInstanceOf(MediaReadError)
      expect(err).toMatchObject({ kind: 'unavailable', message: '对象存储读取失败' })
    } finally {
      await wrong.close()
    }
  }, 30_000)
})
