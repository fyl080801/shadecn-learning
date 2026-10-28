import * as Y from 'yjs'
import {
  FALLBACK_NODE_TYPE,
  isHandlePosition,
  isLegacyEdgeData,
  isLegacyNodeData,
  normalizeNodeData,
  upgradeEdgeData,
  upgradeNodeData,
  type FlowEdge,
  type FlowEdgeData,
  type FlowGraph,
  type FlowNode,
  type UpgradeOptions,
} from './flow-graph.ts'

/**
 * 画布内容在 Yjs 文档里长什么样 —— **这是内容的唯一事实源**，前后端读写的都是这一份。
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
 * ⚠️ **yjs 必须全进程只有一份**：这里通篇靠 `value instanceof Y.Map` 判断结构，
 * 两份副本之间的 `instanceof` 永远为 false，画布会静默变成一张空图。所以 yjs 在本包里
 * 是 peerDependency —— 用的是宿主（apps/web / apps/server）装的那一份；前端另有
 * `resolve.dedupe: ['yjs', 'y-protocols']` 兜着（`apps/web/vite.config.ts`）。
 */

export const NODES_KEY = 'nodes'
export const EDGES_KEY = 'edges'
export const META_KEY = 'meta'

/** meta 里那份兜底视口的键名（真正生效的是每人自己的，见 FlowUserState） */
export const VIEWPORT_KEY = 'viewport'

export function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(NODES_KEY)
}

export function edgesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(EDGES_KEY)
}

export function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(META_KEY)
}

/** 取某个节点 data 那层 Y.Map；节点不存在或结构不对返回 null */
export function nodeData(doc: Y.Doc, nodeId: string): Y.Map<unknown> | null {
  const data = nodesMap(doc).get(nodeId)?.get('data')
  return data instanceof Y.Map ? data : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// —— 写 ——
//
// 写入口有两组，**语义不同，不要互相替代**：
// - `toYNode` / `toYEdge` —— 编辑器新建：造一个全新的 Y.Map，由调用方放进 `nodes` 并包在事务里。
//   边的 `sourceHandle` / `targetHandle` 没有时写成 `null`。
// - `writeNode` / `writeEdge` / `applyGraphToDoc` —— 服务端把老画布的 graph JSON 灌进空文档
//   （`Flow.ydoc` 为 NULL 的画布第一次被打开）：往已有的 Y.Map 上覆盖，没有的字段一律不写。
// 两组写进去的字段集合相同，读回来（`fromYNode` / `fromYEdge`）的结果也相同。

/** 把一个新节点铺进 Y.Map（含嵌套的 data）。调用方负责放进 `nodes` 并包在事务里 */
export function toYNode(node: FlowNode): Y.Map<unknown> {
  const target = new Y.Map<unknown>()
  target.set('type', node.type)
  target.set('position', { ...node.position })
  if (node.width !== undefined) target.set('width', node.width)
  if (node.height !== undefined) target.set('height', node.height)
  if (node.zIndex !== undefined) target.set('zIndex', node.zIndex)
  if (node.parentNode !== undefined) target.set('parentNode', node.parentNode)
  if (node.extent !== undefined) target.set('extent', node.extent)
  if (node.sourcePosition !== undefined) target.set('sourcePosition', node.sourcePosition)
  if (node.targetPosition !== undefined) target.set('targetPosition', node.targetPosition)

  // data 是开放的（业务字段平铺），按**实际有的键**逐个写 ——
  // 照固定清单写的话，清单外的业务字段会被静默丢掉
  const data = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(node.data)) {
    if (value !== undefined) data.set(key, value)
  }
  target.set('data', data)

  return target
}

export function toYEdge(edge: FlowEdge): Y.Map<unknown> {
  const target = new Y.Map<unknown>()
  target.set('source', edge.source)
  target.set('target', edge.target)
  target.set('sourceHandle', edge.sourceHandle ?? null)
  target.set('targetHandle', edge.targetHandle ?? null)
  if (edge.type !== undefined) target.set('type', edge.type)
  if (edge.animated !== undefined) target.set('animated', edge.animated)
  if (edge.label !== undefined) target.set('label', edge.label)
  target.set('data', edge.data)
  return target
}

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

/** 把一个节点铺进已有的 Y.Map（含嵌套的 data）。已存在的键会被覆盖 */
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

// —— 读 ——

/**
 * 读出一个节点；形状不对返回 null。
 *
 * v1 写进去的 data 在这里就地升级（只读不回写，见 `isLegacyNodeData`）。
 * `options` 只有服务端会传，理由见 {@link UpgradeOptions}。
 */
export function fromYNode(
  id: string,
  source: Y.Map<unknown>,
  options?: UpgradeOptions,
): FlowNode | null {
  const position = source.get('position')
  if (!isRecord(position) || typeof position.x !== 'number' || typeof position.y !== 'number') {
    return null
  }

  const rawData = source.get('data')
  const raw = rawData instanceof Y.Map ? (rawData.toJSON() as Record<string, unknown>) : {}
  const data = isLegacyNodeData(raw) ? upgradeNodeData(raw, options) : normalizeNodeData(raw)

  const width = source.get('width')
  const height = source.get('height')
  // 分组 / 层级字段和 width/height 一样是节点顶层的一等公民 ——
  // writeNode 会写进文档（legacy 迁移就靠它），读的时候不认的话，
  // 这些字段会在投影里凭空消失
  const zIndex = source.get('zIndex')
  const parentNode = source.get('parentNode')
  const extent = source.get('extent')
  const sourcePosition = source.get('sourcePosition')
  const targetPosition = source.get('targetPosition')
  const type = source.get('type')

  return {
    id,
    type: typeof type === 'string' ? type : FALLBACK_NODE_TYPE,
    position: { x: position.x, y: position.y },
    ...(typeof width === 'number' ? { width } : {}),
    ...(typeof height === 'number' ? { height } : {}),
    ...(typeof zIndex === 'number' ? { zIndex } : {}),
    ...(typeof parentNode === 'string' ? { parentNode } : {}),
    ...(extent === 'parent' || extent === null ? { extent } : {}),
    ...(isHandlePosition(sourcePosition) ? { sourcePosition } : {}),
    ...(isHandlePosition(targetPosition) ? { targetPosition } : {}),
    data,
  }
}

export function fromYEdge(id: string, source: Y.Map<unknown>): FlowEdge | null {
  const sourceId = source.get('source')
  const targetId = source.get('target')
  if (typeof sourceId !== 'string' || typeof targetId !== 'string') return null

  const rawData = source.get('data')
  const raw = isRecord(rawData) ? rawData : {}
  const type = source.get('type')
  const animated = source.get('animated')
  const label = source.get('label')

  return {
    id,
    source: sourceId,
    target: targetId,
    sourceHandle: (source.get('sourceHandle') as string | null | undefined) ?? null,
    targetHandle: (source.get('targetHandle') as string | null | undefined) ?? null,
    ...(typeof type === 'string' ? { type } : {}),
    ...(typeof animated === 'boolean' ? { animated } : {}),
    ...(typeof label === 'string' ? { label } : {}),
    data: isLegacyEdgeData(raw) ? upgradeEdgeData(raw) : (raw as FlowEdgeData),
  }
}

/**
 * 读出全部节点。
 *
 * 形状不对的整条跳过 —— 这份数据可能来自别的客户端，坏一条不该拖垮整张画布。
 */
export function readNodes(doc: Y.Doc, options?: UpgradeOptions): FlowNode[] {
  const nodes: FlowNode[] = []
  for (const [id, value] of nodesMap(doc).entries()) {
    if (!(value instanceof Y.Map)) continue
    const node = fromYNode(id, value, options)
    if (node) nodes.push(node)
  }
  return nodes
}

/** 读出全部连线；端点已经没了的边跳过，免得渲染出一根悬空的线 */
export function readEdges(doc: Y.Doc, nodeIds: ReadonlySet<string>): FlowEdge[] {
  const edges: FlowEdge[] = []
  for (const [id, value] of edgesMap(doc).entries()) {
    if (!(value instanceof Y.Map)) continue
    const edge = fromYEdge(id, value)
    if (!edge || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
    edges.push(edge)
  }
  return edges
}
