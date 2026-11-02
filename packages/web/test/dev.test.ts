import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './helpers.js'

async function connectHmr(baseUrl: string) {
  const client = await (await fetch(`${baseUrl}/@vite/client`)).text()
  const token = /wsToken = "([^"]+)"/.exec(client)?.[1]
  expect(token).toBeTruthy()
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/?token=${token}`, 'vite-hmr')
  const first = await new Promise<string>((resolve, reject) => {
    ws.onmessage = (event) => resolve(String(event.data))
    ws.onerror = () => reject(new Error('HMR 连接失败'))
  })
  return { ws, first: JSON.parse(first) as { type: string } }
}

describe('WebModule：dev 模式', () => {
  let root: string
  let app: NestFastifyApplication
  let baseUrl: string

  beforeAll(async () => {
    // macOS 的 /var 是软链：root 不是真实路径时 Vite 加载失败，会退回静态中间件返回未转译的原文
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'learning-web-vite-')))
    const page = (name: string) =>
      `<!doctype html><html><head></head><body>${name}<script type="module" src="/main.ts"></script></body></html>`
    fs.writeFileSync(path.join(root, 'index.html'), page('INDEX'))
    fs.writeFileSync(path.join(root, 'login.html'), page('LOGIN'))
    fs.writeFileSync(path.join(root, 'main.ts'), 'const n: number = 1\nconsole.log(n)\n')
    ;({ app, baseUrl } = await createApp({
      mode: 'dev',
      root,
      htmlEntries: { '/login': 'login.html' },
    }))
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it.each([
    ['/', 'INDEX'],
    ['/flows/abc', 'INDEX'],
    ['/login?redirect=/x', 'LOGIN'],
  ])('GET %s → 对应的 HTML 入口，并注入 Vite 客户端', async (url, marker) => {
    const res = await fetch(baseUrl + url)
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(html).toContain(marker)
    expect(html).toContain('/@vite/client')
  })

  it('源码经 Vite 转译后返回', async () => {
    const res = await fetch(`${baseUrl}/main.ts`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).not.toContain(': number')
  })

  it('后端路径不进 Vite：接口正常，未知路径是 JSON 404', async () => {
    expect(await (await fetch(`${baseUrl}/api/hello`)).text()).toBe('Hello World!')
    const missing = await fetch(`${baseUrl}/api/none`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')).toContain('application/json')
  })

  it('回退路由不抢 Vite 的路由：页面请求经 Vite 转译，拿不到 root 里的 HTML 原文', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text()
    expect(html).toContain('/@vite/client')
    expect(html).not.toBe(fs.readFileSync(path.join(root, 'index.html'), 'utf8'))
  })

  it('非 GET 的页面请求 → JSON 404', async () => {
    const res = await fetch(`${baseUrl}/flows/abc`, { method: 'POST' })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('HMR 的 WebSocket 与后端同端口', async () => {
    const { ws, first } = await connectHmr(baseUrl)
    ws.close()
    expect(first.type).toBe('connected')
  })

  it('app.close() 一并关闭 Vite：HMR 还连着也不会挂住', async () => {
    const other = await createApp({ mode: 'dev', root })
    const { ws } = await connectHmr(other.baseUrl)
    const closed = new Promise((resolve) => (ws.onclose = resolve))
    await other.app.close()
    await closed
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })
})
