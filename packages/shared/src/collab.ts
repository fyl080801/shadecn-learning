/**
 * 画布同步通道的线上约定 —— 服务端（`apps/server/collab/`）和前端的两种传输
 * （`apps/web/src/composables/flow/sync/`）认的是同一份（docs/04-realtime-collab.md）。
 *
 * 这些全是字符串 / 数字字面量：写错不会报错，只会静默对不上，所以只在这里声明一次。
 */

/** 协同 WebSocket 的挂载点。房间名不在路径里，走消息（Hocuspocus 协议） */
export const COLLAB_PATH = '/ws/collaboration'

/** 画布房间名的前缀：`flow:<flowId>`。服务端靠它认出「这是某张画布的房间」并去查项目成员身份 */
export const FLOW_ROOM_PREFIX = 'flow:'

/**
 * 服务端广播「我存不进库了 / 又能存了」用的 stateless 消息类型。
 * 载荷是 `{ type: STORE_STATE_MESSAGE, ok: boolean }` 的 JSON。
 */
export const STORE_STATE_MESSAGE = 'flow:store-state'

/**
 * 个人画布（REST 推拉）在 `GET /api/flows/:id/doc` 上用来带回服务端状态向量的响应头，
 * 值是 base64url。客户端以它为基线算差量（见 `apps/web/src/composables/flow/sync/solo.ts`）。
 */
export const FLOW_STATE_VECTOR_HEADER = 'x-flow-state-vector'

// —— 终局关闭 ——

/**
 * 服务端单方面终结一条协同连接时带的信号。
 *
 * 它会走两条路到达前端（见 `apps/server/collab/close.ts`）：已建立的连接被关掉时，
 * CLOSE **消息**只带 reason、真正的关闭帧才带 code；握手被拒时只有一条带 reason 的
 * `PermissionDenied` 消息，没有 code。所以 **reason 才是通用判据**，code 只在关闭帧上有效。
 */
export interface CloseReason {
  /** 4000–4999 是应用自定义区间；只有关闭帧带得动它 */
  code: number
  /** CLOSE 消息、关闭帧、握手拒绝三条路都带，所以前端主要靠它认 */
  reason: string
}

/** 被自己在别处开的新窗口顶下线（`exclusive.ts`）。刷新页面即可重新接管 */
export const CLOSE_SUPERSEDED: CloseReason = { code: 4409, reason: 'session-superseded' }

/** 会话没了（过期 / 登出 / 被踢）。reason 与 Hocuspocus 内置的 `Unauthorized` 一致 */
export const CLOSE_UNAUTHORIZED: CloseReason = { code: 4401, reason: 'Unauthorized' }

/** 人登着，但不该进这个房间：不是项目成员，或画布已删 */
export const CLOSE_REVOKED: CloseReason = { code: 4403, reason: 'permission-revoked' }

/**
 * 画布顶到内容硬限、房间锁写（`quota.ts`）。
 *
 * 和前三种不同，这一种**跟人无关** —— 同一个房间里的每个人都会收到它，因为不能保存的是
 * 这张画布本身。4413 借的是 HTTP 的 413：个人画布那条 REST 通道超限回的正是 413，
 * 前端两边归成同一个终局状态（`too-large`），文案也只写一份。
 */
export const CLOSE_QUOTA_LOCKED: CloseReason = { code: 4413, reason: 'quota-exceeded' }
