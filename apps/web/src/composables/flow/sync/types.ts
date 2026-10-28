import type { Ref } from "vue"
import type * as Y from "yjs"
import type { Awareness } from "y-protocols/awareness"

/**
 * 画布内容的**同步传输层**：把本地 Y.Doc 的改动送出去、把别处的改动收回来。
 *
 * 现在只有一种实现 —— Hocuspocus WebSocket（`./collab.ts`），一张画布一个房间。
 * 项目画布和个人画布都走它（REQ-SOLO / docs/16）：个人画布的房间只对所有者开放，
 * 在场层由 `useFlowPresence` 按 `mode` 关掉。agent 写画布写的就是服务端的活房间，
 * 所以个人画布也得在房间里，才看得见 agent 改了什么（docs/20）。
 *
 * 上层（store、画布、吸附、快捷键）只认 Y.Doc，对传输**完全无感**。
 * 接口留着是为了这条边界本身：加一种传输（比如将来的只读预览）只是多一个实现，
 * 测试也能在这一层换上假的。
 */
export interface FlowTransport {
  /** 和服务端的首次同步完成了没 —— 到这一刻文档才保证是最新的 */
  synced: Ref<boolean>
  /** 通道当前是通的吗（WebSocket 连着） */
  linked: Ref<boolean>
  /**
   * **服务端收到了，但存不进库**。
   *
   * 和断线是两回事 —— 连接好好的、内容也到了服务端，只是服务器那头写库失败了，
   * 字节悬在它的内存里。不把这件事说出来，界面就会一直写着「已同步」，而用户照着继续画。
   * 服务器恢复之后会再广播一次，这个值自己变回 false。
   *
   * 没有「本地还没发出去」这个状态：改动一进 Y.Doc 就顺着连接走了（断线时进 IndexedDB，
   * 重连后补发），所以也没有 flush 这一步。
   */
  saveFailed: Ref<boolean>
  /** 在场用的 awareness。个人画布也有这条连接上的 awareness，只是在场层不用它 */
  awareness: Awareness
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
  /** 自己在别处开了这张画布，这一条被顶下线（同一人同一房间只留最新的窗口）。刷新即可接管回来 */
  | "superseded"
  /** 登录态没了。走全站那套「会话过期」确认框，登录完原地重连 */
  | "unauthorized"
  /** 还登着，但已经不该进这张画布了（被移出项目、画布已删）。没有自救路径 */
  | "forbidden"
  /** 画布顶到内容硬限，房间被锁写清场（服务端的 4413 / `quota-exceeded`） */
  | "too-large"
