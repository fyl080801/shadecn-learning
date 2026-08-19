import type { Ref } from "vue"
import type * as Y from "yjs"
import type { Awareness } from "y-protocols/awareness"

/**
 * 画布内容的**同步传输层**：把本地 Y.Doc 的改动送出去、把别处的改动收回来。
 *
 * 两种画布共用同一个内容模型（Y.Doc + `Flow.ydoc` 字节），分叉只在这一层：
 * - 项目画布（`collab`）—— Hocuspocus WebSocket，一张画布一个房间，带 awareness；
 * - 个人画布（`solo`）—— HTTP 增量推拉，没有房间、没有在场（REQ-SOLO / docs/16）。
 *
 * 上层（store、画布、吸附、快捷键）只认 Y.Doc，对这里选了哪一条**完全无感**。
 * 加第三种传输（比如将来的只读预览）也只是多一个实现，不动上面任何一层。
 */
export interface FlowTransport {
  /** 和服务端的首次同步完成了没 —— 到这一刻文档才保证是最新的 */
  synced: Ref<boolean>
  /** 通道当前是通的吗（协同：WebSocket 连着；个人：上一次推拉成功） */
  linked: Ref<boolean>
  /**
   * 有没有还没送出去的本地改动。
   *
   * 只有个人画布会为真：协同那边改动一进 Y.Doc 就顺着连接走了，
   * 「未保存」这个概念在那边根本不存在。
   */
  pending: Ref<boolean>
  /** 在场用的 awareness；个人画布没有这一层，为 null */
  awareness: Awareness | null
  /** 把还没送出去的立刻送走 —— 离开页面前调 */
  flush: () => Promise<void>
  /** 拆掉传输。**不销毁 doc** —— 文档的生命周期归 `useFlowSync` 管 */
  destroy: () => void
}

export interface TransportContext {
  flowId: string
  doc: Y.Doc
  /** 这条通道再也好不了了，原因是这个 */
  onFatal: (reason: FatalClose) => void
}

/**
 * **终局失败**：这条通道不会自己好，重试也只会被同样地拒掉。
 *
 * 四种原因、四条出路，所以必须分得开 —— 一律显示「已离线，恢复连接后自动同步」
 * 是最坏的一种处理：用户会对着一句「稍后自动同步」继续画，而那些改动只进得了
 * 本地 IndexedDB，永远发不出去。
 */
export type FatalClose =
  /** 自己在别处开了新窗口，这一条被顶下线（仅协同）。刷新即可接管回来 */
  | "superseded"
  /** 登录态没了。走全站那套「会话过期」确认框，登录完原地重连 */
  | "unauthorized"
  /** 还登着，但已经不该进这张画布了（被移出项目、画布已删）。没有自救路径 */
  | "forbidden"
  /** 画布太大，服务端不再接收（仅个人画布：协同那边是房间锁写，不走这里） */
  | "too-large"
