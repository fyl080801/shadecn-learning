import { describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import { nextTick, ref } from "vue"
import type { FlowNode } from "@shadecn/shared/flow-graph"
import { formatNodeMention } from "@shadecn/shared/agent"
import { modelToText, textToModel } from "@/components/prompt-input/serialize"
import type { CustomInline, Paragraph } from "@/components/prompt-input/types"
import {
  NODE_MENTION,
  appendMentions,
  createNodeMentionPlugin,
  nodeMentionCandidates,
  splitMentions,
  useNodeMentionMenu
} from "@/components/flow/agent/nodeMention"
import FlowAgentMention from "@/components/flow/agent/FlowAgentMention.vue"

/**
 * 「提及节点」插件。守两件事：
 * - 字符串格式只认 shared 那一份（`@{node:<id>}`），parse / serialize 互逆 ——
 *   错一点，服务端就认不出用户指的是哪个节点，而界面上照样有一枚好看的 badge；
 * - badge 显示的是节点**当前**的名字，节点删了要看得出来。
 */

const nodes = ref<FlowNode[]>([])

vi.mock("@/composables/flow/editor-context", () => ({
  // Pinia 的 setup store 里 nodes 已经解包；用 getter 保持响应式（组件里会解构出 store）
  useFlowEditor: () => ({
    store: {
      get nodes() {
        return nodes.value
      }
    }
  })
}))

function node(id: string, type: string, label: string, text?: string): FlowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label, status: "idle", ...(text !== undefined ? { text } : {}) }
  } as FlowNode
}

const plugin = createNodeMentionPlugin()

describe("提及节点的 parse / serialize", () => {
  it("@{node:<id>} 解析成一枚 badge，序列化回来一字不差", () => {
    const text = `把 ${formatNodeMention("node_a1")} 和 ${formatNodeMention("n-2")} 改短一点\n第二行`
    const model = textToModel(text, [plugin])

    const inlines = (model[0] as Paragraph).children.filter(
      (child): child is CustomInline => "type" in child && child.type === NODE_MENTION
    )
    expect(inlines.map((item) => item.data)).toEqual([{ id: "node_a1" }, { id: "n-2" }])
    expect(modelToText(model, [plugin])).toBe(text)
  })

  it("节点已经被删了也照样 round-trip —— 存的是 id，跟画布上还有没有它无关", () => {
    nodes.value = []
    const text = `删掉 ${formatNodeMention("gone")}`
    expect(modelToText(textToModel(text, [plugin]), [plugin])).toBe(text)
  })

  it("不像提及的文字原样保留", () => {
    const text = "邮件 a@b.com 和 @{node:} 都不是提及"
    expect(modelToText(textToModel(text, [plugin]), [plugin])).toBe(text)
    expect(splitMentions(text)).toEqual([{ kind: "text", text }])
  })

  it("消息列表用的切分和插件是同一个格式", () => {
    expect(splitMentions(`改 ${formatNodeMention("a")}！`)).toEqual([
      { kind: "text", text: "改 " },
      { kind: "mention", id: "a" },
      { kind: "text", text: "！" }
    ])
  })

  it("快捷引用：追加到末尾，已经提及的不重复", () => {
    expect(appendMentions("", ["a", "b"])).toBe("@{node:a} @{node:b} ")
    expect(appendMentions("改一下", ["a"])).toBe("改一下 @{node:a} ")
    expect(appendMentions("改 @{node:a} ", ["a", "b"])).toBe("改 @{node:a} @{node:b} ")
    expect(appendMentions("改 @{node:a}", ["a"])).toBe("改 @{node:a}")
  })
})

describe("提及候选", () => {
  const list = [
    node("1", "text", "结尾", "开场之后的收束"),
    node("2", "text", "开场白", "大家好"),
    node("3", "group", "第一幕 开场"),
    node("4", "process", "", "这里写着开场")
  ]

  it("名字开头 > 名字包含 > 只有正文包含，分组也在其中", () => {
    expect(nodeMentionCandidates(list, "开场").map((item) => item.id)).toEqual(["2", "3", "1", "4"])
  })

  it("大小写不敏感，限条数", () => {
    const many = Array.from({ length: 20 }, (_, i) => node(`n${i}`, "text", `Scene ${i}`))
    expect(nodeMentionCandidates(many, "SCENE")).toHaveLength(8)
  })

  it("摘要是一行：换行与多余空白压掉、过长截断", () => {
    const [item] = nodeMentionCandidates([node("x", "text", "长", `第一行\n\n第二行${"字".repeat(60)}`)], "")
    expect(item?.excerpt.startsWith("第一行 第二行")).toBe(true)
    expect(item?.excerpt.endsWith("…")).toBe(true)
    expect(item?.excerpt.includes("\n")).toBe(false)
  })

  it("键盘：上下循环移动，Enter 选中高亮项；没有候选时不拦 Enter（留给发送）", () => {
    const menu = useNodeMentionMenu(() => list)
    const commit = vi.fn()
    menu.bindCommit(commit)
    menu.onOpen({ name: NODE_MENTION, search: "开场", range: null as never })

    const key = (k: string) => new KeyboardEvent("keydown", { key: k, cancelable: true })
    expect(menu.plugin.onKeyDown?.(key("ArrowUp"), null as never)).toBe(true)
    expect(menu.active.value).toBe(3)
    menu.plugin.onKeyDown?.(key("ArrowDown"), null as never)
    expect(menu.active.value).toBe(0)
    expect(menu.plugin.onKeyDown?.(key("Enter"), null as never)).toBe(true)
    expect(commit).toHaveBeenCalledWith({ data: { id: "2" } })

    menu.onSearch({ name: NODE_MENTION, search: "不存在的词", range: null as never })
    expect(menu.plugin.onKeyDown?.(key("Enter"), null as never)).toBe(false)
  })
})

describe("提及 badge", () => {
  it("显示节点当前的名字，改名后跟着变", async () => {
    nodes.value = [node("a", "text", "旧名字")]
    const wrapper = mount(FlowAgentMention, { props: { nodeId: "a" } })
    expect(wrapper.text()).toBe("旧名字")

    nodes.value = [node("a", "text", "新名字")]
    await nextTick()
    expect(wrapper.text()).toBe("新名字")
  })

  it("节点被删了 → 「已删除的节点」灰态", () => {
    nodes.value = []
    const wrapper = mount(FlowAgentMention, { props: { nodeId: "gone" } })
    expect(wrapper.text()).toBe("已删除的节点")
    expect(wrapper.attributes("data-mention-missing")).toBe("true")
  })

  it("没起名的节点按类型称呼", () => {
    nodes.value = [node("g", "group", "")]
    expect(mount(FlowAgentMention, { props: { nodeId: "g" } }).text()).toBe("未命名分组")
  })
})
