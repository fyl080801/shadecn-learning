import { createServer } from 'node:http'
import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import canvas from '@shadecn/mod-canvas'
import { flushFlowContent } from '@shadecn/mod-canvas/contract'
import collab from '@shadecn/mod-collab'
import { attachCollabServer } from '@shadecn/mod-collab/hocuspocus'
import { startModules, type ServerRole } from '@shadecn/server-kit/kernel'
import { COLLAB_PATH } from '@shadecn/shared/collab'
import { platform } from '@shadecn/server-core/platform'
import { flushCollabWrites, loadFlowState, roomOf } from '@shadecn/mod-collab/persistence'
import { nodesMap } from '@shadecn/shared/flow-doc'
import { resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject } from '../helpers/project.ts'

/**
 * headless 协同（docs/28 §3.4.2）：只有 agent 角色的进程挂 Hocuspocus 但不接 WebSocket。
 * WebSocket 入口声明的角色是 collab，内核在这种进程里不让它认领；房间只经 direct connection 打开，落库、总线上的落库请求照常。
 */

/** 按给定角色装一遍画布 + 协同，返回协同认领了哪些 WebSocket 入口 */
async function upgradesClaimedAs(roles: ServerRole[]): Promise<string[]> {
  const claimed: string[] = []
  const loaded = await startModules([canvas, collab], {
    roles: new Set(roles),
    isDev: false,
    platform,
    server: createServer(),
    http: { route() {}, use() {}, upgrade: (path) => void claimed.push(path) },
    configs: new Map(),
  })
  await loaded.shutdown()
  return claimed
}

beforeEach(async () => {
  await resetDb()
})

describe('headless 协同实例', () => {
  it('只有 agent 角色：不认领 WebSocket 入口', async () => {
    expect(await upgradesClaimedAs(['agent'])).toEqual([])
  })

  it('带 collab 角色会认领（对照）', async () => {
    expect(await upgradesClaimedAs(['collab'])).toEqual([COLLAB_PATH])
  })

  it('direct connection 写进去的内容，经总线的 flushFlowContent 落进库里', async () => {
    const owner = await actor()
    const projectId = await createProject(owner)
    const flowId = await createFlow(owner, projectId)
    const hocuspocus = await attachCollabServer()

    const connection = await hocuspocus.openDirectConnection(roomOf(flowId), {})
    await connection.transact((doc: Y.Doc) => {
      const node = new Y.Map<unknown>()
      node.set('id', 'n1')
      nodesMap(doc).set('n1', node)
    })

    await flushFlowContent(flowId)
    await flushCollabWrites()

    const stored = await loadFlowState(roomOf(flowId))
    const doc = new Y.Doc()
    if (stored) Y.applyUpdate(doc, stored)
    expect([...nodesMap(doc).keys()]).toContain('n1')

    await connection.disconnect()
  })
})
