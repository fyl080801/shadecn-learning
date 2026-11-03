import { type ChildProcess, execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { FlowDocStore } from '@learning/canvas'
import { nodesMap } from '@learning/contracts/flow-doc'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CollabServer } from '../src/collab-server.js'
import { FlowPersistence, roomOf } from '../src/flow-persistence.js'
import { assertTestDatabase, bootCollabApp, connect, createActor, createFlow, createProject, nodeIdsOf, nodeMap } from './helpers.js'

const packageDir = path.resolve(import.meta.dirname, '..')
const tsc = createRequire(path.join(packageDir, 'package.json')).resolve('typescript/bin/tsc')
const TIMEOUT = { timeout: 8000, interval: 20 }

describe('app.close()', () => {
  let dir: string

  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-close-'))
  })
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /** 实测只调 closeConnections() 不关 socket 时 app.close() 一直不返回，ORM 和 Redis 也就关不掉 */
  it('还有 provider 连着也能关完，防抖窗口里的内容落了库，客户端收到的是能重连的关闭', async () => {
    const url = `file:${path.join(dir, 'close.db')}`
    const app = await bootCollabApp(url)
    const alice = await createActor(app)
    const flowId = await createFlow(alice, await createProject(alice))
    const client = connect((await app.getUrl()).replace('http://', 'ws://'), roomOf(flowId), alice.cookie)
    await vi.waitFor(() => expect(client.synced()).toBe(true), TIMEOUT)

    nodesMap(client.doc).set('last-edit', nodeMap())
    const server = app.get(CollabServer, { strict: false }).hocuspocus
    await vi.waitFor(() => expect(server.documents.get(roomOf(flowId))?.getMap('nodes').has('last-edit')).toBe(true), TIMEOUT)
    const persistence = app.get(FlowPersistence, { strict: false })
    // 还没到 2 秒防抖，库里没有
    expect(persistence.storeStats().completed).toBe(0)

    const started = Date.now()
    await app.close()
    expect(Date.now() - started).toBeLessThan(5000)

    // 4xxx 的关闭 reason 才是终局；这里没有，provider 会自己重连
    await vi.waitFor(() => expect(client.closes.length).toBeGreaterThan(0), TIMEOUT)
    expect(client.closes.map((close) => close.reason)).not.toContain('permission-revoked')
    client.destroy()

    const reader = await bootCollabApp(url)
    const row = await reader.get(FlowDocStore, { strict: false }).read(flowId, { liveProject: true, legacy: false })
    expect(nodeIdsOf(row?.ydoc)).toEqual(['last-edit'])
    await reader.close()
  }, 30_000)

  /** 人走光时 Hocuspocus 自己会补一次存，这条看不出 `flushRooms` 在不在。房间还被 direct connection（agent）撑着时，只有它会写 */
  it('房间不因断连而散场时，退出也逐房间落库：不能指望 Hocuspocus 的散场和防抖', async () => {
    const url = `file:${path.join(dir, 'direct.db')}`
    const app = await bootCollabApp(url)
    const alice = await createActor(app)
    const flowId = await createFlow(alice, await createProject(alice))
    const connection = await app.get(CollabServer, { strict: false }).hocuspocus.openDirectConnection(roomOf(flowId), {})
    await connection.transact((doc) => {
      nodesMap(doc).set('held-open', nodeMap())
    })

    await app.close()

    const reader = await bootCollabApp(url)
    const row = await reader.get(FlowDocStore, { strict: false }).read(flowId, { liveProject: true, legacy: false })
    expect(nodeIdsOf(row?.ydoc)).toEqual(['held-open'])
    await reader.close()
  }, 30_000)

  it('定时器和撤权订阅在关闭时撤掉，不会对着关掉的 ORM 再跑', async () => {
    const app = await bootCollabApp(`file:${path.join(dir, 'timers.db')}`)
    const server = app.get(CollabServer, { strict: false })
    const internals = server as unknown as { timers: unknown[]; stopRevocation: unknown }
    expect(internals.timers.length).toBeGreaterThan(0)
    expect(internals.stopRevocation).toBeTypeOf('function')

    await app.close()

    expect(internals.timers).toEqual([])
    expect(internals.stopRevocation).toBeUndefined()
  })
})

/** 编译要等一会儿；类型走源码（source 条件），互不依赖对方的 dist，所以并行 */
const PACKAGES = ['config', 'contracts', 'foundation', 'cluster', 'data-access', 'session', 'canvas', 'collab']

describe('真 SIGTERM（子进程跑真实产物）', () => {
  beforeAll(async () => {
    const run = promisify(execFile)
    await Promise.all(PACKAGES.map((name) => run(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: path.resolve(packageDir, '..', name) })))
  }, 240_000)

  function start(dataDir: string): Promise<{ child: ChildProcess; url: string; cookie: string; output: () => string }> {
    const child = spawn(process.execPath, [path.join(packageDir, 'test/fixtures/shutdown-app.mjs')], {
      // 干净的 cwd：不读仓库的 .env
      cwd: dataDir,
      env: { PATH: process.env.PATH, NODE_ENV: 'production', DATA_DIR: dataDir, PLATFORM_SESSION_SECRET: 'sigterm-secret' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        output += chunk.toString()
        const ready = /^READY (.+)$/m.exec(output)
        if (ready) resolve({ child, ...(JSON.parse(ready[1]) as { url: string; cookie: string }), output: () => output })
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.once('exit', (code) => reject(new Error(`子进程提前退出（${code}）：${output}`)))
    })
  }

  function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  }

  async function sigtermKeepsLastEdit(databaseUrl: string | null, dataDir: string, cleanup?: (reader: Awaited<ReturnType<typeof bootCollabApp>>) => Promise<unknown>) {
    fs.writeFileSync(path.join(dataDir, 'config.yaml'), JSON.stringify({ server: { port: 0, host: '127.0.0.1' }, ...(databaseUrl ? { database: { url: databaseUrl } } : {}) }))
    const { child, url, cookie, output } = await start(dataDir)
    const api = (target: string, init: { method?: string; body?: unknown } = {}) =>
      fetch(`${url}${target}`, { method: init.method ?? 'GET', headers: { cookie, 'content-type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
    const { id: projectId } = (await (await api('/api/projects', { method: 'POST', body: { name: '项目' } })).json()) as { id: string }
    const { id: flowId } = (await (await api(`/api/projects/${projectId}/flows`, { method: 'POST', body: { name: '画布' } })).json()) as { id: string }

    const client = connect(url.replace('http://', 'ws://'), roomOf(flowId), cookie)
    await vi.waitFor(() => expect(client.synced()).toBe(true), TIMEOUT)
    nodesMap(client.doc).set('last-edit', nodeMap())
    // 服务端确认收到（NACK 之外 unsynced 才归零）。此时离 2 秒防抖还早，内容只在内存里
    await vi.waitFor(() => expect(client.provider.hasUnsyncedChanges).toBe(false), TIMEOUT)

    const exited = exitOf(child)
    const killedAt = Date.now()
    child.kill('SIGTERM')
    const { code, signal } = await exited

    expect({ code, signal, tail: output().slice(-500) }).toMatchObject({ code: 0, signal: null })
    expect(Date.now() - killedAt).toBeLessThan(10_000)
    client.destroy()

    const reader = await bootCollabApp(databaseUrl ?? `file:${path.join(dataDir, 'platform.db')}`)
    const docs = reader.get(FlowDocStore, { strict: false })
    const row = await docs.read(flowId, { liveProject: true, legacy: false })
    expect(nodeIdsOf(row?.ydoc)).toEqual(['last-edit'])
    await cleanup?.(reader)
    await reader.close()
  }

  it('防抖窗口里的最后一笔：kill -TERM 后退出码 0，内容在库', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-sigterm-'))
    try {
      await sigtermKeepsLastEdit(null, dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL
  it.skipIf(!postgresUrl)('PostgreSQL 上同样不丢', async () => {
    const url = postgresUrl as string
    assertTestDatabase(url)
    const schema = 'collab_sigterm_test'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-sigterm-pg-'))
    try {
      const { DataAccess } = await import('@learning/data-access')
      await sigtermKeepsLastEdit(`${url}?schema=${schema}`, dir, (reader) => reader.get(DataAccess).orm.schema.execute(`drop schema if exists ${schema} cascade`))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
