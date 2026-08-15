/**
 * 项目 / 画布的前端类型。
 *
 * 与服务端 `server/store/flow-types.ts`、`server/store/projects.ts` 一一对应 ——
 * 两边是分开的 TS 工程（server 不带 DOM 类型），所以类型各写一份，改一边记得同步另一边。
 */

export const GRAPH_SCHEMA_VERSION = 1

// —— 项目 ——

export type ProjectRole = "admin" | "member"

export interface ProjectSummary {
  id: string
  name: string
  description: string | null
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

export interface FlowSummary {
  id: string
  projectId: string
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

export interface FlowNodeData {
  label: string
  /** 业务种类，决定 config 的形状 */
  kind: string
  description?: string
  icon?: string
  /** 节点的自定义配置，前后端都不解释它 */
  config: Record<string, unknown>
  ports: { inputs: FlowPort[]; outputs: FlowPort[] }
  ui?: Record<string, unknown>
}

/** Vue Flow 认识的字段在顶层，业务数据全在 data 里 */
export interface FlowNode {
  id: string
  type: string
  position: { x: number; y: number }
  width?: number
  height?: number
  zIndex?: number
  parentNode?: string
  extent?: "parent" | null
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

// —— 操作 ——

export type FlowOpType =
  | "node.add"
  | "node.remove"
  | "node.move"
  | "node.resize"
  | "node.update"
  | "edge.add"
  | "edge.remove"
  | "edge.update"
  | "graph.meta"

/** 一次可撤销的最小变更；before/after 自带逆操作所需的信息 */
export interface FlowOp {
  type: FlowOpType
  targetId: string
  before: unknown | null
  after: unknown | null
}

export type FlowTransactionKind = "do" | "undo" | "redo"

/** 一次撤销的粒度 */
export interface FlowTransaction {
  id: string
  label: string
  kind: FlowTransactionKind
  /**
   * 产生这次事务的时刻：UTC epoch 毫秒的整数（`Date.now()`）。
   *
   * 画布这条链路上的时间一律是数值时间戳 —— 协同时要把多个客户端的操作
   * 排到同一条时间轴上，数值能直接比大小，没有时区和格式的歧义。
   * 展示才交给 `@/lib/format`。
   */
  ts: number
  ops: FlowOp[]
}

/** 操作日志的一条（`GET /api/flows/:id/operations`）；两个时间都是 UTC epoch ms */
export interface FlowOperationView {
  id: string
  seq: number
  txId: string
  kind: FlowTransactionKind
  label: string
  ops: FlowOp[]
  actorId: string | null
  /** 客户端上报的产生时刻，钟不准就可能不准 */
  clientTs: number
  /** 服务端落库时刻，排序以它为准 */
  serverTs: number
}

// —— 分页 ——

export interface Paged<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/** 新建节点时的默认 data，保证 config / ports 一定存在 */
export function defaultNodeData(label: string): FlowNodeData {
  return {
    label,
    kind: "process",
    config: {},
    ports: { inputs: [], outputs: [] }
  }
}
