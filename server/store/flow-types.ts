/**
 * 画布内容的数据结构与校验。
 *
 * 约定（见 docs/13-flow-canvas-management.md）：Vue Flow 认识的字段留在节点顶层，
 * 业务自定义的一切都塞进 `data` —— 换渲染层时业务数据不受影响。
 *
 * 服务端只做**结构校验**，不解释 `data` 上那些业务字段，原样透传存储。
 * 前端侧的同名类型在 `src/types/flow.ts`，改这里记得同步。
 */

/**
 * 当前的图结构版本。
 *
 * - v1：业务种类在 `data.kind`，业务字段裹在 `data.config` 里，`ports` 必填空壳；
 * - v2：业务种类**并入顶层 `type`**，业务字段直接平铺在 `data` 上，每个节点带 `status`。
 *
 * **v1 会被就地升级，不是拒收**（见 `upgradeNodeData` / `upgradeEdgeData`）。
 * 这一点是硬要求，不是客气：`Flow.graph` 里存量的全是 v1，而
 * `server/collab/persistence.ts` 的 `loadFlowState()` 靠 `readGraph()` 把老画布
 * 灌进 Yjs 文档 —— 那里读不出内容就返回 null，等于**第一次打开老画布就把它清空**。
 * 比这更高的版本仍然拒收：不猜未来的结构。
 */
export const GRAPH_SCHEMA_VERSION = 2

/** 还认得的最低版本 */
const GRAPH_SCHEMA_MIN_VERSION = 1

/**
 * **节点数 / 连线数不设上限，这是有意去掉的，不是漏了。**
 *
 * 那两个数（曾经是 2000 / 4000）是**产品判断**，不是安全护栏：资源那一面已经由字节数
 * 一条管住（几千个节点也到不了字节上限），而用户先撞上的是 Vue Flow 在几百个节点时的
 * 渲染卡顿，不是这两个数。用一条「超限就静默拒写」去执行「画布不该这么大」这个判断，
 * 代价远大于收益 —— 尤其是它拒的方式是**事后**锁写，而删除也是写，人反而没了自救的路。
 *
 * 所以规模只剩字节数一条线，而且分成两条互不派生的：
 *
 * - **{@link GRAPH_LIMITS}.bytes** —— 派生投影（`graph` 这段 JSON）的上限，也就是下面这个数。
 * - **`COLLAB_LIMITS.document`** —— 画布内容（Yjs 二进制）的上限，比它**大一个量级**。
 *
 * 两者曾经是同一个数，现在**故意不是**：投影会原样出现在 `GET /api/flows/:id` 的响应里
 * （编辑器只用它带的元信息，从不读 graph），而内容只在 WebSocket 上走 —— 让内容的天花板
 * 顺带把每次打开画布要下载的 JSON 抬到几十 MB，是白付的成本。
 *
 * 方向不能反：内容的上限必须 **≥** 投影的上限。两者之间那段（内容合法、投影超限）是
 * 已经处理好的降级 —— `deriveProjection` 跳过本次投影写入、留上一份，列表页的计数会旧，
 * 内容一个字节不受影响（复制画布复制的是 `ydoc`，不是投影）。
 */
export const GRAPH_LIMITS = {
  /**
   * 序列化后的 graph **投影**字节上限。
   *
   * 超过它的投影不写（`deriveProjection` 返回 null）：写了在读的那头也会被
   * `parseGraph` 判超限、降级成空图，反而把「detail 空图、复制出空画布」埋进去。
   */
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

/** 连接点贴在节点的哪一边（Vue Flow 的 Position，服务端不依赖 vue-flow，自己写一份） */
export type FlowHandlePosition = 'left' | 'right' | 'top' | 'bottom'

/** 节点的运行态 */
export type FlowNodeStatus = 'idle' | 'processing' | 'completed' | 'error'

/**
 * 节点的业务数据。
 *
 * **框架字段之外，业务字段直接平铺在这一层**（v1 那个 `config` 包装没有了）——
 * Y.Map 的合并粒度是 key，整块 `config` 会让「两人改不同字段」退化成互相覆盖。
 * 服务端一如既往**不解释**这些字段，只做结构校验后原样透传。
 */
export interface FlowNodeData {
  label: string
  status: FlowNodeStatus
  /** 创建时刻，UTC epoch 毫秒。老数据没有这个字段，所以可选 */
  createdAt?: number
  description?: string
  icon?: string
  ports?: { inputs: FlowPort[]; outputs: FlowPort[] }
  /** 需要持久化的 UI 状态（折叠、颜色…） */
  ui?: Record<string, unknown>
  /** 业务字段平铺在这里 */
  [key: string]: unknown
}

/** `data` 上属于框架的键；升级 v1 数据时用它区分框架字段与平铺的业务字段 */
export const NODE_DATA_RESERVED_KEYS = [
  'label',
  'status',
  'createdAt',
  'description',
  'icon',
  'ports',
  'ui',
] as const

/** **`type` 就是业务种类**（v1 那个和它恒等的 `data.kind` 已并入） */
export interface FlowNode {
  id: string
  type: string
  position: { x: number; y: number }
  width?: number
  height?: number
  zIndex?: number
  /** 分组 / 子流程 */
  parentNode?: string
  extent?: 'parent' | null
  sourcePosition?: FlowHandlePosition
  targetPosition?: FlowHandlePosition
  data: FlowNodeData
}

/** 连线的业务数据，和节点一样平铺 */
export interface FlowEdgeData {
  /** 连线建立的时刻，UTC epoch 毫秒 */
  createdAt?: number
  [key: string]: unknown
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
  data: FlowEdgeData
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

// —— v1 → v2 的就地升级 ——

/**
 * 把 v1 的节点 `data` 升级成 v2：`config` 拆平、`kind` 丢掉、补上 `status`。
 *
 * `kind` 直接丢：v1 里它和顶层 `type` 恒等（两者都只可能是 `'process'`），
 * 留着就是两个字段说同一件事。
 *
 * **框架字段压在业务字段之上**：`config` 里万一有个叫 `label` 的键，
 * 它是业务数据，不该顶掉节点真正的标题。
 *
 * 前端有一份等价实现（`src/lib/flow-doc.ts` 的 `upgradeNodeData`）—— 改一处改两处。
 */
export function upgradeNodeData(raw: Record<string, unknown>): FlowNodeData {
  const config = isRecord(raw.config) ? raw.config : {}

  // 先铺 v1 的 config，再铺 raw 上其余的键 —— 后者包括已经平铺着的未知字段，
  // 升级不该顺手把它们丢了
  const data: FlowNodeData = { ...config, label: '', status: 'idle' }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'kind' || key === 'config' || key === 'ports') continue
    if (value !== undefined) data[key] = value
  }

  // 框架字段最后规范化一遍，压在业务字段之上
  data.label = typeof raw.label === 'string' ? raw.label : ''
  data.status = isNodeStatus(raw.status) ? raw.status : 'idle'
  if (!isTimestamp(data.createdAt)) delete data.createdAt
  if (typeof data.description !== 'string') delete data.description
  if (typeof data.icon !== 'string') delete data.icon
  if (!isRecord(data.ui)) delete data.ui

  // 空壳端口不留：v1 给每个节点都塞了 `{inputs:[],outputs:[]}`，那是噪声不是信息
  const ports = raw.ports
  if (isRecord(ports) && (asArray(ports.inputs).length > 0 || asArray(ports.outputs).length > 0)) {
    data.ports = ports as FlowNodeData['ports']
  }

  return data
}

/**
 * 把 v1 的连线 `data`（`{kind?, condition?, config}`）升级成 v2 的平铺形状。
 *
 * `kind` / `condition` 和节点的 `kind` 不一样，它们是**边自己的**业务语义、
 * 没有别的字段与之重复，所以保留下来平铺，不丢。
 */
export function upgradeEdgeData(raw: Record<string, unknown>): FlowEdgeData {
  const config = isRecord(raw.config) ? raw.config : {}
  const data: FlowEdgeData = { ...config }

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'config') continue
    if (value !== undefined) data[key] = value
  }

  return data
}

function isNodeStatus(value: unknown): value is FlowNodeStatus {
  return value === 'idle' || value === 'processing' || value === 'completed' || value === 'error'
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 校验客户端提交上来的 graph。
 *
 * 只认结构不认内容：节点 id 不能重、边不能指向不存在的节点，
 * 其余（尤其是平铺在 `data` 上的业务字段）原样收下。
 *
 * **v1 的数据会被就地升级成 v2**（见 `GRAPH_SCHEMA_VERSION` 的注释），
 * 因此返回的 graph 一定是 v2。
 */
export function parseGraph(input: unknown): ParseResult<FlowGraph> {
  if (!isRecord(input)) return { ok: false, error: 'graph 必须是对象' }

  const version = input.schemaVersion
  if (
    typeof version !== 'number' ||
    version < GRAPH_SCHEMA_MIN_VERSION ||
    version > GRAPH_SCHEMA_VERSION
  ) {
    return { ok: false, error: `不支持的 graph.schemaVersion：${String(version)}` }
  }
  const needsUpgrade = version < GRAPH_SCHEMA_VERSION

  const viewport = parseViewport(input.viewport)
  if (!viewport.ok) return { ok: false, error: `graph.${viewport.error}` }

  if (!Array.isArray(input.nodes)) return { ok: false, error: 'graph.nodes 必须是数组' }
  if (!Array.isArray(input.edges)) return { ok: false, error: 'graph.edges 必须是数组' }

  // 条数不判 —— 规模只看下面那道字节关（见 `GRAPH_LIMITS` 的注释）

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

    if (needsUpgrade) {
      raw.data = upgradeNodeData(raw.data)
    } else if (!isNodeStatus(raw.data.status)) {
      // v2 而没带 status：补上就是了。这是字段缺省，不是结构错误，
      // 不值得为它把整张画布判死
      raw.data.status = 'idle'
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

    if (needsUpgrade) raw.data = upgradeEdgeData(isRecord(raw.data) ? raw.data : {})
  }

  const graph = input as unknown as FlowGraph
  if (!isRecord(input.meta)) graph.meta = {}
  // 升级过的图从这里开始就是 v2 了 —— 写回版本号，否则下次读又要再升一遍
  graph.schemaVersion = GRAPH_SCHEMA_VERSION

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
