import { describe, expect, it, vi } from "vitest"
import {
  modelToText,
  serializeRange,
  splitByRegex,
  textToModel
} from "@/components/prompt-input/serialize"
import type {
  CustomInline,
  Descendant,
  Paragraph,
  PromptPlugin
} from "@/components/prompt-input/types"

/** 测试用插件：把 @xxx 变成 mention 行内节点 */
const mention: PromptPlugin = {
  name: "mention",
  inline: { type: "mention" },
  parse: (text) =>
    splitByRegex(text, /@(\w+)/g, (m) => ({
      kind: "node",
      type: "mention",
      data: { id: m[1] }
    })),
  serialize: (node) => `@${(node.data as { id: string }).id}`
}

/** 第二个插件：把 #tag 变成 tag 行内节点 */
const tag: PromptPlugin = {
  name: "tag",
  inline: { type: "tag" },
  parse: (text) =>
    splitByRegex(text, /#(\w+)/g, (m) => ({
      kind: "node",
      type: "tag",
      data: { id: m[1] }
    })),
  serialize: (node) => `#${(node.data as { id: string }).id}`
}

const para = (node: Descendant) => node as Paragraph
const texts = (node: Descendant) =>
  para(node).children.map((c) => ("text" in c ? c.text : `<${c.type}>`))

describe("splitByRegex()", () => {
  it("非 global 的正则直接报错（几乎一定是写错了）", () => {
    expect(() =>
      splitByRegex("a@b", /@(\w+)/, () => ({ kind: "text", text: "" }))
    ).toThrowError(/global RegExp/)
  })

  it("匹配部分交给 build，其余原样当文本", () => {
    const segs = splitByRegex("hi @bob !", /@(\w+)/g, (m) => ({
      kind: "node",
      type: "mention",
      data: { id: m[1] }
    }))

    expect(segs).toEqual([
      { kind: "text", text: "hi " },
      { kind: "node", type: "mention", data: { id: "bob" } },
      { kind: "text", text: " !" }
    ])
  })

  it("首尾就是匹配时不产生空文本片段", () => {
    const segs = splitByRegex("@bob", /@(\w+)/g, () => ({
      kind: "node",
      type: "mention"
    }))
    expect(segs).toEqual([{ kind: "node", type: "mention" }])
  })

  it("零宽匹配不会死循环", () => {
    const segs = splitByRegex("abc", /(?:)/g, () => ({
      kind: "node",
      type: "zero"
    }))
    expect(segs.length).toBeLessThan(10)
  })

  it("同一个正则实例复用时会重置 lastIndex", () => {
    const re = /@(\w+)/g
    const build = () => ({ kind: "node" as const, type: "mention" })

    const first = splitByRegex("@a", re, build)
    const second = splitByRegex("@a", re, build)
    expect(second).toEqual(first)
  })

  it("没有任何匹配时返回整段文本", () => {
    expect(
      splitByRegex("plain", /@(\w+)/g, () => ({ kind: "node", type: "x" }))
    ).toEqual([{ kind: "text", text: "plain" }])
  })
})

describe("textToModel()", () => {
  it("空串也给一个能落光标的空段落", () => {
    const model = textToModel("", [])
    expect(model).toEqual([{ type: "paragraph", children: [{ text: "" }] }])
  })

  it("\\n\\n 分段，单个 \\n 留在段内", () => {
    const model = textToModel("a\nb\n\nc", [])

    expect(model).toHaveLength(2)
    expect(texts(model[0]!)).toEqual(["a\nb"])
    expect(texts(model[1]!)).toEqual(["c"])
  })

  it("插件把 @xxx 解析成行内节点", () => {
    const model = textToModel("hi @bob !", [mention])
    const children = para(model[0]!).children

    expect(texts(model[0]!)).toEqual(["hi ", "<mention>", " !"])
    expect((children[1] as CustomInline).data).toEqual({ id: "bob" })
  })

  it("行内节点是 void：children 固定是一个空文本叶子", () => {
    const model = textToModel("@bob", [mention])
    const inline = para(model[0]!).children[1] as CustomInline

    expect(inline.children).toEqual([{ text: "" }])
  })

  it("段落一定以文本叶子开头和结尾（否则光标没地方落）", () => {
    const model = textToModel("@bob", [mention])
    expect(texts(model[0]!)).toEqual(["", "<mention>", ""])
  })

  it("连着两个行内节点时，中间的文本叶子由编辑器归一化补（见 operations 的 normalize）", () => {
    const model = textToModel("@a@b", [mention])
    // serialize 只保证首尾是文本叶子；中间的分隔叶子是 initializeEditor 补的
    expect(texts(model[0]!)).toEqual(["", "<mention>", "<mention>", ""])
  })

  it("多个插件各管各的", () => {
    const model = textToModel("@bob #vue", [mention, tag])
    const children = para(model[0]!).children

    expect(children.map((c) => ("text" in c ? "t" : c.type))).toEqual([
      "t",
      "mention",
      "t",
      "tag",
      "t"
    ])
  })

  it("后注册的插件先看到文本（覆盖语义）", () => {
    const greedy: PromptPlugin = {
      name: "greedy",
      inline: { type: "greedy" },
      parse: (text) =>
        splitByRegex(text, /@\w+/g, () => ({ kind: "node", type: "greedy" })),
      serialize: () => "@greedy"
    }

    const model = textToModel("@bob", [mention, greedy])
    expect((para(model[0]!).children[1] as CustomInline).type).toBe("greedy")
  })

  it("没有插件时纯文本原样进模型", () => {
    expect(texts(textToModel("just @text", [])[0]!)).toEqual(["just @text"])
  })
})

describe("modelToText()", () => {
  it("行内节点交给插件的 serialize", () => {
    const model = textToModel("hi @bob !", [mention])
    expect(modelToText(model, [mention])).toBe("hi @bob !")
  })

  it("段落之间用 \\n\\n 连接", () => {
    expect(modelToText(textToModel("a\n\nb", []), [])).toBe("a\n\nb")
  })

  it.each([
    ["纯文本", "hello world"],
    ["单个换行", "line1\nline2"],
    ["多段", "p1\n\np2\n\np3"],
    ["行内节点", "hi @bob and @amy"],
    ["行首行尾都是行内节点", "@bob mid @amy"],
    ["空串", ""]
  ])("往返一致：%s", (_label, text) => {
    const plugins = [mention]
    expect(modelToText(textToModel(text, plugins), plugins)).toBe(text)
  })

  it("找不到 serializer 的行内节点会被丢掉，并 warn 一声", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const model = textToModel("hi @bob !", [mention])

    // 序列化时没把 mention 插件传进去
    expect(modelToText(model, [])).toBe("hi  !")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mention"))
  })

  it("顶层的非段落节点被跳过", () => {
    const model: Descendant[] = [
      { type: "paragraph", children: [{ text: "keep" }] },
      { text: "loose leaf" }
    ]
    expect(modelToText(model, [])).toBe("keep")
  })
})

describe("serializeRange()", () => {
  const model = textToModel("hello @bob world", [mention])
  // children: ["hello ", <mention>, " world"]

  it("折叠的选区返回空串", () => {
    const point = { path: [0, 0], offset: 2 }
    expect(serializeRange(model, { anchor: point, focus: point }, [mention])).toBe(
      ""
    )
  })

  it("同一个文本叶子内按 offset 切片", () => {
    const text = serializeRange(
      model,
      { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 5 } },
      [mention]
    )
    expect(text).toBe("hello")
  })

  it("anchor/focus 反着写也一样（自动取 edges）", () => {
    const text = serializeRange(
      model,
      { anchor: { path: [0, 0], offset: 5 }, focus: { path: [0, 0], offset: 0 } },
      [mention]
    )
    expect(text).toBe("hello")
  })

  it("跨过行内节点时把它序列化进来", () => {
    const text = serializeRange(
      model,
      { anchor: { path: [0, 0], offset: 6 }, focus: { path: [0, 2], offset: 6 } },
      [mention]
    )
    expect(text).toBe("@bob world")
  })

  it("跨段落时用 \\n\\n 连接", () => {
    const multi = textToModel("first\n\nsecond", [])
    const text = serializeRange(
      multi,
      { anchor: { path: [0, 0], offset: 0 }, focus: { path: [1, 0], offset: 6 } },
      []
    )
    expect(text).toBe("first\n\nsecond")
  })

  it("选中的行内节点没有 serializer 时丢掉并 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const text = serializeRange(
      model,
      { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 2], offset: 6 } },
      []
    )

    expect(text).toBe("hello  world")
    expect(warn).toHaveBeenCalled()
  })
})
