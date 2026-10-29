import { describe, expect, it } from 'vitest'
import {
  deriveInputs,
  emptyGraph,
  GRAPH_SCHEMA_VERSION,
  inputIndexOf,
  nextInputIndex,
  nodeRecordFromParts,
  withInputs,
  type FlowEdge,
  type FlowNodeRecord,
} from '../src/flow-graph.ts'

/**
 * 图结构的纯函数：五组的规范化、inputs 的派生、多输入端口的序号。
 * 前端（增量投影）、服务端（graph 投影）、agent（read_canvas）走的是同一份实现。
 */

function record(id: string, outputs?: Record<string, unknown>): FlowNodeRecord {
  return {
    id,
    type: 'image',
    layout: { position: { x: 0, y: 0 } },
    metadata: { label: id },
    data: {},
    runtime: outputs ? { status: 'completed', outputs } : { status: 'idle' },
  }
}

/** 一条图片 → 图片的边；端口在 data 上，handle 为空。`data` 里给的键覆盖默认的 */
function edge(id: string, source: string, target: string, data: FlowEdge['data'] = {}): FlowEdge {
  return {
    id,
    source,
    target,
    sourceHandle: null,
    targetHandle: null,
    data: { sourcePort: 'image', targetPort: 'image', ...data },
  }
}

describe('节点规范化', () => {
  it('JSON 形状的 runtime.outputs 和文档里的 outputs.<port> 扁平键都认', () => {
    const fromJson = nodeRecordFromParts('n', {
      type: 'x',
      layout: { position: { x: 0, y: 0 } },
      metadata: { label: 'n' },
      data: {},
      runtime: { status: 'completed', outputs: { image: 'a' } },
    })
    const fromDoc = nodeRecordFromParts('n', {
      type: 'x',
      layout: { position: { x: 0, y: 0 } },
      metadata: { label: 'n' },
      data: {},
      runtime: { status: 'completed', 'outputs.image': 'a' },
    })
    expect(fromJson).toEqual(fromDoc)
    expect(fromDoc!.runtime).toEqual({ status: 'completed', outputs: { image: 'a' } })
  })

  it('没有合法 position 的节点返回 null，其余各组缺了给缺省值', () => {
    expect(
      nodeRecordFromParts('n', { type: 'x', layout: {}, metadata: null, data: null, runtime: null }),
    ).toBeNull()
    expect(
      nodeRecordFromParts('n', {
        type: undefined,
        layout: { position: { x: 1, y: 2 } },
        metadata: undefined,
        data: undefined,
        runtime: undefined,
      }),
    ).toEqual({
      id: 'n',
      type: 'process',
      layout: { position: { x: 1, y: 2 } },
      metadata: { label: '' },
      data: {},
      runtime: { status: 'idle' },
    })
  })
})

describe('inputs 派生', () => {
  it('按 (端口, 序号) 排序，序号相同按边 id 兜底；value 取上游对应端口的产出', () => {
    const up = record('up', { image: 'u.png' })
    const incoming = [
      edge('e-b', 'up', 't', { index: 2 }),
      edge('e-c', 'up', 't', { targetPort: 'text', sourcePort: 'missing', index: 1 }),
      edge('e-z', 'up', 't', { index: 1 }),
      edge('e-a', 'up', 't', { index: 1 }),
    ]
    const inputs = deriveInputs(incoming, (id) => (id === 'up' ? up : undefined))
    expect(inputs.map((input) => [input.port, input.index, input.edgeId])).toEqual([
      ['image', 1, 'e-a'],
      ['image', 1, 'e-z'],
      ['image', 2, 'e-b'],
      ['text', 1, 'e-c'],
    ])
    expect(inputs[0]!.value).toBe('u.png')
    // 上游那个端口还没有产出：不出现 value，而不是 value: undefined
    expect('value' in inputs[3]!).toBe(false)
  })

  it('两端都没声明端口的边（data 里没有端口）也列出来，只是没有 value', () => {
    const plain: FlowEdge = { id: 'e', source: 'up', target: 't', sourceHandle: null, targetHandle: null, data: {} }
    const inputs = deriveInputs([plain], () => record('up', { image: 'u.png' }))
    expect(inputs).toEqual([{ port: null, index: 0, edgeId: 'e', source: 'up', sourcePort: null }])
  })

  it('withInputs 一次给一批节点派生，没有入边的是空数组', () => {
    const nodes = withInputs([record('a', { image: 'a.png' }), record('b')], [edge('e', 'a', 'b', { index: 1 })])
    expect(nodes[0]!.inputs).toEqual([])
    expect(nodes[1]!.inputs).toEqual([
      { port: 'image', index: 1, edgeId: 'e', source: 'a', sourcePort: 'image', value: 'a.png' },
    ])
  })
})

describe('多输入端口的序号', () => {
  it('取该端口现有最大序号 + 1，从 1 起；别的端口、别的节点不算', () => {
    const edges = [
      edge('e1', 'a', 't', { index: 1 }),
      edge('e2', 'a', 't', { index: 2 }),
      edge('e3', 'a', 't', { targetPort: 'text', index: 7 }),
      edge('e4', 'a', 'other', { index: 9 }),
    ]
    expect(nextInputIndex(edges, 't', 'image')).toBe(3)
    expect(nextInputIndex(edges, 't', 'video')).toBe(1)
    expect(nextInputIndex([], 't', null)).toBe(1)
  })

  it('删线不重排：删掉 1 号之后 2 号还是 2 号，新连的是 3 号', () => {
    const edges = [edge('e1', 'a', 't', { index: 1 }), edge('e2', 'a', 't', { index: 2 })]
    const remaining = edges.filter((item) => item.id !== 'e1')
    const inputs = deriveInputs(remaining, () => undefined)
    expect(inputs.map((input) => input.index)).toEqual([2])
    expect(nextInputIndex(remaining, 't', 'image')).toBe(3)
  })

  it('老边没有 index 就当 0', () => {
    expect(inputIndexOf({ data: {} })).toBe(0)
    expect(inputIndexOf({ data: { index: 'x' as unknown as number } })).toBe(0)
  })
})

describe('空图', () => {
  it('是当前版本（v3）、视口在原点', () => {
    expect(GRAPH_SCHEMA_VERSION).toBe(3)
    expect(emptyGraph()).toEqual({
      schemaVersion: GRAPH_SCHEMA_VERSION,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      meta: {},
    })
  })
})
