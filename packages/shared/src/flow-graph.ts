/**
 * 画布内容的数据结构 —— 前后端共用的这一份（REQ-CANVAS，见 docs/13-flow-canvas-management.md）。
 *
 * 约定：Vue Flow 认识的字段留在节点顶层，业务自定义的一切都塞进 `data` ——
 * 换渲染层时业务数据不受影响。服务端只做**结构校验**（`apps/server/store/flow-types.ts`
 * 的 `parseGraph`），不解释 `data` 上那些业务字段，原样透传存储。
 *
 * 这里只放纯类型、常量和纯函数：没有 DOM、没有 Node，也不 import 任何东西 ——
 * 前端的叶子模块（`components/flow/node-constants.ts`）也会引它，不能把环带进去。
 */

/**
 * 当前的图结构版本。
 *
 * - v1：业务种类在 `data.kind`，业务字段裹在 `data.config` 里，`ports` 必填空壳；
 * - v2：业务种类**并入顶层 `type`**（节点类型注册表的键），业务字段直接平铺在 `data` 上，
 *   每个节点带 `status`。
 *
 * **v1 会被就地升级，不是拒收**（见 {@link upgradeNodeData} / {@link upgradeEdgeData}）：
 * 读 Y.Doc 时在 `fromYNode` 里升，读 `Flow.graph` 时在服务端的 `parseGraph` 里升。
 * 所以没有迁移脚本，老画布第一次被打开时各自完成升级。
 */
export const GRAPH_SCHEMA_VERSION = 2

/**
 * 认不出 `type` 的节点按哪种渲染 —— 也是 Y.Doc 里 `type` 缺失时 `fromYNode` 读出来的值。
 *
 * 两处必须是同一个值（老画布里的节点写的就是 `process`，换成别的会让既有内容换一副样子），
 * 所以只在这里声明一次：`fromYNode` 用它，前端的 `FALLBACK_NODE_TYPE`
 * （`components/flow/node-constants.ts`）也是从这里转出去的。
 */
export const FALLBACK_NODE_TYPE = 'process'

export interface FlowPort {
  id: string
  label?: string
  /** 数据类型标记，将来做连线合法性校验用；本期只存不判 */
  dataType?: string
}

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
 * 节点的业务数据。
 *
 * **框架字段之外，业务字段直接平铺在这一层**（v1 那个 `config` 包装没有了）。
 * 两个理由：
 * - Y.Map 的合并粒度是 key。`config` 整块存成一个 key 时，甲改 config.prompt、
 *   乙同时改 config.model，后到的那次会把整块盖掉 —— 明明改的是不同字段；
 *   平铺之后每个业务字段各占一个 key，逐键合并才真正成立。
 * - 示例数据（`sample/画布数据参考/`）就是平铺的，对齐之后两边可以直接互读。
 *
 * 代价是索引签名让拼错的字段名不再报错 —— 这是弱 schema 的固有代价，
 * 换来的是加一种节点不用改类型。框架字段的名字见 {@link NODE_DATA_RESERVED_KEYS}。
 */
export interface FlowNodeData {
  label: string
  status: FlowNodeStatus
  /** 创建时刻，UTC epoch 毫秒。老数据没有这个字段，所以可选 */
  createdAt?: number
  description?: string
  icon?: string
  /** 端口定义；不声明就是「一进一出」的默认形状，所以可选 */
  ports?: { inputs: FlowPort[]; outputs: FlowPort[] }
  /** 需要持久化的 UI 状态（折叠、颜色…） */
  ui?: Record<string, unknown>
  /** 业务字段平铺在这里 */
  [key: string]: unknown
}

/**
 * `data` 上属于框架的键。
 *
 * 用来把「框架字段」和「平铺的业务字段」分开 —— 升级 v1 数据时用到，
 * 将来做通用属性面板（"其余字段"那一栏）也读它。
 */
export const NODE_DATA_RESERVED_KEYS = [
  'label',
  'status',
  'createdAt',
  'description',
  'icon',
  'ports',
  'ui',
] as const

/**
 * Vue Flow 认识的字段在顶层，业务数据全在 data 里。
 *
 * **`type` 就是业务种类**（v1 那个和它恒等的 `data.kind` 已经并进来了）：
 * 它是前端节点类型注册表（`apps/web/src/components/flow/node-types.ts`）的键，
 * 决定用哪个组件渲染、新建时给什么默认 data。
 */
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
   * 画布级的兜底视口。真正生效的是**每人自己的**视口（见 {@link FlowUserState}），
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

/**
 * 新建节点时的默认 data。
 *
 * 只保证框架字段齐全（`label` / `status` / `createdAt`）；业务字段由各节点类型的
 * `defaultData()` 铺在上面，见 `apps/web/src/components/flow/node-types.ts`。
 */
export function defaultNodeData(label: string, patch?: Record<string, unknown>): FlowNodeData {
  return {
    label,
    status: 'idle',
    createdAt: Date.now(),
    ...patch,
  }
}

/** 新建连线时的默认 data */
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

// —— v1 → v2 的就地升级 ——

/**
 * 这份节点 `data` 是 v1 写进去的吗？
 *
 * Y.Doc 里没有版本号可查（它存的是内容，不是快照），所以只能看形状：
 * **同时**有字符串 `kind` 和对象 `config` —— 这正是 v1 必写的两个键，
 * 而 v2 一个都不写。要求两个同时命中是为了不误伤某个真的叫 `config` 的业务字段。
 *
 * 升级只发生在**读**这一侧，纯函数、幂等，**不回写文档**：投影函数里写文档会凭空
 * 产生一次 Yjs 事务 —— 进别人的撤销栈、广播给所有人。文档里残留的 `kind` / `config`
 * 键无害（Yjs 本来就只增不减），下次读再拆一遍，结果一样。
 */
export function isLegacyNodeData(data: Record<string, unknown>): boolean {
  return typeof data.kind === 'string' && isRecord(data.config)
}

/** v1 的边 data 是 `{kind?, condition?, config}`，`config` 在就当它是老的 */
export function isLegacyEdgeData(data: Record<string, unknown>): boolean {
  return isRecord(data.config)
}

/**
 * v1 → v2 升级时的可调项。
 *
 * ⚠️ 只有一项，而且它存在的唯一理由是**两端历史上不一致**：合并进 shared 时原样保留了
 * 两边各自的判据，没有趁机统一（统一是一次行为变更，要单独决定）。
 *
 * - `keepCreatedAt` —— v1 data 上的 `createdAt` 留不留。缺省（前端编辑器的投影）只要求
 *   是 number；服务端（`parseGraph`、`readGraphFromDoc` 的 graph 投影）传
 *   {@link STRICT_UPGRADE}，要求 {@link isTimestamp}（正的安全整数）。
 *   只在「v1 形状 + createdAt 是个非正 / 非整数的 number」时有差别 —— 正常写进去的
 *   都是 `Date.now()`，碰不到。
 */
export interface UpgradeOptions {
  keepCreatedAt?: (value: unknown) => boolean
}

/** 服务端用的那套升级判据（见 {@link UpgradeOptions}） */
export const STRICT_UPGRADE: UpgradeOptions = { keepCreatedAt: isTimestamp }

function isNumber(value: unknown): boolean {
  return typeof value === 'number'
}

/**
 * 把 v1 的节点 `data` 升级成 v2：`config` 拆平、`kind` 丢掉、补上 `status`。
 *
 * `kind` 直接丢：v1 里它和顶层 `type` 恒等（两者都只可能是 `'process'`），
 * 留着就是两个字段说同一件事。
 *
 * **框架字段压在业务字段之上**：`config` 里万一有个叫 `label` 的键，
 * 它是业务数据，不该顶掉节点真正的标题。
 */
export function upgradeNodeData(
  raw: Record<string, unknown>,
  options: UpgradeOptions = {},
): FlowNodeData {
  const keepCreatedAt = options.keepCreatedAt ?? isNumber
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
  if (!keepCreatedAt(data.createdAt)) delete data.createdAt
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

/** v2 的节点 data：原样收下，只保证框架字段的形状对 */
export function normalizeNodeData(raw: Record<string, unknown>): FlowNodeData {
  const data: FlowNodeData = { ...raw, label: '', status: 'idle' }
  data.label = typeof raw.label === 'string' ? raw.label : ''
  data.status = isNodeStatus(raw.status) ? raw.status : 'idle'
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
