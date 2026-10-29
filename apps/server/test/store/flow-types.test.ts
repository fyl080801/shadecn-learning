import { describe, expect, it } from 'vitest'
import { GRAPH_SCHEMA_VERSION } from '@shadecn/shared/flow-graph'
import { parseGraph, readGraph } from '../../store/flow-types.ts'

/**
 * `Flow.graph` 投影的校验。v3 照收；v1 / v2 **不升级也不拒收** —— `ydoc` 为 NULL 的老画布
 * 第一次打开时靠它灌进 Yjs，拒收等于把那张画布清空。
 */
describe('parseGraph', () => {
  it('v3 的节点五组原样收下，派生的 inputs 不存', () => {
    const result = parseGraph({
      schemaVersion: 3,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'n1',
          type: 'image',
          layout: { position: { x: 1, y: 2 }, width: 10 },
          metadata: { label: '生图' },
          data: { prompt: 'p' },
          runtime: { status: 'completed', outputs: { image: 'u' } },
          inputs: [{ port: 'image' }],
        },
      ],
      edges: [],
      meta: {},
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.nodes).toEqual([
      {
        id: 'n1',
        type: 'image',
        layout: { position: { x: 1, y: 2 }, width: 10 },
        metadata: { label: '生图' },
        data: { prompt: 'p' },
        runtime: { status: 'completed', outputs: { image: 'u' } },
      },
    ])
  })

  it('v2 的老行（布局平铺在顶层、label 混在 data 里）不抛错、不拒收，名字退化为空', () => {
    const graph = readGraph(
      JSON.stringify({
        schemaVersion: 2,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [{ id: 'n1', type: 'process', position: { x: 5, y: 6 }, data: { label: '老', status: 'idle' } }],
        edges: [{ id: 'e', source: 'n1', target: 'n1' }],
        meta: {},
      }),
    )
    expect(graph.schemaVersion).toBe(GRAPH_SCHEMA_VERSION)
    expect(graph.nodes[0]).toEqual({
      id: 'n1',
      type: 'process',
      layout: { position: { x: 5, y: 6 } },
      metadata: { label: '' },
      data: { label: '老', status: 'idle' },
      runtime: { status: 'idle' },
    })
    expect(graph.edges[0]!.data).toEqual({})
  })

  it('比当前版本更高的拒收；没有合法 position 的拒收', () => {
    expect(parseGraph({ schemaVersion: GRAPH_SCHEMA_VERSION + 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }).ok).toBe(false)
    expect(
      parseGraph({
        schemaVersion: 3,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [{ id: 'n', type: 'x', layout: {} }],
        edges: [],
      }).ok,
    ).toBe(false)
  })
})
