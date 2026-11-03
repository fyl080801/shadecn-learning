import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Module } from '@nestjs/common'
import { nodesMap } from '@learning/contracts/flow-doc'
import { FlowDocStore } from '@learning/canvas'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as Y from 'yjs'
import { CollabServer } from '../src/collab-server.js'
import { CollabModule } from '../src/collab.module.js'
import { FlowPersistence, roomOf } from '../src/flow-persistence.js'
import { bootCollabApp, createActor, createFlow, createProject, nodeIdsOf, nodeMap } from './helpers.js'

/** 只 import `CollabModule` 的进程（docs/30 §2，将来的 agent 进程）：有房间，不接 WebSocket。从 `apps/server/test/collab/headless.test.ts` 移植 */
@Module({ imports: [CollabModule], exports: [CollabModule] })
class HeadlessModule {}

describe('只有 CollabModule 的进程', () => {
  let dir: string
  let app: Awaited<ReturnType<typeof bootCollabApp>>

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-headless-'))
    app = await bootCollabApp(`file:${path.join(dir, 'test.db')}`, { imports: [HeadlessModule] })
  })
  afterAll(async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('不认领 WebSocket：没有 upgrade 监听者', () => {
    expect((app.getHttpServer() as http.Server).listenerCount('upgrade')).toBe(0)
  })

  it('没有 /api/collab 和 /doc 路由', async () => {
    const alice = await createActor(app)
    expect((await alice.request('/api/collab/health')).status).toBe(404)
    expect((await alice.request('/api/flows/x/doc')).status).toBe(404)
  })

  it('direct connection 写进去的内容，散场时经同一条读-合并-CAS 落进库里', async () => {
    const alice = await createActor(app)
    const flowId = await createFlow(alice, await createProject(alice))
    const hocuspocus = app.get(CollabServer, { strict: false }).hocuspocus
    const room = roomOf(flowId)

    const connection = await hocuspocus.openDirectConnection(room, {})
    await connection.transact((doc: Y.Doc) => {
      nodesMap(doc).set('n1', nodeMap())
    })
    await connection.disconnect()
    await vi.waitFor(() => expect(hocuspocus.documents.has(room)).toBe(false), { timeout: 5000 })

    const row = await app.get(FlowDocStore, { strict: false }).read(flowId, { liveProject: true, legacy: false })
    expect(nodeIdsOf(row?.ydoc)).toEqual(['n1'])
    expect(app.get(FlowPersistence, { strict: false }).failedStoreCount()).toBe(0)
  })
})
