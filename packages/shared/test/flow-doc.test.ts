import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  applyGraphToDoc,
  edgesMap,
  fromYNode,
  nodeGroup,
  nodesMap,
  outputKey,
  readEdges,
  readNodeRecords,
  readNodes,
  toYEdge,
  toYNode,
  writeEdge,
  writeNode,
} from '../src/flow-doc.ts'
import {
  emptyGraph,
  FALLBACK_NODE_TYPE,
  type FlowEdge,
  type FlowNodeRecord,
} from '../src/flow-graph.ts'

/**
 * Y.Doc 的形状 —— 前后端读写的同一份实现。写进去的东西必须原样读得回来，
 * 两组写入口（编辑器新建 / 服务端迁移）读回来的结果必须一样。
 */

function fullNode(id: string): FlowNodeRecord {
  return {
    id,
    type: 'image-config',
    layout: {
      position: { x: 10, y: 20 },
      width: 200,
      height: 80,
      zIndex: 1,
      parentNode: 'g1',
      extent: 'parent',
      sourcePosition: 'right',
      targetPosition: 'left',
    },
    metadata: {
      label: '节点',
      description: '说明',
      icon: 'image',
      createdAt: 1_700_000_000_000,
      createdBy: 'u1',
      ui: { collapsed: true },
    },
    data: { prompt: 'p', width: 1024 },
    runtime: {
      status: 'completed',
      error: '上一次失败了',
      taskId: 't1',
      outputs: { image: 'https://x/1.png', mask: { url: 'https://x/m.png' } },
    },
  }
}

function edge(id: string, source: string, target: string, extra: Partial<FlowEdge> = {}): FlowEdge {
  return { id, source, target, type: 'smoothstep', label: '连', data: { createdAt: 1 }, ...extra }
}

describe('写进去读得回来', () => {
  it('toYNode → fromYNode 往返保住五组里的每个字段', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', toYNode(fullNode('n1')))
    expect(readNodeRecords(doc)).toEqual([fullNode('n1')])
  })

  it('runtime.outputs 在文档里按端口摊成 outputs.<portId> 扁平键，不存整块对象', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', toYNode(fullNode('n1')))
    const runtime = nodeGroup(doc, 'n1', 'runtime')!
    expect(runtime.get(outputKey('image'))).toBe('https://x/1.png')
    expect(runtime.get(outputKey('mask'))).toEqual({ url: 'https://x/m.png' })
    expect(runtime.has('outputs')).toBe(false)
  })

  it('layout 留在节点顶层原位，metadata / data / runtime 各是一层 Y.Map', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', toYNode(fullNode('n1')))
    const node = nodesMap(doc).get('n1')!
    expect(node.get('position')).toEqual({ x: 10, y: 20 })
    expect(node.has('layout')).toBe(false)
    for (const group of ['metadata', 'data', 'runtime'] as const) {
      expect(node.get(group)).toBeInstanceOf(Y.Map)
    }
  })

  it('一个端口的产出更新不会盖掉另一个端口的（两个文档并发写）', () => {
    const a = new Y.Doc()
    nodesMap(a).set('n1', toYNode(fullNode('n1')))
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    nodeGroup(a, 'n1', 'runtime')!.set(outputKey('image'), 'https://x/2.png')
    nodeGroup(b, 'n1', 'runtime')!.set(outputKey('mask'), 'https://x/m2.png')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    for (const doc of [a, b]) {
      expect(readNodeRecords(doc)[0]!.runtime.outputs).toEqual({
        image: 'https://x/2.png',
        mask: 'https://x/m2.png',
      })
    }
  })

  it('编辑器新建（toYNode / toYEdge）和服务端迁移（writeNode / writeEdge）读回来一样', () => {
    const viaEditor = new Y.Doc()
    nodesMap(viaEditor).set('a', toYNode(fullNode('a')))
    nodesMap(viaEditor).set('b', toYNode(fullNode('b')))
    edgesMap(viaEditor).set('e', toYEdge(edge('e', 'a', 'b')))

    const viaMigration = new Y.Doc()
    viaMigration.transact(() => {
      for (const id of ['a', 'b']) {
        const target = new Y.Map<unknown>()
        nodesMap(viaMigration).set(id, target)
        writeNode(target, fullNode(id))
      }
      const target = new Y.Map<unknown>()
      edgesMap(viaMigration).set('e', target)
      writeEdge(target, edge('e', 'a', 'b'))
    })

    const ids = new Set(['a', 'b'])
    expect(readNodes(viaMigration)).toEqual(readNodes(viaEditor))
    expect(readEdges(viaMigration, ids)).toEqual(readEdges(viaEditor, ids))
  })

  it('applyGraphToDoc 灌进去的 graph 节点和连线都读得回来', () => {
    const graph = emptyGraph()
    graph.nodes = [fullNode('a'), fullNode('b')]
    graph.edges = [edge('e', 'a', 'b')]
    const doc = new Y.Doc()
    applyGraphToDoc(doc, graph)

    expect(readNodeRecords(doc)).toEqual(graph.nodes)
    expect(readEdges(doc, new Set(['a', 'b']))).toEqual([
      { ...edge('e', 'a', 'b'), sourceHandle: null, targetHandle: null },
    ])
  })

  it('nodeGroup 取得到三组；老节点没有的组只在 create 时现建', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', toYNode(fullNode('n1')))
    expect(nodeGroup(doc, 'n1', 'data')).toBeInstanceOf(Y.Map)
    expect(nodeGroup(doc, 'missing', 'data')).toBeNull()

    const old = new Y.Map<unknown>()
    nodesMap(doc).set('old', old)
    old.set('position', { x: 0, y: 0 })
    expect(nodeGroup(doc, 'old', 'metadata')).toBeNull()
    expect(nodeGroup(doc, 'old', 'metadata', { create: true })).toBeInstanceOf(Y.Map)
    expect(old.get('metadata')).toBeInstanceOf(Y.Map)
  })

  it('组的 key 上已经是别的类型时 nodeGroup 不覆盖（key 的类型首次写入即固定）', () => {
    const doc = new Y.Doc()
    const node = new Y.Map<unknown>()
    nodesMap(doc).set('n1', node)
    node.set('position', { x: 0, y: 0 })
    node.set('metadata', 'oops')
    expect(nodeGroup(doc, 'n1', 'metadata', { create: true })).toBeNull()
    expect(node.get('metadata')).toBe('oops')
  })
})

describe('inputs 派生', () => {
  it('readNodes 按 (data.targetPort, 序号) 排好，value 取上游 runtime.outputs[data.sourcePort]', () => {
    const doc = new Y.Doc()
    const upstream = fullNode('up')
    const target: FlowNodeRecord = { ...fullNode('t'), layout: { position: { x: 0, y: 0 } }, runtime: { status: 'idle' } }
    nodesMap(doc).set('up', toYNode(upstream))
    nodesMap(doc).set('t', toYNode(target))
    // 端口存在边的 data 上，handle 一律为空
    edgesMap(doc).set('e2', toYEdge(edge('e2', 'up', 't', { data: { sourcePort: 'image', targetPort: 'image', index: 2 } })))
    edgesMap(doc).set('e1', toYEdge(edge('e1', 'up', 't', { data: { sourcePort: 'mask', targetPort: 'image', index: 1 } })))
    edgesMap(doc).set('e3', toYEdge(edge('e3', 'up', 't', { data: { sourcePort: 'image', targetPort: 'text', index: 1 } })))

    const read = readNodes(doc).find((node) => node.id === 't')!
    expect(read.inputs).toEqual([
      { port: 'image', index: 1, edgeId: 'e1', source: 'up', sourcePort: 'mask', value: { url: 'https://x/m.png' } },
      { port: 'image', index: 2, edgeId: 'e2', source: 'up', sourcePort: 'image', value: 'https://x/1.png' },
      { port: 'text', index: 1, edgeId: 'e3', source: 'up', sourcePort: 'image', value: 'https://x/1.png' },
    ])
    // inputs 是派生的，文档里没有
    expect(nodesMap(doc).get('t')!.has('inputs')).toBe(false)
  })

  it('悬空的边不进 inputs', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('t', toYNode(fullNode('t')))
    edgesMap(doc).set('e', toYEdge(edge('e', 'gone', 't')))
    expect(readNodes(doc)[0]!.inputs).toEqual([])
  })
})

describe('读的一侧兜底', () => {
  it('缺 type 的节点按 FALLBACK_NODE_TYPE 读出来', () => {
    const doc = new Y.Doc()
    const source = new Y.Map<unknown>()
    nodesMap(doc).set('n1', source)
    source.set('position', { x: 0, y: 0 })
    expect(fromYNode('n1', source)?.type).toBe(FALLBACK_NODE_TYPE)
    expect(FALLBACK_NODE_TYPE).toBe('process')
  })

  it('position 不对的节点读成 null，readNodes 整条跳过', () => {
    const doc = new Y.Doc()
    const source = new Y.Map<unknown>()
    nodesMap(doc).set('bad', source)
    source.set('position', { x: 'a' })
    expect(fromYNode('bad', source)).toBeNull()
    expect(readNodes(doc)).toEqual([])
  })

  it('端点没了的边不读出来', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('a', toYNode(fullNode('a')))
    edgesMap(doc).set('e', toYEdge(edge('e', 'a', 'gone')))
    expect(readEdges(doc, new Set(['a']))).toEqual([])
  })

  it('v2 写的老节点不抛错：没有 metadata / runtime，名字退化为空，老字段留在 data 里', () => {
    const doc = new Y.Doc()
    const source = new Y.Map<unknown>()
    const data = new Y.Map<unknown>()
    nodesMap(doc).set('n1', source)
    source.set('type', 'text')
    source.set('position', { x: 1, y: 2 })
    source.set('data', data)
    data.set('label', '老')
    data.set('status', 'completed')
    data.set('text', '正文')

    expect(readNodes(doc)).toEqual([
      {
        id: 'n1',
        type: 'text',
        layout: { position: { x: 1, y: 2 } },
        metadata: { label: '' },
        data: { label: '老', status: 'completed', text: '正文' },
        runtime: { status: 'idle' },
        inputs: [],
      },
    ])
  })

  it('v1 写的老节点（data 里有 kind / config）也不抛错，原样透传', () => {
    const doc = new Y.Doc()
    const source = new Y.Map<unknown>()
    const data = new Y.Map<unknown>()
    nodesMap(doc).set('n1', source)
    source.set('position', { x: 0, y: 0 })
    source.set('data', data)
    data.set('kind', 'process')
    data.set('config', { prompt: 'p' })
    expect(readNodeRecords(doc)[0]?.data).toEqual({ kind: 'process', config: { prompt: 'p' } })
  })

  it('各组里类型不对的字段丢掉，不抛错', () => {
    const doc = new Y.Doc()
    const source = new Y.Map<unknown>()
    nodesMap(doc).set('n1', source)
    source.set('position', { x: 0, y: 0 })
    source.set('width', 'wide')
    const metadata = new Y.Map<unknown>()
    source.set('metadata', metadata)
    metadata.set('label', 3)
    metadata.set('createdAt', -1)
    const runtime = new Y.Map<unknown>()
    source.set('runtime', runtime)
    runtime.set('status', 'weird')
    source.set('data', 'not-a-map')

    expect(readNodeRecords(doc)[0]).toEqual({
      id: 'n1',
      type: FALLBACK_NODE_TYPE,
      layout: { position: { x: 0, y: 0 } },
      metadata: { label: '' },
      data: {},
      runtime: { status: 'idle' },
    })
  })
})
