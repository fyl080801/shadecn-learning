import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyGraphToDoc, readGraphFromDoc } from '../../collab/flow-doc.ts'
import { emptyGraph, type FlowNode, type FlowNodeData } from '../../store/flow-types.ts'

/**
 * graph JSON ↔ Y.Doc 的往返。legacy 迁移（applyGraphToDoc）写进文档的每个字段，
 * 投影（readGraphFromDoc）都必须读得回来 —— 读不回来的字段会在散场重写投影时
 * 永久消失，而迁移分支在 ydoc 非空后不再运行，没有第二次机会。
 */

function graphWith(nodes: FlowNode[]) {
  const graph = emptyGraph()
  graph.nodes = nodes
  return graph
}

function nodeData(label: string, patch?: Record<string, unknown>): FlowNodeData {
  return { label, status: 'idle', ...patch }
}

describe('graph ↔ Y.Doc 往返', () => {
  it('分组 / 层级字段（zIndex、parentNode、extent）迁移后不丢', () => {
    const doc = new Y.Doc()
    applyGraphToDoc(
      doc,
      graphWith([
        {
          id: 'group',
          type: 'group',
          position: { x: 0, y: 0 },
          data: nodeData('组'),
        },
        {
          id: 'n1',
          type: 'process',
          position: { x: 10, y: 20 },
          zIndex: 5,
          parentNode: 'group',
          extent: 'parent',
          data: nodeData('子'),
        },
      ]),
    )

    const projected = readGraphFromDoc(doc).nodes.find((node) => node.id === 'n1')!
    expect(projected.zIndex).toBe(5)
    expect(projected.parentNode).toBe('group')
    expect(projected.extent).toBe('parent')
  })

  it('width / height 同样往返无损', () => {
    const doc = new Y.Doc()
    applyGraphToDoc(
      doc,
      graphWith([
        {
          id: 'n1',
          type: 'process',
          position: { x: 1, y: 2 },
          width: 200,
          height: 100,
          data: nodeData('n'),
        },
      ]),
    )

    const projected = readGraphFromDoc(doc).nodes[0]!
    expect(projected.width).toBe(200)
    expect(projected.height).toBe(100)
  })

  it('平铺在 data 上的业务字段往返无损', () => {
    const doc = new Y.Doc()
    const business = { prompt: '一只猫', model: 'v2', steps: 30, 嵌套: { 数组: [1, '二', null] } }
    applyGraphToDoc(
      doc,
      graphWith([
        {
          id: 'n1',
          type: 'image-config',
          position: { x: 0, y: 0 },
          sourcePosition: 'right',
          targetPosition: 'left',
          data: nodeData('生图', business),
        },
      ]),
    )

    const projected = readGraphFromDoc(doc).nodes[0]!
    expect(projected.type).toBe('image-config')
    expect(projected.sourcePosition).toBe('right')
    expect(projected.targetPosition).toBe('left')
    expect(projected.data).toMatchObject(business)
  })

  it('v1 的节点（kind + config）在读出来时就地升级成 v2', () => {
    // 直接按 v1 的形状铺进文档 —— 存量 Y.Doc 里就是长这样，
    // 它们不会再走一遍 applyGraphToDoc，只能靠读的那一侧认出来
    const doc = new Y.Doc()
    doc.transact(() => {
      const node = new Y.Map<unknown>()
      node.set('type', 'process')
      node.set('position', { x: 0, y: 0 })
      const data = new Y.Map<unknown>()
      data.set('label', '老节点')
      data.set('kind', 'process')
      data.set('config', { prompt: '一只猫', steps: 30 })
      data.set('ports', { inputs: [], outputs: [] })
      node.set('data', data)
      doc.getMap<Y.Map<unknown>>('nodes').set('n1', node)
    })

    const projected = readGraphFromDoc(doc).nodes[0]!
    expect(projected.data.label).toBe('老节点')
    // config 拆平到 data 上
    expect(projected.data.prompt).toBe('一只猫')
    expect(projected.data.steps).toBe(30)
    // kind 并进了顶层 type，空壳 ports 丢掉，status 补上
    expect(projected.data.kind).toBeUndefined()
    expect(projected.data.config).toBeUndefined()
    expect(projected.data.ports).toBeUndefined()
    expect(projected.data.status).toBe('idle')
  })

  it('v1 的连线 data（config + kind）拆平，kind / condition 保留', () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      const node = new Y.Map<unknown>()
      node.set('type', 'process')
      node.set('position', { x: 0, y: 0 })
      node.set('data', new Y.Map<unknown>())
      doc.getMap<Y.Map<unknown>>('nodes').set('n1', node)

      const edge = new Y.Map<unknown>()
      edge.set('source', 'n1')
      edge.set('target', 'n1')
      edge.set('data', { kind: 'image-input', condition: '有图', config: { 权重: 1 } })
      doc.getMap<Y.Map<unknown>>('edges').set('e1', edge)
    })

    const projected = readGraphFromDoc(doc).edges[0]!
    expect(projected.data.权重).toBe(1)
    expect(projected.data.config).toBeUndefined()
    // 边的 kind / condition 没有别的字段与之重复，是真业务语义，不该丢
    expect(projected.data.kind).toBe('image-input')
    expect(projected.data.condition).toBe('有图')
  })
})
