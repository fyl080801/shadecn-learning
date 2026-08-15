/**
 * 画布内容的数据结构与校验。
 *
 * 约定（见 docs/13-flow-canvas-management.md）：Vue Flow 认识的字段留在节点顶层，
 * 业务自定义的一切都塞进 `data` —— 换渲染层时业务数据不受影响。
 *
 * 服务端只做**结构校验**，不解释 `data.config` 的内容，原样透传存储。
 * 前端侧的同名类型在 `src/types/flow.ts`，改这里记得同步。
 */

/** 当前的图结构版本；读到未知版本直接拒绝，不猜 */
export const GRAPH_SCHEMA_VERSION = 1

export const GRAPH_LIMITS = {
  /** 单画布节点上限 */
  nodes: 2000,
  /** 单画布边上限 */
  edges: 4000,
  /** 序列化后的 graph 字节上限 */
  bytes: 2 * 1024 * 1024,
  /** 单次 commit 的事务条数上限 */
  transactions: 200,
} as const

export interface FlowPort {
  id: string
  label?: string
  /** 数据类型标记，将来做连线合法性校验用；本期只存不判 */
  dataType?: string
}

export interface FlowNodeData {
  label: string
  /** 业务种类，决定 config 的形状 */
  kind: string
  description?: string
  icon?: string
  /** 与 kind 一一对应的自定义配置，前后端都不解释它 */
  config: Record<string, unknown>
  ports: { inputs: FlowPort[]; outputs: FlowPort[] }
  /** 需要持久化的 UI 状态（折叠、颜色…） */
  ui?: Record<string, unknown>
}

export interface FlowNode {
  id: string
  type: string
  position: { x: number; y: number }
  width?: number
  height?: number
  zIndex?: number
  /** 预留：分组 / 子流程 */
  parentNode?: string
  extent?: 'parent' | null
  data: FlowNodeData
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  type?: string
  animated?: boolean
  label?: string
  data: {
    kind?: string
    condition?: unknown
    config: Record<string, unknown>
  }
}

/** 视口：画布看哪儿、放多大 */
export interface FlowViewport {
  x: number
  y: number
  zoom: number
}

export interface FlowGraph {
  schemaVersion: number
  /**
   * 画布级的兜底视口。真正生效的是**每人自己的**视口（见 FlowUserState），
   * 这里这份只在某人第一次打开、还没有自己的记录时用。
   */
  viewport: FlowViewport
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** 画布级自定义数据，同样透传 */
  meta: Record<string, unknown>
}

export function emptyGraph(): FlowGraph {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    meta: {},
  }
}

/** 操作类型 —— 一次可撤销的最小语义变更 */
export type FlowOpType =
  | 'node.add'
  | 'node.remove'
  | 'node.move'
  | 'node.resize'
  | 'node.update'
  | 'edge.add'
  | 'edge.remove'
  | 'edge.update'
  | 'graph.meta'

const OP_TYPES: readonly string[] = [
  'node.add',
  'node.remove',
  'node.move',
  'node.resize',
  'node.update',
  'edge.add',
  'edge.remove',
  'edge.update',
  'graph.meta',
]

export interface FlowOp {
  type: FlowOpType
  targetId: string
  /** 变更前的片段；add 为 null */
  before: unknown | null
  /** 变更后的片段；remove 为 null */
  after: unknown | null
}

export type FlowTransactionKind = 'do' | 'undo' | 'redo'

export interface FlowTransaction {
  /** 客户端生成，用于重试幂等 */
  id: string
  label: string
  kind: FlowTransactionKind
  /**
   * 客户端产生这次事务的时刻：UTC epoch 毫秒的整数。
   *
   * 协同时不同客户端的操作要排到同一条时间轴上，所以时间只用数值时间戳
   * 表示，不用 ISO 字符串、更不用本地时间。客户端的钟可能是歪的，
   * 服务端另记一个 serverTs，排序以服务端的为准。
   */
  ts: number
  ops: FlowOp[]
}

/** 时间戳字段的统一判定：UTC epoch 毫秒，正整数 */
export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 校验客户端提交上来的 graph。
 *
 * 只认结构不认内容：节点 id 不能重、边不能指向不存在的节点，
 * 其余（尤其是 data.config）原样收下。
 */
export function parseGraph(input: unknown): ParseResult<FlowGraph> {
  if (!isRecord(input)) return { ok: false, error: 'graph 必须是对象' }

  if (input.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    return { ok: false, error: `不支持的 graph.schemaVersion：${String(input.schemaVersion)}` }
  }

  const viewport = parseViewport(input.viewport)
  if (!viewport.ok) return { ok: false, error: `graph.${viewport.error}` }

  if (!Array.isArray(input.nodes)) return { ok: false, error: 'graph.nodes 必须是数组' }
  if (!Array.isArray(input.edges)) return { ok: false, error: 'graph.edges 必须是数组' }

  if (input.nodes.length > GRAPH_LIMITS.nodes) {
    return { ok: false, error: `节点数超过上限 ${GRAPH_LIMITS.nodes}` }
  }
  if (input.edges.length > GRAPH_LIMITS.edges) {
    return { ok: false, error: `连线数超过上限 ${GRAPH_LIMITS.edges}` }
  }

  const nodeIds = new Set<string>()
  for (const raw of input.nodes) {
    if (!isRecord(raw)) return { ok: false, error: '节点必须是对象' }
    if (typeof raw.id !== 'string' || raw.id === '') {
      return { ok: false, error: '节点缺少 id' }
    }
    if (nodeIds.has(raw.id)) return { ok: false, error: `节点 id 重复：${raw.id}` }
    nodeIds.add(raw.id)

    if (typeof raw.type !== 'string' || raw.type === '') {
      return { ok: false, error: `节点 ${raw.id} 缺少 type` }
    }
    const position = raw.position
    if (!isRecord(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) {
      return { ok: false, error: `节点 ${raw.id} 的 position 必须是 { x, y }` }
    }
    if (!isRecord(raw.data)) return { ok: false, error: `节点 ${raw.id} 缺少 data` }
    if (typeof raw.data.label !== 'string') {
      return { ok: false, error: `节点 ${raw.id} 的 data.label 必须是字符串` }
    }
  }

  const edgeIds = new Set<string>()
  for (const raw of input.edges) {
    if (!isRecord(raw)) return { ok: false, error: '连线必须是对象' }
    if (typeof raw.id !== 'string' || raw.id === '') {
      return { ok: false, error: '连线缺少 id' }
    }
    if (edgeIds.has(raw.id)) return { ok: false, error: `连线 id 重复：${raw.id}` }
    edgeIds.add(raw.id)

    if (typeof raw.source !== 'string' || typeof raw.target !== 'string') {
      return { ok: false, error: `连线 ${raw.id} 缺少 source / target` }
    }
    if (!nodeIds.has(raw.source)) {
      return { ok: false, error: `连线 ${raw.id} 的 source 指向不存在的节点：${raw.source}` }
    }
    if (!nodeIds.has(raw.target)) {
      return { ok: false, error: `连线 ${raw.id} 的 target 指向不存在的节点：${raw.target}` }
    }
  }

  const graph = input as unknown as FlowGraph
  if (!isRecord(input.meta)) graph.meta = {}

  const size = Buffer.byteLength(JSON.stringify(graph), 'utf8')
  if (size > GRAPH_LIMITS.bytes) {
    return { ok: false, error: `graph 体积 ${size} 字节，超过上限 ${GRAPH_LIMITS.bytes}` }
  }

  return { ok: true, value: graph }
}

/** 反序列化库里的 graph 字段；坏数据不抛异常，退化成空图 */
export function readGraph(serialized: string): FlowGraph {
  try {
    const parsed: unknown = JSON.parse(serialized)
    const result = parseGraph(parsed)
    return result.ok ? result.value : emptyGraph()
  } catch {
    return emptyGraph()
  }
}

/** 校验视口。zoom 必须是正数：0 或负数在渲染层是没有意义的 */
export function parseViewport(input: unknown): ParseResult<FlowViewport> {
  if (
    !isRecord(input) ||
    !isFiniteNumber(input.x) ||
    !isFiniteNumber(input.y) ||
    !isFiniteNumber(input.zoom)
  ) {
    return { ok: false, error: 'viewport 必须是 { x, y, zoom } 三个有限数字' }
  }
  if (input.zoom <= 0) return { ok: false, error: 'viewport.zoom 必须大于 0' }
  return { ok: true, value: { x: input.x, y: input.y, zoom: input.zoom } }
}

// —— 按用户存的画布状态 ——

/**
 * 「每人自己一份」的状态分区表。**这是唯一的扩展点**：
 * 以后还想按用户存别的（面板宽度、折叠了哪些节点、个人主题…），
 * 就在这里加一行 `键名: 校验函数`，再在 src/types/flow.ts 补上对应类型 —— 表结构不用动。
 *
 * 不认识的 key 一律拒收：这张表不是任意 KV，收进来的东西必须有人负责校验。
 */
export const FLOW_USER_STATE_PARSERS: Record<string, (input: unknown) => ParseResult<unknown>> = {
  viewport: parseViewport,
}

export type FlowUserStateKey = keyof typeof FLOW_USER_STATE_PARSERS
export type FlowUserState = Record<string, unknown>

/** 单个分区序列化后的字节上限：这里存的是「我怎么看」，不是内容，不该长 */
export const USER_STATE_VALUE_BYTES = 16 * 1024

/**
 * 校验一次按用户存的状态更新（PATCH 语义：只带要改的分区）。
 * 每个分区各自校验，任一分区不合法就整体拒绝 —— 不做「对一半存一半」。
 */
export function parseUserStatePatch(input: unknown): ParseResult<FlowUserState> {
  if (!isRecord(input)) return { ok: false, error: '请求体必须是对象' }

  const keys = Object.keys(input)
  if (keys.length === 0) return { ok: false, error: '至少要带一个状态分区' }

  const value: FlowUserState = {}
  for (const key of keys) {
    const parse = FLOW_USER_STATE_PARSERS[key]
    if (!parse) return { ok: false, error: `未知的状态分区：${key}` }

    const parsed = parse(input[key])
    if (!parsed.ok) return { ok: false, error: `${key}：${parsed.error}` }

    const size = Buffer.byteLength(JSON.stringify(parsed.value), 'utf8')
    if (size > USER_STATE_VALUE_BYTES) {
      return { ok: false, error: `${key}：${size} 字节，超过上限 ${USER_STATE_VALUE_BYTES}` }
    }

    value[key] = parsed.value
  }

  return { ok: true, value }
}

/** 校验一批待提交的事务 */
export function parseTransactions(input: unknown): ParseResult<FlowTransaction[]> {
  if (!Array.isArray(input)) return { ok: false, error: 'transactions 必须是数组' }
  if (input.length === 0) return { ok: false, error: 'transactions 不能为空' }
  if (input.length > GRAPH_LIMITS.transactions) {
    return { ok: false, error: `单次提交的事务数超过上限 ${GRAPH_LIMITS.transactions}` }
  }

  const seen = new Set<string>()
  const value: FlowTransaction[] = []

  for (const raw of input) {
    if (!isRecord(raw)) return { ok: false, error: '事务必须是对象' }
    if (typeof raw.id !== 'string' || raw.id === '') {
      return { ok: false, error: '事务缺少 id' }
    }
    if (seen.has(raw.id)) return { ok: false, error: `同一批里事务 id 重复：${raw.id}` }
    seen.add(raw.id)

    if (typeof raw.label !== 'string' || raw.label === '') {
      return { ok: false, error: `事务 ${raw.id} 缺少 label` }
    }
    const kind = raw.kind ?? 'do'
    if (kind !== 'do' && kind !== 'undo' && kind !== 'redo') {
      return { ok: false, error: `事务 ${raw.id} 的 kind 只能是 do / undo / redo` }
    }
    if (!Array.isArray(raw.ops) || raw.ops.length === 0) {
      return { ok: false, error: `事务 ${raw.id} 的 ops 不能为空` }
    }
    // 客户端不带 ts（老版本）就按收到的时刻补一个，别让日志出现没有时间的行
    const ts = raw.ts === undefined ? Date.now() : raw.ts
    if (!isTimestamp(ts)) {
      return { ok: false, error: `事务 ${raw.id} 的 ts 必须是 UTC epoch 毫秒时间戳` }
    }

    const ops: FlowOp[] = []
    for (const op of raw.ops) {
      if (!isRecord(op)) return { ok: false, error: `事务 ${raw.id} 的 op 必须是对象` }
      if (typeof op.type !== 'string' || !OP_TYPES.includes(op.type)) {
        return { ok: false, error: `未知的操作类型：${String(op.type)}` }
      }
      if (typeof op.targetId !== 'string' || op.targetId === '') {
        return { ok: false, error: `事务 ${raw.id} 的 op 缺少 targetId` }
      }
      ops.push({
        type: op.type as FlowOpType,
        targetId: op.targetId,
        before: op.before ?? null,
        after: op.after ?? null,
      })
    }

    value.push({ id: raw.id, label: raw.label, kind, ts, ops })
  }

  return { ok: true, value }
}
