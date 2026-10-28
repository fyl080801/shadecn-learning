import { ref } from "vue"
import { useDebounceFn } from "@vueuse/core"
import * as Y from "yjs"
import { ApiError, flowApi } from "@/lib/api"
import type { FlowTransport, TransportContext } from "./types"

/**
 * 个人画布的传输：一次 HTTP 就是一次推 / 拉（REQ-SOLO，docs/16 §4.2）。
 *
 * 没有房间、没有 WebSocket、没有第二个人 —— 但**内容模型和项目画布一模一样**：
 * 事实源是 Y.Doc，库里是 `Flow.ydoc` 字节。所以上层（store、撤销、画布）一无所觉。
 *
 * 协议以**状态向量**为基线：每次把 `Y.encodeStateAsUpdate(doc, lastAck)` 送上去，
 * 服务端回它合并之后的状态向量。这样重发天然安全（Yjs 合并幂等），
 * 断网重连、请求超时都不用对账 —— 按当前基线重算一次差量就行，
 * 也就不需要在客户端维护一条「待确认更新」队列。
 */

/**
 * 一串编辑停下来多久之后补一发。
 *
 * 只管**收尾**：一串编辑的第一次是立刻推的（leading），不等这个窗口。
 * 比视口那套（2s）短一半 —— 这里推的是**内容**，窗口里丢掉的东西只在本地，
 * 而视口丢了最多是下次打开回到上一个位置。
 */
export const SOLO_PUSH_DELAY = 1000

/** 收尾那一发最多能被往后推多久：一直画下去也至少每 5s 落一次地 */
export const SOLO_PUSH_MAX_WAIT = 5000

/** 服务端同步进来的改动带这个 origin，用来和本地编辑区分开 —— 它不该再被推回去 */
export const REMOTE_ORIGIN = Symbol("flow-solo-remote")

export function createSoloTransport(context: TransportContext): FlowTransport {
  const synced = ref(false)
  const linked = ref(false)
  const pending = ref(false)
  /**
   * 个人画布没有这个状态：一次推送**就是**一次写库，成没成 `pending` 已经说清楚了
   * （协同那边内容进内存和落库是两件事，才需要分开报，见 `types.ts`）。
   */
  const saveFailed = ref(false)

  /** 服务端已经确认收到哪儿了。差量以它为基线算 */
  let acked: Uint8Array | undefined
  let disposed = false
  /** 正在飞的那一次推送；同一时刻只允许一个，避免两次差量重叠 */
  let inflight: Promise<void> | null = null

  /**
   * 把服务端那份拉下来合进本地文档。
   *
   * 基线取的是**服务端回的状态向量**，不是合并之后的本地状态 —— 否则离线期间
   * 攒在 IndexedDB 里的改动会被算成「服务端已经知道了」，差量变空，从此推不出去。
   * 拉完立刻比一次：本地要是领先（就是刚才那种情况），当场补一发。
   */
  async function pull() {
    const remote = await flowApi.pullDoc(context.flowId, acked)
    if (disposed) return

    if (remote.update.byteLength > 0) Y.applyUpdate(context.doc, remote.update, REMOTE_ORIGIN)
    acked = remote.stateVector
    synced.value = true
    linked.value = true

    if (!sameBytes(Y.encodeStateVector(context.doc), acked)) {
      pending.value = true
      void push()
    }
  }

  /**
   * 把本地相对基线的差量送上去。
   *
   * 失败**不弹提示**：改动还在 IndexedDB 里，一个字节都没丢，界面上显示
   * 「未保存 / 已离线」就够了。真正需要打断用户的只有终局失败（下面那三种）。
   */
  async function push(): Promise<void> {
    if (disposed || inflight) return inflight ?? undefined
    const local = Y.encodeStateVector(context.doc)
    const update = Y.encodeStateAsUpdate(context.doc, acked)

    inflight = (async () => {
      try {
        const ack = await flowApi.pushDoc(context.flowId, update)
        if (disposed) return
        acked = ack.stateVector
        linked.value = true
        // 推的过程中又改了东西：还欠着一发，等收尾的那次防抖带走
        pending.value = !sameBytes(local, Y.encodeStateVector(context.doc))
      } catch (error) {
        if (disposed) return
        linked.value = false
        const status = error instanceof ApiError ? error.status : 0
        /*
         * 三种服务端明确的拒绝是终局的，重试只会被同样地拒回来：
         * 413 画布装不下了、404 画布没了 / 不是成员了、401 登录态没了。
         * 其余（网络断了、5xx）保持 pending，下一次编辑或离开前会再试。
         */
        if (status === 413) context.onFatal("too-large")
        else if (status === 404) context.onFatal("forbidden")
        else if (status === 401) context.onFatal("unauthorized")
      } finally {
        inflight = null
      }
    })()

    return inflight
  }

  /** 一串编辑的收尾：手停下来一个窗口之后补一发 */
  const scheduleTail = useDebounceFn(
    () => {
      if (pending.value) void push()
    },
    SOLO_PUSH_DELAY,
    { maxWait: SOLO_PUSH_MAX_WAIT }
  )

  /**
   * 本地改动了。**先立刻推一次，再防抖收尾** —— 和视口那套是同一个形状：
   * 纯防抖的话，手一直不停它就一直不发，而这中间的每一秒都只有本地有数据。
   */
  function onUpdate(_update: Uint8Array, origin: unknown) {
    // 服务端刚同步进来的东西不用再推回去
    if (origin === REMOTE_ORIGIN || disposed) return
    const first = !pending.value
    pending.value = true
    if (first && !inflight) void push()
    void scheduleTail()
  }

  context.doc.on("update", onUpdate)

  // 先把服务端那份拉下来。失败不是终局（可能只是断网），保持未同步，
  // 下一次编辑触发的推送会把状态带回来
  void pull().catch(() => {
    linked.value = false
  })

  return {
    synced,
    linked,
    pending,
    saveFailed,
    // 个人画布没有在场这一层 —— 房间里只有一个人，没人可看
    awareness: null,
    flush: async () => {
      // 先等在飞的那一次落地：它算差量时还没有最新的改动
      if (inflight) await inflight
      if (pending.value) await push()
    },
    destroy: () => {
      disposed = true
      context.doc.off("update", onUpdate)
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  // eslint-disable-next-line security/detect-object-injection -- 下标是遍历出来的，不是外部输入
  return a.every((byte, index) => byte === b[index])
}
