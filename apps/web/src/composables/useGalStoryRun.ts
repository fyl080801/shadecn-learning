import { computed, ref, shallowRef } from "vue"

import { GalStoryError, followRun, runApi, saveApi } from "@/lib/galstory"
import type {
  GameState,
  PipelineEvent,
  PlayerOption,
  RunEvent,
  TurnReport
} from "@/types/galstory"

/**
 * 一局的驱动：发起一轮 + 跟事件流 + 把事件翻译成界面要的三样（叙事、流水线、状态）。
 *
 * ## 为什么发起与跟随是**两条**口
 *
 * 引擎那一侧刻意分开：`POST .../turns` 立刻回 202，`GET .../events` 是**纯附着**。
 * 这样「刷新页面」的自然动作（GET）在语义上**不可能**演一轮 —— 只有一条 POST 口的话，
 * 重连与再演一轮在客户端长得一模一样，刷一次页面就把同一个意图演两遍。
 *
 * ## 断线重连靠 `seq`
 *
 * 每条事件带序号，重连时带上最后收到的那个，引擎补发之后的；少了一段它会先发一条
 * `events_dropped` 明说少了几条 —— 静默跳过在界面上与「引擎卡住了」没有分别。
 *
 * ## 这里**不**做的事
 *
 * 不解析、不加工叙事文本。玩家读到的那一段是引擎经 `integrate` 汇总、再按视角落过词的产物，
 * 前端多做一层处理只会有机会把它弄坏。
 */

/** 聊天流里的一条。`pending` 的那条是玩家刚发出、还没被引擎确认吃掉的 */
export interface ChatMessage {
  id: string
  role: "player" | "narrative"
  text: string
  pending?: boolean
  /** 到达时刻（与流水线共用时钟）—— 穿成一条瀑布流时按它排 */
  at: number
  /**
   * 这条是**流式落定**的稿子（汇总一写完就摆出来），还没被 `CUSTOM:turn` 的终稿换掉。
   *
   * ⚠️ 它与终稿的差别只在称呼（未收宏、未按展示策略落词），内容是同一段；换掉时通常一个字
   * 都不变。留这个标记是为了**认得出该换哪一条** —— 而不是为了在界面上把它标成「临时的」。
   */
  draft?: boolean
}

/** 流水线上的一步（由 `CUSTOM:progress` 累积而成） */
export interface PipelineStep {
  id: number
  step: string
  label: string
  elapsed: number
  /** 第几次传输尝试。**同一环节连着几条不是重复**，是它重发过 */
  attempt: number
  error: string
  /** 属于哪一轮。⚠️ 一次 run 可能连演两轮（转场后引擎自动接开场轮），故树要按它分组 */
  turn: number
  /** 归哪个阶段。**引擎给的**（见 `PipelineEvent.phase`），前端只渲染 */
  phase: string
  /**
   * 是**哪一位 agent**：`director` / `actor` / `scene` / `player` —— **全局就这四位**
   * （引擎自己那套 scope 词表）。同样**引擎给的**，与 `phase` 正交。
   * 空串 = 这一次说不出是谁（导演的全知视角就是空的）。
   */
  role: string
  /**
   * 这一步**单独占一行吗**。取料与核验不占（它们是当次调用的一部分）—— 但上面那个 `role`
   * 照样说得出是替谁做的，故它折回那一位名下，而不是变成一位没有名字的 agent。
   */
  attached: boolean
  /** 这次调用的形态：`complete` / `chat` / … */
  form: string
  inputTokens: number
  outputTokens: number
  /** token 是服务端给的还是按字符估的 —— 估的那种别当成账单 */
  tokensEstimated: boolean
  /** 到达时刻（与消息共用时钟） */
  at: number
  /** 替谁跑（已按玩家认知落词）。空 = 这一步不针对某个角色 */
  who: string
}

/**
 * **消息与流水线共用一个到达时钟。**
 *
 * ⚠️ 两边各记各的序号是不行的：界面要把它们按**到达顺序**穿成一条瀑布流
 * （建档 → 开场白 → 排这一轮 → 逐步演出 → 汇总的那段叙事 → 收束与写回），
 * 而那个顺序只有「谁先到」说得清 —— 分成两个计数器就没法比较了。
 */
/**
 * 瀑布流里的一段：要么是一条对话，要么是**连着跑的一串 agent 步骤**。
 *
 * ⚠️ **一个 agent 一段**（同一环节 + 同一个「谁」的连续调用并在一起），**不是把整串步骤塞进
 * 一个框**：那样导演、每个演员、汇总全挤成一坨，看不出「谁接着谁」。分段之后它们与叙事在
 * 同一条流上交错往下走 —— 那正是「先有这些步骤、才有这段话」的可读形态。
 */
export type Segment =
  | { kind: "message"; at: number; message: ChatMessage }
  | { kind: "steps"; at: number; steps: PipelineStep[] }

let clock = 0
const tick = () => ++clock
const nextId = () => `m${tick()}`

/**
 * 进度载荷 → 流水线的一步。**实时与回放共用这一处** —— 分两份写的话，刷新前后显示的
 * 是同一轮却长得不一样，而那不会报错。
 */
function toStep(p: PipelineEvent, id: number, at: number): PipelineStep {
  return {
    id,
    step: p.step,
    label: p.label,
    elapsed: p.elapsed ?? 0,
    attempt: p.attempt ?? 1,
    error: p.error ?? "",
    turn: p.turn ?? 0,
    phase: p.phase || "other",
    // ⚠️ **`??` 而不是 `||`**：空串是引擎在说「这一步是附着型」（取料/核验），而**键不在**
    // 才是「这条轨迹比 `role` 这个字段还老」—— 两者的正确降级相反，合成一个就把老轨迹里的
    // 每一步都当成了附着型，那一整轮会折成一行空的。
    role: p.role ?? "other",
    attached: Boolean(p.attached),
    form: p.form ?? "",
    inputTokens: p.inputTokens ?? 0,
    outputTokens: p.outputTokens ?? 0,
    tokensEstimated: Boolean(p.tokensEstimated),
    at,
    who: p.who ?? ""
  }
}

/**
 * 消息 id 里的轮号（`3-u` / `3-a`，见引擎 `history.thread_messages`）。
 *
 * 回放时要把轨迹与消息**按轮穿插**回去，而这是唯一一处能把一条历史消息对到某一轮上的线索。
 * 认不出就返回 0（开场白那条的 id 是个 uuid，它本来就排在所有轮次之前）。
 */
function turnOf(id: string): number {
  const m = /^(\d+)-[ua]$/.exec(id)
  return m ? Number(m[1]) : 0
}

/**
 * **附着型**：不单独占一行，是某位 agent 那次调用的一部分（取料 / 核验）。
 *
 * ⚠️ 判据是引擎给的 `attached`（`progress.ATTACHED_STEPS`），前端不按环节名再认一次 ——
 * 那就是同一个判据两处声明，而引擎新增一个附着型环节时这边不会有任何东西提醒。
 *
 * ⚠️ **它照样有归属**（`role`/`who`）：取料的视角就是那一位，核验继承它所核验的那次调用。
 * 「附着」说的只是「不单独占一行」。
 */
function isAttached(step: PipelineStep): boolean {
  return step.attached
}

/**
 * 这一步该不该并进**当前这一组**。
 *
 * ⚠️ **判据是引擎给的 `phase`**（初始化 / 导演 / 剧本演绎 / 玩家演绎 / 导演汇总 / 选项 /
 * 写回），前端不自己按环节名再归一次 —— 谁在谁下面是**执行顺序**的事实，出处是引擎那张图。
 *
 * 「是哪一位、具体是谁」**分在组内那几行上**（`agentLanes`），不拿来分组：带上 `who` 的话，
 * 剧本演绎与写回都会按角色碎成 N 组，而对读的人那本来就是一段。
 *
 * 附着型（取料 / 核验）**一律并进当前组**，它不自己占一格。
 *
 * ⚠️ **跨轮一律断开**；一条对话插进来也会断开（`timeline` 里 message 段天然隔断），
 * 「agent 行为与叙事交错」这件事因此是**结构性**的，不靠这里判。
 */
function belongsTogether(group: readonly PipelineStep[], next: PipelineStep): boolean {
  const head = group[0]
  if (!head) return false
  if (head.turn !== next.turn) return false          // 跨轮一律断开
  // 附着型先都收着 —— 它属于哪一段要等**正主**到了才知道（见 `stealTrailingAttached`）
  if (isAttached(next)) return true
  // 拿**最后一个不是附着型**的那条比：附着型自己没有阶段上的归属
  const last = [...group].reverse().find((x) => !isAttached(x))
  if (!last) return true
  // ⚠️ **只比阶段，不比是谁**：「谁在做」永远在下一层（`agentLanes`）。写回那一段曾经在这里
  // 按 agent 拆过，为的是躲开「知识写回」那个抬头 —— 而正确的解法是让 agent 那一层**从不折叠**，
  // 拆在这里只会让同一件事有两种分组规则。
  return last.phase === next.phase
}

/**
 * 一组里的**一行**：某一位 agent 做的一件事，含它自己的取料与核验。
 *
 * ⚠️ **行的单位是「谁做了什么」，不是「哪次调用」**：此前一位演员在这里要占两行（先一条
 * `cognition`、再一条 `render_role`），而那两行合起来才回答得了「这个演员刚才干了什么」——
 * 单看 `cognition` 那一行，它连是替谁取的料都说不出。
 */
export interface AgentLane {
  key: string
  /**
   * 这一行的**主调用**（折进来的取料/核验不算它）。详情面板要看的就是它。
   *
   * 正主还没跑完时（只有取料到了）退回那条取料 —— 那正是「此刻在取料」的形态。
   */
  main: PipelineStep
  /** 是哪一位（`director` / `actor` / `scene` / …）。空 = 正主还没跑完，只有取料到了 */
  role: string
  /** 角色真名。空 = 这一位不是角色（导演、场景、汇总…） */
  who: string
  /** 这一行的全部调用（含折进来的取料与核验） */
  steps: PipelineStep[]
  /** 合计耗时 —— 折叠着的时候要看得出这一行花了多久 */
  elapsed: number
  /** **此刻在做什么**（最后那次调用的说明）。跑完了就不该显示它，由渲染层判 */
  activity: string
}

/**
 * 一组步骤 → 折成几行。
 *
 * ⚠️ **附着型往后并，不往前**：取料跑在生成**之前**，它属于**接下来**那一位，不属于刚跑完的
 * 那一位。往前并的话，每个演员的取料都会被记到导演头上。核验跑在**之后**，它天然落在当前
 * 这一位身上 —— 两者由「攒着、等下一次真正的调用」这一条统一处理，因为核验后面紧接着的
 * 一定还是同一位（`step`/`who` 都相同），会被并回同一行。
 *
 * 末尾还攒着没并出去的（正主还没跑完）→ **单独成一行**，主调用就是那条取料。等正主到了，
 * 下一次重算自然把它并回去。
 */
/**
 * 上一段尾巴上那几条**取料**，如果它们其实是替 `owner` 取的，就还给他。
 *
 * ⚠️ **取料跑在生成之前**，故一位新 agent 的取料是**下一段的开头**，不是上一段的尾巴 ——
 * 而收到它的那一刻还不知道接下来是谁，只能先并进当前段。等正主到了、发现要另起一段时，
 * 再把属于他的那几条领回去。
 *
 * 不这么做的话，演员的取料会留在「规划剧本」那一段里，于是**同一位演员出现两次**：一次只
 * 带着取料挂在导演那段下面，一次才是他真的演出那段。
 *
 * ⚠️ **只领走认得出主人、且确实是自己的那几条**：说不出主人的（导演早期那种）留在原地，
 * 别猜。核验跑在**之后**，它本来就该留在上一段（那正是它服务的那一位）。
 */
function stealTrailingAttached(prev: PipelineStep[], owner: PipelineStep): PipelineStep[] {
  const moved: PipelineStep[] = []
  while (prev.length) {
    const tail = prev[prev.length - 1]!
    if (!isAttached(tail) || !tail.role) break
    if (tail.role !== owner.role || tail.who !== owner.who) break
    moved.unshift(prev.pop()!)
  }
  return moved
}

/**
 * 这一行的「谁」。
 *
 * ⚠️ **只有演员与玩家才有名字**：导演与场景（世界）各只有一位，给它们挂个名字反而是错的 ——
 * 建档时世界 agent **按 observer 各跑一次**给每个人建初次印象，那个 observer 是它**作用的
 * 对象**，不是「另一位场景 agent」。拿它去分行的话，初始化那一段会碎成「场景 · 甲」
 * 「场景 · 乙」几行，而跑它们的自始至终是同一位。对象仍看得到 —— 它落在下一层每一条上。
 */
function laneWho(step: PipelineStep): string {
  return step.role === "actor" || step.role === "player" ? step.who : ""
}

export function agentLanes(steps: readonly PipelineStep[]): AgentLane[] {
  const out: AgentLane[] = []
  let pending: PipelineStep[] = []

  const push = (items: PipelineStep[], main: PipelineStep) => {
    out.push({
      key: `${main.role}|${laneWho(main)}|${items[0]!.id}`,
      main,
      role: main.role,
      who: laneWho(main),
      steps: items,
      elapsed: items.reduce((sum, x) => sum + x.elapsed, 0),
      activity: items[items.length - 1]!.label
    })
  }

  for (const step of steps) {
    if (isAttached(step)) {
      const prev = out[out.length - 1]
      // ⚠️ **认得出主人就并回主人那一行**（核验跑在生成**之后**，主人是**上一位**）；
      // 认不出、或主人还没出现（取料跑在生成**之前**）才攒着等下一位。
      // 只往前并的话，某位的核验会被记到**下一位**头上 —— 而那正是隔壁那一位没做过的事。
      if (prev && step.role && prev.role === step.role && prev.who === laneWho(step)) {
        prev.steps.push(step)
        prev.elapsed += step.elapsed
        prev.activity = step.label
        continue
      }
      pending.push(step)
      continue
    }
    const last = out[out.length - 1]
    // 同一位连着做的几件事并成一行（写回那几步、以及重发）；中间插了新的取料就另起一位
    if (last && last.role === step.role && last.who === laneWho(step) && pending.length === 0) {
      last.steps.push(step)
      last.elapsed += step.elapsed
      last.activity = step.label
      // ⚠️ **主调用换成最新那次**：连着并进来的那些里，算数的是最后一次（重发时前面几次是
      // 传输失败）。留着第一次的话，详情面板打开的是那个失败的尝试，「第 N 次尝试」也永远
      // 显示 1 —— 重发就在界面上消失了。
      last.main = step
      continue
    }
    push([...pending, step], step)
    pending = []
  }
  if (pending.length) push(pending, pending[0]!)
  return out
}

/** 线程历史 → 聊天气泡。`GET /messages` 与 `MESSAGES_SNAPSHOT` 是同一形状，故只写一份 */
function toChat(list: readonly unknown[]): ChatMessage[] {
  return list
    .map((raw) => raw as { id?: string; role?: string; content?: string })
    .filter((m) => (m.content ?? "").trim())
    .map((m) => ({
      id: m.id ?? nextId(),
      role: m.role === "user" ? ("player" as const) : ("narrative" as const),
      text: m.content ?? "",
      at: tick()
    }))
}

export function useGalStoryRun(saveId: string) {
  const state = shallowRef<GameState | null>(null)
  const messages = ref<ChatMessage[]>([])
  const options = ref<PlayerOption[]>([])
  /** 本轮的流水线。**每轮清空**：它是「这一轮走到哪了」，不是一份历史账 */
  const pipeline = ref<PipelineStep[]>([])
  const running = ref(false)
  /** 引擎那侧正在做的大阶段（装配 / 演出…），给流水线一个抬头 */
  const phase = ref("")
  const error = ref<unknown>(null)
  /** 这一局演完了（没有可继续的场景）—— 此后不该再让人发消息 */
  const finished = ref(false)
  /**
   * 汇总正在边生成边吐的那一段（`CUSTOM:narrative_delta`）。
   *
   * ⚠️ **它是草稿，不是终稿**：这份是未收宏、未按展示策略落词的原文，可能与最终那段有细微
   * 出入（`naming.transparent: true` 时终稿用真名，而流里是玩家认知下的公共指代）。方向是
   * 安全的 —— 流里的称呼只会比终稿**窄**。故 `CUSTOM:turn` 一到就拿终稿**整个换掉**它。
   */
  const streaming = ref("")

  let controller: AbortController | null = null
  /**
   * 最后收到的事件序号。
   *
   * ⚠️⚠️ **`seq` 是每条 run 各自从 1 起的，不是全局单调的**（`Run._seq`）。所以换一条 run
   * 就**必须归零**，否则第二轮拿着第一轮的尾号去 `?after=`，引擎会把序号不大于它的全部跳过
   * —— 症状是「第二轮明明跑完了，界面上一条消息、一步流水线都没有」。
   *
   * 它只在**同一条 run 内**才有续传的意义（断线重连）。故用 `followingRunId` 把这件事钉死。
   */
  let lastSeq = 0
  let followingRunId = ""
  let stepSeed = 0

  /** 组件卸载时必须调：不 abort 的话那个读循环会一直挂着 */
  function dispose() {
    controller?.abort()
    controller = null
  }

  /**
   * 把落盘的历史与执行轨迹**按轮穿插**成刷新前那条瀑布流。
   *
   * 一轮里的顺序是固定的：玩家那一步（`{turn}-u`）→ 这一轮跑的那些 agent 步骤 →
   * 汇总出来的叙事（`{turn}-a`）。⚠️ 认不出轮号的（开场白那条 id 是 uuid）排在最前 ——
   * 它本来就发生在第一轮之前。
   */
  function restore(history: readonly unknown[], trace: readonly PipelineEvent[]) {
    const chat = toChat(history)          // 先拿到气泡（`at` 随后重排）
    const byTurn = new Map<number, PipelineEvent[]>()
    for (const item of trace) {
      const turn = item.turn ?? 0
      byTurn.set(turn, [...(byTurn.get(turn) ?? []), item])
    }

    const restored: ChatMessage[] = []
    const steps: PipelineStep[] = []
    const turns = [...new Set([...chat.map((m) => turnOf(m.id)), ...byTurn.keys()])].sort(
      (a, b) => a - b
    )
    let seq = 0
    for (const turn of turns) {
      for (const m of chat.filter((x) => turnOf(x.id) === turn && x.role === "player")) {
        restored.push({ ...m, at: tick() })
      }

      // ⚠️ **叙事插在 `integrate` 之后，不是整轮步骤之后**：那段叙事就是汇总那一步写出来的，
      // 而它后面还排着转场判定、玩家选项与知识写回。全堆在叙事前面的话，刷新之后的顺序
      // 与当时看到的对不上 —— 而当时看到的才是真实发生的顺序。
      const rows = byTurn.get(turn) ?? []
      const cut = rows.map((r) => r.step).lastIndexOf("integrate")
      const before = cut >= 0 ? rows.slice(0, cut + 1) : rows
      const after = cut >= 0 ? rows.slice(cut + 1) : []

      for (const p of before) steps.push(toStep(p, ++seq, tick()))
      for (const m of chat.filter((x) => turnOf(x.id) === turn && x.role === "narrative")) {
        restored.push({ ...m, at: tick() })
      }
      for (const p of after) steps.push(toStep(p, ++seq, tick()))
    }
    messages.value = restored
    pipeline.value = steps
    stepSeed = seq
  }

  function applyState(next: GameState) {
    state.value = next
    options.value = next.options
    finished.value = next.finished
  }

  /**
   * 读回这一局的状态。**返回「这一局装配过没有」。**
   *
   * ⚠️⚠️ **刻意不调 `POST /saves/{id}/open`**，尽管那条口就是干这个的。理由是**装配这件事
   * 首次要跑建档**（归一化 + 公开人物志 + 按 observer 分调的初次印象 + 泄密判定，几十次模型
   * 调用，几分钟起步），而把它做成一次阻塞的 HTTP 请求有两个后果：一是任何一层的超时都会把它
   * 掐掉（实测就是这么炸的，界面上还显示成「连不上后端」）；二是那几分钟里前端**一个字都收不到**，
   * 只能干转圈。
   *
   * 而演一轮那条 `POST .../turns` 的 worker **自己会装配**（`phase: opening_session`），
   * 建档的每一次模型调用都经进度事件流出来。所以正确的做法是：这里只用 GET 探一下，
   * 装配与建档交给第一轮去做 —— 玩家看到的是流水线在走，而不是一个空白的加载条。
   *
   * `GET /state` 在没装配时**409 并指路**（引擎拒绝替调用方决定花那笔钱），那不是错误，
   * 是一个要分流的状态。
   */
  async function probe(): Promise<boolean> {
    error.value = null
    try {
      applyState(await saveApi.state(saveId))
      // ⚠️ **历史要单独拉一次**：`lastNarrative` 只有**最后一段**，拿它当历史的话点「继续」
      // 进来就只看得到一段（实测就是这个症状）。事件流那条 `MESSAGES_SNAPSHOT` 也补历史，
      // 但它只在开一次 run 且客户端没带消息时才发 —— 中途续玩根本不会触发它。
      try {
        // **历史与轨迹一起拉**，再按轮穿插回去 —— 那就是刷新前看到的那条瀑布流
        const [history, trace] = await Promise.all([
          saveApi.messages(saveId),
          saveApi.trace(saveId).catch(() => [] as PipelineEvent[])
        ])
        restore(history, trace)
      } catch {
        // 历史拉不到不该挡住进对局：退回那一段，至少接得上文
        const last = state.value?.lastNarrative?.trim()
        if (last) messages.value = [{ id: nextId(), role: "narrative", text: last, at: tick() }]
      }
      return true
    } catch (err) {
      // 409 = 还没装配过。**这是正常路径**（刚建的存档就是这样），交给第一轮去装配。
      if (err instanceof GalStoryError && err.status === 409) return false
      error.value = err
      throw err
    }
  }

  function onEvent(event: RunEvent, seq: number) {
    lastSeq = seq
    switch (event.type) {
      case "CUSTOM":
        return onCustom(event)
      // ⚠️ **TEXT_MESSAGE_* 刻意不处理**。引擎每一轮把同一段文本发**两遍**：一遍是
      // `_assistant_message`（拼好的一条 assistant 消息，让任何 AG-UI 客户端零改造就能渲染），
      // 一遍是 `CUSTOM:turn`（结构化）。两个都收就会把每段叙事显示两次。
      // 这里选后者，因为它把**玩家那一步**与**导演的汇总**分成两个字段 —— 聊天界面要的正是
      // 两个气泡，而拼好的那条把它们连在了一起，拆不开。
      case "MESSAGES_SNAPSHOT": {
        // 客户端一条消息都没带时（开场轮就是这样）引擎会补这条线程的历史。**整个替换**。
        const list = event.messages
        if (Array.isArray(list)) {
          messages.value = toChat(list)
          // 快照把整个列表换掉了，锚点跟着挪到末尾，否则它指向的是上一份列表里的位置
              }
        return
      }
      case "STATE_SNAPSHOT":
        if (event.snapshot) applyState(event.snapshot as GameState)
        return
      case "RUN_ERROR":
        // ⚠️ 错误也走事件流（这个端点的出口只有 SSE），故它**不是**异常，是一条事件
        error.value = new Error(String(event.message ?? event.code ?? "这一轮没演成"))
        running.value = false
        return
      case "RUN_FINISHED":
        running.value = false
        return
      default:
        return
    }
  }

  function onCustom(event: RunEvent) {
    switch (event.name) {
      case "progress": {
        const p = event.value as PipelineEvent
        // ⚠️ **先记这一步、再摆叙事**：`integrate` 那一步**产生**了这段叙事，瀑布流上就该
        // 排在它前面（「先有这些步骤、才有这段话」）。反过来写的话，产生它的那一步会显示在
        // 它后面 —— 顺序一眼就是错的。
        pipeline.value.push(toStep(p, ++stepSeed, tick()))
        // ⚠️ **汇总一写完就把叙事摆出来，别等 `CUSTOM:turn`**。那条回执要等这一轮**全部**跑完
        // ——转场判定、玩家选项、还有提交事务里的知识写回（`summarize_for`/`digest_*`），
        // 实测又是十几到几十秒。而叙事在 `integrate` 结束的那一刻就已经生成好了，让它在那儿
        // 顶着一个光标干等，读起来就是「卡住了」。
        if (p.step === "integrate" && streaming.value.trim()) {
          messages.value.push({
            id: nextId(),
            role: "narrative",
            text: streaming.value,
            draft: true,
            at: tick()
          })
          streaming.value = ""
        }
        return
      }
      case "narrative_delta": {
        const delta = (event.value as { delta?: string })?.delta ?? ""
        if (delta) streaming.value += delta
        return
      }
      case "phase":
        phase.value = String((event.value as { phase?: string })?.phase ?? "")
        return
      case "turn": {
        const report = event.value as TurnReport
        streaming.value = ""

        // ① **玩家那条气泡就地落定 —— 保留他自己打的字/选的那一句**。
        //
        // ⚠️⚠️ **刻意不用 `playerNarrative`**（玩家 agent 演绎出的那一步，属于**剧本线**）。
        // 玩家看到并按下的是他自己的那句意图，界面上再把它换成一段第二人称的演绎，读起来就是
        // 「我说的话被改写了」—— 而 agency 正是这里最不该动的东西。演绎那一份仍然照常进剧本线、
        // 进实录、给下游各 agent 读，只是**不摆到玩家面前**。
        //
        // `consumedInput` 为 false 说明这一轮没吃我们的输入（开场轮，或附着到了已经在跑的
        // 那一轮），那条 pending 的气泡就该撤掉 —— 它没有发生。
        const pendingAt = messages.value.findIndex((m) => m.pending)
        if (pendingAt >= 0) {
          if (report.consumedInput) messages.value[pendingAt]!.pending = false
          else messages.value.splice(pendingAt, 1)
        }

        // ② **叙事换掉流式落定的那条**（不是再加一条）。⚠️ 草稿是在 `integrate` 结束时就
        //    摆出来的，那时玩家气泡还没落定 —— 故这里**重新找一次下标**，别用早先算的。
        const draftAt = messages.value.findIndex((m) => m.draft)
        if (report.narrative?.trim()) {
          // ⚠️ **继承草稿那条的到达时刻**：终稿是这一轮末尾才到的，按新时刻排就会掉到
          // 「收束与写回」那几步的后面 —— 而它明明是在汇总那一步产生的。
          const at = draftAt >= 0 ? messages.value[draftAt]!.at : tick()
          const settled: ChatMessage = { id: nextId(), role: "narrative", text: report.narrative, at }
          if (draftAt >= 0) messages.value.splice(draftAt, 1, settled)
          else messages.value.push(settled)
        } else if (draftAt >= 0) {
          // 终稿没给正文（少见）：草稿留着当正文，只撕掉标记
          delete messages.value[draftAt]!.draft
        }

        options.value = report.options ?? []
        if (report.finished) finished.value = true
        return
      }
      case "finished":
        finished.value = true
        return
      case "events_dropped": {
        const n = (event.value as { count?: number })?.count ?? 0
        // 明说少了几条：静默跳过在界面上与「引擎卡住了」一模一样
        pipeline.value.push({
          id: ++stepSeed,
          step: "events_dropped",
          label: `断线期间漏掉了 ${n} 条进度（产物没丢，仍在磁盘上）`,
          elapsed: 0,
          attempt: 1,
          error: "",
          // 挂在**最后见过的那一轮**上；一条都还没收到时挂 0，别凭空造一个轮号
          turn: pipeline.value[pipeline.value.length - 1]?.turn ?? 0,
          phase: "other",
          role: "other",
          attached: false,
          who: "",
          form: "",
          inputTokens: 0,
          outputTokens: 0,
          tokensEstimated: false,
          at: tick()
        })
        return
      }
      default:
        return
    }
  }

  /**
   * 这个存档此刻有没有一轮在跑；有就**附着上去**（不发起任何东西）。
   *
   * ⚠️ 补的是一个真实的洞：演一轮几十秒，这期间刷新页面 / 从故事列表点「回到这一局」进来，
   * 原来什么都不会发生 —— 界面静静地停在那儿，而后台正演着。引擎那条 `GET .../events`
   * 在语义上**不可能**演一轮，所以附着是安全的：它只看。
   */
  async function attach(): Promise<boolean> {
    const inFlight = (await runApi.list()).running.find((r) => r.saveId === saveId)
    if (!inFlight) return false
    // 换了一条 run 就从头收（`seq` 是每条 run 各自从 1 起的，见 `lastSeq` 那条注释）
    if (inFlight.runId !== followingRunId) {
      followingRunId = inFlight.runId
      lastSeq = 0
    }
    running.value = true
    await follow()
    return true
  }

  /**
   * 对话与执行过程**按到达顺序穿成一条**。
   *
   * 这就是那条瀑布流：建档 → 开场白 → 排这一轮 → 逐步演出 → 汇总的那段叙事 → 收束与写回。
   * 排序只认 `at`（共用时钟），故「谁在谁前面」是**记录下来的事实**，不是猜的。
   */
  const timeline = computed<Segment[]>(() => {
    const parts: Segment[] = [
      ...messages.value.map((message) => ({ kind: "message" as const, at: message.at, message })),
      ...pipeline.value.map((step) => ({ kind: "steps" as const, at: step.at, steps: [step] }))
    ].sort((a, b) => a.at - b.at)

    const out: Segment[] = []
    for (const part of parts) {
      const prev = out[out.length - 1]
      if (part.kind !== "steps" || prev?.kind !== "steps") {
        out.push(part.kind === "steps" ? { ...part, steps: [...part.steps] } : part)
        continue
      }
      const next = part.steps[0]!
      if (belongsTogether(prev.steps, next)) {
        prev.steps.push(...part.steps)
        continue
      }
      // 另起一段时，把上一段尾巴上**其实是替我取的**那几条领回来
      out.push({ ...part, steps: [...stealTrailingAttached(prev.steps, next), ...part.steps] })
    }
    return out
  })

  /** 跟事件流直到这一轮结束。断线由调用方决定要不要重来 */
  async function follow() {
    dispose()
    controller = new AbortController()
    try {
      await followRun(saveId, onEvent, { after: lastSeq, signal: controller.signal })
    } catch (err) {
      // 主动 abort 不是错误（组件卸载、换存档）
      if (controller?.signal.aborted) return
      throw err
    } finally {
      running.value = false
    }
  }

  /**
   * 演一轮。`text` 为空 = 开场轮（引擎驱动、不消费输入）。
   *
   * 返回 202 回执里的 `consumedInput` —— 调用方据它决定要不要清空输入框。
   */
  async function play(text: string) {
    if (running.value) return false
    error.value = null
    running.value = true
    // **一做出选择，其余选项立刻消失**：它们已经不是可选项了，留在那儿只会让人以为还能再点
    // 一个（而这一轮正在跑，点了也只会被配额挡回来）。新的选项随 `CUSTOM:turn` 一起来。
    options.value = []
    // ⚠️ **不清空 pipeline**：里面可能有从磁盘回放来的历史轨迹（刷新之后那条瀑布流），
    // 清掉就等于「一发新消息，之前的执行过程全没了」。新的步骤按到达时刻接在后面。
    phase.value = ""
    streaming.value = ""

    if (text.trim()) {
      messages.value.push({ id: nextId(), role: "player", text, pending: true, at: tick() })
    }

    try {
      const accepted = await saveApi.playTurn(saveId, text)
      // 新的一条 run（或换了一条）→ 序号从头来。**这一行是那个「第二轮没消息」的修法**。
      if (accepted.runId !== followingRunId) {
        followingRunId = accepted.runId
        lastSeq = 0
      }
      await follow()
      return accepted.consumedInput
    } catch (err) {
      error.value = err
      running.value = false
      // 这一轮压根没发生，把那条还没落定的气泡撤掉
      const pendingIndex = messages.value.findIndex((m) => m.pending)
      if (pendingIndex >= 0) messages.value.splice(pendingIndex, 1)
      throw err
    }
  }

  return {
    state,
    messages,
    options,
    pipeline,
    phase,
    running,
    streaming,
    timeline,
    finished,
    error,
    probe,
    attach,
    play,
    follow,
    dispose
  }
}
