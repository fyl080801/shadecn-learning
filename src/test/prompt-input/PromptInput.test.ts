import { afterEach, describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { nextTick } from "vue"
import PromptInput from "@/components/prompt-input/PromptInput.vue"
import { Transforms, createEditor, createInline } from "@/components/prompt-input/operations"
import { splitByRegex } from "@/components/prompt-input/serialize"
import type { PromptPlugin } from "@/components/prompt-input/types"

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

let mounted: ReturnType<typeof mount> | null = null

/**
 * 挂一个装好 mention 插件、内容为 `text` 的编辑器。
 * 文档在 onMounted 里才写进 editor，所以要等一个 tick 才有 DOM。
 */
async function mountEditor(text = "") {
  const { editor } = createEditor({ plugins: [mention] })
  const wrapper = mount(PromptInput, {
    props: { editor, modelValue: text },
    attachTo: document.body
  })
  mounted = wrapper
  await nextTick()
  return { wrapper, editor }
}

afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ""
})

/** 组件是多根（编辑区 + Teleport），统一从挂载点上查 DOM */
const q = (selector: string) => document.body.querySelectorAll(selector)
const blocks = () => q("[data-block-path]")

describe("PromptInput 渲染", () => {
  it("每个 \\n 渲染成一个独立的块 div", async () => {
    await mountEditor("a\nb\nc")
    expect(blocks()).toHaveLength(3)
  })

  it("空行也是一个块，不是叶子里的换行符", async () => {
    await mountEditor("a\n\nb")
    expect(blocks()).toHaveLength(3)
    expect(q("[data-slate-string]")).toHaveLength(2)
  })

  it("空段落叶渲染成 FEFF + <br>（撑起行高，光标有地方落）", async () => {
    await mountEditor("")
    const zero = q('[data-slate-zero-width="n"]')[0] as HTMLElement

    expect(zero).toBeTruthy()
    expect(zero.firstChild?.textContent).toBe("\uFEFF")
    expect(zero.querySelectorAll("br")).toHaveLength(1)
  })

  it("内联节点相邻的空叶是 z 型，不带 <br>", async () => {
    await mountEditor("@bob")
    const zeros = q('[data-slate-zero-width="z"]')

    expect(zeros.length).toBeGreaterThan(0)
    for (const z of zeros) {
      expect(z.textContent).toBe("\uFEFF")
      expect(z.querySelectorAll("br")).toHaveLength(0)
    }
  })
})

describe("PromptInput 自愈浏览器对零宽占位的破坏", () => {
  it("被吞掉的 FEFF 文本节点会补回来", async () => {
    const { editor } = await mountEditor("")
    const zero = q("[data-slate-zero-width]")[0] as HTMLElement
    // 模拟 Firefox：吞掉 FEFF 文本节点
    zero.firstChild?.remove()
    expect(zero.firstChild?.textContent).not.toBe("\uFEFF")

    editor.apply()
    await nextTick()
    await nextTick()

    expect(zero.firstChild?.textContent).toBe("\uFEFF")
  })

  it("块里被注入的游离 <br> 会被清掉", async () => {
    const { editor } = await mountEditor("hello")
    const block = q("[data-block-path]")[0] as HTMLElement
    // 模拟 Firefox：在 beforeinput 之前往块里塞一个 <br>
    block.appendChild(document.createElement("br"))

    editor.apply()
    await nextTick()
    await nextTick()

    expect(block.querySelectorAll("br")).toHaveLength(0)
  })

  it("空段落的 <br> 不会被误删", async () => {
    const { editor } = await mountEditor("")
    editor.apply()
    await nextTick()
    await nextTick()

    const zero = q('[data-slate-zero-width="n"]')[0] as HTMLElement
    expect(zero.querySelectorAll("br")).toHaveLength(1)
  })
})

describe("PromptInput 与模型的同步", () => {
  it("插入带 \\n 的文本后 DOM 上多出对应的块", async () => {
    const { editor } = await mountEditor("a")
    Transforms.select(editor, {
      anchor: { path: [0, 0], offset: 1 },
      focus: { path: [0, 0], offset: 1 }
    })

    Transforms.insertText(editor, "b\nc")
    await nextTick()

    expect(blocks()).toHaveLength(2)
  })

  it("插入内联节点后 emit 出序列化好的字符串", async () => {
    const { wrapper, editor } = await mountEditor("hi ")
    Transforms.select(editor, {
      anchor: { path: [0, 0], offset: 3 },
      focus: { path: [0, 0], offset: 3 }
    })

    Transforms.insertNodes(editor, createInline("mention", { id: "bob" }))
    // revision 的 watcher 在 nextTick 里才序列化并 emit
    await nextTick()
    await nextTick()

    const emitted = wrapper.emitted("update:modelValue") ?? []
    expect(emitted[emitted.length - 1]).toEqual(["hi @bob"])
  })
})
