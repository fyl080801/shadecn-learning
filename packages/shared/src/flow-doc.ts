import * as Y from 'yjs'
import {
  nodeRecordFromParts,
  OUTPUT_KEY_PREFIX,
  withInputs,
  type FlowEdge,
  type FlowEdgeData,
  type FlowGraph,
  type FlowNode,
  type FlowNodeRecord,
  type FlowNodeRuntime,
} from './flow-graph.ts'

/**
 * 画布内容在 Yjs 文档里长什么样 —— **这是内容的唯一事实源**，前后端读写的都是这一份。
 *
 * ```
 * ydoc
 *  ├─ nodes: Y.Map<nodeId, Y.Map>   节点
 *  │    type
 *  │    position, width, height, zIndex, parentNode, extent,
 *  │    sourcePosition, targetPosition          ← layout：留在顶层原位，不嵌套
 *  │    metadata: Y.Map   label, description, icon, createdAt, createdBy, ui
 *  │    data:     Y.Map   业务字段平铺
 *  │    runtime:  Y.Map   status, error, taskId, outputs.<portId>…
 *  ├─ edges: Y.Map<edgeId, Y.Map>   连线
 *  └─ meta:  Y.Map                  画布级自定义数据 + 兜底视口
 * ```
 *
 * **为什么节点是 Y.Map 而不是整块 JSON**：Y.Map 的合并粒度是 key。
 * 甲改标题、乙同时拖位置，两人改的是不同的 key，CRDT 会各自保留；
 * 存成一整块 JSON 的话后到的那份会把先到的整个盖掉。
 * metadata / data / runtime 各套一层 Y.Map 同理 —— 名字、业务字段、运行态是分开改的，
 * 组内也逐 key 合并（甲改 metadata.label、乙改 data.prompt，两边都留）。
 *
 * **layout 为什么不套**：拖动是最热的写路径，`position` 一直是顶层的一个 key；
 * Vue Flow 也要平铺的形状。v3 把它「归组」只发生在投影类型上（`FlowNode.layout`），
 * 文档里的位置没动 —— 老文档的位置因此原样读得出来。
 *
 * **运行态的产出按端口摊平**：`outputs.<portId>` 一个端口一个 key（和
 * `flow-collection.ts` 的平铺分键同一个思路），不存整块 `outputs` 对象 ——
 * 一个端口出了新结果不该把另一个端口的结果整块盖掉。
 *
 * **key 的类型首次写入即固定**：metadata / runtime 是 v3 新加的 key，从第一次写入起就是
 * Y.Map，不存在「同一个 key 新老客户端写不同类型」的问题。老节点（v1 / v2 写的）没有这两个
 * key，写的时候现建（{@link nodeGroupMap} 的 `create`）。
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

/** 节点上三组嵌套 Y.Map 的键名 —— 也是 store / agent 按组写时的组名 */
export const NODE_GROUPS = ['metadata', 'data', 'runtime'] as const
export type FlowNodeGroup = (typeof NODE_GROUPS)[number]

/** layout 在节点顶层占的那些键 */
export const LAYOUT_KEYS = [
  'position',
  'width',
  'height',
  'zIndex',
  'parentNode',
  'extent',
  'sourcePosition',
  'targetPosition',
] as const

/** 某个输出端口的产出在 runtime 那层 Y.Map 里的键：`outputs.<portId>` */
export function outputKey(portId: string): string {
  return `${OUTPUT_KEY_PREFIX}${portId}`
}

export function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(NODES_KEY)
}

export function edgesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(EDGES_KEY)
}

export function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(META_KEY)
}

/**
 * 取某个节点某一组的那层 Y.Map。
 *
 * - 节点不存在 → null；
 * - 这一组的 key 不存在（老节点没有 metadata / runtime）→ `create` 时现建一个，否则 null；
 * - 这个 key 上是别的东西（不是 Y.Map）→ **一律 null，绝不覆盖**：key 的类型首次写入即固定，
 *   换类型会让写它的另一方整棵子树消失。
 *
 * `create` 只能在事务里用（它会写文档）。
 */
export function nodeGroupMap(
  node: Y.Map<unknown> | undefined,
  group: FlowNodeGroup,
  options: { create?: boolean } = {},
): Y.Map<unknown> | null {
  if (!(node instanceof Y.Map)) return null
  const value = node.get(group)
  if (value instanceof Y.Map) return value as Y.Map<unknown>
  if (value !== undefined || !options.create) return null
  const created = new Y.Map<unknown>()
  node.set(group, created)
  return created
}

/** 按文档 + 节点 id 取某一组；语义同 {@link nodeGroupMap} */
export function nodeGroup(
  doc: Y.Doc,
  nodeId: string,
  group: FlowNodeGroup,
  options: { create?: boolean } = {},
): Y.Map<unknown> | null {
  return nodeGroupMap(nodesMap(doc).get(nodeId), group, options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// —— 写 ——
//
// 写入口有两组，**语义不同，不要互相替代**：
// - `toYNode` / `toYEdge` —— 编辑器 / agent 新建：造一个全新的 Y.Map，由调用方放进 `nodes`
//   并包在事务里。边的 `sourceHandle` / `targetHandle` 没有时写成 `null`。
// - `writeNode` / `writeEdge` / `applyGraphToDoc` —— 服务端把老画布的 graph JSON 灌进空文档
//   （`Flow.ydoc` 为 NULL 的画布第一次被打开）：往已有的 Y.Map 上覆盖，没有的字段一律不写。
// 两组写进去的字段集合相同，读回来（`fromYNode` / `fromYEdge`）的结果也相同。

/** 运行态摊平成 Y.Map 里的键值：产出按端口拆成 `outputs.<portId>` */
function runtimeEntries(runtime: FlowNodeRuntime): [string, unknown][] {
  const entries: [string, unknown][] = [['status', runtime.status]]
  if (runtime.error !== undefined) entries.push(['error', runtime.error])
  if (runtime.taskId !== undefined) entries.push(['taskId', runtime.taskId])
  for (const [port, value] of Object.entries(runtime.outputs ?? {})) {
    if (value !== undefined) entries.push([outputKey(port), value])
  }
  return entries
}

/** 把一组键值逐个写进 Y.Map（开放的组按**实际有的键**写，照固定清单写会丢掉清单外的字段） */
function writeEntries(target: Y.Map<unknown>, entries: Iterable<[string, unknown]>) {
  for (const [key, value] of entries) {
    if (value !== undefined) target.set(key, value)
  }
}

function writeLayout(target: Y.Map<unknown>, record: FlowNodeRecord) {
  const layout = record.layout as unknown as Record<string, unknown>
  for (const key of LAYOUT_KEYS) {
    const value = layout[key]
    if (value === undefined) continue
    target.set(key, key === 'position' ? { ...(value as object) } : value)
  }
}

/**
 * 把一个新节点铺进 Y.Map（含三组嵌套的 Y.Map）。调用方负责放进 `nodes` 并包在事务里。
 *
 * 收的是 {@link FlowNodeRecord}：传一个带 `inputs` 的 {@link FlowNode} 也行，`inputs` 是派生的，不写。
 */
export function toYNode(record: FlowNodeRecord): Y.Map<unknown> {
  const target = new Y.Map<unknown>()
  target.set('type', record.type)
  writeLayout(target, record)

  const metadata = new Y.Map<unknown>()
  writeEntries(metadata, Object.entries(record.metadata))
  target.set('metadata', metadata)

  const data = new Y.Map<unknown>()
  writeEntries(data, Object.entries(record.data))
  target.set('data', data)

  const runtime = new Y.Map<unknown>()
  writeEntries(runtime, runtimeEntries(record.runtime))
  target.set('runtime', runtime)

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

/** 把一个节点铺进已有的 Y.Map（含三组嵌套的 Y.Map）。已存在的键会被覆盖 */
export function writeNode(target: Y.Map<unknown>, record: FlowNodeRecord) {
  target.set('type', record.type)
  writeLayout(target, record)
  const groups: [typeof NODE_GROUPS[number], Iterable<[string, unknown]>][] = [
    ['metadata', Object.entries(record.metadata ?? {})],
    ['data', Object.entries(record.data ?? {})],
    ['runtime', runtimeEntries(record.runtime ?? { status: 'idle' })],
  ]
  for (const [group, entries] of groups) {
    const map = nodeGroupMap(target, group, { create: true })
    // 这个 key 上已经是别的类型：不覆盖（见 nodeGroupMap），这一组跳过
    if (map) writeEntries(map, entries)
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

/** 一组嵌套 Y.Map 读成普通对象；不是 Y.Map（老数据没有、或者是坏的）就当空 */
function groupJSON(source: Y.Map<unknown>, group: string): Record<string, unknown> {
  const value = source.get(group)
  return value instanceof Y.Map ? (value.toJSON() as Record<string, unknown>) : {}
}

/**
 * 读出一个节点存下来的部分；形状不对（没有合法的 position）返回 null。
 *
 * **不升级、不抛错**：v1 / v2 写的老节点没有 metadata / runtime，读出来名字为空、状态 idle，
 * 原来混在 data 上的 label / status 原样留在 data 里（产品决定不做迁移）。
 */
export function fromYNode(id: string, source: Y.Map<unknown>): FlowNodeRecord | null {
  const layout: Record<string, unknown> = {}
  for (const key of LAYOUT_KEYS) layout[key] = source.get(key)
  return nodeRecordFromParts(id, {
    type: source.get('type'),
    layout,
    metadata: groupJSON(source, 'metadata'),
    data: groupJSON(source, 'data'),
    runtime: groupJSON(source, 'runtime'),
  })
}

export function fromYEdge(id: string, source: Y.Map<unknown>): FlowEdge | null {
  const sourceId = source.get('source')
  const targetId = source.get('target')
  if (typeof sourceId !== 'string' || typeof targetId !== 'string') return null

  const rawData = source.get('data')
  const type = source.get('type')
  const animated = source.get('animated')
  const label = source.get('label')
  const sourceHandle = source.get('sourceHandle')
  const targetHandle = source.get('targetHandle')

  return {
    id,
    source: sourceId,
    target: targetId,
    sourceHandle: typeof sourceHandle === 'string' ? sourceHandle : null,
    targetHandle: typeof targetHandle === 'string' ? targetHandle : null,
    ...(typeof type === 'string' ? { type } : {}),
    ...(typeof animated === 'boolean' ? { animated } : {}),
    ...(typeof label === 'string' ? { label } : {}),
    data: isRecord(rawData) ? (rawData as FlowEdgeData) : {},
  }
}

/**
 * 读出全部节点存下来的部分（不含 inputs）。
 *
 * 形状不对的整条跳过 —— 这份数据可能来自别的客户端，坏一条不该拖垮整张画布。
 */
export function readNodeRecords(doc: Y.Doc): FlowNodeRecord[] {
  const nodes: FlowNodeRecord[] = []
  for (const [id, value] of nodesMap(doc).entries()) {
    if (!(value instanceof Y.Map)) continue
    const node = fromYNode(id, value)
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

/**
 * 读出全部节点，**带上派生的 inputs**（服务端、agent 用；编辑器有自己的增量投影）。
 * inputs 只从**两端都还在**的边派生 —— 和渲染层看得见的边是同一批。
 */
export function readNodes(doc: Y.Doc): FlowNode[] {
  const records = readNodeRecords(doc)
  const edges = readEdges(doc, new Set(records.map((record) => record.id)))
  return withInputs(records, edges)
}
