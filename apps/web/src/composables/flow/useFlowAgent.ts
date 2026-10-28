import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from "vue"
import {
  AGENT_PROMPT_MAX_LENGTH,
  AGENT_TITLE_MAX_LENGTH,
  type AgentActiveRunView,
  type AgentChatMessage,
  type AgentConversationView,
  type AgentSessionView
} from "@shadecn/shared/agent"
import { ApiError, agentApi } from "@/lib/api"
import {
  applyAgentEvent,
  beginTurn,
  emptyConversation,
  interruptTurn,
  resumeTurn,
  rollbackTurn
} from "@/lib/agent-conversation"
import { useAsyncAction } from "@/composables/useAsyncAction"

/**
 * 有一轮在跑、但这个窗口读不到它的事件流时（别人发起的、或者自己那轮接不回来），
 * 隔多久问一次服务端「结束了没」。
 *
 * 只有这两种情况才轮询，平时一个请求都不发。5s 是「结束后多久解除锁定」的上限 ——
 * 画布内容本来就经 WebSocket 实时到达，这里等的只是一个「可以发了」的信号。
 */
export const AGENT_POLL_INTERVAL = 5000

/**
 * 我的一轮刚发起、服务端还没建好它的会话时（`activeRun.mine` 但 `conversationId === null`，
 * 只有几毫秒），隔多久再问一次。这时候的 `latest` 可能还是**上一个**会话，接上去就会把这一轮
 * 折叠进错的会话里 —— 所以不接，稍等再问。
 */
export const AGENT_RESUME_RETRY_DELAY = 300

/** 上面那种「再问一次」最多连着几次；之后退回普通轮询，免得服务端一直不给 id 时空转 */
const AGENT_RESUME_RETRY_LIMIT = 10

/**
 * 画布 Agent 的对话（REQ-AGENT，docs/20）：拿会话、发一轮、接回一轮、停、切换 / 新建会话。
 *
 * **不挂进编辑器上下文**：只有对话面板用它，面板自己调一次就够 ——
 * 加一块面板不该改 `provideFlowEditor`。面板收起时组件仍挂着（`v-show`），
 * 所以这里的状态和正在读的流都不会因为收起而断。
 *
 * agent 对画布的改动**不走这条流**：它们经协同层进 Y.Doc，和别人的编辑一样实时到达
 * （个人画布也走 WebSocket，所以发送前不用等什么）。这条流只讲「agent 在说什么、在做什么」。
 *
 * **一轮不随这条流存亡**：关面板、换画布、刷新都只断本地的读，服务端那一轮照跑，
 * 只有停止按钮（`POST /abort`）会中止它。所以打开画布时先问一次服务端（`activeRun`）：
 * - 是我发起的 → 打开那个会话、订阅它的事件流，补发 + 后续事件照常折叠进去（「接回」）；
 * - 是别人发起的 → 只提示、锁发送，轮询到它结束为止；
 * - 接不回来（404 已经结束 / 410 补发缓冲溢出 / 流断了）→ 不打扰用户，等它结束后重新拉会话。
 */
export function useFlowAgent(flowId: Ref<string>) {
  /** 服务端的状态：配没配模型、模型名、此刻有没有一轮在跑（最近一次快照） */
  const session = ref<Omit<AgentSessionView, "latest"> | null>(null)
  const loading = ref(false)
  const loadError = ref<string | null>(null)
  const conversation = reactive(emptyConversation())
  /** 当前显示的会话 id；null = 新会话（第一条消息发出去、RUN_STARTED 回来才有 id） */
  const conversationId = ref<string | null>(null)
  /** 当前会话的标题（原文，可含提及）；新会话为 null */
  const title = ref<string | null>(null)
  /** 正在读接回的那条事件流 */
  const resuming = ref(false)

  /**
   * 每换一张画布 +1。在途的请求、流里的事件、轮询都带着发起时的值，对不上就丢 ——
   * 否则上一张画布的 agent 回复会流进这一张的对话里。
   */
  let generation = 0
  /** 正在读的那条流；换画布、卸载时掐掉（只掐本地的读，不替用户中止服务端那一轮） */
  let stream: AbortController | null = null
  /** 每次主动切换会话 +1：连点两个会话时，只认最后一次点的 */
  let switchSeq = 0
  /** 本窗口自己发起的一轮正在进行（值 = 发起时的 generation）；此时服务端快照不该覆盖对话区 */
  let turnTicket: number | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 这一轮接不回来了（404 / 410 / 流断了）—— 别再试着订阅它，等它结束。
   * 不记的话，服务端快照里它还挂着时会「接回 → 失败 → 再接回」地空转。
   */
  let unresumableRunId: string | null = null
  /** 那一轮结束之后要重新拉的会话（它的 assistant 消息要到结束才落库） */
  let staleConversationId: string | null = null
  /** 连着因为「会话还没建好」而重问了几次（见 `AGENT_RESUME_RETRY_DELAY`） */
  let resumeRetries = 0

  const activeRun = computed(() => session.value?.activeRun ?? null)

  function readingTurn() {
    return turnTicket === generation || resuming.value
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  /** 过一个间隔再问一次服务端；已经排着了就不重复排 */
  function schedulePoll(delay = AGENT_POLL_INTERVAL) {
    if (pollTimer) return
    const ticket = generation
    pollTimer = setTimeout(() => {
      pollTimer = null
      if (ticket === generation) void refresh()
    }, delay)
  }

  /** 我的一轮还没定下属于哪个会话：很快再问一次（连问太多次就退回普通轮询） */
  function retryResumeSoon() {
    stopPolling()
    resumeRetries++
    schedulePoll(resumeRetries <= AGENT_RESUME_RETRY_LIMIT ? AGENT_RESUME_RETRY_DELAY : AGENT_POLL_INTERVAL)
  }

  /** 静默地重新问一次服务端（轮询、接回失败之后）。失败了就接着轮询，不报错 */
  async function refresh() {
    const ticket = generation
    try {
      const view = await agentApi.session(flowId.value)
      if (ticket === generation) applySession(view, false)
    } catch {
      if (ticket === generation) schedulePoll()
    }
  }

  async function load() {
    const ticket = generation
    const id = flowId.value
    loading.value = true
    loadError.value = null
    try {
      const view = await agentApi.session(id)
      if (ticket !== generation) return
      applySession(view, true)
    } catch (error) {
      if (ticket !== generation) return
      loadError.value = error instanceof Error ? error.message : "加载对话失败"
    } finally {
      if (ticket === generation) loading.value = false
    }
  }

  /**
   * 收下一份服务端快照，按 `activeRun` 决定下一步。
   *
   * @param adopt 没有接回、也没有待重拉的会话时，要不要把 `latest` 摆到对话区 ——
   *   打开画布时要；轮询时不要（用户可能已经切到了别的会话、或者点了新会话）
   */
  function applySession(view: AgentSessionView, adopt: boolean) {
    const { latest, ...rest } = view
    session.value = rest
    // 本窗口正在读一条流：快照里没有这一轮还没落定的部分，不拿它盖掉对话区
    if (readingTurn()) return

    const run = view.activeRun
    if (run?.mine && run.runId !== unresumableRunId) {
      /*
       * 会话还没建好（新会话刚发起的那几毫秒）：此刻的 `latest` 可能是上一个会话。
       * 不拿它去接 —— 稍等再问一次，拿到 id 再接。比「先订阅、看 RUN_STARTED 的 threadId
       * 再换会话」简单：后者得把换会话那次 GET 期间到达的事件先攒起来，而这个窗口只有几毫秒。
       */
      if (!run.conversationId) {
        retryResumeSoon()
        return
      }
      // 不在这里清零 `resumeRetries`：threadId 对不上而重来的话，下一次照样要算进上限
      stopPolling()
      void resume(run, latest)
      return
    }
    resumeRetries = 0
    if (run) {
      // 别人的一轮（看不到内容，只等它结束），或者自己那轮接不回来
      if (adopt) showConversation(latest)
      schedulePoll()
      return
    }

    // 没有在跑的了
    stopPolling()
    unresumableRunId = null
    const stale = staleConversationId
    staleConversationId = null
    if (stale && stale === conversationId.value) {
      // 自己那一轮没能接着看完，现在结束了：重新拉那个会话，拿落定的 assistant 消息
      if (latest?.id === stale) showConversation(latest)
      else void reloadConversation(stale)
      return
    }
    if (adopt) showConversation(latest)
  }

  async function reloadConversation(id: string) {
    const ticket = generation
    const seq = ++switchSeq
    try {
      const view = await agentApi.conversation(flowId.value, id)
      if (ticket === generation && seq === switchSeq && !readingTurn()) showConversation(view)
    } catch (error) {
      // 拉不到就留着现在这份：这一轮的结果以画布上的实际内容为准，不值得为它弹提示
      console.warn("[agent] 重新拉取会话失败", error)
    }
  }

  /** 把一个会话（或 null = 新会话空状态）摆到对话区 */
  function showConversation(view: AgentConversationView | null) {
    conversationId.value = view?.id ?? null
    title.value = view?.title ?? null
    Object.assign(conversation, emptyConversation(view ? [...view.messages] : []))
  }

  /** 这一轮结束了，服务端那份「有没有在跑」的快照也就过期了 */
  function markIdle() {
    if (session.value) session.value = { ...session.value, running: false, activeRun: null }
  }

  /**
   * 接回自己正在跑的那一轮：摆好它所在的会话，订阅事件流，补发 + 后续的一起折叠进去。
   * 收尾事件到了就复位；接不回来就记下来、等它结束再重拉会话 —— 都不弹提示。
   */
  async function resume(run: AgentActiveRunView, latest: AgentConversationView | null) {
    const ticket = generation
    const id = flowId.value
    const controller = new AbortController()
    let outcome: "finished" | "gone" | "wait" | "retry"
    /** 补发的 RUN_STARTED 说这一轮属于另一个会话（快照之间的竞态）：停下重来，别折叠进错的会话 */
    let wrongConversation = false
    resuming.value = true
    // 作废在途的会话切换：接回的这一轮优先
    switchSeq++
    try {
      let view = latest
      // 契约上 `latest` 就是这一轮的会话；对不上（快照之间的竞态）就按 id 再拿一次
      if (run.conversationId && view?.id !== run.conversationId) {
        view = await agentApi.conversation(id, run.conversationId)
      }
      if (ticket !== generation) return
      showConversation(view)
      resumeTurn(conversation, run.runId)

      stream = controller
      await agentApi.runEvents(id, run.runId, {
        signal: controller.signal,
        onEvent: (event) => {
          if (ticket !== generation || wrongConversation) return
          // 以流里的 threadId 为准：它才是这一轮真正所属的会话
          if (event.type === "RUN_STARTED" && event.threadId !== conversationId.value) {
            wrongConversation = true
            controller.abort()
            return
          }
          applyAgentEvent(conversation, event)
        }
      })
      // 流读完了却没等到收尾事件（代理掐断、断网）：那一轮多半还在跑
      outcome = wrongConversation ? "retry" : conversation.finished ? "finished" : "wait"
    } catch (error) {
      if (wrongConversation && ticket === generation) {
        outcome = "retry"
      } else if (controller.signal.aborted || ticket !== generation) {
        // 换画布 / 卸载时本地掐掉的：什么都不做
        return
      } else {
        // 404 = 已经结束了（或者不是我的）；410 = 补发缓冲溢出；其余（网络）一样当成「等它结束」
        outcome = error instanceof ApiError && error.status === 404 ? "gone" : "wait"
      }
    } finally {
      if (stream === controller) stream = null
      if (ticket === generation) resuming.value = false
    }
    if (ticket !== generation) return

    if (outcome === "finished") {
      // 从头到尾看完了，手里这份就是落定的：之前记下的「等它结束再重拉」作废
      staleConversationId = null
      resumeRetries = 0
      markIdle()
      return
    }
    if (outcome === "retry") {
      // 不记成「接不回来」：重新问一次服务端，拿到对的会话再接
      retryResumeSoon()
      return
    }
    unresumableRunId = run.runId
    staleConversationId = run.conversationId
    // 已经结束了：马上重拉；还在跑：等它结束
    if (outcome === "gone") void refresh()
    else schedulePoll()
  }

  /** 这一轮在跑时（自己发起的、接回的、接不回来在等的）不能切会话：事件只折叠进它那个会话 */
  const running = computed(
    () => sending.value || resuming.value || activeRun.value?.mine === true
  )

  /**
   * 发起新会话：只是前端把当前会话置空，不发请求 ——
   * 第一条消息发出去时服务端才建会话。
   */
  function newConversation(): boolean {
    if (running.value) return false
    switchSeq++
    showConversation(null)
    return true
  }

  /** 切到某个已有会话并加载它；这一轮在跑时拒绝；失败抛异常（会话还是原来的） */
  async function openConversation(id: string): Promise<boolean> {
    if (running.value) return false
    if (id === conversationId.value) return true
    const ticket = generation
    const seq = ++switchSeq
    const view = await agentApi.conversation(flowId.value, id)
    // 换了画布、又点了别的会话、或期间发起 / 接回了一轮：这份响应过期了
    if (ticket !== generation || seq !== switchSeq || running.value) return false
    showConversation(view)
    return true
  }

  function reset() {
    generation++
    stream?.abort()
    stream = null
    stopPolling()
    turnTicket = null
    resuming.value = false
    unresumableRunId = null
    staleConversationId = null
    resumeRetries = 0
    session.value = null
    loadError.value = null
    switchSeq++
    showConversation(null)
  }

  /**
   * 发一条 prompt，跑完一整轮才 resolve。
   *
   * 返回 `true` = 服务端接下了这一轮（之后怎么收尾都在对话里展示）；
   * 抛异常 = 这一轮根本没开始，乐观插入的那条已经撤回 —— 调用方据此把输入框的字还回去。
   */
  async function sendTurn(text: string): Promise<boolean> {
    const prompt = text.trim()
    if (!prompt) return false
    if (prompt.length > AGENT_PROMPT_MAX_LENGTH) {
      throw new Error(`消息太长了，最多 ${AGENT_PROMPT_MAX_LENGTH} 字`)
    }

    const ticket = generation
    const id = flowId.value
    const optimistic: Extract<AgentChatMessage, { role: "user" }> = {
      id: `local-user-${Date.now()}`,
      role: "user",
      text: prompt,
      createdAt: Date.now()
    }
    beginTurn(conversation, optimistic)
    turnTicket = ticket
    stopPolling()

    const controller = new AbortController()
    stream = controller
    let accepted = false
    /** 流开了但没读到收尾：服务端那一轮多半还在跑，结束后去接回 / 重拉 */
    let interrupted = false
    try {
      await agentApi.send(
        id,
        { text: prompt, conversationId: conversationId.value },
        {
          signal: controller.signal,
          onOpen: () => {
            accepted = true
          },
          onEvent: (event) => {
            if (ticket !== generation) return
            // 新会话由服务端在这一轮开始时建好，id 在 threadId 里带回来
            if (event.type === "RUN_STARTED") {
              conversationId.value = event.threadId
              title.value ??= prompt.slice(0, AGENT_TITLE_MAX_LENGTH)
            }
            applyAgentEvent(conversation, event)
          }
        }
      )
      if (ticket === generation && !conversation.finished) {
        interruptTurn(conversation)
        interrupted = true
      }
      return true
    } catch (error) {
      // 换画布 / 卸载时本地掐掉的：不是错误，什么都不说（服务端那一轮照跑，换回来时接回）
      if (controller.signal.aborted || ticket !== generation) return accepted
      if (accepted) {
        // 流开了之后断的：对话里先标成中断，别弹 toast
        interruptTurn(conversation)
        interrupted = true
        return true
      }
      rollbackTurn(conversation)
      // 409：有一轮在跑而这边不知道（别人刚发起、或者自己在另一个标签页发起的）——
      // 重新问一次，是自己的就接回，是别人的就锁上发送等它结束
      if (error instanceof ApiError && error.status === 409) void refresh()
      throw explainSendError(error)
    } finally {
      if (stream === controller) stream = null
      if (turnTicket === ticket) turnTicket = null
      if (ticket === generation) {
        markIdle()
        if (interrupted) {
          // 问一次服务端：还在跑就接回（补发会把这一轮从头拼出来），已经结束就重拉这个会话
          staleConversationId = conversationId.value
          void refresh()
        }
      }
    }
  }

  const { run: send, pending: sending } = useAsyncAction(sendTurn, {
    errorMessage: "发送失败"
  })

  const { run: abort, pending: aborting } = useAsyncAction(
    async () => {
      const ticket = generation
      await agentApi.abort(flowId.value)
      // 读着流的话收尾事件自己会到；读不到（接不回来在等）就别干等下一次轮询
      if (ticket === generation && !readingTurn()) void refresh()
    },
    { errorMessage: "停止失败" }
  )

  watch(
    flowId,
    () => {
      reset()
      void load()
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    generation++
    stream?.abort()
    stream = null
    stopPolling()
  })

  return {
    session,
    loading,
    loadError,
    reload: load,
    conversationId,
    title,
    newConversation,
    openConversation,
    /** 对话列表（含这一轮正在流式拼出来的那条） */
    messages: computed(() => conversation.messages),
    /**
     * 我的一轮正在跑：这个窗口发起的、接回的、或者接不回来正在等它结束的。
     * 为真时发送换成停止、不能切会话。
     */
    running,
    /**
     * 别人发起的一轮正在跑（服务端说的，轮询到它结束为止）。
     * 看不到内容，只提示是谁、锁住发送 —— 发了服务端也会 409。
     */
    foreignRun: computed(() => {
      const run = activeRun.value
      return run && !run.mine && !running.value ? run : null
    }),
    send,
    abort,
    aborting
  }
}

/** 发送请求被拒时给人看的话 */
function explainSendError(error: unknown): Error {
  if (error instanceof ApiError) {
    if (error.status === 409) return new Error("这张画布上有一轮 agent 正在运行，等它结束再发")
    if (error.status === 503) return new Error("服务端未配置模型，暂时用不了 agent")
  }
  return error instanceof Error ? error : new Error("发送失败")
}

export type FlowAgent = ReturnType<typeof useFlowAgent>
