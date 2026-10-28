import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  applyGraphToDoc,
  edgesMap,
  fromYNode,
  nodeData,
  nodesMap,
  readEdges,
  readNodes,
  toYEdge,
  toYNode,
  writeEdge,
  writeNode,
} from '../src/flow-doc.ts'
import {
  emptyGraph,
  FALLBACK_NODE_TYPE,
  STRICT_UPGRADE,
  type FlowEdge,
  type FlowNode,
} from '../src/flow-graph.ts'

/**
 * Y.Doc 的形状 —— 前后端读写的同一份实现。写进去的东西必须原样读得回来，
 * 两组写入口（编辑器新建 / 服务端迁移）读回来的结果必须一样。
 */

function fullNode(id: string): FlowNode {
  return {
    id,
    type: 'text',
    position: { x: 10, y: 20 },
    width: 200,
    height: 80,
    zIndex: 1,
    parentNode: 'g1',
    extent: 'parent',
    sourcePosition: 'right',
    targetPosition: 'left',
    data: { label: '节点', status: 'idle', createdAt: 1_700_000_000_000, prompt: 'p' },
  }
}

function edge(id: string, source: string, target: string): FlowEdge {
  return { id, source, target, type: 'smoothstep', label: '连', data: { createdAt: 1 } }
}

describe('写进去读得回来', () => {
  it('toYNode → fromYNode 往返保住每个字段', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', toYNode(fullNode('n1')))
    expect(readNodes(doc)).toEqual([fullNode('n1')])
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

    expect(readNodes(doc)).toEqual(graph.nodes)
    expect(readEdges(doc, new Set(['a', 'b']))).toEqual([
      { ...edge('e', 'a', 'b'), sourceHandle: null, targetHandle: null },
    ])
  })

  it('nodeData 拿到的是节点 data 那层 Y.Map', () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', toYNode(fullNode('n1')))
    expect(nodeData(doc, 'n1')).toBeInstanceOf(Y.Map)
    expect(nodeData(doc, 'missing')).toBeNull()
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

  it('v1 写进去的 data 读时升级，不回写文档；升级判据随 options 传到底', () => {
    const doc = new Y.Doc()
    const source = new Y.Map<unknown>()
    const data = new Y.Map<unknown>()
    nodesMap(doc).set('n1', source)
    source.set('position', { x: 0, y: 0 })
    source.set('data', data)
    data.set('label', '老')
    data.set('kind', 'process')
    data.set('config', { prompt: 'p' })
    data.set('createdAt', 1.5)

    expect(readNodes(doc)[0]?.data).toEqual({ label: '老', status: 'idle', prompt: 'p', createdAt: 1.5 })
    expect(readNodes(doc, STRICT_UPGRADE)[0]?.data).toEqual({ label: '老', status: 'idle', prompt: 'p' })
    // 读不改文档：残留的 kind / config 还在
    expect(data.get('kind')).toBe('process')
  })
})
