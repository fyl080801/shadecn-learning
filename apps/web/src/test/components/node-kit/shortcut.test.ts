import { afterEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, ref } from "vue"
import { mount, type VueWrapper } from "@vue/test-utils"

import { createNodeKitRuntime } from "@/components/flow/node-kit/context"
import { defineNodeAction, defineNodeFeature } from "@/components/flow/node-kit/protocol"
import { createNodeKit } from "@/components/flow/node-kit/registry"
import { matchesShortcut, parseShortcut } from "@/components/flow/node-kit/shortcut"
import type { FlowEditorContext } from "@/composables/flow/editor-context"
import { useFlowShortcuts } from "@/composables/flow/useFlowShortcuts"
import { fakeContext } from "./fake-context"

/**
 * 动作快捷键：写法与匹配、按键交给选中节点的动作、编辑器自己的全局键优先。
 */

vi.mock("vue-router", () => ({ onBeforeRouteLeave: () => undefined }))

const Icon = defineComponent({ render: () => null })

function key(keyName: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) {
  return new KeyboardEvent("keydown", {
    key: keyName,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    cancelable: true
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("快捷键的写法与匹配", () => {
  it("Mod 认 Meta 或 Ctrl；修饰键精确匹配；键名大小写不敏感", () => {
    const modD = parseShortcut("Mod+D")
    expect(matchesShortcut(modD, key("d", { meta: true }))).toBe(true)
    expect(matchesShortcut(modD, key("d", { ctrl: true }))).toBe(true)
    expect(matchesShortcut(modD, key("d"))).toBe(false)
    expect(matchesShortcut(modD, key("D", { meta: true, shift: true }))).toBe(false)

    const ungroup = parseShortcut("mod + shift + g")
    expect(matchesShortcut(ungroup, key("G", { meta: true, shift: true }))).toBe(true)

    expect(matchesShortcut(parseShortcut("F2"), key("F2"))).toBe(true)
  })

  it("写错的快捷键解析失败", () => {
    expect(() => parseShortcut("Ctrl+D")).toThrow(/Ctrl|ctrl/)
    expect(() => parseShortcut("Mod+Shift")).toThrow(/键名/)
    expect(() => parseShortcut("")).toThrow()
  })

  it("注册表装配期校验会报出写错的快捷键", () => {
    const kit = createNodeKit()
    kit.registerFeature(
      defineNodeFeature({
        id: "f",
        actions: [defineNodeAction({ id: "bad", slot: "toolbar", icon: Icon, label: "坏", shortcut: "Hyper+X", run: () => undefined })]
      })
    )
    expect(kit.validate()).toEqual([expect.stringContaining("bad")])
  })
})

function setup(extra: Partial<Parameters<typeof defineNodeAction>[0]> = {}) {
  const kit = createNodeKit()
  const run = vi.fn()
  kit.registerFeature(
    defineNodeFeature({
      id: "dup",
      actions: [defineNodeAction({ id: "dup", slot: "toolbar", icon: Icon, label: "复制", shortcut: "Mod+D", run, ...extra })]
    })
  )
  kit.registerType({ type: "t", features: ["dup"] })
  const runtime = createNodeKitRuntime(kit)
  const ctx = fakeContext(kit, "n1", "t")
  runtime.hosts.set("n1", ctx)
  return { kit, runtime, run, ctx }
}

describe("按键交给节点的动作", () => {
  it("命中：以节点上下文执行动作，返回 true", async () => {
    const { runtime, run, ctx } = setup()
    expect(runtime.dispatchShortcut("n1", key("d", { meta: true }))).toBe(true)
    await Promise.resolve()
    expect(run).toHaveBeenCalledWith(ctx)
  })

  it("没命中 / 节点不在画布上：返回 false，什么都不执行", () => {
    const { runtime, run } = setup()
    expect(runtime.dispatchShortcut("n1", key("e", { meta: true }))).toBe(false)
    expect(runtime.dispatchShortcut("gone", key("d", { meta: true }))).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it("动作此刻不出现（when 为假）：快捷键也不触发，不接走", () => {
    const { runtime, run } = setup({ when: () => false })
    expect(runtime.dispatchShortcut("n1", key("d", { meta: true }))).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it("动作置灰（enabled 为假）：接走但不执行 —— 落空的 Mod+D 也不该弹出浏览器的加书签", () => {
    const { runtime, run } = setup({ enabled: () => false })
    expect(runtime.dispatchShortcut("n1", key("d", { meta: true }))).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it("和按钮共用一把锁：上一次还没跑完，再按一次被丢掉", async () => {
    let finish: () => void = () => undefined
    const { runtime, run, ctx, kit } = setup({ run: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))) })
    const action = kit.allActionsFor("t")[0]!
    void runtime.actions.run(ctx, action)
    expect(runtime.actions.isPending("n1", "dup")).toBe(true)

    runtime.dispatchShortcut("n1", key("d", { meta: true }))
    finish()
    await Promise.resolve()
    expect(action.run).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
  })
})

describe("useFlowShortcuts", () => {
  let wrapper: VueWrapper | null = null
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  /** 选中的节点 n1 上挂一个绑在 `shortcut` 上的动作 */
  function mountShortcuts(selectedNodeId: string | null, shortcut = "Mod+D") {
    const { runtime, run } = setup({ shortcut })
    const undo = vi.fn()
    const context = {
      store: { undo, redo: vi.fn() },
      canvas: { deleteSelection: vi.fn() },
      document: { flushBeforeLeave: vi.fn() },
      selection: { selectedNodeId: ref(selectedNodeId) },
      nodeKit: runtime
    } as unknown as FlowEditorContext
    wrapper = mount(
      defineComponent({
        setup() {
          useFlowShortcuts(context)
          return () => h("div")
        }
      })
    )
    return { undo, run }
  }

  it("单独选中一个节点：它的动作快捷键生效，浏览器默认行为被拦住", async () => {
    const { run } = mountShortcuts("n1")
    const event = key("d", { meta: true })
    window.dispatchEvent(event)
    await Promise.resolve()

    expect(run).toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it("没有单独选中的节点：节点动作的快捷键不生效", () => {
    const { run } = mountShortcuts(null)
    const event = key("d", { meta: true })
    window.dispatchEvent(event)

    expect(run).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it("在输入框里按：交给输入本身，不触发节点动作", () => {
    const { run } = mountShortcuts("n1")
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true, bubbles: true }))
    input.remove()

    expect(run).not.toHaveBeenCalled()
  })

  it("编辑器自己的全局键优先：节点动作也绑了 Mod+Z，按下去仍然是撤销", async () => {
    const { undo, run } = mountShortcuts("n1", "Mod+Z")
    window.dispatchEvent(key("z", { meta: true }))
    await Promise.resolve()

    expect(undo).toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
