import * as Y from 'yjs'
import { edgesMap, metaMap, nodesMap, readEdges, readNodeRecords, VIEWPORT_KEY } from '@shadecn/shared/flow-doc'
import {
  emptyGraph,
  GRAPH_SCHEMA_VERSION,
  type FlowGraph,
  type FlowViewport,
} from '@shadecn/shared/flow-graph'

/**
 * Y.Doc 的服务端专属操作：派生只读的 graph 投影、清理悬空边。
 *
 * 文档的形状本身（键名、嵌套结构、读写、节点五组的规范化）在 `@shadecn/shared/flow-doc`，
 * 前端读写的是同一份实现 —— 这里只放只有服务端才做的事。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从 Y.Doc 派生一份普通的 graph JSON。
 *
 * 这是**只读投影**：列表页的节点数、缩略图、将来的只读预览走它，
 * 编辑器不读（编辑器的内容直接来自 Y.Doc）。
 * 形状不对的节点 / 悬空的边直接跳过，不抛异常 —— 投影坏一条不该拖垮整张画布。
 */
export function readGraphFromDoc(doc: Y.Doc): FlowGraph {
  const graph = emptyGraph()
  graph.schemaVersion = GRAPH_SCHEMA_VERSION

  // 只存节点自己的部分：inputs 是派生的，不进投影
  graph.nodes = readNodeRecords(doc)
  // 端点没了的边不进投影：parseGraph 会因为它整张图判不合法
  graph.edges = readEdges(doc, new Set(graph.nodes.map((node) => node.id)))

  const meta = metaMap(doc).toJSON() as Record<string, unknown>
  const viewport = meta[VIEWPORT_KEY]
  if (
    isRecord(viewport) &&
    typeof viewport.x === 'number' &&
    typeof viewport.y === 'number' &&
    typeof viewport.zoom === 'number' &&
    viewport.zoom > 0
  ) {
    graph.viewport = viewport as unknown as FlowViewport
  }
  delete meta[VIEWPORT_KEY]
  graph.meta = meta

  return graph
}

/**
 * 清掉端点已经不存在的边，返回删了几条。
 *
 * 这种边是**并发的正常产物**，不是 bug：甲删掉一个节点、乙同时往它连线，
 * 两个操作各自合法，CRDT 把它们都保留下来，于是留下一条指向空处的边。
 * 投影层（`readGraphFromDoc` / 前端 store 的边投影）会把它过滤掉，所以界面上看不见 ——
 * 但它一直躺在文档里，只会越积越多。
 *
 * 用 `'gc'` 这个 origin：客户端的 `Y.UndoManager` 只跟踪自己的 `LOCAL_ORIGIN`，
 * 所以这次清理不会跑进任何人的撤销栈里。
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
    const source = value.get('source')
    const target = value.get('target')
    if (typeof source !== 'string' || typeof target !== 'string') {
      doomed.push(id)
      continue
    }
    if (!nodes.has(source) || !nodes.has(target)) doomed.push(id)
  }
  if (doomed.length === 0) return 0

  doc.transact(() => {
    for (const id of doomed) edges.delete(id)
  }, 'gc')
  return doomed.length
}
