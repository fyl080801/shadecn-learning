import type { FlowGraph, FlowUserState } from './flow-graph.ts'

/**
 * 项目 / 画布接口的线上形状（REQ-CANVAS）—— 服务端产出、前端消费的同一份。
 *
 * 时间字段一律是 ISO 字符串（带 `Z`），由服务端的 store 用 `toISOString()` 映射出来；
 * 画布内容里的时间才是 epoch 毫秒（见 `flow-graph.ts`）。
 */

// —— 项目 ——

export type ProjectRole = 'admin' | 'member'

/**
 * 项目的两种形态（REQ-SOLO）。
 *
 * - `team` —— 正常项目：有成员、有分享链接，里面的画布走协同。
 * - `personal` —— 每人一个的私人空间：只有自己一个成员、没有分享链接，
 *   里面的画布**不走协同**（`mode = 'solo'`）。
 *
 * 画布的 mode 由它派生，不在 `Flow` 上另存一份 —— 存两处必然漂移。
 */
export type ProjectKind = 'team' | 'personal'

export interface ProjectSummary {
  id: string
  name: string
  description: string | null
  /** team | personal —— personal 里的画布不走协同 */
  kind: ProjectKind
  memberCount: number
  flowCount: number
  /** 当前请求者在这个项目里的角色 */
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

/**
 * 项目的分享链接，一个项目只有一条；不限使用次数，只有有效期。
 *
 * `url` 是服务端按**这次请求的访问域名**拼好的完整链接（`apps/server/routes/projects.ts`
 * 的 `withUrl`），直接复制就能发人。store 层产出的记录没有它。
 */
export interface ProjectInviteView {
  id: string
  projectId: string
  token: string
  url: string
  role: ProjectRole
  createdById: string
  createdAt: string
  expiresAt: string
}

export type InviteInvalidReason = 'not_found' | 'expired' | 'project_deleted' | 'project_full'

/**
 * 打开分享链接时的预览。
 *
 * `message` 是服务端按 `reason` 配好的那句中文（`apps/server/routes/invites.ts`），
 * store 层产出的预览没有它。
 */
export interface InvitePreview {
  valid: boolean
  reason?: InviteInvalidReason
  message?: string
  projectId?: string
  projectName?: string
  memberCount?: number
  /** 已经是成员了 —— 前端把按钮换成「进入项目」 */
  alreadyMember: boolean
}

// —— 画布 ——

export type FlowStatus = 'draft' | 'published' | 'archived'

/**
 * 这张画布走哪条同步通道（REQ-SOLO）。
 *
 * - `collab` —— 协同：Hocuspocus WebSocket，一张画布一个房间；
 * - `solo` —— 个人画布：HTTP 增量推拉，没有房间、没有在场。
 *
 * **由服务端从所属项目的 `kind` 派生，不落库**（`modeOfKind`）：一张画布在个人空间里
 * 就是 solo，挪进团队项目就是 collab。客户端只照着执行 —— 自己声明的模式不算数
 * （服务端两条通道都会拒掉走错的那一边）。
 */
export type FlowMode = 'solo' | 'collab'

export interface FlowSummary {
  id: string
  projectId: string
  /** solo = 不走协同（个人画布）；collab = 走 WebSocket 房间 */
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
  /**
   * 请求者**自己**的画布状态（视口等），刚建/刚复制出来的是空对象。
   * 没存过的分区不出现；前端各自回落到默认值（视口回落到 graph.viewport）。
   */
  userState: FlowUserState
}

// —— 分页 ——

/** 列表接口的分页信封（`GET /api/projects`、`GET /api/projects/:id/flows`） */
export interface Paged<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}
