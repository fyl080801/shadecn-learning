/**
 * 画布内容的数据结构 —— 前后端共用的这一份（REQ-CANVAS，见 docs/13-flow-canvas-management.md）。
 *
 * 一个节点分五组，外加一组只读派生的 `inputs`：
 *
 * | 组         | 放什么                                         | 谁写                         |
 * | ---------- | ---------------------------------------------- | ---------------------------- |
 * | `type`     | 节点类型注册表的键，建好不改                   | 新建时                       |
 * | `layout`   | 位置、尺寸、层级、分组归属 —— Vue Flow 认识的   | 拖动 / 拉伸 / 打组           |
 * | `metadata` | 名字、说明、图标、创建时刻 / 创建者、UI 状态     | 改名、改说明                 |
 * | `data`     | **纯业务字段**，平铺，没有任何保留字           | 各节点类型自己的编辑入口     |
 * | `runtime`  | 运行态：状态、错误、任务 id、各输出端口的产出   | 执行器（将来）/ agent        |
 * | `inputs`   | 派生：连进来的边 + 上游对应端口的产出（不存）   | 没人写，投影时算出来         |
 *
 * 分组的理由是**谁在什么时候改它**：拖动只碰 layout，改名只碰 metadata，跑一次生成只碰
 * runtime —— 三者互不相干，混在一层里（v2 的 `data` 上同时住着 label / status / prompt）
 * 就只能靠一张「保留字清单」去区分哪些是框架的、哪些是业务的。
 *
 * 服务端只做**结构校验**（`apps/server/store/flow-types.ts` 的 `parseGraph`），
 * 不解释 `data` 上那些业务字段，原样透传存储。
 *
 * 这里只放纯类型、常量和纯函数：没有 DOM、没有 Node，也不 import 任何东西 ——
 * 前端的叶子模块（`components/flow/node-constants.ts`）也会引它，不能把环带进去。
 */

/**
 * 当前的图结构版本。
 *
 * - v1：业务种类在 `data.kind`，业务字段裹在 `data.config` 里；
 * - v2：业务字段平铺在 `data` 上，框架字段（label / status / createdAt…）也混在里面；
 * - v3：节点分 `type` / `layout` / `metadata` / `data` / `runtime` 五组（见文件头）。
 *
 * **v1 / v2 不做迁移、不就地升级**（产品决定）：老文档照常能读，读不出来的字段退化成
 * 缺省值（老节点的名字读出来是空串、老的 label / status 留在 `data` 上当普通业务字段），
 * 但**读的时候绝不抛错**，形状不对的节点整条跳过。
 */
export const GRAPH_SCHEMA_VERSION = 3

/**
 * 认不出 `type` 的节点按哪种渲染 —— 也是 Y.Doc 里 `type` 缺失时 `fromYNode` 读出来的值。
 *
 * 两处必须是同一个值（老画布里的节点写的就是 `process`，换成别的会让既有内容换一副样子），
 * 所以只在这里声明一次：`fromYNode` 用它，前端的 `FALLBACK_NODE_TYPE`
 * （`components/flow/node-constants.ts`）也是从这里转出去的。
 */
export const FALLBACK_NODE_TYPE = 'process'

/** 连接点贴在节点的哪一边（Vue Flow 的 Position；服务端不依赖 vue-flow，所以自己写一份） */
export type FlowHandlePosition = 'left' | 'right' | 'top' | 'bottom'

/**
 * 节点的运行态。
 *
 * 画布不只是画出来的图，节点将来要真的跑起来（生成、上传、转换），
 * 所以「这个节点现在处于什么状态」是每个节点都有的字段，而不是某一类节点的私有配置。
 */
export type FlowNodeStatus = 'idle' | 'processing' | 'completed' | 'error'

/**
 * 布局 —— Vue Flow 认识的那些字段。
 *
 * 在 Y.Doc 里它们**留在节点顶层原位、不嵌套**（见 `flow-doc.ts`）：拖动是最热的写路径，
 * 多套一层 Y.Map 只会多一次查找；Vue Flow 本来也要平铺的形状。
 */
export interface FlowNodeLayout {
  position: { x: number; y: number }
  width?: number
  height?: number
  zIndex?: number
  /** 分组 / 子流程 */
  parentNode?: string
  extent?: 'parent' | null
  sourcePosition?: FlowHandlePosition
  targetPosition?: FlowHandlePosition
}

/** 节点的描述性信息：叫什么、什么时候谁建的 */
export interface FlowNodeMetadata {
  /** 节点名。老数据（v1 / v2）没有 metadata，读出来是空串 */
  label: string
  description?: string
  icon?: string
  /** 创建时刻，UTC epoch 毫秒 */
  createdAt?: number
  /** 创建者的用户 id */
  createdBy?: string
  /** 需要持久化的 UI 状态（折叠、颜色…） */
  ui?: Record<string, unknown>
}

/**
 * 运行态。
 *
 * `outputs` 按**输出端口 id** 分键：在 Y.Doc 里摊成 `outputs.<portId>` 一串平级的键
 * （`flow-doc.ts`），一个端口的产出更新不会盖掉另一个端口的。
 */
export interface FlowNodeRuntime {
  status: FlowNodeStatus
  error?: string
  taskId?: string
  outputs?: Record<string, unknown>
}

/**
 * 一条连进来的输入 —— **派生值，不存**。
 *
 * 连线是唯一的事实源：`port` 是边上的 `data.targetPort`、`sourcePort` 是 `data.sourcePort`，
 * `index` 是 `data.index`（同一个多输入端口里的序号），`value` 是上游节点
 * `runtime.outputs[sourcePort]`。端口**不是** Vue Flow 的 handle id —— 每个节点最多左右各一个
 * 不带 id 的连接点，端口只存在边的 data 上（见 {@link FlowEdgeData}）。
 */
export interface FlowNodeInput {
  /** 连到本节点的哪个输入端口；没声明端口的节点是 null */
  port: string | null
  /** 同一端口内的序号，来自 `edge.data.index`；老边没有就是 0 */
  index: number
  edgeId: string
  source: string
  /** 上游的哪个输出端口；没声明端口的上游是 null */
  sourcePort: string | null
  /** 上游对应输出端口当前的产出；还没有就不出现 */
  value?: unknown
}

/**
 * 节点**存下来的那部分** —— Y.Doc 里有的、`Flow.graph` 投影里存的就是这个形状。
 *
 * `type` 是业务种类，也是前端节点类型注册表（`apps/web/src/components/flow/node-types.ts`）的键，
 * 决定用哪个组件渲染、新建时给什么默认值、有哪些端口。
 */
export interface FlowNodeRecord {
  id: string
  type: string
  layout: FlowNodeLayout
  metadata: FlowNodeMetadata
  /**
   * 纯业务字段，平铺。**没有保留字** —— 框架字段都搬去了 metadata / runtime。
   *
   * 平铺的理由没变：Y.Map 的合并粒度是 key，甲改 prompt、乙同时改 model 要各自保留。
   */
  data: Record<string, unknown>
  runtime: FlowNodeRuntime
}

/** 编辑器和 agent 读到的节点：存下来的部分 + 派生的 inputs */
export interface FlowNode extends FlowNodeRecord {
  inputs: FlowNodeInput[]
}

/**
 * 连线的业务数据，和节点一样平铺。
 *
 * **端口存在这里，不存在 handle 上**：画布上每个节点最多左边一个、右边一个连接点（都不带 id），
 * 连上的是哪对端口由连线时自动选定（`resolveConnection`）后写进 `sourcePort` / `targetPort`。
 * 两端都没声明端口的连线不写这三个字段。
 */
export interface FlowEdgeData {
  /** 连线建立的时刻，UTC epoch 毫秒 */
  createdAt?: number
  /** 起点的输出端口 id；起点类型没声明端口时不写 */
  sourcePort?: string
  /** 终点的输入端口 id；终点类型没声明端口时不写 */
  targetPort?: string
  /**
   * 在目标端口里的序号（从 1 起），有 `targetPort` 才有。连线时取该端口现有最大值 + 1，
   * **删线不重排** —— prompt 里写的「图片2」指的就是 index 为 2 的那条，删掉 1 号之后它也不能变成 1。
   */
  index?: number
  [key: string]: unknown
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  /** Vue Flow 的 handle id —— 节点的连接点不带 id，所以一律为 null（端口见 `data`） */
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
   * 画布级的兜底视口。真正生效的是**每人自己的**视口（见 {@link FlowUserState}），
   * 这里这份只在某人第一次打开、还没有自己的记录时用。
   */
  viewport: FlowViewport
  /** 只存节点自己的部分；`inputs` 是派生的，不进投影 */
  nodes: FlowNodeRecord[]
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

// —— 按用户存的画布状态 ——

/**
 * 「每人自己一份」的状态：视口是第一个分区，以后还会有别的
 * （面板宽度、折叠了哪些节点…）。字段一律可选：老数据里没有它。
 *
 * **扩展点**：加一个分区 = 这里加一个可选字段 + 服务端
 * `apps/server/store/flow-types.ts` 的 `FLOW_USER_STATE_PARSERS` 加一条校验。
 * 后者按这个接口的键做了映射类型，**漏加校验会编译失败**；表结构和接口都不用动。
 */
export interface FlowUserState {
  viewport?: FlowViewport
}

// —— 新建 ——

/** 新建节点时的 metadata：名字 + 创建时刻（+ 创建者，知道的话） */
export function defaultNodeMetadata(label: string, createdBy?: string): FlowNodeMetadata {
  return {
    label,
    createdAt: Date.now(),
    ...(createdBy ? { createdBy } : {}),
  }
}

/** 新建节点时的运行态：空闲，没有产出 */
export function defaultNodeRuntime(): FlowNodeRuntime {
  return { status: 'idle' }
}

/** 新建连线时的默认 data（不含端口）；带端口的见 `flow-node-types.ts` 的 `connectionEdgeData` */
export function defaultEdgeData(): FlowEdgeData {
  return { createdAt: Date.now() }
}

// —— 判定 ——

/** 时间戳字段的统一判定：UTC epoch 毫秒，正整数 */
export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isNodeStatus(value: unknown): value is FlowNodeStatus {
  return value === 'idle' || value === 'processing' || value === 'completed' || value === 'error'
}

export function isHandlePosition(value: unknown): value is FlowHandlePosition {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// —— 规范化：把来路不明的各组拼成一个节点 ——

/** 运行态里「某输出端口的产出」在扁平形状下的键前缀（`outputs.<portId>`） */
export const OUTPUT_KEY_PREFIX = 'outputs.'

/**
 * 节点五组的原始材料，来自 Y.Doc（`fromYNode`）或 JSON（`parseGraph`）。
 * 每一组都可能缺、可能形状不对 —— 数据可能来自老客户端、老版本，或者干脆是坏的。
 */
export interface FlowNodeParts {
  type: unknown
  /** 布局字段所在的对象（Y.Doc 里就是节点顶层） */
  layout: Record<string, unknown>
  metadata: unknown
  data: unknown
  runtime: unknown
}

function normalizeLayout(source: Record<string, unknown>): FlowNodeLayout | null {
  const position = source.position
  if (!isRecord(position) || typeof position.x !== 'number' || typeof position.y !== 'number') {
    return null
  }
  const { width, height, zIndex, parentNode, extent, sourcePosition, targetPosition } = source
  return {
    position: { x: position.x, y: position.y },
    ...(typeof width === 'number' ? { width } : {}),
    ...(typeof height === 'number' ? { height } : {}),
    ...(typeof zIndex === 'number' ? { zIndex } : {}),
    ...(typeof parentNode === 'string' ? { parentNode } : {}),
    ...(extent === 'parent' || extent === null ? { extent } : {}),
    ...(isHandlePosition(sourcePosition) ? { sourcePosition } : {}),
    ...(isHandlePosition(targetPosition) ? { targetPosition } : {}),
  }
}

function normalizeMetadata(raw: unknown): FlowNodeMetadata {
  const source = isRecord(raw) ? raw : {}
  const { label, description, icon, createdAt, createdBy, ui } = source
  return {
    label: typeof label === 'string' ? label : '',
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof icon === 'string' ? { icon } : {}),
    ...(isTimestamp(createdAt) ? { createdAt } : {}),
    ...(typeof createdBy === 'string' ? { createdBy } : {}),
    ...(isRecord(ui) ? { ui } : {}),
  }
}

/**
 * 运行态两种来路都认：Y.Doc 里产出是扁平的 `outputs.<portId>` 键，
 * JSON 投影里是一个 `outputs` 对象。两种同时出现时扁平键优先（它是事实源的形状）。
 */
function normalizeRuntime(raw: unknown): FlowNodeRuntime {
  const source = isRecord(raw) ? raw : {}
  const runtime: FlowNodeRuntime = { status: isNodeStatus(source.status) ? source.status : 'idle' }
  if (typeof source.error === 'string') runtime.error = source.error
  if (typeof source.taskId === 'string') runtime.taskId = source.taskId

  const outputs: Record<string, unknown> = isRecord(source.outputs) ? { ...source.outputs } : {}
  for (const [key, value] of Object.entries(source)) {
    if (key.length > OUTPUT_KEY_PREFIX.length && key.startsWith(OUTPUT_KEY_PREFIX)) {
      outputs[key.slice(OUTPUT_KEY_PREFIX.length)] = value
    }
  }
  for (const key of Object.keys(outputs)) {
    if (outputs[key] === undefined) delete outputs[key]
  }
  if (Object.keys(outputs).length > 0) runtime.outputs = outputs
  return runtime
}

/**
 * 把节点五组的原始材料拼成一个 {@link FlowNodeRecord}；布局不对（没有合法的 position）返回 null。
 *
 * **只兜底、不升级、不抛错**：缺的组给缺省值，类型不对的字段丢掉。老数据（v1 / v2）
 * 走的也是这条路 —— 它们没有 metadata / runtime，读出来名字为空、状态为 idle，
 * 原来混在 data 上的 label / status 留在 data 里当普通字段（产品决定不做迁移）。
 */
export function nodeRecordFromParts(id: string, parts: FlowNodeParts): FlowNodeRecord | null {
  const layout = normalizeLayout(parts.layout)
  if (!layout) return null
  const data: Record<string, unknown> = {}
  if (isRecord(parts.data)) {
    for (const [key, value] of Object.entries(parts.data)) {
      if (value !== undefined) data[key] = value
    }
  }
  return {
    id,
    type: typeof parts.type === 'string' && parts.type ? parts.type : FALLBACK_NODE_TYPE,
    layout,
    metadata: normalizeMetadata(parts.metadata),
    data,
    runtime: normalizeRuntime(parts.runtime),
  }
}

// —— 输入：从连线派生 ——

/** 边连的是起点的哪个输出端口；没写就是 null */
export function edgeSourcePort(edge: Pick<FlowEdge, 'data'>): string | null {
  const port = edge.data?.sourcePort
  return typeof port === 'string' && port ? port : null
}

/** 边连的是终点的哪个输入端口；没写就是 null */
export function edgeTargetPort(edge: Pick<FlowEdge, 'data'>): string | null {
  const port = edge.data?.targetPort
  return typeof port === 'string' && port ? port : null
}

/** 一条边在目标端口里的序号；老边没有 `data.index` 就是 0 */
export function inputIndexOf(edge: Pick<FlowEdge, 'data'>): number {
  const index = edge.data?.index
  return typeof index === 'number' && Number.isFinite(index) ? index : 0
}

/**
 * 新连一条线到 `(target, targetPort)` 时该给的序号：该端口现有最大序号 + 1（从 1 起）。
 *
 * **删线不重排**：序号是 prompt 里「图片2」这类引用的锚点，删掉别的线不能让它漂移。
 * 两个人同时往同一个端口连线可能拿到同一个序号 —— 排序时按边 id 兜底，结果仍然确定。
 */
export function nextInputIndex(
  edges: Iterable<Pick<FlowEdge, 'target' | 'data'>>,
  target: string,
  targetPort: string | null | undefined,
): number {
  const port = targetPort ?? null
  let max = 0
  for (const edge of edges) {
    if (edge.target !== target || edgeTargetPort(edge) !== port) continue
    max = Math.max(max, inputIndexOf(edge))
  }
  return max + 1
}

function comparePort(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a < b ? -1 : 1
}

/**
 * 从「连进这个节点的边」派生它的 `inputs`：按 (端口, 序号) 排序，序号相同再按边 id，
 * `value` 取上游 `runtime.outputs[data.sourcePort]`。
 *
 * @param incoming 所有 `target` 是这个节点的边（顺序无所谓，这里会排）
 * @param recordOf 按 id 取上游节点；取不到（悬空边）的那条照样列出，只是没有 value
 */
export function deriveInputs(
  incoming: readonly FlowEdge[],
  recordOf: (id: string) => Pick<FlowNodeRecord, 'runtime'> | undefined,
): FlowNodeInput[] {
  const inputs = incoming.map<FlowNodeInput>((edge) => {
    const sourcePort = edgeSourcePort(edge)
    const input: FlowNodeInput = {
      port: edgeTargetPort(edge),
      index: inputIndexOf(edge),
      edgeId: edge.id,
      source: edge.source,
      sourcePort,
    }
    if (sourcePort !== null) {
      const value = recordOf(edge.source)?.runtime.outputs?.[sourcePort]
      if (value !== undefined) input.value = value
    }
    return input
  })
  return inputs.sort(
    (a, b) =>
      comparePort(a.port, b.port) ||
      a.index - b.index ||
      (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0),
  )
}

/** 按目标节点把边分桶 —— 派生 inputs 的前置步骤 */
export function groupEdgesByTarget(edges: readonly FlowEdge[]): Map<string, FlowEdge[]> {
  const byTarget = new Map<string, FlowEdge[]>()
  for (const edge of edges) {
    const bucket = byTarget.get(edge.target)
    if (bucket) bucket.push(edge)
    else byTarget.set(edge.target, [edge])
  }
  return byTarget
}

/**
 * 一次性给一批节点派生 inputs（服务端、agent 用；编辑器的增量版本在前端的投影层）。
 */
export function withInputs(records: readonly FlowNodeRecord[], edges: readonly FlowEdge[]): FlowNode[] {
  const byId = new Map(records.map((record) => [record.id, record]))
  const byTarget = groupEdgesByTarget(edges)
  return records.map((record) => ({
    ...record,
    inputs: deriveInputs(byTarget.get(record.id) ?? [], (id) => byId.get(id)),
  }))
}
