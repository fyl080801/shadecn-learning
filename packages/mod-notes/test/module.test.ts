import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { Server } from 'node:http'
import { ALL_ROLES, startModules, type ServerRole } from '@shadecn/server-kit/kernel'
import type { Platform } from '@shadecn/server-kit/platform'
import notes from '../src/module.ts'

describe('笔记模块', () => {
  it('setup 把 /api/notes 挂到宿主上，接口照常工作', async () => {
    const app = new Hono()
    await startModules([notes], {
      roles: new Set<ServerRole>(ALL_ROLES),
      isDev: true,
      platform: {} as Platform,
      server: {} as Server,
      http: { route: (path, sub) => void app.route(path, sub), use() {}, upgrade() {} },
      configs: new Map(),
    })
    const created = await app.request('/api/notes', { method: 'POST', body: JSON.stringify({ title: 't', content: 'c' }) })
    expect(created.status).toBe(201)
    expect(((await (await app.request('/api/notes')).json()) as unknown[]).length).toBeGreaterThan(0)
  })
})
