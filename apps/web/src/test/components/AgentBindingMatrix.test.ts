import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { h } from "vue"

import { TooltipProvider } from "@/components/ui/tooltip"
import AgentBindingMatrix from "@/components/galstory/AgentBindingMatrix.vue"
import type { Binding, ModelConfig } from "@/types/galstory"

/**
 * 配置页那张矩阵**按职能分组**。
 *
 * ⚠️ 组头是引擎里的五位 agent，而**归属由引擎给**（`Binding.role`，判据写在那个环节自己的
 * 模块里）。这里守的是「前端不再按环节名硬编码一张归类表」——那是同一个判据两处声明，
 * 引擎把某个环节从一位挪给另一位时前端不会有任何东西提醒，页面只是默默放错组。
 */

function binding(name: string, role: Binding["role"], shared = false): Binding {
  return {
    name,
    role,
    shared,
    output: "text",
    reasoning: true,
    binding: "thinking",
    kind: "thinking",
    mechanical: false,
    connectionId: "local",
    source: "default",
    resolved: true,
    presetId: "",
    timeoutS: null,
    maxRetries: null,
    wallTimeoutS: null,
    cognition: null,
    timeBudgetS: 40
  }
}

function render(bindings: Binding[]) {
  const config = {
    defaultConnect: "local",
    agentBindings: { thinking: "local", no_thinking: "" },
    connections: [],
    presets: [],
    agents: [],
    bindings,
    // ⚠️ 顺序由**引擎**给（`roster.AGENT_ROLE_IDS`）—— 夹具照给，别让组件回落到本地那份
    roleOrder: ["world", "director", "actor", "scene", "player"],
    issues: [],
    log: null,
    path: "",
    writable: true,
    writeBlockedReason: "",
    format: "yaml"
  } as unknown as ModelConfig
  // 组头那个说明气泡是 reka 的 Tooltip —— 它要求外面有 provider（应用里由 `SidebarProvider` 给）
  return mount(TooltipProvider, {
    slots: { default: () => h(AgentBindingMatrix, { config, issuesByAgent: {} }) }
  })
}

describe("按职能分组", () => {
  it("组头是**五位 agent**，不是路由键", () => {
    const wrapper = render([
      binding("content_normalization", "world"),
      binding("plan", "director"),
      binding("render_role", "actor"),
      binding("render_scene", "scene"),
      binding("render_player", "player")
    ])
    const text = wrapper.text()

    for (const label of ["世界", "导演", "演员", "场景", "玩家"]) {
      expect(text).toContain(label)
    }
  })

  it("**顺序由引擎给**（一轮里它们登场的顺序：建档 → 排这一轮 → 演出 → 玩家那一侧）", () => {
    const wrapper = render([
      binding("render_player", "player"),
      binding("plan", "director"),
      binding("content_normalization", "world")
    ])
    const text = wrapper.text()

    expect(text.indexOf("世界")).toBeLessThan(text.indexOf("导演"))
    expect(text.indexOf("导演")).toBeLessThan(text.indexOf("玩家"))
  })

  it("**核验器单列**：它伺候四位的产出，挂在其中任何一位名下都是错的", () => {
    const wrapper = render([binding("plan", "director"), binding("critique", "director", true)])
    const text = wrapper.text()

    expect(text).toContain("跨位")
    // 判据是引擎给的 `shared`，不是这里按名字认出来的
    expect(text.indexOf("导演")).toBeLessThan(text.indexOf("跨位"))
  })

  it("空的那一位不占一行（那个故事里没有这几步）", () => {
    const wrapper = render([binding("plan", "director")])

    expect(wrapper.text()).not.toContain("场景")
  })

  it("**路由键仍看得见** —— 每一行用徽章说明它走哪一边", () => {
    // `agent_bindings` 那两行由页面在表上方单列成两张卡（换 provider 时要改的就是它俩），
    // 这张表只管「谁在干」+「这一步走哪一边」。
    const row = binding("judge_transition", "director")
    const wrapper = render([{ ...row, reasoning: false }])

    expect(wrapper.text()).toContain("不必思考")
  })
})
