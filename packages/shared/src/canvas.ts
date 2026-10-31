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

// —— 画布资源 ——

/**
 * `POST /api/flows/:flowId/assets` 的回包。`url` 是对象存储（S3）的原始地址，
 * 前端原样写进节点的 `data.src` / `data.poster`，读资源不经后端。
 */
export interface UploadedAsset {
  url: string
  key: string
  contentType: string
  size: number
  /**
   * 这次实际生成了的缩略图档（可能为空）。只供展示 / 调试：节点里不存它，前端也不靠它判断有没有缩略图
   * （按 {@link assetVariantPath} 推地址，取不到退回原图，docs/27 §4）
   */
  variants?: AssetVariant[]
}

// —— 缩略图（docs/27）——

/** 缩略图的档：`icon` 图标、`low` 低清；原图不算一档 */
export const ASSET_VARIANTS = ['icon', 'low'] as const
export type AssetVariant = (typeof ASSET_VARIANTS)[number]

/** 显示时取哪一档：两档缩略图之外加上原图 */
export type AssetSize = AssetVariant | 'original'

/**
 * 各档规格：长边上限（只缩不放）、webp 质量、动图是否保留动画。
 * 前端不读这些数，放在这里只是让「档」的定义只有一处。
 */
export const ASSET_VARIANT_SPECS: Readonly<
  Record<AssetVariant, { readonly maxEdge: number; readonly quality: number; readonly animated: boolean }>
> = {
  icon: { maxEdge: 128, quality: 70, animated: false },
  low: { maxEdge: 768, quality: 80, animated: true },
}

/**
 * 素材键 / 地址的末尾：`assets/<uuid 前 2 位>/<第 3–4 位>/<uuid><ext>`，两级目录必须正是 uuid 的开头。
 * 和服务端 `storage/keys.ts` 拼出来的形状一致（那边另有更严的整键校验）。
 */
const ASSET_TAIL =
  /(^|\/)assets\/([0-9a-f]{2})\/([0-9a-f]{2})\/(\2\3[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.[a-z0-9]{1,8})?$/

/** 矢量图不生成缩略图 */
const NO_VARIANT_EXTENSIONS = new Set(['.svg'])

/**
 * 原图的对象键或地址 → 那一档缩略图的键或地址（同一目录，文件名 `<uuid>@<档>.webp`）；
 * 不是我们拼出来的素材形状（外部链接、`data:` / `blob:`、老的 `projects/…` 分层键、带 query 的、SVG）→ null，调用方用原图。
 *
 * 只做字符串推导，**不保证对象存在**：老数据、生成失败的没有缩略图，前端加载失败要退回原图。
 */
export function assetVariantPath(original: string, variant: AssetVariant): string | null {
  const match = ASSET_TAIL.exec(original)
  if (!match) return null
  const ext = match[5] ?? ''
  if (NO_VARIANT_EXTENSIONS.has(ext)) return null
  return `${original.slice(0, original.length - ext.length)}@${variant}.webp`
}

/**
 * 分片大小，也是「要不要分片」的分界线：**大于它的文件分片上传**，否则一次传完。
 *
 * 前后端读同一份：单次上传接口的请求体上限就是它，分片接口按它切片、按它限每片的大小。
 * 8 MiB —— S3 要求除最后一片外每片 ≥ 5 MiB，最多 10000 片。
 */
export const ASSET_PART_SIZE = 8 * 1024 * 1024

/** S3 一次分片上传最多 10000 片 */
export const ASSET_MAX_PARTS = 10_000

/**
 * 开始一次分片上传（`POST /api/flows/:flowId/assets/multipart`）的回包。
 * 后端不记会话：之后的每片、完成、放弃都由客户端把 `uploadId` + `key` 带回来。
 */
export interface AssetUploadSession {
  uploadId: string
  key: string
  partSize: number
  partCount: number
}

/** 传完一片拿到的回执；完成时按 `partNumber` 升序整组交回去 */
export interface AssetUploadPart {
  partNumber: number
  etag: string
}
