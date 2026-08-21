/**
 * 项目 / 画布的前端类型。
 *
 * 与服务端 `server/store/flow-types.ts`、`server/store/projects.ts` 一一对应 ——
 * 两边是分开的 TS 工程（server 不带 DOM 类型），所以类型各写一份，改一边记得同步另一边。
 */

/**
 * 图结构版本。
 *
 * - v1：业务种类在 `data.kind`，业务字段裹在 `data.config` 里，`ports` 必填空壳；
 * - v2：业务种类**并入顶层 `type`**（节点类型注册表的键），业务字段直接平铺在 `data` 上，
 *   每个节点带 `status`。
 *
 * v1 的数据不会被拒收：读的时候就地升级（见 `fromYNode` 与服务端的 `parseGraph`），
 * 所以没有迁移脚本，老画布第一次被打开时各自完成升级。
 */
export const GRAPH_SCHEMA_VERSION = 2

// —— 项目 ——

export type ProjectRole = "admin" | "member"

/**
 * 项目的两种形态（REQ-SOLO）：`personal` 是每人一个的私人空间，
 * 里面的画布不走协同。服务端镜像在 `server/store/projects.ts`。
 */
export type ProjectKind = "team" | "personal"

export interface ProjectSummary {
  id: string
  name: string
  description: string | null
  kind: ProjectKind
  memberCount: number
  flowCount: number
  myRole: ProjectRole
  createdById: string
  createdAt: string
  updatedAt: string
}

export interface ProjectMemberView {
  userId: string
  name: string | null
  username: string | null
  email: string | null
  avatarUrl: string | null
  role: ProjectRole
  joinedAt: string
  invitedById: string | null
}

/** 项目的分享链接，一个项目只有一条；不限使用次数，只有有效期 */
export interface ProjectInviteView {
  id: string
  projectId: string
  token: string
  /** 服务端拼好的完整链接，直接复制就能发人 */
  url: string
  role: ProjectRole
  createdById: string
  createdAt: string
  expiresAt: string
}

export type InviteInvalidReason = "not_found" | "expired" | "project_deleted" | "project_full"

export interface InvitePreview {
  valid: boolean
  reason?: InviteInvalidReason
  message?: string
  projectId?: string
  projectName?: string
  memberCount?: number
  alreadyMember: boolean
}

// —— 画布 ——

export type FlowStatus = "draft" | "published" | "archived"

/**
 * 这张画布走哪条同步通道（REQ-SOLO）。
 *
 * - `collab` —— 协同：Hocuspocus WebSocket，一张画布一个房间；
 * - `solo` —— 个人画布：HTTP 增量推拉，没有房间、没有在场。
 *
 * **由服务端从所属项目派生**，客户端只照着执行 —— 自己声明的模式不算数
 * （服务端两条通道都会拒掉走错的那一边）。
 */
export type FlowMode = "solo" | "collab"

export interface FlowSummary {
  id: string
  projectId: string
  mode: FlowMode
  name: string
  description: string | null
  status: FlowStatus
  tags: string[]
  thumbnail: string | null
  nodeCount: number
  edgeCount: number
  revision: number
  createdById: string
  createdAt: string
  updatedAt: string
}

export interface FlowDetail extends FlowSummary {
  graph: FlowGraph
  /** 当前用户自己的画布状态；没存过的分区不出现 */
  userState: FlowUserState
}

// —— 按用户存的画布状态 ——

/**
 * 「每人自己一份」的状态：视口是第一个分区，以后还会有别的
 * （面板宽度、折叠了哪些节点…）。
 *
 * **扩展点**：加一个分区 = 这里加一个可选字段 + 服务端
 * `server/store/flow-types.ts` 的 `FLOW_USER_STATE_PARSERS` 加一条校验，
 * 表结构和接口都不用动。字段一律可选：老数据里没有它。
 */
export interface FlowUserState {
  viewport?: FlowViewport
}

// —— 图内容 ——

export interface FlowPort {
  id: string
  label?: string
  dataType?: string
}

/** 连接点贴在节点的哪一边（Vue Flow 的 Position，这里自己写一份，服务端也要认） */
export type FlowHandlePosition = "left" | "right" | "top" | "bottom"

/**
 * 节点的运行态。
 *
 * 画布不只是画出来的图，节点将来要真的跑起来（生成、上传、转换），
 * 所以「这个节点现在处于什么状态」是每个节点都有的字段，而不是某一类节点的私有配置。
 */
export type FlowNodeStatus = "idle" | "processing" | "completed" | "error"

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
 * 换来的是加一种节点不用改类型。框架字段的名字见 `NODE_DATA_RESERVED_KEYS`。
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
 * 用来把「框架字段」和「平铺的业务字段」分开 —— 目前只有升级 v1 数据时用到，
 * 将来做通用属性面板（"其余字段"那一栏）也读它。
 */
export const NODE_DATA_RESERVED_KEYS = [
  "label",
  "status",
  "createdAt",
  "description",
  "icon",
  "ports",
  "ui"
] as const

/**
 * Vue Flow 认识的字段在顶层，业务数据全在 data 里。
 *
 * **`type` 就是业务种类**（v1 那个和它恒等的 `data.kind` 已经并进来了）：
 * 它是节点类型注册表（`src/components/flow/node-types.ts`）的键，
 * 决定用哪个组件渲染、新建时给什么默认 data。
 */
export interface FlowNode {
  id: string
  type: string
  position: { x: number; y: number }
  width?: number
  height?: number
  zIndex?: number
  parentNode?: string
  extent?: "parent" | null
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

export interface FlowViewport {
  x: number
  y: number
  zoom: number
}

export interface FlowGraph {
  schemaVersion: number
  viewport: FlowViewport
  nodes: FlowNode[]
  edges: FlowEdge[]
  meta: Record<string, unknown>
}

export function emptyGraph(): FlowGraph {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    meta: {}
  }
}

// —— 分页 ——

export interface Paged<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/**
 * 新建节点时的默认 data。
 *
 * 只保证框架字段齐全（`label` / `status` / `createdAt`）；业务字段由各节点类型的
 * `defaultData()` 铺在上面，见 `src/components/flow/node-types.ts`。
 */
export function defaultNodeData(label: string, patch?: Record<string, unknown>): FlowNodeData {
  return {
    label,
    status: "idle",
    createdAt: Date.now(),
    ...patch
  }
}

/** 新建连线时的默认 data */
export function defaultEdgeData(): FlowEdgeData {
  return { createdAt: Date.now() }
}
