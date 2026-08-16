import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { nodesMap } from '../../collab/flow-doc.ts'
import { flushCollabWrites, forgetFlow, roomOf, storeFlowState } from '../../collab/persistence.ts'
import { prisma, resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject } from '../helpers/project.ts'

/**
 * 落库的写放大。两处省法都要能验证：
 * - 状态向量没变 → 整个跳过；
 * - 平时只写 ydoc，派生投影留到散场。
 */

async function newFlow() {
  const alice = await actor()
  const projectId = await createProject(alice)
  return createFlow(alice, projectId)
}

function docWith(nodeIds: string[]) {
  const doc = new Y.Doc()
  doc.transact(() => {
    for (const id of nodeIds) {
      const node = new Y.Map<unknown>()
      node.set('position', { x: 0, y: 0 })
      const data = new Y.Map<unknown>()
      data.set('label', id)
      node.set('data', data)
      nodesMap(doc).set(id, node)
    }
  })
  return doc
}

/** 库里那行现在长什么样 */
async function row(flowId: string) {
  return prisma.flow.findUniqueOrThrow({
    where: { id: flowId },
    select: { ydoc: true, graph: true, nodeCount: true, revision: true },
  })
}

describe('落库的写放大', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('平时只写 ydoc，派生投影原封不动', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1', 'n2'])

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()

    const after = await row(flowId)
    expect(after.ydoc).not.toBeNull()
    // 内容进了 ydoc，但列表页看到的还是初始值 —— 投影要等散场
    expect(after.nodeCount).toBe(0)
    expect(JSON.parse(after.graph).nodes).toHaveLength(0)
    forgetFlow(roomOf(flowId))
  })

  it('散场时才把投影补上', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1', 'n2'])

    await storeFlowState(roomOf(flowId), doc)
    await storeFlowState(roomOf(flowId), doc, { projection: true })
    await flushCollabWrites()

    const after = await row(flowId)
    expect(after.nodeCount).toBe(2)
    expect(JSON.parse(after.graph).nodes).toHaveLength(2)
    forgetFlow(roomOf(flowId))
  })

  it('文档没变就整个跳过，不产生第二次写', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    const first = await row(flowId)

    // 一个字都没改，再存一次
    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    const second = await row(flowId)

    expect(second.revision).toBe(first.revision)
    forgetFlow(roomOf(flowId))
  })

  it('内容真的变了就照写不误', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    const first = await row(flowId)

    const node = new Y.Map<unknown>()
    node.set('position', { x: 1, y: 1 })
    nodesMap(doc).set('n2', node)

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    const second = await row(flowId)

    expect(second.revision).toBeGreaterThan(first.revision)
    forgetFlow(roomOf(flowId))
  })

  it('要投影时不走「没变就跳过」那条捷径 —— 否则复制画布会拿到旧投影', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])

    // 先写一次（只有 ydoc），此时状态向量已经记下了
    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    expect((await row(flowId)).nodeCount).toBe(0)

    // 内容一个字没改，但这次要投影 —— 必须真的写
    await storeFlowState(roomOf(flowId), doc, { projection: true })
    await flushCollabWrites()
    expect((await row(flowId)).nodeCount).toBe(1)
    forgetFlow(roomOf(flowId))
  })

  it('「改完等过防抖窗口再关页面」这条路径，投影也必须补上', async () => {
    // 这是 beforeUnloadDocument 存在的理由：Hocuspocus 在最后一个人离开时，
    // 只有还挂着防抖 store 才会补一次 onStoreDocument，否则直接卸载文档。
    // 所以「平时写 ydoc + 散场写投影」的散场那一半，不能只靠 onStoreDocument。
    const flowId = await newFlow()
    const doc = docWith(['n1', 'n2', 'n3'])

    // 模拟防抖窗口内的若干次写（都不带投影）
    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    expect((await row(flowId)).nodeCount).toBe(0)

    // 卸载前那一下（beforeUnloadDocument 走的就是这个调用）
    await storeFlowState(roomOf(flowId), doc, { projection: true })
    await flushCollabWrites()

    const after = await row(flowId)
    expect(after.nodeCount).toBe(3)
    expect(JSON.parse(after.graph).nodes).toHaveLength(3)
    forgetFlow(roomOf(flowId))
  })

  it('散场清掉状态向量后，下一轮会重新写一次', async () => {
    const flowId = await newFlow()
    const doc = docWith(['n1'])

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    const first = await row(flowId)

    forgetFlow(roomOf(flowId))

    await storeFlowState(roomOf(flowId), doc)
    await flushCollabWrites()
    expect((await row(flowId)).revision).toBeGreaterThan(first.revision)
    forgetFlow(roomOf(flowId))
  })
})
