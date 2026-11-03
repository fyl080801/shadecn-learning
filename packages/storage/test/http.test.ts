import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { ASSET_PART_SIZE, type AssetUploadSession, type UploadedAsset } from '@learning/contracts/canvas'
import { SessionService, UserService } from '@learning/session'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootStorageApp, fakeS3 } from './helpers.js'

/**
 * 真走 socket：`app.inject` 给的请求流和真的 `IncomingMessage` 不是一回事，提前结束、拒绝之后还在发字节这些只有真连接才看得出来。
 * 浏览器的 fetch 由 Node 的 fetch 代替。
 */
describe('上传接口（真的 HTTP 连接）', () => {
  let dir: string
  let app: NestFastifyApplication
  let baseUrl: string
  let cookie: string
  let bobCookie: string
  let flowId: string
  const s3 = fakeS3()

  async function login(subject: string) {
    const user = await app.get(UserService).findOrCreate({ issuer: 'https://issuer.test', subject })
    const token = await app.get(SessionService).create({
      userId: user.id,
      provider: 'oidc',
      tokens: { accessToken: 'x', refreshToken: null, idToken: null, expiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: null, sessionState: null },
    })
    return `sid=${token}`
  }

  const headers = (extra: Record<string, string> = {}) => ({ cookie, origin: 'http://127.0.0.1:3000', ...extra })

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-http-'))
    app = await bootStorageApp({ databaseUrl: `file:${path.join(dir, 'test.db')}`, s3: s3.client })
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
    cookie = await login('http-alice')
    bobCookie = await login('http-bob')
    const project = await (await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ name: '项目' }) })).json()
    const flow = await (await fetch(`${baseUrl}/api/projects/${(project as { id: string }).id}/flows`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ name: '画布' }) })).json()
    flowId = (flow as { id: string }).id
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('浏览器那样发 FormData → 201，文件名和类型都收到了', async () => {
    const form = new FormData()
    form.set('file', new File([new Uint8Array(5000)], '图片 (1).PNG', { type: 'image/png' }))
    const res = await fetch(`${baseUrl}/api/flows/${flowId}/assets`, { method: 'POST', headers: headers(), body: form })
    expect(res.status).toBe(201)
    const body = (await res.json()) as UploadedAsset
    expect(body).toMatchObject({ contentType: 'image/png', size: 5000 })
    expect(body.key.endsWith('.png')).toBe(true)
    expect(s3.bytes.get(body.key)?.byteLength).toBe(5000)
  })

  it('整片大小的分片：字节一个不少', async () => {
    const start = await fetch(`${baseUrl}/api/flows/${flowId}/assets/multipart`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ filename: 'a.mp4', contentType: 'video/mp4', size: ASSET_PART_SIZE }),
    })
    const session = (await start.json()) as AssetUploadSession
    const res = await fetch(`${baseUrl}/api/flows/${flowId}/assets/multipart/${encodeURIComponent(session.uploadId)}/parts/1?key=${encodeURIComponent(session.key)}`, {
      method: 'PUT',
      headers: headers({ 'content-type': 'application/octet-stream' }),
      body: new Uint8Array(ASSET_PART_SIZE),
    })
    expect(res.status).toBe(200)
    expect(s3.uploads.get(session.uploadId)?.parts.get(1)).toBe(ASSET_PART_SIZE)
  })

  it('分块编码、不声明长度、发个不停：一超限对方就能收到 413（连接没被提前掐断），同一个进程接着能用', async () => {
    // 一直发、不结束：服务端要是等读完才判，这个请求永远回不来
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
    })
    const res = await fetch(`${baseUrl}/api/flows/${flowId}/assets`, {
      method: 'POST',
      headers: headers({ 'content-type': 'multipart/form-data; boundary=x' }),
      body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    expect(((await res.json()) as { message: string }).message).toContain('分片')
    expect((await fetch(`${baseUrl}/api/projects`, { headers: headers() })).status).toBe(200)
  })

  it('非成员：真的发了一个大请求体也是 404，不用等传完', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const { hostname, port } = new URL(baseUrl)
      const req = http.request(
        { hostname, port, method: 'POST', path: `/api/flows/${flowId}/assets`, headers: { cookie: bobCookie, 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(ASSET_PART_SIZE * 4) } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
          req.destroy()
        },
      )
      req.on('error', reject)
      // 只发一点，响应已经回来就说明没有在等请求体
      req.write(Buffer.alloc(1024))
    })
    expect(status).toBe(404)
  })

  it('客户端传到一半断开：什么都不写，进程还活着', async () => {
    const before = s3.objects.size
    await new Promise<void>((resolve) => {
      const { hostname, port } = new URL(baseUrl)
      const req = http.request({ hostname, port, method: 'POST', path: `/api/flows/${flowId}/assets`, headers: { cookie, 'content-type': 'multipart/form-data; boundary=x', 'content-length': '100000' } })
      req.on('error', () => undefined)
      req.write(Buffer.alloc(1000))
      setTimeout(() => {
        req.destroy()
        resolve()
      }, 50)
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(s3.objects.size).toBe(before)
    expect((await fetch(`${baseUrl}/api/projects`, { headers: headers() })).status).toBe(200)
  })
})
