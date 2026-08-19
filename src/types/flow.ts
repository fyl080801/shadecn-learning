/**
 * 项目 / 画布的前端类型。
 *
 * 与服务端 `server/store/flow-types.ts`、`server/store/projects.ts` 一一对应 ——
 * 两边是分开的 TS 工程（server 不带 DOM 类型），所以类型各写一份，改一边记得同步另一边。
 */

export const GRAPH_SCHEMA_VERSION = 1

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

// —— 操作日志 ——

/**
 * 操作日志的一条（`GET /api/flows/:id/operations`）。
 *
 * 一条 = 客户端的一次 Yjs 事务。`update` 二进制本身不出接口 ——
 * 它对界面没用，真要回放就按 seq 顺序取出来 applyUpdate 到一个空文档。
 */
export interface FlowOperationView {
  id: string
  seq: number
  /** 谁改的；服务端在 WebSocket 握手时认定，客户端伪造不了 */
  actorId: string | null
  /** 服务端收到的时刻，UTC epoch 毫秒 */
  serverTs: number
  /** 这次更新的字节数 */
  size: number
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
