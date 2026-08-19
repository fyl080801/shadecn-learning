import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { authorizeCollab } from '../../auth/ws.ts'
import { nodesMap } from '../../collab/flow-doc.ts'
import { forgetFlow, roomOf } from '../../collab/persistence.ts'
import { COLLAB_LIMITS } from '../../collab/quota.ts'
import type { ProjectSummary } from '../../store/projects.ts'
import { resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, type Actor } from '../helpers/project.ts'

/**
 * 个人画布的内容通道（REQ-SOLO §4.2 / §4.4）。
 *
 * 重点不在「能存能取」，而在**两条通道不许串台**：个人画布不许连协同房间，
 * 项目画布不许走这个接口。任何一头漏了，用户都会以为自己存上了而其实没有。
 */

const OCTET = { 'content-type': 'application/octet-stream' }

async function personalSpace(who: Actor): Promise<ProjectSummary> {
  return (await (await who.request('/api/projects/personal')).json()) as ProjectSummary
}

/** 造一段「加这些节点」的 Yjs 增量 */
function addNodes(...ids: string[]): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => {
    for (const id of ids) {
      const node = new Y.Map<unknown>()
      node.set('position', { x: 0, y: 0 })
      node.set('data', new Y.Map<unknown>())
      nodesMap(doc).set(id, node)
    }
  })
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

function push(who: Actor, flowId: string, update: Uint8Array) {
  return who.request(`/api/flows/${flowId}/doc`, {
    method: 'POST',
    headers: OCTET,
    body: update,
  })
}

async function pull(who: Actor, flowId: string, sv?: string) {
  const res = await who.request(`/api/flows/${flowId}/doc${sv ? `?sv=${sv}` : ''}`)
  return res
}

/** 把拉回来的字节读成一个文档，看看里面有哪些节点 */
function nodeIdsOf(bytes: ArrayBuffer): string[] {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(bytes))
  const ids = [...nodesMap(doc).keys()].sort()
  doc.destroy()
  return ids
}

describe('个人画布的内容通道', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('推上去的增量能原样拉回来', async () => {
    const alice = await actor()
    const space = await personalSpace(alice)
    const flowId = await createFlow(alice, space.id)

    const pushed = await push(alice, flowId, addNodes('n1', 'n2'))
    expect(pushed.status).toBe(200)
    const ack = (await pushed.json()) as { stateVector: string; revision: number; noop: boolean }
    expect(ack.noop).toBe(false)
    expect(ack.revision).toBe(1)

    const pulled = await pull(alice, flowId)
    expect(pulled.headers.get('content-type')).toContain('application/octet-stream')
    expect(nodeIdsOf(await pulled.arrayBuffer())).toEqual(['n1', 'n2'])

    // 带上服务端给的基线：已经同步到最新，拉回来的差量近乎为空
    const diff = await pull(alice, flowId, ack.stateVector)
    expect(nodeIdsOf(await diff.arrayBuffer())).toEqual([])

    await forgetFlow(roomOf(flowId))
  })

  it('项目画布走这条通道 → 409，内容一个字节都没进去', async () => {
    const alice = await actor()
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)

    expect((await push(alice, flowId, addNodes('n1'))).status).toBe(409)
    expect((await pull(alice, flowId)).status).toBe(409)

    await forgetFlow(roomOf(flowId))
  })

  it('个人画布连协同房间 → 拒掉（reason 是 forbidden）', async () => {
    const alice = await actor()
    const space = await personalSpace(alice)
    const soloId = await createFlow(alice, space.id)
    const collabId = await createFlow(alice, await createProject(alice))

    const solo = await authorizeCollab(alice.cookie, roomOf(soloId))
    const collab = await authorizeCollab(alice.cookie, roomOf(collabId))

    // 前端会按 mode 分流，但拦不住有人手搓一个 provider 直接连过来
    expect(solo).toEqual({ ok: false, reason: 'forbidden' })
    expect(collab.ok).toBe(true)
  })

  it('不是成员 → 404，和画布不存在同一个口径', async () => {
    const alice = await actor('alice')
    const bob = await actor('bob')
    const space = await personalSpace(alice)
    const flowId = await createFlow(alice, space.id)

    expect((await pull(bob, flowId)).status).toBe(404)
    expect((await push(bob, flowId, addNodes('n1'))).status).toBe(404)
    expect((await pull(alice, 'no-such-flow')).status).toBe(404)

    await forgetFlow(roomOf(flowId))
  })

  it('请求体超过单条上限 → 413', async () => {
    const alice = await actor()
    const space = await personalSpace(alice)
    const flowId = await createFlow(alice, space.id)

    const huge = new Uint8Array(COLLAB_LIMITS.message + 1)
    expect((await push(alice, flowId, huge)).status).toBe(413)

    await forgetFlow(roomOf(flowId))
  })

  it('空请求体 → 400；sv 不合法 → 400', async () => {
    const alice = await actor()
    const space = await personalSpace(alice)
    const flowId = await createFlow(alice, space.id)

    expect((await push(alice, flowId, new Uint8Array(0))).status).toBe(400)
    expect((await pull(alice, flowId, '这不是-base64url!!')).status).toBe(400)

    await forgetFlow(roomOf(flowId))
  })

  it('重复推同一段 → noop，revision 不涨', async () => {
    const alice = await actor()
    const space = await personalSpace(alice)
    const flowId = await createFlow(alice, space.id)
    const update = addNodes('n1')

    await push(alice, flowId, update)
    const again = (await (await push(alice, flowId, update)).json()) as {
      noop: boolean
      revision: number
    }

    expect(again).toMatchObject({ noop: true, revision: 1 })
    await forgetFlow(roomOf(flowId))
  })
})
