import { afterEach, describe, expect, it, vi } from "vitest"

import { createNodeModeController } from "@/components/flow/node-kit/modes"
import { defineNodeFeature, defineNodeMode } from "@/components/flow/node-kit/protocol"
import { createNodeKit } from "@/components/flow/node-kit/registry"
import { fakeContext } from "./fake-context"

/**
 * 编辑模式：整张画布同时只有一个节点可编辑；选中别的节点，上一个的编辑以 preempted 退出。
 */

function setup() {
  const kit = createNodeKit()
  const renameExit = vi.fn()
  const promptEnter = vi.fn()
  const promptExit = vi.fn()
  kit.registerFeature(
    defineNodeFeature({ id: "rename", modes: [defineNodeMode({ id: "rename", exit: renameExit })] })
  )
  kit.registerFeature(
    defineNodeFeature({
      id: "prompt",
      modes: [
        defineNodeMode({
          id: "edit-prompt",
          reveal: ["composer"],
          conceal: ["toolbar"],
          enter: promptEnter,
          exit: promptExit
        })
      ]
    })
  )
  kit.registerType({ type: "image", features: ["rename", "prompt"] })
  kit.registerType({ type: "text", features: ["rename"] })

  const modes = createNodeModeController(kit)
  const events: string[] = []
  kit.on("mode:enter", ({ mode }, ctx) => events.push(`enter ${ctx.id} ${mode}`))
  kit.on("mode:exit", ({ mode, reason }, ctx) => events.push(`exit ${ctx.id} ${mode} ${reason}`))

  return {
    kit,
    modes,
    events,
    renameExit,
    promptEnter,
    promptExit,
    a: fakeContext(kit, "a", "image"),
    b: fakeContext(kit, "b", "text")
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("编辑模式", () => {
  it("进入模式：调 enter 钩子、发 mode:enter，当前编辑者就是它", () => {
    const { modes, events, promptEnter, a } = setup()

    expect(modes.enter(a, "edit-prompt")).toBe(true)
    expect(promptEnter).toHaveBeenCalledWith(a)
    expect(modes.current.value).toEqual({ nodeId: "a", mode: "edit-prompt" })
    expect(modes.modeOf("a")).toBe("edit-prompt")
    expect(events).toEqual(["enter a edit-prompt"])
  })

  it("类型没启用的模式进不去", () => {
    const { modes, b } = setup()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    expect(modes.enter(b, "edit-prompt")).toBe(false)
    expect(modes.current.value).toBeNull()
  })

  it("整张画布同时只有一个节点可编辑：另一个节点进入模式，上一个以 preempted 退出", () => {
    const { modes, events, promptExit, a, b } = setup()
    modes.enter(a, "edit-prompt")
    modes.enter(b, "rename")

    expect(promptExit).toHaveBeenCalledWith(a, "preempted")
    expect(modes.current.value).toEqual({ nodeId: "b", mode: "rename" })
    expect(modes.modeOf("a")).toBeNull()
    expect(events).toEqual(["enter a edit-prompt", "exit a edit-prompt preempted", "enter b rename"])
  })

  it("同一节点换模式，旧模式同样以 preempted 退出；重复进入同一模式什么也不发生", () => {
    const { modes, events, a } = setup()
    modes.enter(a, "rename")
    modes.enter(a, "rename")
    modes.enter(a, "edit-prompt")

    expect(events).toEqual(["enter a rename", "exit a rename preempted", "enter a edit-prompt"])
  })

  it("选中另一个节点，上一个节点的编辑取消；选中的仍是它自己则不动", () => {
    const { modes, renameExit, a, b } = setup()
    modes.enter(a, "rename")

    modes.syncSelection("a")
    expect(modes.modeOf("a")).toBe("rename")

    modes.syncSelection(b.id)
    expect(renameExit).toHaveBeenCalledWith(a, "preempted")
    expect(modes.current.value).toBeNull()
  })

  it("清空选中也会结束编辑", () => {
    const { modes, a } = setup()
    modes.enter(a, "rename")
    modes.syncSelection(null)
    expect(modes.current.value).toBeNull()
  })

  it("exit 带 nodeId 时只结束那个节点的编辑", () => {
    const { modes, promptExit, a } = setup()
    modes.enter(a, "edit-prompt")

    modes.exit("cancel", "b")
    expect(modes.modeOf("a")).toBe("edit-prompt")

    modes.exit("cancel", "a")
    expect(promptExit).toHaveBeenCalledWith(a, "cancel")
    expect(modes.current.value).toBeNull()
  })

  it("模式对区域的要求只作用于正在编辑的那个节点", () => {
    const { modes, a } = setup()
    modes.enter(a, "edit-prompt")

    expect(modes.slotOverride("a", "composer")).toBe("reveal")
    expect(modes.slotOverride("a", "toolbar")).toBe("conceal")
    expect(modes.slotOverride("a", "side")).toBeNull()
    expect(modes.slotOverride("b", "composer")).toBeNull()
  })

  it("钩子抛错只记日志，状态照样切换", () => {
    const kit = createNodeKit()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    kit.registerFeature(
      defineNodeFeature({
        id: "f",
        modes: [
          defineNodeMode({
            id: "m",
            enter: () => {
              throw new Error("enter")
            },
            exit: () => {
              throw new Error("exit")
            }
          })
        ]
      })
    )
    kit.registerType({ type: "t", features: ["f"] })
    const modes = createNodeModeController(kit)
    const ctx = fakeContext(kit, "n", "t")

    expect(modes.enter(ctx, "m")).toBe(true)
    expect(modes.modeOf("n")).toBe("m")
    modes.exit()
    expect(modes.current.value).toBeNull()
  })

  it("节点视图：current 跟着编辑器级状态走，enter / exit 只作用于自己", () => {
    const { modes, a, b } = setup()
    const viewA = modes.viewFor(() => "a", () => a)
    const viewB = modes.viewFor(() => "b", () => b)

    viewA.enter("edit-prompt")
    expect(viewA.current.value).toBe("edit-prompt")
    expect(viewB.current.value).toBeNull()

    viewB.exit("cancel")
    expect(viewA.current.value).toBe("edit-prompt")

    viewB.enter("rename")
    expect(viewA.current.value).toBeNull()
    expect(viewB.current.value).toBe("rename")
  })
})
