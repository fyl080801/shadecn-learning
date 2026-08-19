import { beforeEach, describe, expect, it } from "vitest"
import {
  Editor,
  Range,
  Transforms,
  createEditor,
  createInline,
  createParagraph,
  createText,
  initializeEditor
} from "@/components/prompt-input/operations"
import { modelToText, splitByRegex, textToModel } from "@/components/prompt-input/serialize"
import type {
  Descendant,
  Editor as EditorType,
  Paragraph,
  PromptPlugin
} from "@/components/prompt-input/types"

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

const plugins = [mention]

/** 段落的 children 摘要：文本叶子给内容，行内节点给 <type> */
const shape = (editor: EditorType, blockIdx = 0) =>
  (editor.children[blockIdx] as Paragraph).children.map((c) =>
    "text" in c ? c.text : `<${c.type}>`
  )

const asText = (editor: EditorType) => modelToText(editor.children, plugins)

/** 建一个装好 mention 插件、内容为 `text` 的编辑器 */
function makeEditor(text = "") {
  const { editor, addPlugin, getPlugins, removePlugin } = createEditor({ plugins })
  initializeEditor(editor, textToModel(text, plugins) as Descendant[])
  return { editor, addPlugin, getPlugins, removePlugin }
}

/** 把光标放到某个位置 */
const caret = (editor: EditorType, path: number[], offset: number) => {
  editor.selection = Range.create({ path, offset })
}

describe("createEditor() / initializeEditor()", () => {
  let editor: EditorType

  beforeEach(() => {
    editor = makeEditor("hello").editor
  })

  it("初始化后光标落在最后一个文本叶子的末尾", () => {
    expect(editor.selection).toEqual({
      anchor: { path: [0, 0], offset: 5 },
      focus: { path: [0, 0], offset: 5 }
    })
  })

  it("空文档也有一个能落光标的空段落", () => {
    const empty = makeEditor("").editor
    expect(empty.children).toHaveLength(1)
    expect(shape(empty)).toEqual([""])
    expect(empty.selection?.anchor).toEqual({ path: [0, 0], offset: 0 })
  })

  it("归一化会在两个相邻行内节点之间补上文本叶子", () => {
    const { editor: e } = makeEditor("@a@b")
    expect(shape(e)).toEqual(["", "<mention>", "", "<mention>", ""])
  })

  it("归一化会合并相邻的文本叶子", () => {
    const { editor: e } = createEditor()
    initializeEditor(e, [createParagraph([createText("a"), createText("b"), createText("c")])])

    expect(shape(e)).toEqual(["abc"])
  })

  it("归一化保证段落首尾都是文本叶子", () => {
    const { editor: e } = createEditor({ plugins })
    initializeEditor(e, [createParagraph([createInline("mention", { id: "x" })])])

    expect(shape(e)).toEqual(["", "<mention>", ""])
  })
})

describe("插件注册", () => {
  it("addPlugin 之后 isInline/isVoid 认得这个类型", () => {
    const { editor, addPlugin } = createEditor()
    expect(editor.isInline({ type: "mention" } as never)).toBe(false)

    addPlugin(mention)
    expect(editor.isInline({ type: "mention" } as never)).toBe(true)
    expect(editor.isVoid({ type: "mention" } as never)).toBe(true)
  })

  it("按 name 幂等，重复注册不会有两份", () => {
    const { addPlugin, getPlugins } = createEditor({ plugins })
    addPlugin(mention)
    expect(getPlugins()).toHaveLength(1)
  })

  it("removePlugin 之后就不再认这个行内类型了", () => {
    const { editor, removePlugin } = createEditor({ plugins })
    removePlugin("mention")
    expect(editor.isInline({ type: "mention" } as never)).toBe(false)
  })

  it("段落永远不是行内节点", () => {
    const { editor } = createEditor({ plugins })
    expect(editor.isInline({ type: "paragraph" } as never)).toBe(false)
  })
})

describe("Transforms.insertText()", () => {
  it("在光标处插入", () => {
    const { editor } = makeEditor("hello")
    caret(editor, [0, 0], 5)

    Transforms.insertText(editor, " world")

    expect(asText(editor)).toBe("hello world")
    expect(editor.selection?.anchor.offset).toBe(11)
  })

  it("在中间插入，光标跟着往后走", () => {
    const { editor } = makeEditor("hello")
    caret(editor, [0, 0], 2)

    Transforms.insertText(editor, "XY")

    expect(asText(editor)).toBe("heXYllo")
    expect(editor.selection?.anchor.offset).toBe(4)
  })

  it("插入空串什么也不做", () => {
    const { editor } = makeEditor("hello")
    const before = editor.revision
    Transforms.insertText(editor, "")

    expect(asText(editor)).toBe("hello")
    expect(editor.revision).toBe(before)
  })

  it("有选区时先删掉选中的再插入", () => {
    const { editor } = makeEditor("hello")
    editor.selection = {
      anchor: { path: [0, 0], offset: 1 },
      focus: { path: [0, 0], offset: 4 }
    }

    Transforms.insertText(editor, "EY")
    expect(asText(editor)).toBe("hEYo")
  })

  it("每次提交都会推进 revision（组件靠它强制重渲染）", () => {
    const { editor } = makeEditor("a")
    const before = editor.revision
    Transforms.insertText(editor, "b")

    expect(editor.revision).toBeGreaterThan(before)
  })

  it("带 \\n 的文本拆成多个段落块，文本叶子里不留 \\n", () => {
    const { editor } = makeEditor("a")
    caret(editor, [0, 0], 1)

    Transforms.insertText(editor, "b\nc\nd")

    expect(editor.children).toHaveLength(3)
    expect(asText(editor)).toBe("ab\nc\nd")
    for (const block of editor.children) {
      for (const child of (block as Paragraph).children) {
        if ("text" in child) expect(child.text).not.toContain("\n")
      }
    }
  })

  it("一次带 \\n 的插入只算一次撤销", () => {
    const { editor } = makeEditor("a")
    caret(editor, [0, 0], 1)

    Transforms.insertText(editor, "b\nc")
    editor.undo()

    expect(asText(editor)).toBe("a")
  })

  it("\\r\\n 归一成 \\n，零宽占位符被剥掉", () => {
    const { editor } = makeEditor("")
    caret(editor, [0, 0], 0)

    Transforms.insertText(editor, "a\r\n\u200Bb\uFEFF")

    expect(asText(editor)).toBe("a\nb")
  })
})

describe("Transforms.insertNodes() —— 插入行内 void", () => {
  it("在光标处插入 mention，光标落到它后面的文本叶子", () => {
    const { editor } = makeEditor("hi ")
    caret(editor, [0, 0], 3)

    Transforms.insertNodes(editor, createInline("mention", { id: "bob" }))

    expect(shape(editor)).toEqual(["hi ", "<mention>", ""])
    expect(asText(editor)).toBe("hi @bob")
    expect(editor.selection?.anchor).toEqual({ path: [0, 2], offset: 0 })
  })

  it("插在中间时把原文本叶子切成两半", () => {
    const { editor } = makeEditor("ab")
    caret(editor, [0, 0], 1)

    Transforms.insertNodes(editor, createInline("mention", { id: "x" }))

    expect(shape(editor)).toEqual(["a", "<mention>", "b"])
  })

  it("插两次能得到两个 mention，中间有文本叶子隔开", () => {
    const { editor } = makeEditor("")
    caret(editor, [0, 0], 0)
    Transforms.insertNodes(editor, createInline("mention", { id: "a" }))
    Transforms.insertNodes(editor, createInline("mention", { id: "b" }))

    expect(asText(editor)).toBe("@a@b")
    expect(shape(editor)).toEqual(["", "<mention>", "", "<mention>", ""])
  })

  it("没有选区时不做任何事", () => {
    const { editor } = makeEditor("hi")
    editor.selection = null

    Transforms.insertNodes(editor, createInline("mention", { id: "x" }))
    expect(asText(editor)).toBe("hi")
  })
})

describe("删除", () => {
  it("退格删掉光标前一个字符", () => {
    const { editor } = makeEditor("abc")
    caret(editor, [0, 0], 3)

    Transforms.delete(editor)

    expect(asText(editor)).toBe("ab")
    expect(editor.selection?.anchor.offset).toBe(2)
  })

  it("退格把整个 mention 一次删掉（行内 void 是原子的）", () => {
    const { editor } = makeEditor("hi @bob")
    // children: ["hi ", <mention>, ""] —— 光标在 mention 后面那个空叶子的开头
    caret(editor, [0, 2], 0)

    Transforms.delete(editor)

    expect(asText(editor)).toBe("hi ")
    expect(shape(editor)).toEqual(["hi "])
  })

  it("在文档最开头退格是安全的 no-op", () => {
    const { editor } = makeEditor("abc")
    caret(editor, [0, 0], 0)

    Transforms.delete(editor)
    expect(asText(editor)).toBe("abc")
  })

  it("有选区时退格删掉整段选区", () => {
    const { editor } = makeEditor("abcdef")
    editor.selection = {
      anchor: { path: [0, 0], offset: 1 },
      focus: { path: [0, 0], offset: 4 }
    }

    Transforms.delete(editor)
    expect(asText(editor)).toBe("aef")
  })

  it("段首退格会和上一段合并", () => {
    const { editor } = makeEditor("aa\nbb")
    caret(editor, [1, 0], 0)

    Transforms.delete(editor)

    expect(editor.children).toHaveLength(1)
    expect(asText(editor)).toBe("aabb")
  })

  it("Delete 键删掉光标后一个字符", () => {
    const { editor } = makeEditor("abc")
    caret(editor, [0, 0], 1)

    Transforms.delete(editor, { reverse: false })
    expect(asText(editor)).toBe("ac")
  })

  it("Delete 键在 mention 前面时把整个 mention 删掉", () => {
    const { editor } = makeEditor("hi @bob")
    caret(editor, [0, 0], 3)

    Transforms.delete(editor, { reverse: false })
    expect(asText(editor)).toBe("hi ")
  })

  it("段尾按 Delete 和下一段合并", () => {
    const { editor } = makeEditor("aa\nbb")
    caret(editor, [0, 0], 2)

    Transforms.delete(editor, { reverse: false })

    expect(editor.children).toHaveLength(1)
    expect(asText(editor)).toBe("aabb")
  })
})

describe("Transforms.splitBlock()", () => {
  it("在光标处切成两段，光标落到新段落开头", () => {
    const { editor } = makeEditor("abcd")
    caret(editor, [0, 0], 2)

    Transforms.splitBlock(editor)

    expect(editor.children).toHaveLength(2)
    expect(asText(editor)).toBe("ab\ncd")
    expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 })
  })

  it("在段尾回车得到一个空段落", () => {
    const { editor } = makeEditor("ab")
    caret(editor, [0, 0], 2)

    Transforms.splitBlock(editor)

    expect(editor.children).toHaveLength(2)
    expect(shape(editor, 1)).toEqual([""])
  })

  it("mention 跟着落到后面那一段", () => {
    const { editor } = makeEditor("x @bob")
    caret(editor, [0, 0], 1)

    Transforms.splitBlock(editor)

    expect(asText(editor)).toBe("x\n @bob")
  })
})

describe("Transforms.select() / move()", () => {
  it("select 换选区，但不改内容", () => {
    const { editor } = makeEditor("abc")
    const range = Range.create({ path: [0, 0], offset: 1 })

    Transforms.select(editor, range)
    expect(editor.selection).toEqual(range)
    expect(asText(editor)).toBe("abc")
  })

  it("move 往后走一格", () => {
    const { editor } = makeEditor("abc")
    caret(editor, [0, 0], 0)

    Transforms.move(editor)
    expect(editor.selection?.anchor.offset).toBe(1)
  })

  it("move reverse 往前走一格", () => {
    const { editor } = makeEditor("abc")
    caret(editor, [0, 0], 2)

    Transforms.move(editor, { reverse: true })
    expect(editor.selection?.anchor.offset).toBe(1)
  })

  it("走到文档尽头就停住，不会越界", () => {
    const { editor } = makeEditor("ab")
    caret(editor, [0, 0], 2)

    Transforms.move(editor)
    expect(editor.selection?.anchor.offset).toBe(2)
  })
})

describe("Editor 只读查询", () => {
  it("Editor.string 取选区内的文本", () => {
    const { editor } = makeEditor("hello")
    const range = {
      anchor: { path: [0, 0], offset: 1 },
      focus: { path: [0, 0], offset: 4 }
    }

    expect(Editor.string(editor, range)).toBe("ell")
  })

  it("折叠选区的 string 是空串", () => {
    const { editor } = makeEditor("hello")
    const point = { path: [0, 0], offset: 2 }
    expect(Editor.string(editor, { anchor: point, focus: point })).toBe("")
  })

  it("Editor.isCollapsed 默认看当前选区", () => {
    const { editor } = makeEditor("hello")
    caret(editor, [0, 0], 1)
    expect(Editor.isCollapsed(editor)).toBe(true)

    editor.selection = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 2 }
    }
    expect(Editor.isCollapsed(editor)).toBe(false)
  })

  it("Editor.before/after 在文档边界返回 null", () => {
    const { editor } = makeEditor("ab")
    expect(Editor.before(editor, { path: [0, 0], offset: 0 })).toBeNull()
    expect(Editor.after(editor, { path: [0, 0], offset: 2 })).toBeNull()
  })

  it("Editor.before 按词跳到词首", () => {
    const { editor } = makeEditor("foo bar")
    expect(Editor.before(editor, { path: [0, 0], offset: 7 }, { unit: "word" })).toEqual({
      path: [0, 0],
      offset: 4
    })
  })

  it("Range.edges 会把反向选区正过来", () => {
    const a = { path: [0, 0], offset: 5 }
    const b = { path: [0, 0], offset: 1 }
    expect(Range.edges({ anchor: a, focus: b })).toEqual([b, a])
  })
})

describe("撤销 / 重做", () => {
  it("撤销回滚上一次内容变更", () => {
    const { editor } = makeEditor("a")
    caret(editor, [0, 0], 1)
    Transforms.insertText(editor, "b")
    expect(asText(editor)).toBe("ab")

    editor.undo()
    expect(asText(editor)).toBe("a")
  })

  it("重做把撤销掉的再放回来", () => {
    const { editor } = makeEditor("a")
    caret(editor, [0, 0], 1)
    Transforms.insertText(editor, "b")
    editor.undo()
    editor.redo()

    expect(asText(editor)).toBe("ab")
  })

  it("连续多次编辑可以一步步撤回", () => {
    const { editor } = makeEditor("")
    caret(editor, [0, 0], 0)
    Transforms.insertText(editor, "a")
    Transforms.insertText(editor, "b")
    Transforms.insertText(editor, "c")

    editor.undo()
    expect(asText(editor)).toBe("ab")
    editor.undo()
    expect(asText(editor)).toBe("a")
  })

  it("栈空时撤销是 no-op", () => {
    const { editor } = makeEditor("abc")
    editor.undo()
    editor.undo()
    expect(asText(editor)).toBe("abc")
  })

  it("光标移动本身不产生撤销点（Ctrl+Z 要回滚的是编辑，不是光标）", () => {
    const { editor } = makeEditor("a")
    caret(editor, [0, 0], 1)
    Transforms.insertText(editor, "b")

    Transforms.select(editor, Range.create({ path: [0, 0], offset: 0 }))
    Transforms.move(editor)

    editor.undo()
    expect(asText(editor)).toBe("a")
  })

  it("新的编辑会清掉 redo 分支", () => {
    const { editor } = makeEditor("")
    caret(editor, [0, 0], 0)
    Transforms.insertText(editor, "a")
    editor.undo()
    Transforms.insertText(editor, "z")

    editor.redo()
    expect(asText(editor)).toBe("z")
  })

  it("撤销会把插入的 mention 整个拿掉", () => {
    const { editor } = makeEditor("hi ")
    caret(editor, [0, 0], 3)
    Transforms.insertNodes(editor, createInline("mention", { id: "bob" }))

    editor.undo()
    expect(asText(editor)).toBe("hi ")
    expect(shape(editor)).toEqual(["hi "])
  })
})

describe("editor.batch() —— 一次粘贴 = 一次撤销", () => {
  it("批次里的多次编辑只留一个撤销点", () => {
    const { editor } = makeEditor("")
    caret(editor, [0, 0], 0)

    editor.batch(() => {
      Transforms.insertText(editor, "hello ")
      Transforms.insertNodes(editor, createInline("mention", { id: "bob" }))
      Transforms.insertText(editor, " bye")
    })
    expect(asText(editor)).toBe("hello @bob bye")

    editor.undo()
    expect(asText(editor)).toBe("")
  })

  it("批次里没产生内容变化就不留撤销点", () => {
    const { editor } = makeEditor("abc")
    caret(editor, [0, 0], 1)

    editor.batch(() => {
      Transforms.select(editor, Range.create({ path: [0, 0], offset: 2 }))
    })

    editor.undo()
    expect(asText(editor)).toBe("abc")
  })

  it("嵌套的 batch 合并进最外层，仍然只有一个撤销点", () => {
    const { editor } = makeEditor("")
    caret(editor, [0, 0], 0)

    editor.batch(() => {
      Transforms.insertText(editor, "a")
      editor.batch(() => {
        Transforms.insertText(editor, "b")
        Transforms.insertText(editor, "c")
      })
    })
    expect(asText(editor)).toBe("abc")

    editor.undo()
    expect(asText(editor)).toBe("")
  })

  it("批次里抛异常也要正确收尾（depth 不能漏减）", () => {
    const { editor } = makeEditor("")
    caret(editor, [0, 0], 0)

    expect(() =>
      editor.batch(() => {
        Transforms.insertText(editor, "a")
        throw new Error("boom")
      })
    ).toThrowError("boom")

    // depth 已经归零：后续编辑照常记录撤销点
    Transforms.insertText(editor, "b")
    editor.undo()
    expect(asText(editor)).toBe("a")
  })
})

describe("editor.muteHistory() —— 自动同步不算撤销步", () => {
  it("静音期间的改动不产生撤销点", () => {
    const { editor } = makeEditor("a")
    caret(editor, [0, 0], 1)

    Transforms.insertText(editor, "b")
    editor.muteHistory(() => {
      Transforms.insertText(editor, "c")
    })

    // 撤销只回退到静音变更之后、上一次真实编辑之前的状态
    editor.undo()
    expect(asText(editor)).toBe("a")
  })

  it("静音变更后的下一次撤销不会把静音变更一起吐回来", () => {
    const { editor } = makeEditor("a")
    caret(editor, [0, 0], 1)

    editor.muteHistory(() => {
      Transforms.insertText(editor, "X")
    })
    Transforms.insertText(editor, "b")

    editor.undo()
    // 快照的 before 是"静音变更之后"的状态，X 保留
    expect(asText(editor)).toBe("aX")
  })

  it("可重入：嵌套静音退出后恢复到进入前的状态", () => {
    const { editor } = makeEditor("")
    caret(editor, [0, 0], 0)

    editor.muteHistory(() => {
      editor.muteHistory(() => {
        Transforms.insertText(editor, "a")
      })
      Transforms.insertText(editor, "b")
    })
    // 静音结束，恢复记录
    Transforms.insertText(editor, "c")

    editor.undo()
    expect(asText(editor)).toBe("ab")
  })

  it("静音期间抛异常也要恢复静音状态", () => {
    const { editor } = makeEditor("")
    caret(editor, [0, 0], 0)

    expect(() =>
      editor.muteHistory(() => {
        throw new Error("boom")
      })
    ).toThrowError("boom")

    Transforms.insertText(editor, "a")
    Transforms.insertText(editor, "b")
    editor.undo()
    expect(asText(editor)).toBe("a")
  })
})
