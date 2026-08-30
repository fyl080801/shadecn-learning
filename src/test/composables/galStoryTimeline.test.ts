import { describe, expect, it, vi } from "vitest"

import type { RunEvent } from "@/types/galstory"

/**
 * 瀑布流的顺序判据。
 *
 * 界面要把「agent 干的活儿」与「产出的内容」穿成**一条**：
 * 建档 → 开场白 → 排这一轮 → 逐步演出 → 汇总的那段叙事 → 收束与写回。
 *
 * ⚠️ 这个顺序**不是渲染时排出来的，是记录下来的**（共用一个到达时钟）。最容易坏的是两处：
 * 一是消息与步骤各记各的序号（那就没法比较了），二是终稿替换草稿时**换了新的到达时刻** ——
 * 终稿是这一轮末尾才到的，按新时刻排就会掉到「收束与写回」后面，而它明明产生于汇总那一步。
 */

const events: RunEvent[] = []
let history: unknown[] = []
let traceRows: unknown[] = []

vi.mock("@/lib/galstory", async () => {
  const actual = await vi.importActual<typeof import("@/lib/galstory")>("@/lib/galstory")
  return {
    ...actual,
    saveApi: {
      ...actual.saveApi,
      state: vi.fn(async () => ({
        saveId: "s", story: "", title: "", line: "", epoch: 0, finished: false,
        awaitingOpening: false, stage: { id: "", name: "" }, scene: { id: "", name: "" },
        sceneNo: 1, sceneCount: 1, turn: 2, present: [], options: [], lastNarrative: "",
        player: { id: "user", label: "你" }, notices: []
      })),
      messages: vi.fn(async () => history),
      trace: vi.fn(async () => traceRows),
      playTurn: vi.fn(async () => ({
        saveId: "s",
        runId: "r1",
        accepted: true,
        consumedInput: true,
        epoch: 0
      }))
    },
    runApi: { list: vi.fn(async () => ({ limit: 2, running: [] })) },
    followRun: vi.fn(
      async (_id: string, onEvent: (e: RunEvent, seq: number) => void) => {
        events.forEach((event, i) => onEvent(event, i + 1))
      }
    )
  }
})

/**
 * 引擎那张 `ROLES` 表在夹具里的替身（`gal_server/progress.py`）。
 *
 * ⚠️ **附着型给空串**：认知检索与核验不是「一位 agent」，是某位 agent 正在做的一件事 ——
 * 那正是这里要验的折叠行为的入口判据。
 */
const ROLE_OF: Record<string, string> = {
  plan: "director",
  integrate: "director",
  judge_transition: "director",
  digest_script: "director",
  render_scene: "scene",
  // ⚠️ 建档那几步归**世界**，不是场景：场景 agent 演的是这一场里的环境与时间推移，
  // 世界 agent 干的是开局把这个世界立起来（跑在任何一场之前）
  content_normalization: "world",
  public_profiles: "world",
  world_bootstrap: "world",
  render_player: "player",
  propose_options: "player",
  render_role: "actor",
  summarize_for: "actor",
  update_relations: "actor"
}

/** 取料与核验**不单独占一行**，但照样说得出是替谁做的（`role`/`who` 仍有值） */
const ATTACHED = new Set(["cognition", "critique"])

function progress(step: string, phase: string, turn = 1, who = "", role = ""): RunEvent {
  return {
    type: "CUSTOM",
    name: "progress",
    value: {
      step,
      label: step,
      phase,
      role: role || ROLE_OF[step] || (ATTACHED.has(step) ? "" : "other"),
      attached: ATTACHED.has(step),
      who,
      form: "complete",
      elapsed: 1,
      attempt: 1,
      turn,
      inputTokens: 1,
      outputTokens: 1,
      tokensEstimated: false,
      error: ""
    }
  }
}

/** 一轮真实的到达顺序（照 `_turns` 里的先后） */
function scriptedTurn(): RunEvent[] {
  return [
    progress("plan", "plan"),
    progress("render_role", "perform"),
    progress("render_scene", "perform"),
    // 汇总一写完，草稿就落定成一条叙事
    { type: "CUSTOM", name: "narrative_delta", value: { step: "integrate", delta: "雨还在下。" } },
    progress("integrate", "integrate"),
    // 收束与写回排在叙事之后
    progress("judge_transition", "integrate"),
    progress("summarize_for", "writeback"),
    {
      type: "CUSTOM",
      name: "turn",
      value: {
        turn: 1,
        consumedInput: true,
        playerNarrative: "你推门进去。",
        narrative: "雨还在下，檐角的水线连成一片。",
        playerSegments: [],
        options: [],
        sceneEnded: false,
        finished: false,
        reason: "",
        committedItems: 0,
        retractedItems: 0
      }
    },
    { type: "RUN_FINISHED" }
  ]
}

async function runTurn(script: RunEvent[]) {
  events.length = 0
  events.push(...script)
  const { useGalStoryRun } = await import("@/composables/useGalStoryRun")
  const run = useGalStoryRun("s")
  await run.play("推门进去")
  return run
}

describe("执行过程与产出穿成一条瀑布流", () => {
  it("**一个 agent 一段**，与叙事在同一条流上交错 —— 不是全挤进一个框", async () => {
    const run = await runTurn(scriptedTurn())

    const shape = run.timeline.value.map((part) =>
      part.kind === "message" ? `msg:${part.message.role}` : `steps:${part.steps[0]!.step}`
    )

    // 你那句 → 导演排这一轮 → 剧本演绎 → 汇总 → 汇总写出的那段叙事 → 判定 → 写回
    expect(shape).toEqual([
      "msg:player",
      "steps:plan",
      "steps:render_role",
      "steps:integrate",
      "msg:narrative",
      "steps:judge_transition",
      "steps:summarize_for"
    ])
  })

  it("终稿替换草稿时**继承到达时刻** —— 否则它会掉到写回那几步后面", async () => {
    const run = await runTurn(scriptedTurn())

    const parts = run.timeline.value
    const narrativeAt = parts.findIndex((p) => p.kind === "message" && p.message.role === "narrative")
    const lastSteps = parts.length - 1

    expect(narrativeAt).toBeLessThan(lastSteps)
    // 而且它是终稿（收宏落词之后那一份），不是流式草稿
    const part = parts[narrativeAt]
    if (part?.kind !== "message") throw new Error("那一段该是一条叙事")
    expect(part.message.text).toBe("雨还在下，檐角的水线连成一片。")
    expect(part.message.draft).toBeUndefined()
  })

  it("**剧本演绎自成一段**，段内按演员/场景分行", async () => {
    const { agentLanes } = await import("@/composables/useGalStoryRun")
    const run = await runTurn([
      progress("plan", "plan"),
      progress("cognition", "retrieve", 1, "Fuwawa", "actor"),
      progress("render_role", "perform", 1, "Fuwawa"),
      progress("render_scene", "perform"),
      progress("cognition", "retrieve", 1, "Mococo", "actor"),
      progress("render_role", "perform", 1, "Mococo"),
      { type: "RUN_FINISHED" } as RunEvent
    ])

    const steps = run.timeline.value.filter((p) => p.kind === "steps")
    // 导演一段、剧本演绎一段 —— 阶段是引擎给的（`phase`）
    expect(steps).toHaveLength(2)

    const perform = steps[1]!
    if (perform.kind !== "steps") throw new Error("该有一组步骤")
    // 段内三行：两位演员各一行（各自带着自己的取料）+ 场景
    expect(agentLanes(perform.steps).map((l) => `${l.role}|${l.who}`))
      .toEqual(["actor|Fuwawa", "scene|", "actor|Mococo"])
  })

  it("**写回是一段、谁在做在下一层** —— 分段只看阶段，不看是谁", async () => {
    // 曾经在分段这一层按 agent 拆过，为的是躲开「知识写回」那个抬头 —— 而正确的解法是让
    // agent 那一层**从不折叠**（组件那侧），拆在这里只会让同一件事有两种分组规则。
    const { agentLanes } = await import("@/composables/useGalStoryRun")
    const run = await runTurn([
      progress("summarize_for", "writeback", 1, "Fuwawa"),
      progress("update_relations", "writeback", 1, "Fuwawa"),
      progress("summarize_for", "writeback", 1, "Mococo"),
      { type: "RUN_FINISHED" } as RunEvent
    ])

    const steps = run.timeline.value.filter((p) => p.kind === "steps")
    expect(steps).toHaveLength(1)

    const group = steps[0]!
    if (group.kind !== "steps") throw new Error("该有一组步骤")
    const lanes = agentLanes(group.steps)

    expect(lanes.map((l) => l.who)).toEqual(["Fuwawa", "Mococo"])
    // 同一位连着做的两件事在他自己那一行里
    expect(lanes[0]!.steps.map((x) => x.step)).toEqual(["summarize_for", "update_relations"])
  })

  it("**建档那一段是场景（世界）在跑** —— observer 是它作用的对象，不是另一位 agent", async () => {
    const { agentLanes } = await import("@/composables/useGalStoryRun")
    const run = await runTurn([
      progress("content_normalization", "bootstrap"),
      progress("public_profiles", "bootstrap"),
      progress("world_bootstrap", "bootstrap", 1, "Fuwawa"),
      progress("world_bootstrap", "bootstrap", 1, "Mococo"),
      { type: "RUN_FINISHED" } as RunEvent
    ])

    const group = run.timeline.value.find((p) => p.kind === "steps")
    if (group?.kind !== "steps") throw new Error("该有一组步骤")

    // **一行**：跑它们的自始至终是同一位。按 observer 分行的话，这一段会碎成
    // 「场景 · 甲」「场景 · 乙」几行，而那几位并不存在。
    const lanes = agentLanes(group.steps)
    expect(lanes).toHaveLength(1)
    expect(lanes[0]!.role).toBe("world")
    expect(lanes[0]!.who).toBe("")
    expect(lanes[0]!.steps).toHaveLength(4)
  })

  it("**取料往后并、核验往前并** —— 各自归到它服务的那一位", async () => {
    // 取料跑在生成**之前**（属于接下来那一位），核验跑在**之后**（属于刚跑完那一位）。
    // 都往后并的话，某位的核验会被记到**下一位**头上 —— 而那正是隔壁那位没做过的事。
    const { agentLanes } = await import("@/composables/useGalStoryRun")
    const run = await runTurn([
      progress("cognition", "retrieve", 1, "Fuwawa", "actor"),
      progress("render_role", "perform", 1, "Fuwawa"),
      progress("critique", "verify", 1, "Fuwawa", "actor"),
      progress("cognition", "retrieve", 1, "Mococo", "actor"),
      progress("render_role", "perform", 1, "Mococo"),
      { type: "RUN_FINISHED" } as RunEvent
    ])

    const group = run.timeline.value.find((p) => p.kind === "steps")
    if (group?.kind !== "steps") throw new Error("该有一组步骤")
    const lanes = agentLanes(group.steps)

    expect(lanes.map((l) => l.who)).toEqual(["Fuwawa", "Mococo"])
    expect(lanes[0]!.steps.map((x) => x.step)).toEqual(["cognition", "render_role", "critique"])
    expect(lanes[1]!.steps.map((x) => x.step)).toEqual(["cognition", "render_role"])
  })

  it("取料到了、正主还没跑完 → 那一行先立着，等正主到了自然并回去", async () => {
    const { agentLanes } = await import("@/composables/useGalStoryRun")
    const run = await runTurn([
      progress("cognition", "retrieve", 1, "Fuwawa", "actor"),
      { type: "RUN_FINISHED" } as RunEvent
    ])

    const group = run.timeline.value.find((p) => p.kind === "steps")
    if (group?.kind !== "steps") throw new Error("该有一组步骤")
    const lanes = agentLanes(group.steps)

    expect(lanes).toHaveLength(1)
    expect(lanes[0]!.who).toBe("Fuwawa")
    expect(lanes[0]!.main.step).toBe("cognition")
  })

  it("**导演的取料也归得了位** —— 那条轴上他不再是唯一没有名字的一位", async () => {
    // `viewer=None` 是**全知**（不设视界），不是「以某个 id 看」；但那次取料确实有主人，
    // 就是导演。引擎在「替谁跑」那条轴上给了他 `DIRECTOR_ID`，故这里认得出来。
    const { agentLanes } = await import("@/composables/useGalStoryRun"),
      run = await runTurn([
        progress("cognition", "retrieve", 1, "", "director"),
        progress("plan", "plan"),
        { type: "RUN_FINISHED" } as RunEvent
      ])

    const group = run.timeline.value.find((p) => p.kind === "steps")
    if (group?.kind !== "steps") throw new Error("该有一组步骤")
    const lanes = agentLanes(group.steps)

    // **一行**：取料折进导演那一行，不另立一位说不出主人的 `cognition`
    expect(lanes).toHaveLength(1)
    expect(lanes[0]!.role).toBe("director")
    expect(lanes[0]!.steps.map((x) => x.step)).toEqual(["cognition", "plan"])
  })

  it("**演员的取料不会被拽进导演那一段** —— 同一位演员只出现一次", async () => {
    // 取料跑在生成**之前**，收到它的那一刻还不知道接下来是谁，只能先并进当前段；等正主到了、
    // 发现要另起一段时再领回去。不领的话演员会出现两次：一次只带着取料挂在「规划剧本」下面，
    // 一次才是他真的演出那段。
    const { agentLanes } = await import("@/composables/useGalStoryRun")
    const run = await runTurn([
      progress("cognition", "retrieve", 1, "", "director"),
      progress("plan", "plan"),
      progress("cognition", "retrieve", 1, "Fuwawa", "actor"),
      progress("render_role", "perform", 1, "Fuwawa"),
      { type: "RUN_FINISHED" } as RunEvent
    ])

    const steps = run.timeline.value.filter((p) => p.kind === "steps")
    expect(steps).toHaveLength(2)

    const plan = steps[0]!
    const perform = steps[1]!
    if (plan.kind !== "steps" || perform.kind !== "steps") throw new Error("该有两组步骤")

    // 规划那一段只有导演；演员连着他自己的取料，整个在演绎那一段
    expect(agentLanes(plan.steps).map((l) => l.role)).toEqual(["director"])
    expect(agentLanes(perform.steps).map((l) => l.who)).toEqual(["Fuwawa"])
    expect(perform.steps.map((x) => x.step)).toEqual(["cognition", "render_role"])
  })

  it("**建档那几步合成一组**，不是四段平铺", async () => {
    const run = await runTurn([
      progress("content_normalization", "bootstrap"),
      progress("public_profiles", "bootstrap"),
      progress("world_bootstrap", "bootstrap"),
      progress("critique_impression", "bootstrap"),
      { type: "RUN_FINISHED" } as RunEvent
    ])

    const steps = run.timeline.value.filter((p) => p.kind === "steps")
    expect(steps).toHaveLength(1)
    expect(steps[0]!.kind === "steps" && steps[0]!.steps).toHaveLength(4)
  })

  it("跨轮一律断开 —— 一次 run 可能连演两轮", async () => {
    const run = await runTurn([
      progress("plan", "plan", 3),
      progress("plan", "plan", 4),
      { type: "RUN_FINISHED" } as RunEvent
    ])

    expect(run.timeline.value.filter((p) => p.kind === "steps")).toHaveLength(2)
  })

  it("**「是哪一位」分在组内那几行上，不分成两组**", async () => {
    // 组答的是「现在是哪一位 agent 在忙」，具体是谁由组内那几行各自说。带上 `who` 去分组的话，
    // 写回那一段会按角色碎成 N 组 —— 而对读的人那本来就是同一件事。
    const { agentLanes } = await import("@/composables/useGalStoryRun")
    const run = await runTurn([
      progress("render_role", "perform", 1, "Fuwawa"),
      progress("render_role", "perform", 1, "Fuwawa"),
      progress("render_role", "perform", 1, "Mococo"),
      { type: "RUN_FINISHED" } as RunEvent
    ])

    const steps = run.timeline.value.filter((p) => p.kind === "steps")
    expect(steps).toHaveLength(1)

    const group = steps[0]!
    if (group.kind !== "steps") throw new Error("该有一组步骤")
    const lanes = agentLanes(group.steps)

    // Fuwawa 那两次并成一行（连着的同一位 = 重发），Mococo 另起一行
    expect(lanes.map((l) => l.who)).toEqual(["Fuwawa", "Mococo"])
    expect(lanes[0]!.steps).toHaveLength(2)
  })
})

describe("刷新之后把执行过程显示回去", () => {
  it("轨迹与历史**按轮穿插**回去 —— 玩家那一步 → 这一轮的 agent 步骤 → 汇总的叙事", async () => {
    // ⚠️ 唯一能把一条历史消息对到某一轮上的线索就是 id（`{turn}-u` / `{turn}-a`，
    // 见引擎 `history.thread_messages`）。
    history = [
      { id: "开场白uuid", role: "assistant", content: "雨夜的客栈。" },
      { id: "1-u", role: "user", content: "你推门进去。" },
      { id: "1-a", role: "assistant", content: "第一轮的叙事。" },
      { id: "2-u", role: "user", content: "你坐下。" },
      { id: "2-a", role: "assistant", content: "第二轮的叙事。" }
    ]
    traceRows = [
      { step: "plan", label: "排这一轮", phase: "plan", turn: 1, elapsed: 1, attempt: 1 },
      { step: "integrate", label: "汇总", phase: "integrate", turn: 1, elapsed: 1, attempt: 1 },
      { step: "plan", label: "排这一轮", phase: "plan", turn: 2, elapsed: 1, attempt: 1 }
    ]
    events.length = 0
    const { useGalStoryRun } = await import("@/composables/useGalStoryRun")
    const run = useGalStoryRun("s")
    await run.probe()

    const shape = run.timeline.value.map((p) =>
      p.kind === "message" ? `${p.message.role}:${p.message.text.slice(0, 3)}` : `steps:${p.steps.length}`
    )

    expect(shape).toEqual([
      "narrative:雨夜的",   // 开场白排在所有轮次之前（它的 id 认不出轮号）
      "player:你推门",
      "steps:1",           // 第 1 轮：导演一段
      "steps:1",           //          汇总一段（**一个 agent 一段**）
      "narrative:第一轮",
      "player:你坐下",
      "steps:1",
      "narrative:第二轮"
    ])
  })

  it("拉不到轨迹也要能进对局 —— 老存档就没有这份文件", async () => {
    history = [{ id: "1-a", role: "assistant", content: "只有叙事。" }]
    traceRows = []
    const { useGalStoryRun } = await import("@/composables/useGalStoryRun")
    const run = useGalStoryRun("s")

    await run.probe()

    expect(run.timeline.value.map((p) => p.kind)).toEqual(["message"])
  })
})

describe("玩家那条气泡是他自己的话", () => {
  it("**不拿剧本线的演绎替换掉玩家的输入** —— 那读起来就是「我说的话被改写了」", async () => {
    // 引擎的 `playerNarrative` 是玩家 agent 把意图演绎成的那一步（**剧本线**）。它照常
    // 进实录、给下游各 agent 读，但不该摆到玩家面前 —— agency 是这里最不该动的东西。
    const run = await runTurn(scriptedTurn())

    const player = run.timeline.value.find(
      (p) => p.kind === "message" && p.message.role === "player"
    )
    expect(player?.kind === "message" && player.message.text).toBe("推门进去")
    // 演绎那一份（"你推门进去。"）不该出现在任何一条气泡里
    const texts = run.timeline.value
      .filter((p) => p.kind === "message")
      .map((p) => (p.kind === "message" ? p.message.text : ""))
    expect(texts).not.toContain("你推门进去。")
  })

  it("这一轮没吃我们的输入时，那条气泡要撤掉 —— 它没有发生", async () => {
    const script = scriptedTurn().map((e) =>
      e.name === "turn"
        ? { ...e, value: { ...(e.value as object), consumedInput: false } }
        : e
    )
    const run = await runTurn(script as RunEvent[])

    expect(
      run.timeline.value.some((p) => p.kind === "message" && p.message.role === "player")
    ).toBe(false)
  })

  it("一做出选择，其余选项立刻消失（别等这一轮跑完）", async () => {
    events.length = 0
    events.push({ type: "RUN_FINISHED" })
    const { useGalStoryRun } = await import("@/composables/useGalStoryRun")
    const run = useGalStoryRun("s")
    run.options.value = [
      { id: "a", text: "走过去" },
      { id: "b", text: "站着不动" }
    ]

    const pending = run.play("走过去")
    // 同步就该空了：留在那儿只会让人以为还能再点一个
    expect(run.options.value).toEqual([])
    await pending
  })
})

describe("刷新之后，agent 行为与汇总输出的**穿插**必须还在", () => {
  it("叙事插在 `integrate` 之后 —— 它后面还排着判定、选项与写回", async () => {
    // ⚠️ 把整轮步骤全堆在叙事前面的话，刷新之后的顺序与当时看到的对不上 ——
    // 而当时看到的才是真实发生的顺序（叙事就是汇总那一步写出来的）。
    history = [
      { id: "1-u", role: "user", content: "推门进去" },
      { id: "1-a", role: "assistant", content: "第一轮的叙事。" }
    ]
    traceRows = [
      { step: "plan", label: "排这一轮", phase: "plan", turn: 1, elapsed: 1, attempt: 1 },
      { step: "integrate", label: "汇总", phase: "integrate", turn: 1, elapsed: 1, attempt: 1 },
      { step: "summarize_for", label: "写回", phase: "writeback", turn: 1, elapsed: 1, attempt: 1 }
    ]
    events.length = 0
    const { useGalStoryRun } = await import("@/composables/useGalStoryRun")
    const run = useGalStoryRun("s")
    await run.probe()

    const shape = run.timeline.value.map((p) =>
      p.kind === "message" ? `msg:${p.message.role}` : `steps:${p.steps[0]!.step}`
    )

    expect(shape).toEqual([
      "msg:player",
      "steps:plan",
      "steps:integrate",
      "msg:narrative",       // ← 汇总之后、写回之前
      "steps:summarize_for"
    ])
  })
})
