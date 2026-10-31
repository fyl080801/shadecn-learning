import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from "vue"
import {
  AGENT_CONVERSATION_TITLE_EVENT,
  AGENT_PROMPT_MAX_LENGTH,
  AGENT_TITLE_MAX_LENGTH,
  parseAgentConversationTitle,
  parseAgentRunsMessage,
  type AgentActiveRunView,
  type AgentAttachment,
  type AgentChatMessage,
  type AgentConversationView,
  type AgentRunEntry,
  type AgentSessionView,
  type AgentStreamEvent,
  type AgentUserView
} from "@shadecn/shared/agent"
import { AGENT_RUNS_MESSAGE } from "@shadecn/shared/collab"
import type { FlowMode } from "@shadecn/shared/canvas"
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
 * 任务列表推送走的那条通道 —— 就是同步层（`useFlowSync`）的那两样，测试里换成假的。
 * 同步层只按 `type` 分发 stateless 消息，载荷由这里解析（`parseAgentRunsMessage`）。
 */
export interface FlowAgentChannel {
  onStateless: (type: string, handler: (payload: string) => void) => () => void
  /** 协同连接通不通；每次从断到通都重新 `GET` 一次面板快照，补上没连着那段时间的变化 */
  connected: Ref<boolean>
}

export interface FlowAgentOptions {
  /** 这张画布是什么；只决定**显示**（项目画布才标发起人），`null` = 元信息还没回来 */
  mode?: Ref<FlowMode | null>
  /** 当前登录用户（没开登录时为 null —— 那时从服务端给的 `mine` 里学出自己的 id） */
  user?: Ref<{ id: string; name: string | null; avatarUrl: string | null } | null>
  /** 我是不是这张画布所属项目的管理员 —— 决定能不能停别人的一轮（服务端照样把关） */
  isAdmin?: Ref<boolean>
  channel?: FlowAgentChannel
  /**
   * 会话的入口节点（docs/20 §3.10.9、docs/07 §7.5）：给了就是导演台里的那一份对话 —— 新会话的第一条消息带上 `nodeId`
   * （服务端只记下入口，不限制工具），续聊不带（服务端从会话里读）。
   */
  nodeId?: Ref<string | null>
  /**
   * 打开画布时要不要把服务端给的 `latest`（我最近的会话，不论绑没绑节点）摆到对话区，默认要。
   * 导演台的对话面板不要：它自己挑入口是这个节点的那个会话。
   */
  adoptLatest?: boolean
}

/**
 * 画布 Agent 的对话（REQ-AGENT，docs/20 §3.10.3–§3.10.5）：任务列表、看 / 发 / 接回 / 停、切换 / 新建会话。
 *
 * **不挂进编辑器上下文**，也**不要在组件里直接调**：对话框和工具栏快捷输入共用一份，
 * 由 `agent-panel.ts` 的 `provideFlowAgentPanel()` 在编辑器根视图调一次（调两次就是两条流）。
 * 对话框收起时组件仍挂着（`v-show`），所以这里的状态和正在读的流都不会因为收起而断。
 *
 * agent 对画布的改动**不走这条流**：它们经协同层进 Y.Doc，和别人的编辑一样实时到达。
 * 这条流只讲「agent 在说什么、在做什么」。
 *
 * **并发单位是会话**：这张画布上可以同时有好几轮（不同会话、不同的人）。
 * - **任务列表**（`activeRuns`）：打开时 `GET` 一次，之后只收协同连接上的 `agent:runs` 推送（全量，直接替换），
 *   重连时再 `GET` 一次。没有轮询。
 * - **只有「当前会话在跑」才挡发送**（`running`）；别人的、我别的会话里的都不挡。
 * - **一轮不随这条流存亡**：切会话、新会话、换画布、刷新都只断本地的读（服务端那一轮照跑，留在任务列表里），
 *   只有停止按钮（`POST …/runs/:runId/abort`）会中止它。切回一个在跑的会话（自己的或别人的）时
 *   订阅它的事件流，补发 + 后续事件照常折叠进去（「接回」/「旁观」，同一条路）。
 * - 接不回来（404 已经结束 / 410 补发缓冲溢出 / 流断了）→ 不打扰用户，等任务列表说它结束了再重新拉会话。
 */
export function useFlowAgent(flowId: Ref<string>, options: FlowAgentOptions = {}) {
  /** 服务端配没配模型（最近一次快照）；null = 还没拿到 */
  const session = ref<{ enabled: boolean } | null>(null)
  const loading = ref(false)
  const loadError = ref<string | null>(null)
  const conversation = reactive(emptyConversation())
  /** 当前显示的会话 id；null = 新会话（第一条消息发出去、RUN_STARTED 回来才有 id） */
  const conversationId = ref<string | null>(null)
  /** 当前会话的标题（原文，可含提及）；新会话为 null */
  const title = ref<string | null>(null)
  /** 当前会话的发起人；新会话为 null（那就是我） */
  const owner = ref<AgentUserView | null>(null)
  /** 当前会话是不是我的 —— 别人的只读：不能发、不能删（新会话恒为 true） */
  const mine = ref(true)
  /** 正在读接回 / 旁观的那条事件流（当前会话的） */
  const resuming = ref(false)
  /** 本窗口在当前会话里发起的一轮还在读它的流 */
  const localTurn = ref(false)

  /** 这张画布上在跑的任务（原样，不带 `mine`；`mine` 按当前用户现算） */
  const runList = ref<AgentRunEntry[]>([])
  /** 没开登录时，从服务端给的 `mine` 里学到的自己的 id */
  const learnedSelfId = ref<string | null>(null)
  const selfId = computed(() => options.user?.value?.id ?? learnedSelfId.value)

  /**
   * 每换一张画布 +1。在途的请求、流里的事件都带着发起时的值，对不上就丢 ——
   * 否则上一张画布的 agent 回复会流进这一张的对话里。
   */
  let generation = 0
  /** 对话区每换一次内容 +1（`display`）；读着的流只往发起时那份对话里折叠 */
  let viewSeq = 0
  /** 每次**用户**主动切换会话（打开 / 新建）+1：连点两个会话时只认最后一次，在途的接回也作废 */
  let switchSeq = 0
  /** 正在读的那条流；切会话、换画布、卸载时掐掉（只掐本地的读，不替用户中止服务端那一轮） */
  let stream: AbortController | null = null
  /** 正在准备接回的那一轮（拉会话中）：任务列表这时候再变也别重复接 */
  let attachingRunId: string | null = null
  /**
   * 这一轮接不回来了（410 / 流断了）—— 别再试着订阅它，等它结束。
   * 不记的话，任务列表里它还挂着时会「接回 → 失败 → 再接回」地空转。
   */
  let unresumableRunId: string | null = null
  /** 那一轮结束之后要重新拉的会话（它的 assistant 消息要到结束才落库） */
  let staleConversationId: string | null = null
  /** 本地已经看着它收尾的轮次：迟到的推送 / 快照里再出现也不当它还在跑 */
  const finishedRuns = new Set<string>()
  /** 本窗口发起的轮次 —— 推送回来时从它的 owner 学到自己的 id（没开登录时） */
  const localRunIds = new Set<string>()
  /** 每收一次推送 +1；`GET` 回来时若期间收到过推送，快照里的任务列表比推送旧，不用它 */
  let pushSeq = 0

  const showOwners = computed(() => options.mode?.value === "collab")

  /** 全部在跑的任务，按开始时刻升序，带上「是不是我的」 */
  const activeRuns = computed<AgentActiveRunView[]>(() => {
    const id = selfId.value
    return [...runList.value]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((run) => ({ ...run, mine: (id !== null && run.owner.id === id) || localRunIds.has(run.runId) }))
  })

  /** 当前会话正在跑的那一轮（任何人的）；新会话没有 */
  const currentRun = computed(() => {
    const id = conversationId.value
    return id ? (activeRuns.value.find((run) => run.conversationId === id) ?? null) : null
  })

  /** 当前会话在跑：本窗口发起的、接回 / 旁观的，或者任务列表里有它（接不回来在等的也算） */
  const running = computed(() => localTurn.value || resuming.value || currentRun.value !== null)

  function readingTurn() {
    return localTurn.value || resuming.value
  }

  function learnSelf(id: string | null | undefined) {
    if (id && !options.user?.value) learnedSelfId.value = id
  }

  /** 掐掉本地正在读的流（服务端那一轮照跑） */
  function detach() {
    stream?.abort()
    stream = null
    resuming.value = false
    localTurn.value = false
  }

  /** 把一个会话（或 null = 新会话空状态）摆到对话区；正在读的流随之断开 */
  function display(view: AgentConversationView | null) {
    detach()
    viewSeq++
    conversationId.value = view?.id ?? null
    title.value = view?.title ?? null
    owner.value = view?.owner ?? null
    mine.value = view ? view.mine : true
    if (view?.mine) learnSelf(view.owner.id)
    Object.assign(conversation, emptyConversation(view ? [...view.messages] : []))
  }

  /**
   * 服务端生成的会话标题（docs/20 §3.9「会话标题」，CUSTOM `agent.conversation-title`）：
   * 是当前会话就换掉头部的标题；任务列表里那个会话的一项也换（推送晚到时先显示新的）
   */
  function applyTitleEvent(event: AgentStreamEvent) {
    if (event.type !== "CUSTOM" || event.name !== AGENT_CONVERSATION_TITLE_EVENT) return
    const update = parseAgentConversationTitle(event.value)
    if (!update) return
    if (conversationId.value === update.conversationId) title.value = update.title
    if (runList.value.some((run) => run.conversationId === update.conversationId && run.conversationTitle !== update.title)) {
      runList.value = runList.value.map((run) =>
        run.conversationId === update.conversationId ? { ...run, conversationTitle: update.title } : run
      )
    }
  }

  // —— 任务列表 ——

  /**
   * 每一项按本机时钟的过期时刻（docs/20 §3.4、§3.10.8）：服务端的 `expiresAt` 减去它发出时的时钟（`now`）就是还剩多久，
   * 加到本机收到的时刻上 —— 两边时钟对不上也不会让标签提前消失。到点还没收到新的就去掉那一项（副本崩溃时没人发「离开」）。
   * 没有 `expiresAt` 的（老载荷、本地乐观插入的）不按时过期。
   */
  const deadlines = new Map<string, number>()
  let expiryTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleExpiry() {
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = null
    let next = Infinity
    for (const run of runList.value) next = Math.min(next, deadlines.get(run.runId) ?? Infinity)
    if (next === Infinity) return
    expiryTimer = setTimeout(dropExpired, Math.max(0, next - Date.now()))
  }

  function dropExpired() {
    expiryTimer = null
    const now = Date.now()
    const alive = runList.value.filter((run) => (deadlines.get(run.runId) ?? Infinity) > now)
    if (alive.length !== runList.value.length) {
      for (const run of runList.value) if (!alive.includes(run)) deadlines.delete(run.runId)
      runList.value = alive
      afterRunsChanged()
    }
    scheduleExpiry()
  }

  /** @param serverNow 这份列表发出时服务端的时钟（载荷的 `now`）；没有就当两边时钟一致 */
  function setRuns(entries: readonly AgentRunEntry[], serverNow?: number) {
    const received = Date.now()
    deadlines.clear()
    for (const run of entries) {
      if (run.expiresAt !== undefined) deadlines.set(run.runId, received + (run.expiresAt - (serverNow ?? received)))
    }
    runList.value = entries.filter(
      (run) => run.conversationId && !finishedRuns.has(run.runId) && (deadlines.get(run.runId) ?? Infinity) > received
    )
    for (const run of runList.value) {
      if (localRunIds.has(run.runId)) learnSelf(run.owner.id)
    }
    scheduleExpiry()
  }

  /** 本地确知这一轮结束了：先从列表里拿掉，不等推送 */
  function markRunFinished(runId: string) {
    finishedRuns.add(runId)
    if (runList.value.some((run) => run.runId === runId)) {
      runList.value = runList.value.filter((run) => run.runId !== runId)
    }
  }

  /**
   * 任务列表变了之后：接不回来在等的那一轮结束了就重拉它的会话；当前会话里有一轮在跑而本窗口没在读，就接上去。
   * @param fresh 刚拿到的当前会话内容（打开 / 切换时手里就有），有就不再拉一次
   */
  function afterRunsChanged(fresh: AgentConversationView | null = null) {
    if (unresumableRunId && !runList.value.some((run) => run.runId === unresumableRunId)) {
      unresumableRunId = null
    }
    const stale = staleConversationId
    // 那个会话里已经没有在跑的了：拿落定的 assistant 消息（还在跑的话下面会接上去，接回时会重拉）
    if (stale && !runList.value.some((run) => run.conversationId === stale)) {
      staleConversationId = null
      if (stale === conversationId.value && !readingTurn()) {
        if (fresh?.id === stale) display(fresh)
        else void reloadConversation(stale)
      }
    }
    maybeAttach(fresh)
  }

  function maybeAttach(fresh: AgentConversationView | null) {
    if (readingTurn()) return
    const run = currentRun.value
    if (!run || run.runId === unresumableRunId || run.runId === attachingRunId) return
    void attach(run, fresh)
  }

  function onRunsMessage(payload: string) {
    const parsed = parseAgentRunsMessage(payload)
    // 换画布时的残留、或者读不懂的：丢掉（解析器本身不抛）
    if (!parsed || parsed.flowId !== flowId.value) return
    pushSeq++
    setRuns(parsed.runs, parsed.now)
    afterRunsChanged()
  }

  // —— 快照 ——

  /**
   * 收下一份 `GET {agentApiPath}` 快照。
   * @param adopt 要不要把 `latest` 摆到对话区 —— 打开画布时要；重连时不要（用户可能已经切到了别的会话）
   */
  function applySession(view: AgentSessionView, adopt: boolean, pushesBefore: number) {
    session.value = { enabled: view.enabled }
    for (const run of view.activeRuns) if (run.mine) learnSelf(run.owner.id)
    // 期间收到过推送：推送比这份快照新
    if (pushesBefore === pushSeq) setRuns(view.activeRuns, view.now)
    if (adopt && options.adoptLatest !== false && !readingTurn()) display(view.latest)
    afterRunsChanged(view.latest && view.latest.id === conversationId.value ? view.latest : null)
  }

  async function fetchSession(adopt: boolean) {
    const ticket = generation
    const pushes = pushSeq
    const view = await agentApi.session(flowId.value)
    if (ticket === generation) applySession(view, adopt, pushes)
  }

  async function load() {
    const ticket = generation
    loading.value = true
    loadError.value = null
    try {
      await fetchSession(true)
    } catch (error) {
      if (ticket !== generation) return
      loadError.value = error instanceof Error ? error.message : "加载对话失败"
    } finally {
      if (ticket === generation) loading.value = false
    }
  }

  /** 静默地重新问一次服务端（重连、接回失败之后）。失败了不报错 —— 下次重连 / 推送会补上 */
  async function refresh() {
    const ticket = generation
    // 首次加载失败过：这次成功就当是首次加载
    const adopt = session.value === null && !loading.value
    try {
      await fetchSession(adopt)
      if (ticket === generation && adopt) loadError.value = null
    } catch (error) {
      console.warn("[agent] 刷新任务列表失败", error)
    }
  }

  async function reloadConversation(id: string) {
    const ticket = generation
    const seq = switchSeq
    try {
      const view = await agentApi.conversation(flowId.value, id)
      if (ticket === generation && seq === switchSeq && conversationId.value === id && !readingTurn()) {
        display(view)
      }
    } catch (error) {
      // 拉不到就留着现在这份：这一轮的结果以画布上的实际内容为准，不值得为它弹提示
      console.warn("[agent] 重新拉取会话失败", error)
    }
  }

  // —— 接回 / 旁观 ——

  /**
   * 订阅当前会话正在跑的那一轮：摆好会话内容，补发 + 后续的一起折叠进去。
   * 自己的叫接回，别人的叫旁观（只读），走同一条路。收尾事件到了就从任务列表里拿掉；
   * 接不回来就记下来、等它结束再重拉会话 —— 都不弹提示。
   */
  async function attach(run: AgentActiveRunView, fresh: AgentConversationView | null) {
    const ticket = generation
    const seq = switchSeq
    const id = flowId.value
    attachingRunId = run.runId
    let view = fresh?.id === run.conversationId ? fresh : null
    try {
      // 手里那份可能是这一轮开始之前拿的（里面没有这一轮的用户消息）：重拿一次
      view ??= await agentApi.conversation(id, run.conversationId)
    } catch (error) {
      console.warn("[agent] 接回时拉取会话失败", error)
      if (attachingRunId === run.runId) attachingRunId = null
      return
    }
    if (attachingRunId === run.runId) attachingRunId = null
    // 拉会话期间换了画布、切了会话、或者本窗口自己发起了一轮：这次接回作废
    if (ticket !== generation || seq !== switchSeq || conversationId.value !== run.conversationId || readingTurn()) {
      return
    }

    display(view)
    // 刚拉的就是最新的：之前记下的「等它结束再重拉」作废（这一轮接下来要么看完，要么重新记上）
    if (staleConversationId === run.conversationId) staleConversationId = null
    const myView = viewSeq
    resumeTurn(conversation, run.runId)
    resuming.value = true
    const controller = new AbortController()
    stream = controller
    /** 补发的 RUN_STARTED 说这一轮属于另一个会话：别折叠进错的会话 */
    let wrongConversation = false
    let outcome: "finished" | "gone" | "wait"
    try {
      await agentApi.runEvents(id, run.runId, {
        signal: controller.signal,
        onEvent: (event) => {
          if (ticket !== generation || myView !== viewSeq || wrongConversation) return
          if (event.type === "RUN_STARTED" && event.threadId !== conversationId.value) {
            wrongConversation = true
            controller.abort()
            return
          }
          applyTitleEvent(event)
          applyAgentEvent(conversation, event)
        }
      })
      // 流读完了却没等到收尾事件（代理掐断、断网）：那一轮多半还在跑
      outcome = conversation.finished ? "finished" : "wait"
    } catch (error) {
      if (!wrongConversation && (controller.signal.aborted || ticket !== generation)) {
        // 切会话 / 换画布 / 卸载时本地掐掉的：什么都不做
        return
      }
      // 404 = 已经结束了；410 = 补发缓冲溢出；其余（网络、会话对不上）一样当成「等它结束」
      outcome = !wrongConversation && error instanceof ApiError && error.status === 404 ? "gone" : "wait"
    } finally {
      if (stream === controller) stream = null
      if (myView === viewSeq) resuming.value = false
    }
    if (ticket !== generation || myView !== viewSeq) return

    if (outcome === "finished") {
      // 从头到尾看完了，手里这份就是落定的
      markRunFinished(run.runId)
      return
    }
    unresumableRunId = run.runId
    staleConversationId = run.conversationId
    if (outcome === "gone") {
      // 已经结束了：问一次服务端（它不在任务列表里了 → 重拉这个会话）
      markRunFinished(run.runId)
      void refresh()
    }
    // 还在跑：等推送（或下一次重连的快照）说它结束了
  }

  // —— 切换 ——

  /**
   * 发起新会话：只是前端把当前会话置空，不发请求 —— 第一条消息发出去时服务端才建会话。
   * 当前会话在跑也可以：只断本地的读，那一轮照跑、留在任务列表里。
   */
  function newConversation(): boolean {
    switchSeq++
    display(null)
    return true
  }

  /** 切到某个已有会话并加载它（在跑的就接上它的事件流）；失败抛异常（会话还是原来的） */
  async function openConversation(id: string): Promise<boolean> {
    if (id === conversationId.value) return true
    const ticket = generation
    const seq = ++switchSeq
    const view = await agentApi.conversation(flowId.value, id)
    // 换了画布、又点了别的会话：这份响应过期了
    if (ticket !== generation || seq !== switchSeq) return false
    display(view)
    maybeAttach(view)
    return true
  }

  function reset() {
    generation++
    switchSeq++
    detach()
    attachingRunId = null
    unresumableRunId = null
    staleConversationId = null
    finishedRuns.clear()
    localRunIds.clear()
    runList.value = []
    deadlines.clear()
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = null
    session.value = null
    loadError.value = null
    display(null)
  }

  // —— 发送 ——

  /** 本窗口刚收到 RUN_STARTED：先把这一轮放进任务列表，不等推送（没连着协同时也有角标） */
  function noteLocalRun(runId: string, threadId: string, prompt: string, entryNodeId: string | null) {
    localRunIds.add(runId)
    if (finishedRuns.has(runId) || runList.value.some((run) => run.runId === runId)) return
    const me = options.user?.value
    runList.value = [
      ...runList.value,
      {
        runId,
        conversationId: threadId,
        conversationTitle: title.value ?? prompt.slice(0, AGENT_TITLE_MAX_LENGTH),
        owner: { id: selfId.value ?? "", name: me?.name ?? "我", avatarUrl: me?.avatarUrl ?? null },
        startedAt: Date.now(),
        ...(entryNodeId ? { nodeId: entryNodeId } : {}),
        // 本地乐观插入的这一项还不知道占用了什么，也不按时过期（推送来了就被替换）
        occupies: []
      }
    ]
  }

  /**
   * 发一条 prompt（可带附件，docs/20 §3.10.12），跑完一整轮（或被切走）才 resolve。
   *
   * 返回 `true` = 服务端接下了这一轮（之后怎么收尾都在对话里展示）；
   * 抛异常 = 这一轮根本没开始，乐观插入的那条已经撤回 —— 调用方据此把输入框的字和附件还回去。
   * 附件是已经传完的（键 + 文件名 + 地址 + 类型）：请求里只带键和文件名，其余的服务端按上传记录补，
   * 乐观插入的那条先用本地这份显示，回显（`agent.user-message`）到了换成服务端那份。
   */
  async function sendTurn(text: string, attachments: readonly AgentAttachment[] = []): Promise<boolean> {
    const prompt = text.trim()
    if (!prompt && attachments.length === 0) return false
    if (!mine.value) throw new Error("这是别人的会话，只能查看")
    if (prompt.length > AGENT_PROMPT_MAX_LENGTH) {
      throw new Error(`消息太长了，最多 ${AGENT_PROMPT_MAX_LENGTH} 字`)
    }

    const ticket = generation
    const id = flowId.value
    const optimistic: Extract<AgentChatMessage, { role: "user" }> = {
      id: `local-user-${Date.now()}`,
      role: "user",
      text: prompt,
      createdAt: Date.now(),
      ...(attachments.length > 0 ? { attachments: attachments.map((item) => ({ ...item })) } : {})
    }
    /** 只发附件时的标题，同服务端（会话标题、任务列表里先用它） */
    const titleText = prompt || `[附件] ${attachments.map((item) => item.name).join("、")}`
    beginTurn(conversation, optimistic)
    const myView = viewSeq
    localTurn.value = true
    const current = () => ticket === generation && myView === viewSeq

    const controller = new AbortController()
    stream = controller
    let accepted = false
    let runId: string | null = null
    /** 新会话才带 nodeId（续聊时服务端从会话里读，给了反而 400）；续聊时入口也还是它 */
    const entryNodeId = options.nodeId?.value ?? null
    const newNodeId = conversationId.value === null ? entryNodeId : null
    /** 流开了但没读到收尾：服务端那一轮多半还在跑，结束后去接回 / 重拉 */
    let interrupted = false
    try {
      await agentApi.send(
        id,
        {
          text: prompt,
          conversationId: conversationId.value,
          ...(newNodeId ? { nodeId: newNodeId } : {}),
          ...(attachments.length > 0 ? { attachments: attachments.map(({ key, name }) => ({ key, name })) } : {})
        },
        {
          signal: controller.signal,
          onOpen: () => {
            accepted = true
          },
          onEvent: (event) => {
            if (ticket !== generation) return
            if (event.type === "RUN_STARTED") {
              runId = event.runId
              noteLocalRun(event.runId, event.threadId, titleText, entryNodeId)
            }
            // 切走了：这一轮照跑，事件不再往对话区里折叠
            if (myView !== viewSeq) return
            // 新会话由服务端在这一轮开始时建好，id 在 threadId 里带回来
            if (event.type === "RUN_STARTED") {
              conversationId.value = event.threadId
              title.value ??= titleText.slice(0, AGENT_TITLE_MAX_LENGTH)
            }
            applyTitleEvent(event)
            applyAgentEvent(conversation, event)
          }
        }
      )
      if (current() && !conversation.finished) {
        interruptTurn(conversation)
        interrupted = true
      }
      return true
    } catch (error) {
      // 切走 / 换画布 / 卸载时本地掐掉的：不是错误，什么都不说（服务端那一轮照跑，回来时接回）
      if (controller.signal.aborted || ticket !== generation) return accepted
      if (accepted) {
        // 流开了之后断的：对话里先标成中断，别弹 toast
        if (current()) {
          interruptTurn(conversation)
          interrupted = true
        }
        return true
      }
      if (current()) rollbackTurn(conversation)
      // 409：这个会话已经有一轮在跑而这边不知道（自己在另一个标签页发起的）—— 问一次，接上去
      if (error instanceof ApiError && error.status === 409) void refresh()
      throw explainSendError(error)
    } finally {
      if (stream === controller) stream = null
      if (myView === viewSeq) localTurn.value = false
      if (ticket === generation) {
        // 读到了收尾事件：它确实结束了
        if (runId && !interrupted && conversation.finished && myView === viewSeq) markRunFinished(runId)
        if (interrupted) {
          // 问一次服务端：还在跑就接回（补发会把这一轮从头拼出来），已经结束就重拉这个会话
          unresumableRunId = null
          staleConversationId = conversationId.value
          void refresh()
        }
      }
    }
  }

  const { run: send, pending: sending } = useAsyncAction(sendTurn, {
    errorMessage: "发送失败"
  })

  /** 当前会话在跑、而我能停它：我自己的，或者我是项目管理员 */
  const canStop = computed(
    () => running.value && (mine.value || (options.isAdmin?.value ?? false))
  )

  const { run: abort, pending: aborting } = useAsyncAction(
    async () => {
      const ticket = generation
      // 停的是「当前会话这一轮」：读着的那条流的 runId，没有就是任务列表里它那一轮
      const runId = conversation.runId ?? currentRun.value?.runId ?? null
      if (!runId) return
      await agentApi.abort(flowId.value, runId)
      // 读着流的话收尾事件自己会到；读不到（接不回来在等）就问一次
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

  const stopListening = options.channel?.onStateless(AGENT_RUNS_MESSAGE, onRunsMessage)
  if (options.channel) {
    // 连上 / 重连：补上没连着那段时间的变化（推送只发给连着的人）
    watch(options.channel.connected, (now, before) => {
      if (now && !before) void refresh()
    })
  }

  onBeforeUnmount(() => {
    generation++
    detach()
    stopListening?.()
    if (expiryTimer) clearTimeout(expiryTimer)
  })

  return {
    session,
    loading,
    loadError,
    reload: load,
    conversationId,
    title,
    /** 当前会话的发起人（新会话为 null） */
    owner,
    /** 当前会话是不是我的；false = 只读 */
    mine,
    /** 项目画布才显示发起人（个人画布上只有自己） */
    showOwners,
    newConversation,
    openConversation,
    /** 对话列表（含这一轮正在流式拼出来的那条） */
    messages: computed(() => conversation.messages),
    /**
     * 当前会话正在跑（任何人的）。为真时发送换成停止（能停的话）；**只挡当前会话**，不挡切走、不挡新会话。
     */
    running,
    /** 这张画布上在跑的全部任务（项目画布是所有成员的，个人画布只有自己的），按开始时刻升序 */
    activeRuns,
    canStop,
    send,
    sending,
    abort,
    aborting
  }
}

/** 发送请求被拒时给人看的话 */
function explainSendError(error: unknown): Error {
  if (error instanceof ApiError) {
    if (error.status === 409) return new Error("这个会话已经有一轮 agent 正在运行，等它结束或先停止它")
    if (error.status === 403) return new Error("这是别人的会话，只能查看，不能继续对话")
    if (error.status === 503) return new Error("服务端未配置模型，暂时用不了 agent")
  }
  return error instanceof Error ? error : new Error("发送失败")
}

export type FlowAgent = ReturnType<typeof useFlowAgent>
