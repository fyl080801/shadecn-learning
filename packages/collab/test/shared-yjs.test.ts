import { nodeGroup, nodesMap, readNodes, toYNode } from '@learning/contracts/flow-doc'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { readGraphFromDoc } from '../src/flow-doc.js'
import { roomOf } from '../src/flow-persistence.js'
import { connect, createFlow, createProject, describeOnBothDatabases, nodeMap } from './helpers.js'

/** contracts 通篇靠 `instanceof Y.Map` 判断结构，两份 yjs 之间永远 false，画布静默读成一张空图。从 `apps/server/test/collab/shared-yjs.test.ts` 移植，解析路径的那条在 `package.test.ts` */
describe('contracts 与本包共用一份 yjs', () => {
  it('contracts 造的 Y.Map 是本包这份 yjs 的实例，反过来也读得出来', () => {
    const made = toYNode({ id: 'n1', type: 'text', layout: { position: { x: 0, y: 0 } }, metadata: { label: '节点' }, data: {}, runtime: { status: 'idle' } })
    expect(made).toBeInstanceOf(Y.Map)

    const doc = new Y.Doc()
    nodesMap(doc).set('n1', made)
    expect(nodeGroup(doc, 'n1', 'data')).toBeInstanceOf(Y.Map)
    expect(nodeGroup(doc, 'n1', 'metadata')).toBeInstanceOf(Y.Map)
    expect(readNodes(doc).map((node) => node.id)).toEqual(['n1'])
  })
})

describeOnBothDatabases('Hocuspocus 和本包共用一份 yjs', (ctx) => {
  it('真 provider 写进来的节点，Hocuspocus 文档里 getMap 的结果 instanceof 本包的 Y.Map', async () => {
    const alice = await ctx.actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const client = connect(ctx.wsUrl, roomOf(flowId), alice.cookie)
    await vi.waitFor(() => expect(client.synced()).toBe(true), { timeout: 5000 })

    nodesMap(client.doc).set('n1', nodeMap('一'))

    const server = ctx.server.hocuspocus
    await vi.waitFor(() => expect(server.documents.get(roomOf(flowId))?.getMap('nodes').has('n1')).toBe(true), { timeout: 5000 })
    const document = server.documents.get(roomOf(flowId))
    expect(document).toBeInstanceOf(Y.Doc)
    expect(document?.getMap('nodes')).toBeInstanceOf(Y.Map)
    expect(document?.getMap('nodes').get('n1')).toBeInstanceOf(Y.Map)
    // 上面那条是 false 的话，这里静默读成空图
    expect(readGraphFromDoc(document as Y.Doc).nodes.map((node) => node.id)).toEqual(['n1'])
    client.destroy()
  })
})
