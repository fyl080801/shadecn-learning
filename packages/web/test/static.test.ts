import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './helpers.js'

// 工厂只在 vite 真被加载时才运行：static 模式碰到它，下面的用例全部失败
vi.mock('vite', () => {
  throw new Error('static 模式不该加载 vite')
})

const htmlEntries = { '/login': 'login.html' }

describe('WebModule：static 模式', () => {
  let dir: string
  let app: NestFastifyApplication
  let baseUrl: string

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-web-static-'))
    fs.mkdirSync(path.join(dir, 'assets'))
    fs.writeFileSync(path.join(dir, 'index.html'), 'INDEX')
    fs.writeFileSync(path.join(dir, 'login.html'), 'LOGIN')
    fs.writeFileSync(path.join(dir, 'assets/a.js'), 'console.log(1)')
    ;({ app, baseUrl } = await createApp({ mode: 'static', root: dir, htmlEntries }))
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['/', 'INDEX'],
    ['/flows/abc?x=1', 'INDEX'],
    ['/login', 'LOGIN'],
    ['/login?redirect=/x', 'LOGIN'],
    ['/loginXxx', 'INDEX'],
  ])('GET %s → 对应的 HTML 入口，且不缓存', async (url, body) => {
    const res = await fetch(baseUrl + url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(body)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('存在的文件按原样返回', async () => {
    const res = await fetch(`${baseUrl}/assets/a.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toBe('console.log(1)')
  })

  it('后端路由优先，前缀下的未知路径是 JSON 404 而不是 HTML', async () => {
    expect(await (await fetch(`${baseUrl}/api/hello`)).text()).toBe('Hello World!')
    const missing = await fetch(`${baseUrl}/api/none`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')).toContain('application/json')
  })

  it('非 GET 的页面请求 → 404', async () => {
    expect((await fetch(`${baseUrl}/flows/abc`, { method: 'POST' })).status).toBe(404)
  })

  it('apiPrefix 可配置：换前缀后原来的 /api 下也回落到 HTML', async () => {
    const custom = await createApp({ mode: 'static', root: dir, apiPrefix: '/backend' })
    try {
      const res = await fetch(`${custom.baseUrl}/backend/none`)
      expect(res.status).toBe(404)
      expect(await (await fetch(`${custom.baseUrl}/other`)).text()).toBe('INDEX')
    } finally {
      await custom.app.close()
    }
  })

  it('产物缺 HTML 入口 → 启动失败，提示先构建', async () => {
    const missing = path.join(os.tmpdir(), 'learning-web-不存在')
    await expect(createApp({ mode: 'static', root: missing })).rejects.toThrow('先构建前端')
  })
})
