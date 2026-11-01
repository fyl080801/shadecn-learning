import type { Extension } from '@hocuspocus/server'
import type { FlowDocStore } from '@shadecn/mod-canvas/contract'

export type { FlowDocRow, FlowDocReadOptions, FlowDocStore, FlowDocWrite } from '@shadecn/mod-canvas/contract'

/**
 * 协同模块内部用的依赖（REQ-MODULES，docs/28 §3.1.2）。
 *
 * 由模块的 `setup(ctx)` 从平台能力和 `canvas` 服务拼好、经 {@link configureCollab} 存一份（`./module.ts`）：
 * 会话怎么认、成员怎么判来自平台和画布模块，画布内容的存取来自 `canvas.docs`，实例身份和 Redis 来自 `ctx.platform.runtime`。
 * 没装配就用 → 直接抛，不猜默认值。
 */

// ---------------------------------------------------------------- 鉴权

/**
 * 进房的人是谁。awareness 里客户端自报的 `user` 字段一律被它覆盖，杜绝同房间内冒名。
 * 字段和前端 `PresenceUser` 对齐（少一个 `color` —— 那个由 id 在本地哈希出来，不走网络，也就没法伪造）。
 */
export interface CollabIdentity {
  id: string
  name: string
  avatarUrl: string | null
}

/**
 * 拒绝的原因 —— **必须区分**，两者出路完全不同：
 * - `unauthorized`：会话没了（过期、登出、被踢），重新登录就能回来；
 * - `forbidden`：人是登着的，只是不该进这个房间（不是项目成员、画布已删），让他去登录毫无意义。
 */
export type CollabDenialReason = 'unauthorized' | 'forbidden'

/** 放行时带上是谁；没启用登录时 identity 为 null */
export type CollabAuthorization =
  | { ok: false; reason: CollabDenialReason }
  | {
      ok: true
      identity: CollabIdentity | null
      /** 个人画布的房间（只有所有者进得来）：没有协作者，在场层整个关掉 —— 见 `hocuspocus.ts` 的 awareness 钩子 */
      personal?: boolean
    }

export interface CollabAuthorizeOptions {
  /**
   * 允不允许顺手续期会话。默认 true —— 握手本身就是一次真实的 HTTP 请求。
   * 定期复验传 `false`：那趟检查背后没有任何用户动作，让它续期等于「标签页开着就永不登出」。
   */
  refresh?: boolean
}

export interface CollabAuthPort {
  /** 按 cookie 头和房间名判进房资格（实现：`./authorize.ts` 的 `authorizeCollab`） */
  authorize(cookieHeader: string | null | undefined, room: string, options?: CollabAuthorizeOptions): Promise<CollabAuthorization>
  /** WebSocket 握手的 `Origin` 校验（CSWSH；实现：`./authorize.ts` 的 `isAllowedCollabOrigin`） */
  isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean
}

// ---------------------------------------------------------------- 汇总

export interface CollabPorts {
  auth: CollabAuthPort
  flowDocs: FlowDocStore
  /** 这个进程的身份（`INSTANCE_ID`）：socketId 前缀、Redis 扩展的实例名 */
  instanceId: string
  /** 多副本时的 Redis（Hocuspocus 的 redis 扩展用）；单副本 = null */
  redis: { url: string; prefix: string } | null
  /**
   * 额外的 Hocuspocus 扩展，排在业务钩子之前（日志扩展 `./logging.ts` 的 `collabLogging()`：带 `priority`，
   * 一头一尾夹住落库，「开始 − 完成」= 失败次数）。每次 attach 调一次。
   */
  extensions?: () => Extension[]
}

let current: CollabPorts | undefined

export function configureCollab(ports: CollabPorts): void {
  current = ports
}

export function collabPorts(): CollabPorts {
  if (!current) {
    throw new Error('[collab] 协同模块还没装配（setup 时调 configureCollab）')
  }
  return current
}
