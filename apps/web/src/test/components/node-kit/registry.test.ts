import { afterEach, describe, expect, it, vi } from "vitest"
import { defineComponent } from "vue"

import {
  defineNodeAction,
  defineNodeFeature,
  defineNodeHandler,
  defineNodePart,
  ORDER_FRAMEWORK,
  type NodePartDef
} from "@/components/flow/node-kit/protocol"
import { createNodeKit, matchesNode } from "@/components/flow/node-kit/registry"
import { fakeContext } from "./fake-context"

/**
 * 注册表：按类型解析「某个区域最终挂哪些」（收集 → 剔除 → 排序）、装配期校验、事件总线。
 * 全是纯逻辑，不挂载任何组件。
 */

const Stub = defineComponent({ render: () => null })

function part(id: string, extra: Partial<NodePartDef> = {}): NodePartDef {
  return defineNodePart({ id, slot: "toolbar", component: Stub, ...extra })
}

function action(id: string, extra: Partial<Parameters<typeof defineNodeAction>[0]> = {}) {
  return defineNodeAction({ id, slot: "toolbar", icon: Stub, label: id, run: () => undefined, ...extra })
}

const ids = (list: readonly { id: string }[]) => list.map((item) => item.id)

afterEach(() => {
  vi.restoreAllMocks()
})

describe("matchesNode", () => {
  const info = { type: "image-config", features: ["rename", "runnable"] }

  it("各项之间是「且」：types 命中其一、features 全部具备、not 一项都不沾", () => {
    expect(matchesNode({}, info)).toBe(true)
    expect(matchesNode({ types: ["text", "image-config"] }, info)).toBe(true)
    expect(matchesNode({ types: ["text"] }, info)).toBe(false)
    expect(matchesNode({ features: ["rename", "runnable"] }, info)).toBe(true)
    expect(matchesNode({ features: ["rename", "composer"] }, info)).toBe(false)
    expect(matchesNode({ not: { features: ["runnable"] } }, info)).toBe(false)
    expect(matchesNode({ not: { types: ["image-config"] } }, info)).toBe(false)
    expect(matchesNode({ types: ["image-config"], not: { features: ["resizable"] } }, info)).toBe(true)
  })
})

describe("部件解析", () => {
  it("能力里的部件只挂到启用了这个能力的类型上", () => {
    const kit = createNodeKit()
    kit.registerFeature(defineNodeFeature({ id: "runnable", parts: [part("status.badge", { slot: "badge" })] }))
    kit.registerType({ type: "image-config", features: ["runnable"] })
    kit.registerType({ type: "text", features: [] })

    expect(ids(kit.partsFor("image-config", "badge"))).toEqual(["status.badge"])
    expect(kit.partsFor("text", "badge")).toEqual([])
  })

  it("区域只对注册了部件的类型存在：没注册 composer 部件的类型解析出空数组", () => {
    const kit = createNodeKit()
    kit.registerFeature(defineNodeFeature({ id: "rename" }))
    kit.registerType({
      type: "image-config",
      features: ["rename"],
      parts: [part("image.composer", { slot: "composer" })]
    })
    kit.registerType({ type: "text", features: ["rename"] })

    expect(ids(kit.partsFor("image-config", "composer"))).toEqual(["image.composer"])
    expect(kit.partsFor("text", "composer")).toHaveLength(0)
  })

  it("单独注册的部件按 match.types 只挂到指定的类型上", () => {
    const kit = createNodeKit()
    kit.registerPart(part("prompt.composer", { slot: "composer", match: { types: ["image-config", "video-config"] } }))

    expect(ids(kit.partsFor("image-config", "composer"))).toEqual(["prompt.composer"])
    expect(ids(kit.partsFor("video-config", "composer"))).toEqual(["prompt.composer"])
    expect(kit.partsFor("text", "composer")).toHaveLength(0)
  })

  it("能力里的部件自带 match 时再收窄一次", () => {
    const kit = createNodeKit()
    kit.registerFeature(
      defineNodeFeature({
        id: "output-preview",
        parts: [part("preview.thumb", { slot: "footer", match: { types: ["image-source"] } })]
      })
    )
    kit.registerType({ type: "image-source", features: ["output-preview"] })
    kit.registerType({ type: "text-config", features: ["output-preview"] })

    expect(ids(kit.partsFor("image-source", "footer"))).toEqual(["preview.thumb"])
    expect(kit.partsFor("text-config", "footer")).toHaveLength(0)
  })

  it("按 order 排序，同 order 按注册顺序；类型自带的部件默认排在能力之后", () => {
    const kit = createNodeKit()
    kit.registerFeature(defineNodeFeature({ id: "a", parts: [part("a.1"), part("a.2")] }))
    kit.registerFeature(defineNodeFeature({ id: "b", parts: [part("b.first", { order: ORDER_FRAMEWORK })] }))
    kit.registerType({ type: "t", features: ["a", "b"], parts: [part("t.own")] })
    kit.registerPart(part("loose", { match: { types: ["t"] } }))

    expect(ids(kit.partsFor("t", "toolbar"))).toEqual(["b.first", "a.1", "a.2", "loose", "t.own"])
  })

  it("replaces 顶替被点名的那条，hides 直接去掉；只在启用了它的类型上生效", () => {
    const kit = createNodeKit()
    kit.registerFeature(defineNodeFeature({ id: "base", parts: [part("x"), part("y"), part("z")] }))
    kit.registerFeature(
      defineNodeFeature({ id: "custom", parts: [part("x2", { replaces: "x", hides: ["z"] })] })
    )
    kit.registerType({ type: "plain", features: ["base"] })
    kit.registerType({ type: "custom", features: ["base", "custom"] })

    expect(ids(kit.partsFor("plain", "toolbar"))).toEqual(["x", "y", "z"])
    expect(ids(kit.partsFor("custom", "toolbar"))).toEqual(["y", "x2"])
  })

  it("没登记的类型当作没有能力，只拿到 match 恰好命中它的单独部件", () => {
    const kit = createNodeKit()
    kit.registerFeature(defineNodeFeature({ id: "rename", parts: [part("label.title", { slot: "label" })] }))
    kit.registerPart(part("everywhere", { slot: "label", match: {} }))

    expect(ids(kit.partsFor("unknown", "label"))).toEqual(["everywhere"])
    expect(kit.featuresOf("unknown")).toEqual([])
  })

  it("解析结果按类型缓存；之后再注册会让缓存失效", () => {
    const kit = createNodeKit()
    kit.registerFeature(defineNodeFeature({ id: "a", parts: [part("a.1")] }))
    kit.registerType({ type: "t", features: ["a"] })

    const first = kit.partsFor("t", "toolbar")
    expect(kit.partsFor("t", "toolbar")).toBe(first)

    kit.registerPart(part("late", { match: { types: ["t"] } }))
    expect(ids(kit.partsFor("t", "toolbar"))).toEqual(["a.1", "late"])
  })
})

describe("动作与模式解析", () => {
  it("动作和部件同一套规则：按区域分组、replaces 生效", () => {
    const kit = createNodeKit()
    kit.registerFeature(defineNodeFeature({ id: "delete", actions: [action("node.delete")] }))
    kit.registerFeature(defineNodeFeature({ id: "duplicate", actions: [action("node.duplicate", { order: 50 })] }))
    kit.registerFeature(
      defineNodeFeature({ id: "run", actions: [action("node.run", { slot: "footer" })] })
    )
    kit.registerType({ type: "t", features: ["delete", "duplicate", "run"] })
    kit.registerType({
      type: "g",
      features: ["delete"],
      actions: [action("group.ungroup", { replaces: "node.delete" })]
    })

    expect(ids(kit.actionsFor("t", "toolbar"))).toEqual(["node.duplicate", "node.delete"])
    expect(ids(kit.actionsFor("t", "footer"))).toEqual(["node.run"])
    expect(ids(kit.allActionsFor("t"))).toEqual(["node.duplicate", "node.delete", "node.run"])
    expect(ids(kit.actionsFor("g", "toolbar"))).toEqual(["group.ungroup"])
  })

  it("模式只对启用了所属能力的类型可用", () => {
    const kit = createNodeKit()
    kit.registerFeature(defineNodeFeature({ id: "edit-body", modes: [{ id: "edit-body" }] }))
    kit.registerType({ type: "text", features: ["edit-body"] })
    kit.registerType({ type: "process", features: [] })

    expect(kit.findMode("text", "edit-body")?.id).toBe("edit-body")
    expect(kit.findMode("process", "edit-body")).toBeNull()
  })
})

describe("装配期校验", () => {
  it("类型引用没登记的能力时立即报错", () => {
    const kit = createNodeKit()
    expect(() => kit.registerType({ type: "t", features: ["missing"] })).toThrow(/missing/)
  })

  it("部件 / 动作 / 能力 / 模式 / 类型的 id 重复都报错", () => {
    const kit = createNodeKit()
    kit.registerFeature(defineNodeFeature({ id: "f", parts: [part("p")], actions: [action("a")], modes: [{ id: "m" }] }))
    kit.registerType({ type: "t", features: [] })

    expect(() => kit.registerFeature(defineNodeFeature({ id: "f" }))).toThrow(/能力/)
    expect(() => kit.registerPart(part("p", { match: {} }))).toThrow(/部件/)
    expect(() => kit.registerAction(action("a", { match: {} }))).toThrow(/动作/)
    expect(() => kit.registerFeature(defineNodeFeature({ id: "g", modes: [{ id: "m" }] }))).toThrow(/模式/)
    expect(() => kit.registerType({ type: "t", features: [] })).toThrow(/类型/)
  })

  it("单独注册的部件 / 动作必须写 match", () => {
    const kit = createNodeKit()
    expect(() => kit.registerPart(part("p"))).toThrow(/match/)
    expect(() => kit.registerAction(action("a"))).toThrow(/match/)
  })

  it("replaces / hides 点名了不存在的条目：validate 列出来，assertValid 抛出", () => {
    const kit = createNodeKit()
    kit.registerFeature(
      defineNodeFeature({
        id: "f",
        parts: [part("p", { replaces: "ghost" })],
        actions: [action("a", { hides: ["nobody"] })]
      })
    )

    expect(kit.validate()).toHaveLength(2)
    expect(() => kit.assertValid()).toThrow(/ghost/)
  })

  it("被点名的条目晚于点名者登记也算存在 —— 登记顺序不是约束", () => {
    const kit = createNodeKit()
    kit.registerFeature(defineNodeFeature({ id: "late-ref", parts: [part("p2", { replaces: "p1" })] }))
    kit.registerFeature(defineNodeFeature({ id: "base", parts: [part("p1")] }))

    expect(kit.validate()).toEqual([])
  })
})

describe("事件总线", () => {
  it("能力里的处理函数只收启用了这个能力的节点发出的事件", () => {
    const kit = createNodeKit()
    const handle = vi.fn()
    kit.registerFeature(
      defineNodeFeature({
        id: "runnable",
        handlers: [defineNodeHandler({ event: "action:invoke", handle })]
      })
    )
    kit.registerType({ type: "image-config", features: ["runnable"] })
    kit.registerType({ type: "text", features: [] })

    kit.emit("action:invoke", { action: "x" }, fakeContext(kit, "n1", "image-config"))
    kit.emit("action:invoke", { action: "x" }, fakeContext(kit, "n2", "text"))

    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledWith({ action: "x" }, expect.objectContaining({ id: "n1" }))
  })

  it("编辑器级订阅默认收所有节点的，可以按 match 收窄；注销后不再被调用", () => {
    const kit = createNodeKit()
    kit.registerType({ type: "t", features: [] })
    const all = vi.fn()
    const onlyOther = vi.fn()
    const off = kit.on("node:select", all)
    kit.on("node:select", onlyOther, { match: { types: ["other"] } })

    const ctx = fakeContext(kit, "n1", "t")
    ctx.emit("node:select", { selected: true })
    expect(all).toHaveBeenCalledWith({ selected: true }, ctx)
    expect(onlyOther).not.toHaveBeenCalled()

    off()
    ctx.emit("node:select", { selected: false })
    expect(all).toHaveBeenCalledTimes(1)
  })

  it("一个处理函数抛错只记日志，不影响后面的，也不往发出方抛", () => {
    const kit = createNodeKit()
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const after = vi.fn()
    kit.on("node:dblclick", () => {
      throw new Error("boom")
    })
    kit.on("node:dblclick", after)

    expect(() => kit.emit("node:dblclick", { event: new MouseEvent("dblclick") }, fakeContext(kit, "n", "t"))).not.toThrow()
    expect(after).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })

  it("处理函数里注销自己，不影响这一轮里的其他处理函数", () => {
    const kit = createNodeKit()
    const second = vi.fn()
    const off = kit.on("node:select", () => off())
    kit.on("node:select", second)

    kit.emit("node:select", { selected: true }, fakeContext(kit, "n", "t"))
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("处理函数互相触发时按嵌套深度掐断，不会无限递归", () => {
    const kit = createNodeKit()
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const ctx = fakeContext(kit, "n", "t")
    const ping = vi.fn(() => ctx.emit("slot:close", { slot: "side" }))
    kit.on("slot:open", ping)
    kit.on("slot:close", () => ctx.emit("slot:open", { slot: "side" }))

    ctx.emit("slot:open", { slot: "side" })

    expect(ping.mock.calls.length).toBeGreaterThan(1)
    expect(ping.mock.calls.length).toBeLessThanOrEqual(32)
    expect(error).toHaveBeenCalledWith(expect.stringContaining("嵌套"))
  })
})
