import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyGraphToDoc, outputKey } from '@shadecn/shared/flow-doc'
import { readGraphFromDoc } from '../../collab/flow-doc.ts'
import { emptyGraph, type FlowNodeRecord } from '@shadecn/shared/flow-graph'

/**
 * graph JSON ↔ Y.Doc 的往返。legacy 迁移（applyGraphToDoc）写进文档的每个字段，
 * 投影（readGraphFromDoc）都必须读得回来 —— 读不回来的字段会在散场重写投影时
 * 永久消失，而迁移分支在 ydoc 非空后不再运行，没有第二次机会。
 */

function graphWith(nodes: FlowNodeRecord[]) {
  const graph = emptyGraph()
  graph.nodes = nodes
  return graph
}

function node(id: string, type: string, layout: FlowNodeRecord['layout'], extra: Partial<FlowNodeRecord> = {}): FlowNodeRecord {
  return { id, type, layout, metadata: { label: id }, data: {}, runtime: { status: 'idle' }, ...extra }
}

describe('graph ↔ Y.Doc 往返', () => {
  it('分组 / 层级字段（zIndex、parentNode、extent）迁移后不丢', () => {
    const doc = new Y.Doc()
    applyGraphToDoc(
      doc,
      graphWith([
        node('group', 'group', { position: { x: 0, y: 0 } }),
        node('n1', 'process', { position: { x: 10, y: 20 }, zIndex: 5, parentNode: 'group', extent: 'parent' }),
      ]),
    )

    const projected = readGraphFromDoc(doc).nodes.find((item) => item.id === 'n1')!
    expect(projected.layout).toEqual({ position: { x: 10, y: 20 }, zIndex: 5, parentNode: 'group', extent: 'parent' })
  })

  it('width / height 同样往返无损', () => {
    const doc = new Y.Doc()
    applyGraphToDoc(doc, graphWith([node('n1', 'process', { position: { x: 1, y: 2 }, width: 200, height: 100 })]))

    const projected = readGraphFromDoc(doc).nodes[0]!
    expect(projected.layout.width).toBe(200)
    expect(projected.layout.height).toBe(100)
  })

  it('五组都往返无损：metadata、平铺的业务字段、runtime 的产出', () => {
    const doc = new Y.Doc()
    const business = { prompt: '一只猫', model: 'v2', steps: 30, 嵌套: { 数组: [1, '二', null] } }
    const original = node(
      'n1',
      'image',
      { position: { x: 0, y: 0 }, sourcePosition: 'right', targetPosition: 'left' },
      {
        metadata: { label: '生图', description: '说明', createdAt: 1_700_000_000_000 },
        data: business,
        runtime: { status: 'completed', taskId: 't', outputs: { image: 'https://x/1.png' } },
      },
    )
    applyGraphToDoc(doc, graphWith([original]))

    const projected = readGraphFromDoc(doc).nodes[0]!
    expect(projected).toEqual(original)
    // 投影里不存派生的 inputs
    expect(projected).not.toHaveProperty('inputs')
    // 文档里产出是按端口摊平的
    const runtime = doc.getMap<Y.Map<unknown>>('nodes').get('n1')!.get('runtime') as Y.Map<unknown>
    expect(runtime.get(outputKey('image'))).toBe('https://x/1.png')
  })

  it('v1 / v2 写的老节点读出来不抛错：名字退化为空，老字段留在 data 里', () => {
    // 直接按老形状铺进文档 —— 存量 Y.Doc 里就是长这样（产品决定不迁移、不升级）
    const doc = new Y.Doc()
    doc.transact(() => {
      const old = new Y.Map<unknown>()
      old.set('type', 'process')
      old.set('position', { x: 0, y: 0 })
      const data = new Y.Map<unknown>()
      data.set('label', '老节点')
      data.set('kind', 'process')
      data.set('config', { prompt: '一只猫' })
      old.set('data', data)
      doc.getMap<Y.Map<unknown>>('nodes').set('n1', old)
    })

    const projected = readGraphFromDoc(doc).nodes[0]!
    expect(projected.metadata.label).toBe('')
    expect(projected.runtime.status).toBe('idle')
    expect(projected.data).toEqual({ label: '老节点', kind: 'process', config: { prompt: '一只猫' } })
  })

  it('连线 data 原样透传（不再有 v1 的拆平）', () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      const one = new Y.Map<unknown>()
      one.set('type', 'process')
      one.set('position', { x: 0, y: 0 })
      doc.getMap<Y.Map<unknown>>('nodes').set('n1', one)

      const edge = new Y.Map<unknown>()
      edge.set('source', 'n1')
      edge.set('target', 'n1')
      edge.set('data', { kind: 'image-input', index: 2 })
      doc.getMap<Y.Map<unknown>>('edges').set('e1', edge)
    })

    expect(readGraphFromDoc(doc).edges[0]!.data).toEqual({ kind: 'image-input', index: 2 })
  })
})
