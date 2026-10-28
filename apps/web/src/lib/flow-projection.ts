import * as Y from "yjs"
import type {
  FlowEdge,
  FlowEdgeData,
  FlowHandlePosition,
  FlowNode,
  FlowNodeData,
  FlowNodeStatus,
  FlowViewport
} from "@/types/flow"

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
 * ⚠️ 服务端有一份等价实现（`server/collab/flow-doc.ts`）—— server 和 src 是两个
 * TS 工程，互相 import 不了。**两边的键名和嵌套结构必须完全一致**，
 * 改一处记得改另一处，否则一边写进去的东西另一边读不出来。
 */

export const NODES_KEY = "nodes"
export const EDGES_KEY = "edges"
export const META_KEY = "meta"

/** meta 里那份兜底视口的键名（真正生效的是每人自己的，见 FlowUserState） */
export const VIEWPORT_KEY = "viewport"

export function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(NODES_KEY)
}

export function edgesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(EDGES_KEY)
}

export function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(META_KEY)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// —— 写 ——

/** 把一个新节点铺进 Y.Map（含嵌套的 data）。调用方负责放进 `nodes` 并包在事务里 */
export function toYNode(node: FlowNode): Y.Map<unknown> {
  const target = new Y.Map<unknown>()
  target.set("type", node.type)
  target.set("position", { ...node.position })
  if (node.width !== undefined) target.set("width", node.width)
  if (node.height !== undefined) target.set("height", node.height)
  if (node.zIndex !== undefined) target.set("zIndex", node.zIndex)
  if (node.parentNode !== undefined) target.set("parentNode", node.parentNode)
  if (node.extent !== undefined) target.set("extent", node.extent)
  if (node.sourcePosition !== undefined) target.set("sourcePosition", node.sourcePosition)
  if (node.targetPosition !== undefined) target.set("targetPosition", node.targetPosition)

  // data 是开放的（业务字段平铺），按**实际有的键**逐个写 ——
  // 照固定清单写的话，清单外的业务字段会被静默丢掉
  const data = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(node.data)) {
    if (value !== undefined) data.set(key, value)
  }
  target.set("data", data)

  return target
}

export function toYEdge(edge: FlowEdge): Y.Map<unknown> {
  const target = new Y.Map<unknown>()
  target.set("source", edge.source)
  target.set("target", edge.target)
  target.set("sourceHandle", edge.sourceHandle ?? null)
  target.set("targetHandle", edge.targetHandle ?? null)
  if (edge.type !== undefined) target.set("type", edge.type)
  if (edge.animated !== undefined) target.set("animated", edge.animated)
  if (edge.label !== undefined) target.set("label", edge.label)
  target.set("data", edge.data)
  return target
}

// —— v1 → v2 的就地升级 ——

/**
 * 这份 `data` 是 v1 写进去的吗？
 *
 * Y.Doc 里没有版本号可查，只能看形状：**同时**有字符串 `kind` 和对象 `config` ——
 * 这正是 v1 必写的两个键，v2 一个都不写。要求两个同时命中，是为了不误伤
 * 某个真的叫 `config` 的业务字段。
 *
 * 升级只发生在**读**这一侧，纯函数、幂等，**不回写文档**：投影里写文档会凭空
 * 产生一次 Yjs 事务 —— 进撤销栈、广播给所有人。残留的 `kind` / `config` 键无害。
 *
 * ⚠️ 服务端有等价实现（`server/store/flow-types.ts` 的 `upgradeNodeData`）。
 */
function isLegacyNodeData(data: Record<string, unknown>): boolean {
  return typeof data.kind === "string" && isRecord(data.config)
}

/** v1 的节点 data → v2：`config` 拆平、`kind` 丢掉、补上 `status` */
function upgradeNodeData(raw: Record<string, unknown>): FlowNodeData {
  const config = isRecord(raw.config) ? raw.config : {}

  // 先铺 v1 的 config，再铺 raw 其余的键 —— 包括已经平铺着的未知字段，别升丢了
  const data: FlowNodeData = { ...config, label: "", status: "idle" }
  for (const [key, value] of Object.entries(raw)) {
    if (key === "kind" || key === "config" || key === "ports") continue
    if (value !== undefined) data[key] = value
  }

  // 框架字段最后规范化，压在业务字段之上
  data.label = typeof raw.label === "string" ? raw.label : ""
  data.status = isNodeStatus(raw.status) ? raw.status : "idle"
  if (typeof data.createdAt !== "number") delete data.createdAt
  if (typeof data.description !== "string") delete data.description
  if (typeof data.icon !== "string") delete data.icon
  if (!isRecord(data.ui)) delete data.ui

  // 空壳端口不留：v1 给每个节点都塞了 `{inputs:[],outputs:[]}`，那是噪声不是信息
  const ports = raw.ports
  if (isRecord(ports) && (asArray(ports.inputs).length > 0 || asArray(ports.outputs).length > 0)) {
    data.ports = ports as FlowNodeData["ports"]
  }

  return data
}

/** v2 的 data：原样收下，只保证框架字段的形状对 */
function normalizeNodeData(raw: Record<string, unknown>): FlowNodeData {
  const data: FlowNodeData = { ...raw, label: "", status: "idle" }
  data.label = typeof raw.label === "string" ? raw.label : ""
  data.status = isNodeStatus(raw.status) ? raw.status : "idle"
  return data
}

/**
 * v1 的边 data 是 `{kind?, condition?, config}` —— `config` 在就当它是老的。
 * `kind` / `condition` 是边自己的业务语义，没有别的字段与之重复，保留平铺，不丢。
 */
function upgradeEdgeData(raw: Record<string, unknown>): FlowEdgeData {
  const config = isRecord(raw.config) ? raw.config : {}
  const data: FlowEdgeData = { ...config }
  for (const [key, value] of Object.entries(raw)) {
    if (key === "config") continue
    if (value !== undefined) data[key] = value
  }
  return data
}

function isNodeStatus(value: unknown): value is FlowNodeStatus {
  return value === "idle" || value === "processing" || value === "completed" || value === "error"
}

function isHandlePosition(value: unknown): value is FlowHandlePosition {
  return value === "left" || value === "right" || value === "top" || value === "bottom"
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 取某个节点 data 那层 Y.Map；节点不存在或结构不对返回 null */
export function nodeData(doc: Y.Doc, nodeId: string): Y.Map<unknown> | null {
  const data = nodesMap(doc).get(nodeId)?.get("data")
  return data instanceof Y.Map ? data : null
}

// —— 读 ——

export function fromYNode(id: string, source: Y.Map<unknown>): FlowNode | null {
  const position = source.get("position")
  if (!isRecord(position) || typeof position.x !== "number" || typeof position.y !== "number") {
    return null
  }

  const rawData = source.get("data")
  const raw = rawData instanceof Y.Map ? (rawData.toJSON() as Record<string, unknown>) : {}
  const data = isLegacyNodeData(raw) ? upgradeNodeData(raw) : normalizeNodeData(raw)

  const width = source.get("width")
  const height = source.get("height")
  // 分组 / 层级字段和 width/height 一样是节点顶层的一等公民 ——
  // 不读的话 legacy 迁移写进文档的分组信息会在投影里凭空消失（服务端同此）
  const zIndex = source.get("zIndex")
  const parentNode = source.get("parentNode")
  const extent = source.get("extent")
  const sourcePosition = source.get("sourcePosition")
  const targetPosition = source.get("targetPosition")

  return {
    id,
    type: typeof source.get("type") === "string" ? (source.get("type") as string) : "process",
    position: { x: position.x, y: position.y },
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
    ...(typeof zIndex === "number" ? { zIndex } : {}),
    ...(typeof parentNode === "string" ? { parentNode } : {}),
    ...(extent === "parent" || extent === null ? { extent } : {}),
    ...(isHandlePosition(sourcePosition) ? { sourcePosition } : {}),
    ...(isHandlePosition(targetPosition) ? { targetPosition } : {}),
    data
  }
}

export function fromYEdge(id: string, source: Y.Map<unknown>): FlowEdge | null {
  const sourceId = source.get("source")
  const targetId = source.get("target")
  if (typeof sourceId !== "string" || typeof targetId !== "string") return null

  const rawData = source.get("data")
  const raw = isRecord(rawData) ? rawData : {}
  const type = source.get("type")
  const animated = source.get("animated")
  const label = source.get("label")

  return {
    id,
    source: sourceId,
    target: targetId,
    sourceHandle: (source.get("sourceHandle") as string | null | undefined) ?? null,
    targetHandle: (source.get("targetHandle") as string | null | undefined) ?? null,
    ...(typeof type === "string" ? { type } : {}),
    ...(typeof animated === "boolean" ? { animated } : {}),
    ...(typeof label === "string" ? { label } : {}),
    data: isRecord(raw.config) ? upgradeEdgeData(raw) : (raw as FlowEdgeData)
  }
}

/**
 * 读出全部节点。
 *
 * 形状不对的整条跳过 —— 这份数据可能来自别的客户端，坏一条不该拖垮整张画布。
 */
export function readNodes(doc: Y.Doc): FlowNode[] {
  const nodes: FlowNode[] = []
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

// —— 增量投影 ——

/**
 * 从一批 `observeDeep` 事件里挑出「哪些顶层键变了」。
 *
 * 事件分两种，都要认：
 * - **直接改这张 Map**（增删节点）：`event.path` 为空，变化的键在 `event.changes.keys` 里；
 * - **改某个节点内部**（拖位置、改标题）：`event.path[0]` 就是那个节点的 id。
 *
 * 返回 null 表示「说不清，全量重来」—— 宁可退回全量也不要漏掉一个键，
 * 漏掉的后果是画面和文档不一致，比多算一次贵得多。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs 的 observeDeep 回调就是这个签名
export function changedTopLevelKeys(events: Y.YEvent<any>[]): Set<string> | null {
  const keys = new Set<string>()
  for (const event of events) {
    if (event.path.length === 0) {
      for (const key of event.changes.keys.keys()) keys.add(key)
      continue
    }
    const first = event.path[0]
    if (typeof first !== "string") return null
    keys.add(first)
  }
  return keys
}

/**
 * 按 Y.Map 当前的键顺序重建数组，**只对变化的键重新解析**，其余复用上一轮的对象。
 *
 * 复用对象引用不只是省 CPU：Vue Flow 靠引用判断节点要不要重新同步，
 * 引用不变的节点它就不碰。
 *
 * `cache` 会被就地更新（删掉已经不存在的键），调用方持有它跨轮复用。
 */
export function projectMap<T extends { id: string }>(
  source: Y.Map<Y.Map<unknown>>,
  cache: Map<string, T>,
  changed: Set<string> | null,
  parse: (id: string, value: Y.Map<unknown>) => T | null,
): T[] {
  const result: T[] = []
  const alive = new Set<string>()

  for (const [id, value] of source.entries()) {
    alive.add(id)
    let item = cache.get(id)
    // changed 为 null = 全量重算；否则只有点名的那些要重新解析
    if (item === undefined || changed === null || changed.has(id)) {
      if (!(value instanceof Y.Map)) {
        cache.delete(id)
        continue
      }
      const parsed = parse(id, value)
      if (!parsed) {
        cache.delete(id)
        continue
      }
      item = parsed
      cache.set(id, item)
    }
    result.push(item)
  }

  for (const id of [...cache.keys()]) {
    if (!alive.has(id)) cache.delete(id)
  }
  return result
}

/** 快照里那份兜底视口；没有或不合法返回 null */
export function readFallbackViewport(doc: Y.Doc): FlowViewport | null {
  const viewport = metaMap(doc).get(VIEWPORT_KEY)
  if (
    !isRecord(viewport) ||
    typeof viewport.x !== "number" ||
    typeof viewport.y !== "number" ||
    typeof viewport.zoom !== "number" ||
    viewport.zoom <= 0
  ) {
    return null
  }
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
}
