import { describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import { nextTick } from "vue"
import { formatNodeMention } from "@shadecn/shared/agent"
import FlowAgentMarkdown from "@/components/flow/agent/FlowAgentMarkdown.vue"

/**
 * agent 回复的 Markdown 渲染（docs/20 F16）。守两件事：
 * - 模型输出是不可信内容（画布里的文字能诱导它写什么）：HTML 不变成元素、危险链接不可点、图片不自动加载；
 * - 代码块是 shadcn 的 `CodeBlock`、提及是同一枚 badge —— 这两样是不用 `v-html` 的理由。
 */

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    store: {
      nodeById: new Map([
        ["n1", { id: "n1", type: "text", metadata: { label: "开场白" } }]
      ])
    }
  })
}))

function render(text: string) {
  return mount(FlowAgentMarkdown, { props: { text }, attachTo: document.body })
}

describe("FlowAgentMarkdown", () => {
  it("标题、列表、粗体、行内代码、表格按结构渲染", () => {
    const wrapper = render(
      ["## 改动", "", "- **新增** 一个节点", "- 改了 `label`", "", "| 名字 | 数量 |", "| :-- | --: |", "| 节点 | 3 |"].join(
        "\n"
      )
    )
    expect(wrapper.get("h2").text()).toBe("改动")
    expect(wrapper.findAll("ul > li")).toHaveLength(2)
    expect(wrapper.get("strong").text()).toBe("新增")
    expect(wrapper.get("li code").text()).toBe("label")
    expect(wrapper.findAll("td").map((cell) => cell.attributes("style"))).toEqual([
      "text-align: left;",
      "text-align: right;"
    ])
    // 紧凑列表不包 <p>
    expect(wrapper.find("li p").exists()).toBe(false)
  })

  it("原始 HTML 原样显示成文字，不生成元素", () => {
    const wrapper = render('<img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n<div>块</div>')
    expect(wrapper.find("img").exists()).toBe(false)
    expect(wrapper.find("script").exists()).toBe(false)
    expect(wrapper.findAll('[data-role="markdown"] div')).toHaveLength(0)
    expect(wrapper.text()).toContain('<img src=x onerror="alert(1)">')
    expect(wrapper.text()).toContain("<div>块</div>")
  })

  it("javascript: 链接不可点；外链新窗口打开并带 noopener", () => {
    const wrapper = render("[坏](javascript:alert(1)) [文档](https://example.com/a) <https://example.com/b>")
    const links = wrapper.findAll("a")
    expect(links.map((link) => link.attributes("href"))).toEqual(["https://example.com/a", "https://example.com/b"])
    for (const link of links) {
      expect(link.attributes("target")).toBe("_blank")
      expect(link.attributes("rel")).toBe("noopener noreferrer")
    }
    expect(wrapper.text()).toContain("坏")
  })

  it("图片不直接加载，显示成链接", () => {
    const wrapper = render("![示意图](https://example.com/p.png)")
    expect(wrapper.find("img").exists()).toBe(false)
    expect(wrapper.get("a").attributes("href")).toBe("https://example.com/p.png")
    expect(wrapper.get("a").text()).toBe("示意图")
  })

  it("代码块渲染成 CodeBlock：带语言名和复制按钮，内容是原文", () => {
    const wrapper = render("看这段：\n\n```ts\nconst a = 1\nconst b = '<b>'\n```")
    const block = wrapper.get('[data-role="code-block"]')
    expect(block.attributes("data-slot")).toBe("code-block")
    expect(block.attributes("data-lang")).toBe("ts")
    expect(block.get('[data-slot="code-block-title"]').text()).toBe("ts")
    expect(block.find('[data-slot="code-block-copy-button"]').exists()).toBe(true)
    expect(block.findAll('[data-slot="code-block-line"]').map((line) => line.text())).toEqual([
      "const a = 1",
      "const b = '<b>'"
    ])
    expect(block.find("b").exists()).toBe(false)
  })

  it("流式中没闭合的代码块照样按代码渲染", async () => {
    const wrapper = render("```json\n{\"a\":")
    expect(wrapper.get('[data-role="code-block"]').text()).toContain('{"a":')

    await wrapper.setProps({ text: "```json\n{\"a\": 1}\n```\n\n完成" })
    await nextTick()
    expect(wrapper.findAll('[data-role="code-block"]')).toHaveLength(1)
    expect(wrapper.get("p").text()).toBe("完成")
  })

  it("@{node:<id>} 显示成提及 badge，代码里的不换", () => {
    const mention = formatNodeMention("n1")
    const wrapper = render(`改了 ${mention} 的内容\n\n\`${mention}\``)
    expect(wrapper.get("p").text()).toContain("开场白")
    expect(wrapper.get("code").text()).toBe(mention)
  })

  it("单个换行也换行（和纯文本时一致）", () => {
    const wrapper = render("第一行\n第二行")
    expect(wrapper.findAll("p br")).toHaveLength(1)
  })
})
