import type { FlowMode } from "@/types/flow"
import type { FatalClose } from "./sync"

/**
 * 画布上那行小字说什么 —— **纯函数，没有 ref、没有 store**。
 *
 * 从 `useFlowDocument` 里拆出来只为一件事：**能被真的测到**。
 * 那个 composable 要 router、要组件实例、`watch(flowId, …, {immediate:true})`
 * 一挂上就发请求，为了钉几句文案去搭那一整套环境不划算；
 * 而把判断抄进测试里再断言，测的是复制品，改了实现它照样绿 ——
 * 那种测试比没有更糟。`src/lib/presence.ts` 拆出纯逻辑是同一个路数。
 *
 * 这里管的是**说法**，不是状态。什么时候进入哪种状态由同步层决定。
 */

export interface SyncTextInput {
  /** 终局失败（不会自己好），`null` = 没有 */
  fatal: FatalClose | null
  /** 项目画布还是个人画布 —— 两边的说法不一样，见下 */
  mode: FlowMode | null
  /** 通道是通的吗（传输连着 **且** 网卡说在线） */
  connected: boolean
  /** 和服务端的首次同步完成了没 */
  synced: boolean
  /** 有没有还没送出去的本地改动（只有个人画布会为真） */
  pending: boolean
  /** 服务端收到了但存不进库（只有协同画布会为真） */
  saveFailed: boolean
  /** 本地缓存（IndexedDB）用不了 —— 「断网不丢」在这台浏览器上不成立 */
  cacheFailed: boolean
}

/**
 * **两种画布这里的说法不一样，而且不能混**（REQ-SOLO §4.6）：
 * 项目画布是「同步」（改动进 Y.Doc 就走了，没有保存这一步），
 * 个人画布是「保存」（推一次 HTTP 才算落地）。跟个人画布的用户说
 * 「协作会话已过期」，他会去找那个根本不存在的协作者。
 */
export function syncTextOf(input: SyncTextInput): string {
  /*
   * 终局失败要**先判、且分开判**。这些都不会自己好，套用下面那句
   * 「恢复连接后自动同步」就是在骗人：用户会照着继续画，而那些改动进得了本地
   * IndexedDB、永远发不出去。几种原因几条出路，所以文案也得分开写。
   */
  switch (input.fatal) {
    case "superseded":
      return "协作会话已过期，请刷新页面"
    case "unauthorized":
      return "登录态已过期，请重新登录"
    case "forbidden":
      return "已失去访问权限，改动不再同步"
    case "too-large":
      return "画布太大，最近的改动没能保存"
  }

  /*
   * 断线时的文案有两个版本，因为**兜底到底存不存在**是两回事。
   *
   * 平时那句「改动存在本地」是有依据的：内容进了 IndexedDB，刷新、关页面都不丢，
   * 恢复后自动补发。但无痕模式、浏览器禁用 IndexedDB、配额写满时那一层根本没建起来
   * —— 这时候还说「存在本地」就是在骗人，而代价是用户安心地继续画、然后刷新一次全没。
   *
   * 只在**断线**时才换这句话：在线时本地缓存用不上也没影响，内容照样同步出去了；
   * 进场时已经 toast 过一次（见 `sync/index.ts`），不必再占着状态栏制造焦虑。
   */
  const offlineText = input.cacheFailed
    ? "已离线，且这台浏览器存不下草稿 —— 刷新会丢失未同步的改动"
    : null

  if (input.mode === "solo") {
    // 断网时改的东西存在本地 IndexedDB 里，刷新也不丢，恢复后自动补发
    if (!input.connected) {
      if (offlineText) return offlineText
      return input.synced ? "已离线，改动存在本地，恢复网络后自动保存" : "连不上服务器，改动只存在本地"
    }
    return input.pending ? "保存中…" : "已保存"
  }

  if (!input.connected) return offlineText ?? "已离线，改动存在本地，恢复连接后自动同步"

  /*
   * 连接是好的、内容也同步给了同房间的人，但服务器**写不进库** ——
   * 这时候显示「已同步」就是在骗人：字节只悬在服务器内存里，那个进程一重启就没了。
   *
   * 措辞刻意不吓人、也不给按钮：用户这会儿什么都做不了，重试是服务端自动的
   * （恢复后会再广播一次，这行字自己就消失了）。它要传达的只有一件事 ——
   * **现在别关页面**。
   */
  if (input.saveFailed) return "服务器暂时无法保存，改动已同步给协作者"
  return input.synced ? "已同步" : "同步中…"
}

/** 这行小字要不要标成警告色。断线时给个视觉提醒，但不做成可点的动作 —— 重试是自动的 */
export function syncWarningOf(input: SyncTextInput): boolean {
  return !input.connected || input.fatal !== null || input.saveFailed || input.cacheFailed
}
