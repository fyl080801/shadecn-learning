import * as Y from 'yjs'
import {
  GRAPH_SCHEMA_VERSION,
  emptyGraph,
  upgradeEdgeData,
  upgradeNodeData,
  type FlowEdge,
  type FlowGraph,
  type FlowHandlePosition,
  type FlowNode,
  type FlowNodeData,
  type FlowNodeStatus,
  type FlowViewport,
} from '../store/flow-types.ts'

/**
 * 画布内容在 Yjs 文档里长什么样 —— **这是内容的唯一事实源**。
 *
 * ```
 * ydoc
 *  ├─ nodes: Y.Map<nodeId, Y.Map>   节点；其中 data 又是一层 Y.Map
 *  ├─ edges: Y.Map<edgeId, Y.Map>   连线
 *  └─ meta:  Y.Map                  画布级自定义数据 + 兜底视口
 * ```
 *
 * **为什么节点是 Y.Map 而不是整块 JSON**：Y.Map 的合并粒度是 key。
 * 甲改标题、乙同时拖位置，两人改的是不同的 key，CRDT 会各自保留；
 * 存成一整块 JSON 的话后到的那份会把先到的整个盖掉。
 * `data` 再套一层同理 —— 标题、说明、各个业务字段是分开改的。
 *
 * **v2 起 `data` 上的业务字段是平铺的**，正是为了这一条：v1 把它们裹在
 * `config` 一个键里，甲改 config.prompt、乙改 config.model 会互相整块覆盖。
 *
 * **哪些不套 Y.Map**：`position`（x/y 永远一起变，拆开没意义）、
 * 边的 `data`（整块替换的语义，且没有并发编辑入口）。
 *
 * ⚠️ 前端有一份等价实现（`src/lib/flow-doc.ts`）—— server 和 src 是两个 TS 工程，
 * 互相 import 不了。**两边的键名和嵌套结构必须完全一致**，改一处记得改另一处，
 * 否则一边写进去的东西另一边读不出来。
 */

export const NODES_KEY = 'nodes'
export const EDGES_KEY = 'edges'
export const META_KEY = 'meta'

/** meta 里那份兜底视口的键名（真正生效的是每人自己的，见 FlowUserState） */
export const VIEWPORT_KEY = 'viewport'

/** 节点顶层直接存值的字段（`data` 单独处理，它是嵌套的 Y.Map） */
const NODE_FIELDS = [
  'type',
  'position',
  'width',
  'height',
  'zIndex',
  'parentNode',
  'extent',
  'sourcePosition',
  'targetPosition',
] as const

/** 连线的字段。边没有属性面板，不存在按字段并发编辑，整条平铺就够了 */
const EDGE_FIELDS = [
  'source',
  'target',
  'sourceHandle',
  'targetHandle',
  'type',
  'animated',
  'label',
  'data',
] as const

export function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(NODES_KEY)
}

export function edgesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(EDGES_KEY)
}

export function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(META_KEY)
}

// —— 写进 Y.Doc ——

/** 把一个节点铺进 Y.Map（含嵌套的 data）。已存在的键会被覆盖 */
export function writeNode(target: Y.Map<unknown>, node: FlowNode) {
  const source = node as unknown as Record<string, unknown>
  for (const field of NODE_FIELDS) {
    const value = source[field]
    if (value !== undefined) target.set(field, value)
  }

  let data = target.get('data')
  if (!(data instanceof Y.Map)) {
    data = new Y.Map<unknown>()
    target.set('data', data)
  }
  // v2 的 data 是开放的（业务字段平铺），所以按**实际有的键**逐个写，
  // 不能再照着一份固定清单来 —— 清单之外的业务字段会被静默丢掉
  const dataSource = (node.data ?? {}) as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(dataSource)) {
    if (value !== undefined) (data as Y.Map<unknown>).set(key, value)
  }
}

export function writeEdge(target: Y.Map<unknown>, edge: FlowEdge) {
  const source = edge as unknown as Record<string, unknown>
  for (const field of EDGE_FIELDS) {
    const value = source[field]
    if (value !== undefined) target.set(field, value)
  }
}

/**
 * 把一整张 graph 灌进空文档 —— **只在迁移老数据时用**
 * （`Flow.ydoc` 为 NULL 的画布第一次被打开）。
 */
export function applyGraphToDoc(doc: Y.Doc, graph: FlowGraph) {
  doc.transact(() => {
    const nodes = nodesMap(doc)
    const edges = edgesMap(doc)
    const meta = metaMap(doc)

    for (const node of graph.nodes) {
      const target = new Y.Map<unknown>()
      nodes.set(node.id, target)
      writeNode(target, node)
    }
    for (const edge of graph.edges) {
      const target = new Y.Map<unknown>()
      edges.set(edge.id, target)
      writeEdge(target, edge)
    }
    for (const [key, value] of Object.entries(graph.meta ?? {})) meta.set(key, value)
    if (graph.viewport) meta.set(VIEWPORT_KEY, graph.viewport)
  }, 'migrate')
}

// —— 从 Y.Doc 读出来 ——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 这份 `data` 是 v1 写进去的吗？
 *
 * Y.Doc 里没有版本号可查（它存的是内容，不是快照），所以只能看形状：
 * **同时**有字符串 `kind` 和对象 `config` —— 这正是 v1 `writeNode` 必写的两个键，
 * 而 v2 一个都不写。要求两个同时命中是为了不误伤某个真的叫 `config` 的业务字段。
 *
 * 升级只发生在**读**的这一侧，是纯函数、幂等，不回写文档：
 * 投影函数里写文档会凭空产生一次 Yjs 事务 —— 进别人的撤销栈、广播给所有人。
 * 文档里残留的 `kind` / `config` 键无害（Yjs 本来就只增不减），下次读再拆一遍，结果一样。
 */
function isLegacyNodeData(data: Record<string, unknown>): boolean {
  return typeof data.kind === 'string' && isRecord(data.config)
}

function readNode(id: string, source: Y.Map<unknown>): FlowNode | null {
  const position = source.get('position')
  if (!isRecord(position) || typeof position.x !== 'number' || typeof position.y !== 'number') {
    return null
  }

  const rawData = source.get('data')
  const raw = rawData instanceof Y.Map ? (rawData.toJSON() as Record<string, unknown>) : {}
  const data = isLegacyNodeData(raw) ? upgradeNodeData(raw) : normalizeNodeData(raw)

  // 分组 / 层级三兄弟：writeNode 会写进文档（legacy 迁移就靠它），读的时候不认的话，
  // 这些字段会在下一次投影重写时从 graph 里永久消失
  const zIndex = source.get('zIndex')
  const parentNode = source.get('parentNode')
  const extent = source.get('extent')
  const sourcePosition = source.get('sourcePosition')
  const targetPosition = source.get('targetPosition')

  return {
    id,
    type: typeof source.get('type') === 'string' ? (source.get('type') as string) : 'process',
    position: { x: position.x, y: position.y },
    ...(typeof source.get('width') === 'number' ? { width: source.get('width') as number } : {}),
    ...(typeof source.get('height') === 'number' ? { height: source.get('height') as number } : {}),
    ...(typeof zIndex === 'number' ? { zIndex } : {}),
    ...(typeof parentNode === 'string' ? { parentNode } : {}),
    ...(extent === 'parent' || extent === null ? { extent } : {}),
    ...(isHandlePosition(sourcePosition) ? { sourcePosition } : {}),
    ...(isHandlePosition(targetPosition) ? { targetPosition } : {}),
    data,
  }
}

/** v2 的 data：原样收下，只保证框架字段的形状对 */
function normalizeNodeData(raw: Record<string, unknown>): FlowNodeData {
  const data: FlowNodeData = { ...raw, label: '', status: 'idle' }
  data.label = typeof raw.label === 'string' ? raw.label : ''
  data.status = isNodeStatus(raw.status) ? raw.status : 'idle'
  return data
}

function isNodeStatus(value: unknown): value is FlowNodeStatus {
  return value === 'idle' || value === 'processing' || value === 'completed' || value === 'error'
}

function isHandlePosition(value: unknown): value is FlowHandlePosition {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom'
}

/** v1 的边 data 是 `{kind?, condition?, config}`，`config` 在就当它是老的 */
function isLegacyEdgeData(data: Record<string, unknown>): boolean {
  return isRecord(data.config)
}

function readEdge(id: string, source: Y.Map<unknown>): FlowEdge | null {
  const sourceId = source.get('source')
  const targetId = source.get('target')
  if (typeof sourceId !== 'string' || typeof targetId !== 'string') return null

  const rawData = source.get('data')
  const raw = isRecord(rawData) ? rawData : {}

  return {
    id,
    source: sourceId,
    target: targetId,
    sourceHandle: (source.get('sourceHandle') as string | null | undefined) ?? null,
    targetHandle: (source.get('targetHandle') as string | null | undefined) ?? null,
    ...(typeof source.get('type') === 'string' ? { type: source.get('type') as string } : {}),
    ...(typeof source.get('animated') === 'boolean'
      ? { animated: source.get('animated') as boolean }
      : {}),
    ...(typeof source.get('label') === 'string' ? { label: source.get('label') as string } : {}),
    data: isLegacyEdgeData(raw) ? upgradeEdgeData(raw) : (raw as FlowEdge['data']),
  }
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

  const nodeIds = new Set<string>()
  for (const [id, value] of nodesMap(doc).entries()) {
    if (!(value instanceof Y.Map)) continue
    const node = readNode(id, value)
    if (!node) continue
    graph.nodes.push(node)
    nodeIds.add(id)
  }

  for (const [id, value] of edgesMap(doc).entries()) {
    if (!(value instanceof Y.Map)) continue
    const edge = readEdge(id, value)
    // 端点没了的边不进投影：parseGraph 会因为它整张图判不合法
    if (!edge || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
    graph.edges.push(edge)
  }

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
 * 投影层（`readGraphFromDoc` / 前端的 `readEdges`）会把它过滤掉，所以界面上看不见 ——
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
