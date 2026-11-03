import { edgesMap, metaMap, nodesMap, readEdges, readNodeRecords, VIEWPORT_KEY } from '@learning/contracts/flow-doc'
import { emptyGraph, type FlowGraph, type FlowViewport, GRAPH_SCHEMA_VERSION } from '@learning/contracts/flow-graph'
import * as Y from 'yjs'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从 Y.Doc 派生只读的 graph 投影：列表页的计数、缩略图读它，编辑器不读。
 * 形状不对的节点、悬空的边直接跳过，不抛异常：投影坏一条不该拖垮整张画布。
 */
export function readGraphFromDoc(doc: Y.Doc): FlowGraph {
  const graph = emptyGraph()
  graph.schemaVersion = GRAPH_SCHEMA_VERSION

  graph.nodes = readNodeRecords(doc)
  // 端点没了的边不进投影：parseGraph 会因为它整张图判不合法
  graph.edges = readEdges(doc, new Set(graph.nodes.map((node) => node.id)))

  const meta = metaMap(doc).toJSON() as Record<string, unknown>
  const viewport = meta[VIEWPORT_KEY]
  if (isRecord(viewport) && typeof viewport.x === 'number' && typeof viewport.y === 'number' && typeof viewport.zoom === 'number' && viewport.zoom > 0) {
    graph.viewport = viewport as unknown as FlowViewport
  }
  delete meta[VIEWPORT_KEY]
  graph.meta = meta

  return graph
}

/**
 * 清掉端点已经不存在的边，返回删了几条。这是并发的正常产物：甲删节点、乙同时往它连线，CRDT 把两边都留下了。
 * 用 `'gc'` origin：客户端的 `Y.UndoManager` 只跟踪自己的 origin，这次清理不进任何人的撤销栈。
 */
export function pruneDanglingEdges(doc: Y.Doc): number {
  const nodes = nodesMap(doc)
  const edges = edgesMap(doc)

  const doomed: string[] = []
  for (const [id, value] of edges.entries()) {
    if (!(value instanceof Y.Map)) {
      doomed.push(id)
      continue
    }
    const source: unknown = value.get('source')
    const target: unknown = value.get('target')
    if (typeof source !== 'string' || typeof target !== 'string' || !nodes.has(source) || !nodes.has(target)) doomed.push(id)
  }
  if (doomed.length === 0) return 0

  doc.transact(() => {
    for (const id of doomed) edges.delete(id)
  }, 'gc')
  return doomed.length
}
