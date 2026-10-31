import type { Extension } from '@hocuspocus/server'
import type { FlowGraph } from '@shadecn/shared/flow-graph'

/**
 * 协同模块向底座要的东西（REQ-MODULES，docs/28 §3.1.4）。
 *
 * 这个包不 import `apps/server`、不读 `process.env`：画布表怎么读写、会话怎么认、实例叫什么、Redis 在哪，
 * 全由宿主在启动时经 {@link configureCollab} 交进来（`apps/server/modules/collab.ts`）。
 * 测试同样要先交一份（`apps/server/test/setup.ts`），没交就用 → 直接抛，不猜默认值。
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
  /** 按 cookie 头和房间名判进房资格（实现：`apps/server/auth/ws.ts` 的 `authorizeCollab`） */
  authorize(cookieHeader: string | null | undefined, room: string, options?: CollabAuthorizeOptions): Promise<CollabAuthorization>
  /** WebSocket 握手的 `Origin` 校验（CSWSH；实现：`auth/ws.ts` 的 `isAllowedCollabOrigin`） */
  isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean
}

// ---------------------------------------------------------------- 画布内容的存取

/** 读到的一行画布内容 */
export interface FlowDocRow {
  /** `Flow.ydoc`：Yjs 状态，**事实源**。空 / 没有 = null */
  ydoc: Uint8Array | null
  /** 服务端的 CAS 计数 */
  revision: number
  /**
   * 老数据迁移用：`ydoc` 为空时，库里那份 graph JSON 解析出来的图（坏数据已退化成空图）。
   * 只在 `read(..., { legacy: true })` 且 `ydoc` 为空时给；其余情况 null。
   */
  legacy: FlowGraph | null
}

export interface FlowDocReadOptions {
  /** 只认所属项目也没删的画布（进房、REST 读写）；落库只看画布本身没删（项目刚删时房间里那份照样写进去） */
  liveProject: boolean
  /** 要不要带上老 graph（见 {@link FlowDocRow.legacy}） */
  legacy: boolean
}

export interface FlowDocWrite {
  /** 新的 Yjs 状态 */
  ydoc: Uint8Array
  /**
   * 顺带写的派生投影（列表计数、缩略图读的 `graph`）。不给就只写 `ydoc`。
   * 序列化和字节上限由宿主判（`GRAPH_LIMITS.bytes`，超了跳过投影、只写内容，docs/04 §4.2）。
   */
  projection?: FlowGraph
}

/**
 * `Flow` 表上协同要的那几步（实现：`apps/server/store/flow-docs.ts`，MikroORM）。
 * 写入是一次 CAS：`where revision = expectedRevision`，返回是否真的写进去了（false = 被抢先 / 已删，调用方重读重来）。
 * 实现必须自己写 `updatedAt`（直接发 SQL 的更新不触发 `onUpdate`，`.claude/rules/database.md`）。
 */
export interface FlowDocStore {
  read(flowId: string, options: FlowDocReadOptions): Promise<FlowDocRow | null>
  compareAndWrite(flowId: string, expectedRevision: number, write: FlowDocWrite): Promise<boolean>
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
   * 额外的 Hocuspocus 扩展，排在业务钩子之前（宿主的日志扩展 `collabLogging()`：带 `priority`，
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
    throw new Error('[collab] 协同模块还没装配：宿主要先调 configureCollab()（apps/server/modules/collab.ts）')
  }
  return current
}
