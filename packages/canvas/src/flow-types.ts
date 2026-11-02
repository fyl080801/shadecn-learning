import {
  emptyGraph,
  GRAPH_SCHEMA_VERSION,
  type FlowGraph,
  type FlowNodeRecord,
  type FlowUserState,
  type FlowViewport,
  nodeRecordFromParts,
} from '@learning/contracts/flow-graph'

/**
 * 画布内容的服务端校验。结构本身（节点 / 连线 / 视口的类型、版本号、节点五组的规范化）在 `@learning/contracts/flow-graph`，
 * 这里只放只有服务端才做的事：校验库里来的 JSON、限额、按用户存的状态分区表。
 *
 * 服务端只做**结构校验**，不解释 `data` 上那些业务字段，原样透传存储。
 * 只认当前版本：这个服务没有老数据（docs/30 §1），别的版本读出来退化成空图。
 */

export const GRAPH_LIMITS = {
  /**
   * 序列化后的 graph **投影**字节上限。规模只看字节，不限节点数和连线数。
   * 超过它的投影不写（`FlowDocStore`）：写了在读的那头也会被 `parseGraph` 判超限、降级成空图，
   * 反而把「详情空图、复制出空画布」埋进去。
   */
  bytes: 2 * 1024 * 1024,
} as const

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 校验一份 graph。只认结构不认内容：节点 id 不能重、边不能指向不存在的节点，其余（尤其是平铺在 `data` 上的业务字段）原样收下。
 * 节点按 v3 的五组规范化（`nodeRecordFromParts`）；`inputs` 是派生值，收到了也不存。
 */
export function parseGraph(input: unknown): ParseResult<FlowGraph> {
  if (!isRecord(input)) return { ok: false, error: 'graph 必须是对象' }

  const version = input.schemaVersion
  if (version !== GRAPH_SCHEMA_VERSION) {
    return { ok: false, error: `不支持的 graph.schemaVersion：${String(version)}` }
  }

  const viewport = parseViewport(input.viewport)
  if (!viewport.ok) return { ok: false, error: `graph.${viewport.error}` }

  if (!Array.isArray(input.nodes)) return { ok: false, error: 'graph.nodes 必须是数组' }
  if (!Array.isArray(input.edges)) return { ok: false, error: 'graph.edges 必须是数组' }

  const nodeIds = new Set<string>()
  const nodes: FlowNodeRecord[] = []
  for (const raw of input.nodes) {
    if (!isRecord(raw)) return { ok: false, error: '节点必须是对象' }
    if (typeof raw.id !== 'string' || raw.id === '') return { ok: false, error: '节点缺少 id' }
    if (nodeIds.has(raw.id)) return { ok: false, error: `节点 id 重复：${raw.id}` }
    nodeIds.add(raw.id)

    if (typeof raw.type !== 'string' || raw.type === '') return { ok: false, error: `节点 ${raw.id} 缺少 type` }
    const layout = raw.layout
    if (!isRecord(layout) || !isRecord(layout.position) || !isFiniteNumber(layout.position.x) || !isFiniteNumber(layout.position.y)) {
      return { ok: false, error: `节点 ${raw.id} 的 layout.position 必须是 { x, y }` }
    }
    if (raw.data !== undefined && !isRecord(raw.data)) return { ok: false, error: `节点 ${raw.id} 的 data 必须是对象` }

    const node = nodeRecordFromParts(raw.id, {
      type: raw.type,
      layout,
      metadata: raw.metadata,
      data: raw.data,
      runtime: raw.runtime,
    })
    // position 上面已经校验过，这里不会是 null；类型上兜一下
    if (!node) return { ok: false, error: `节点 ${raw.id} 的 layout 不合法` }
    nodes.push(node)
  }

  const edgeIds = new Set<string>()
  for (const raw of input.edges) {
    if (!isRecord(raw)) return { ok: false, error: '连线必须是对象' }
    if (typeof raw.id !== 'string' || raw.id === '') return { ok: false, error: '连线缺少 id' }
    if (edgeIds.has(raw.id)) return { ok: false, error: `连线 id 重复：${raw.id}` }
    edgeIds.add(raw.id)

    if (typeof raw.source !== 'string' || typeof raw.target !== 'string') {
      return { ok: false, error: `连线 ${raw.id} 缺少 source / target` }
    }
    if (!nodeIds.has(raw.source)) return { ok: false, error: `连线 ${raw.id} 的 source 指向不存在的节点：${raw.source}` }
    if (!nodeIds.has(raw.target)) return { ok: false, error: `连线 ${raw.id} 的 target 指向不存在的节点：${raw.target}` }
    if (!isRecord(raw.data)) raw.data = {}
  }

  const graph = input as unknown as FlowGraph
  graph.nodes = nodes
  if (!isRecord(input.meta)) graph.meta = {}

  const size = Buffer.byteLength(JSON.stringify(graph), 'utf8')
  if (size > GRAPH_LIMITS.bytes) return { ok: false, error: `graph 体积 ${size} 字节，超过上限 ${GRAPH_LIMITS.bytes}` }

  return { ok: true, value: graph }
}

/** 反序列化库里的 graph 字段；坏数据不抛异常，退化成空图 */
export function readGraph(serialized: string): FlowGraph {
  try {
    const result = parseGraph(JSON.parse(serialized))
    return result.ok ? result.value : emptyGraph()
  } catch {
    return emptyGraph()
  }
}

/** 校验视口。zoom 必须是正数：0 或负数在渲染层是没有意义的 */
export function parseViewport(input: unknown): ParseResult<FlowViewport> {
  if (!isRecord(input) || !isFiniteNumber(input.x) || !isFiniteNumber(input.y) || !isFiniteNumber(input.zoom)) {
    return { ok: false, error: 'viewport 必须是 { x, y, zoom } 三个有限数字' }
  }
  if (input.zoom <= 0) return { ok: false, error: 'viewport.zoom 必须大于 0' }
  return { ok: true, value: { x: input.x, y: input.y, zoom: input.zoom } }
}

/**
 * 「每人自己一份」的状态分区表。**这是唯一的扩展点**：在 `FlowUserState` 上加一个可选字段，再在这里加一行 `键名: 校验函数`，表结构不用动。
 * 类型是按 `FlowUserState` 的键做的映射：那边加了字段、这里没加校验，**编译不过**。
 * 不认识的 key 一律拒收：这张表不是任意 KV。
 */
export const FLOW_USER_STATE_PARSERS: {
  readonly [K in keyof FlowUserState]-?: (input: unknown) => ParseResult<NonNullable<FlowUserState[K]>>
} = {
  viewport: parseViewport,
}

function userStateParserOf(key: string): ((input: unknown) => ParseResult<unknown>) | undefined {
  return Object.hasOwn(FLOW_USER_STATE_PARSERS, key)
    ? (FLOW_USER_STATE_PARSERS as Record<string, (input: unknown) => ParseResult<unknown>>)[key]
    : undefined
}

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

  const value: Record<string, unknown> = {}
  for (const key of keys) {
    const parse = userStateParserOf(key)
    if (!parse) return { ok: false, error: `未知的状态分区：${key}` }

    const parsed = parse(input[key])
    if (!parsed.ok) return { ok: false, error: `${key}：${parsed.error}` }

    const size = Buffer.byteLength(JSON.stringify(parsed.value), 'utf8')
    if (size > USER_STATE_VALUE_BYTES) return { ok: false, error: `${key}：${size} 字节，超过上限 ${USER_STATE_VALUE_BYTES}` }

    value[key] = parsed.value
  }

  return { ok: true, value: value as FlowUserState }
}
