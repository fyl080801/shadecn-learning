import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { nextTick } from "vue"

import { Collapsible } from "@/components/ui/collapsible"
import PipelineTree from "@/components/galstory/PipelineTree.vue"
import type { PipelineStep } from "@/composables/useGalStoryRun"

/**
 * 流水线上**一组**的渲染。
 *
 * ⚠️ **分组不在这里做**（那是 `useGalStoryRun.belongsTogether` 的事，测试在
 * `galStoryTimeline.test.ts`）：这个组件只负责把已经分好的一组画成「父步骤 + 级联子项」。
 *
 * 这里**跑真的 reka-ui Stepper**（房子的规矩：component test 只 stub `@/lib/api`），
 * 故它同时验着那套原语挂不挂得起来 —— 纵向 stepper 写错是**渲染层面**的静默错误，
 * 类型检查一个字都不会说。
 */

let seq = 0
function step(partial: Partial<PipelineStep> & { step: string }): PipelineStep {
  return {
    id: ++seq,
    label: partial.step,
    elapsed: 1,
    attempt: 1,
    error: "",
    turn: 1,
    phase: "perform",
    // 缺省是「一位演员」。**取料/核验传 `attached: true`** —— 那是引擎的说法
    // （`progress.ATTACHED_STEPS`），而它们的 `role` 照样有值：折回哪一位靠的就是它。
    role: "actor",
    attached: false,
    form: "complete",
    inputTokens: 100,
    outputTokens: 50,
    tokensEstimated: false,
    at: seq,
    who: "",
    ...partial
  }
}

function render(steps: PipelineStep[], running = false) {
  return mount(PipelineTree, { props: { steps, running } })
}

/**
 * 展开**两层**（①这一段 → ②每一位）。
 *
 * ⚠️ **不点 DOM 按钮**：reka 的 trigger 在 jsdom 里点不动（它要真实指针事件），而那是组件库
 * 自己的事。折叠着的内容**压根不在 DOM 里**（`CollapsibleContent` 会卸载）—— 那不是测试的
 * 技术细节，正是这个面板的设计。
 *
 * ⚠️ 得**逐层**来：②那几个 `Collapsible` 在①展开之前根本没被挂载。
 */
async function settle() {
  // ⚠️ 一次 `nextTick` 不够：`CollapsibleContent` 是**打开之后**才挂内容的，②那几个
  // `Collapsible` 要等这一层渲染完才存在（实测第一轮 tick 后仍只找得到①那一个）。
  for (let i = 0; i < 4; i += 1) await nextTick()
}

async function expand(wrapper: ReturnType<typeof render>) {
  wrapper.findComponent(Collapsible).vm.$emit("update:open", true)
  await settle()
  // ②每一位（第 0 个是①那一层，跳过）
  for (const lane of wrapper.findAllComponents(Collapsible).slice(1)) {
    lane.vm.$emit("update:open", true)
  }
  await settle()
}

describe("这一组叫什么", () => {
  it("建档那几步合起来叫「初始化」", () => {
    const wrapper = render([
      step({ step: "content_normalization", phase: "bootstrap", role: "world" }),
      step({ step: "public_profiles", phase: "bootstrap", role: "world" })
    ])

    expect(wrapper.text()).toContain("初始化")
  })

  it("演出那一段叫「剧本演绎」—— 组名是阶段，谁在做分在下一层", () => {
    const wrapper = render([
      step({ step: "render_role", who: "Fuwawa" }),
      step({ step: "render_scene", who: "", role: "scene" })
    ])

    expect(wrapper.text()).toContain("剧本演绎")
  })

  it("**写回也是「谁在做」在下一层** —— 抬头说的是这一段在干什么", async () => {
    const wrapper = render([
      step({ step: "summarize_for", phase: "writeback", who: "Mococo" }),
      step({ step: "update_relations", phase: "writeback", who: "Mococo" })
    ])
    await expand(wrapper)
    const text = wrapper.text()

    expect(text).toContain("知识写回")     // ① 这一段在干什么
    expect(text).toContain("演员 · Mococo") // ② 谁在做
    expect(text).toContain("知识归纳")      // ③ 他做的每一件事
  })
})

describe("子项级联展开", () => {
  it("**哪个演员在干什么**：②是「谁」，③才是他做的几件事", async () => {
    const wrapper = render([
      step({ step: "render_role", label: "角色演出中", who: "Fuwawa" }),
      step({ step: "render_scene", who: "", role: "scene" })
    ])
    await expand(wrapper)
    const text = wrapper.text()

    expect(text).toContain("演员 · Fuwawa")   // ②
    expect(text).toContain("场景")            // ②
    expect(text).toContain("演员演出")         // ③
  })

  it("⚠️ **只有一位时也不折掉②那一层** —— 「谁在做」得有个固定的位置", async () => {
    // 折掉之后「谁在做」有时在第二层、有时在第一层，读的人每次都要重新找；更糟的是
    // 「认知检索」「知识写回」这种**不是 agent 的东西**会顶到 agent 的位置上。
    const wrapper = render([
      step({ step: "content_normalization", phase: "bootstrap", role: "world" }),
      step({ step: "public_profiles", phase: "bootstrap", role: "world" })
    ])
    await expand(wrapper)
    const text = wrapper.text()

    expect(text).toContain("初始化")      // ①
    expect(text).toContain("世界")        // ② —— 只有这一位，但它照样在
    expect(text).toContain("建档归一化")   // ③
    expect(text).toContain("公开人物志")
  })

  it("**取料不单独占一行** —— 它折进它服务的那一位", async () => {
    // 单看一行 `cognition`，它连是替谁取的料都说不出；折进去之后，那一行才回答得了
    // 「这个演员刚才干了什么」。
    const wrapper = render([
      step({ step: "cognition", phase: "retrieve", attached: true, who: "Fuwawa" }),
      step({ step: "render_role", who: "Fuwawa" }),
      step({ step: "render_scene", who: "", role: "scene" })
    ])
    await expand(wrapper)

    // ②那一层的 trigger：`text-[11px]` 且**不是** baseline 对齐的那种（③是 baseline）
    const rows = wrapper.findAll("button").filter(
      (b) => b.classes().includes("text-[11px]") && !b.classes().includes("items-baseline")
    )
    // 演员一行 + 世界一行，**没有**第三行给取料
    expect(rows).toHaveLength(2)
  })

  it("还在跑的那一位带一个「此刻在做什么」的标签", async () => {
    const wrapper = render(
      [
        step({ step: "render_role", who: "Fuwawa" }),
        step({ step: "cognition", phase: "retrieve", attached: true, label: "检索认知",
               who: "Mococo" })
      ],
      true
    )
    await expand(wrapper)

    expect(wrapper.text()).toContain("检索认知")
  })

  it("**跑完就不再显示那个标签** —— 它是个状态，不是一条记录", async () => {
    const wrapper = render([
      step({ step: "render_role", who: "Fuwawa" }),
      step({ step: "cognition", phase: "retrieve", attached: true, label: "检索认知",
             who: "Mococo" }),
      step({ step: "render_role", label: "角色演出中", who: "Mococo" })
    ])
    await expand(wrapper)
    const trigger = wrapper.findAll("button").find((b) => b.text().includes("Mococo"))!

    expect(trigger.text()).not.toContain("检索认知")
  })

  it("折叠时看得出有几位（那个数本身有信息）", () => {
    const wrapper = render([
      step({ step: "render_role", who: "Fuwawa" }),
      step({ step: "render_role", who: "Mococo" })
    ])

    expect(wrapper.text()).toMatch(/剧本演绎[\s\S]{0,20}2/)
  })

  it("正在跑的那一组默认就是展开的", () => {
    const wrapper = render(
      [step({ step: "render_role", who: "Fuwawa" }), step({ step: "render_scene", role: "scene" })],
      true
    )

    expect(wrapper.text()).toContain("演员 · Fuwawa")
  })
})

describe("看得出出了什么事", () => {
  it("失败的那一步标出来", async () => {
    const wrapper = render([
      step({ step: "integrate", phase: "integrate", role: "director", error: "上游 502" })
    ])
    await expand(wrapper)

    expect(wrapper.text()).toContain("上游 502")
  })

  it("重发看得见 —— 同一位连着几条不是重复", async () => {
    const wrapper = render([
      step({ step: "render_role", who: "Fuwawa", attempt: 1 }),
      step({ step: "render_role", who: "Fuwawa", attempt: 2 })
    ])
    await expand(wrapper)

    expect(wrapper.text()).toContain("第 2 次尝试")
  })

  it("空组不渲染任何东西（空态由页面统一说）", () => {
    expect(render([]).text()).toBe("")
  })
})

describe("纵向连线", () => {
  it("**用组件库自己的 separator**，不自己拿 div 画一条", () => {
    // 它跟着根上的 `orientation` 走、还带着本 item 的 `data-state`（走完了变色）——
    // 自己画的话这两样都得在这里拿三元表达式重写一遍，而它们本来就是这套原语的全部价值。
    const wrapper = render([step({ step: "plan", phase: "plan", role: "director" })])

    const line = wrapper.find('[data-orientation="vertical"][role="none"]')
    expect(line.exists()).toBe(true)
  })
})

describe("点某一次调用 = 想看它的详情", () => {
  it("把那一条原样抛出去，**自己不开面板** —— 详情摆在哪由页面定", async () => {
    const steps = [step({ step: "render_role", who: "Fuwawa" })]
    const wrapper = render(steps, true)
    await expand(wrapper)

    // ③那一层的每一条都是一个按钮（②那一层的 trigger 也在 `text-[11px]` 那档，
    // 故按**有没有 `items-baseline`**分开 —— ③是 baseline 对齐的那种）
    const call = wrapper.findAll("button").find((b) => b.classes().includes("items-baseline"))!
    await call.trigger("click")

    expect(wrapper.emitted("select")).toBeTruthy()
  })

  it("正看着的那一条要高亮 —— 否则右边显示的是哪一步得靠猜", async () => {
    const steps = [step({ step: "render_role", who: "Fuwawa" })]
    const wrapper = render(steps, true)
    await wrapper.setProps({ selectedId: steps[0]!.id })
    await expand(wrapper)

    expect(wrapper.findAll("button").filter((b) => b.classes().includes("ring-1"))).toHaveLength(1)
  })
})
