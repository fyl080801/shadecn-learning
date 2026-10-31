import { createServer } from 'node:http'
import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { flushRoom } from '@shadecn/mod-collab/contract'
import { attachCollabServer } from '@shadecn/mod-collab/hocuspocus'
import { flushCollabWrites, loadFlowState, roomOf } from '@shadecn/mod-collab/persistence'
import { nodesMap } from '@shadecn/shared/flow-doc'
import { resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject } from '../helpers/project.ts'

/**
 * headless 协同（docs/28 §3.4.2）：只有 agent 角色的进程挂 Hocuspocus 但不接 WebSocket。
 * 房间只经 direct connection 打开；落库、总线上的落库请求照常。
 */

beforeEach(async () => {
  await resetDb()
})

describe('headless 协同实例', () => {
  it('不在 http server 上注册 upgrade 监听', async () => {
    const server = createServer()
    const before = server.listenerCount('upgrade')

    await attachCollabServer(server, { headless: true })

    expect(server.listenerCount('upgrade')).toBe(before)
  })

  it('非 headless 会注册（对照）', async () => {
    const server = createServer()
    await attachCollabServer(server)
    expect(server.listenerCount('upgrade')).toBe(1)
  })

  it('direct connection 写进去的内容，经总线的 flushRoom 落进库里', async () => {
    const owner = await actor()
    const projectId = await createProject(owner)
    const flowId = await createFlow(owner, projectId)
    const hocuspocus = await attachCollabServer(createServer(), { headless: true })

    const connection = await hocuspocus.openDirectConnection(roomOf(flowId), {})
    await connection.transact((doc: Y.Doc) => {
      const node = new Y.Map<unknown>()
      node.set('id', 'n1')
      nodesMap(doc).set('n1', node)
    })

    await flushRoom(flowId)
    await flushCollabWrites()

    const stored = await loadFlowState(roomOf(flowId))
    const doc = new Y.Doc()
    if (stored) Y.applyUpdate(doc, stored)
    expect([...nodesMap(doc).keys()]).toContain('n1')

    await connection.disconnect()
  })
})
