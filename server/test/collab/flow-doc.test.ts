import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyGraphToDoc, readGraphFromDoc } from '../../collab/flow-doc.ts'
import { emptyGraph, type FlowNode } from '../../store/flow-types.ts'

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

describe('graph ↔ Y.Doc 往返', () => {
  it('分组 / 层级字段（zIndex、parentNode、extent）迁移后不丢', () => {
    const doc = new Y.Doc()
    applyGraphToDoc(
      doc,
      graphWith([
        {
          id: 'group',
          type: 'process',
          position: { x: 0, y: 0 },
          data: { label: '组', kind: 'process', config: {}, ports: { inputs: [], outputs: [] } },
        },
        {
          id: 'n1',
          type: 'process',
          position: { x: 10, y: 20 },
          zIndex: 5,
          parentNode: 'group',
          extent: 'parent',
          data: { label: '子', kind: 'process', config: {}, ports: { inputs: [], outputs: [] } },
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
          data: { label: 'n', kind: 'process', config: {}, ports: { inputs: [], outputs: [] } },
        },
      ]),
    )

    const projected = readGraphFromDoc(doc).nodes[0]!
    expect(projected.width).toBe(200)
    expect(projected.height).toBe(100)
  })
})
