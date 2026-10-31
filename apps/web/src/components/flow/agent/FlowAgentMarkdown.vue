<script setup lang="ts">
import { computed, Fragment, h, type VNodeChild } from "vue"
import MarkdownIt, { type Token } from "markdown-it"
import FlowAgentCodeBlock from "./FlowAgentCodeBlock.vue"
import FlowAgentAttachmentMention from "./FlowAgentAttachmentMention.vue"
import FlowAgentMention from "./FlowAgentMention.vue"
import { splitMentions } from "./nodeMention"

/**
 * agent 回复的 Markdown 正文（REQ-AGENT，docs/20 F16）。
 *
 * **不走 `v-html`**：markdown-it 只负责解析，token 在这里逐个转成 VNode ——
 * 文字永远是文本节点，模型输出里的 HTML 原样显示成字，不会变成元素。
 * 这样代码块才能是 shadcn 的 `CodeBlock` 组件、`@{node:<id>}` 才能是和输入框同一个提及 badge。
 *
 * 流式时每来一段就整篇重新解析：几 KB 的文字解析成本可以忽略；没闭合的 ``` 会一直按代码块渲染到末尾。
 */
const props = defineProps<{ text: string }>()

/**
 * `html: false`：原始 HTML 当文字；`breaks: true`：单个换行也换行（和改成 Markdown 之前的纯文本显示一致）。
 * 实例只建一次，所有消息共用
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

/** markdown-it 核心规则只会产出这些标签；不在表里的一律降级成 span，不信任 token 里的 tag */
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li",
  "strong", "em", "s", "table", "thead", "tbody", "tr", "th", "td"
])

/** 链接只放行这几种协议（markdown-it 自己已经拦了 `javascript:` 等，这里再收窄一层） */
const SAFE_LINK = /^(https?:|mailto:)/i

/** 表格单元格的对齐是 markdown-it 写在 style 上的，只认这一种值 */
const CELL_ALIGN = /^text-align:(left|right|center)$/

function link(href: string | null, children: VNodeChild[]): VNodeChild {
  if (!href || !SAFE_LINK.test(href)) return h("span", children)
  return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, children)
}

/** token 上的属性；类型上可能是数字，统一成字符串 */
function attr(token: Token, name: string): string | null {
  const value = token.attrGet(name)
  return value === null ? null : String(value)
}

/** 一个成对 token（`*_open` … `*_close`）连同里面渲染好的子节点 */
function element(token: Token, children: VNodeChild[]): VNodeChild {
  // 紧凑列表里的段落：markdown-it 标成 hidden，只要内容不要 <p>
  if (token.hidden) return h(Fragment, children)
  if (token.type === "link_open") return link(attr(token, "href"), children)
  if (token.type === "table_open") {
    return h("div", { class: "my-2 overflow-x-auto" }, [h("table", { class: "my-0" }, children)])
  }
  if (token.tag === "th" || token.tag === "td") {
    const style = attr(token, "style")
    return h(token.tag, style && CELL_ALIGN.test(style) ? { style } : null, children)
  }
  if (token.tag === "ol") {
    const start = Number(attr(token, "start"))
    return h("ol", Number.isInteger(start) && start !== 1 ? { start } : null, children)
  }
  return h(BLOCK_TAGS.has(token.tag) ? token.tag : "span", children)
}

/** 文字里的 `@{node:<id>}` / `@{attachment:<key>}` 换成提及 badge，其余原样当文本 */
function textNodes(content: string): VNodeChild[] {
  return splitMentions(content).map((segment) => {
    if (segment.kind === "mention") return h(FlowAgentMention, { nodeId: segment.id, class: "mx-0.5" })
    if (segment.kind === "attachment") return h(FlowAgentAttachmentMention, { attachmentKey: segment.key, class: "mx-0.5" })
    return segment.text
  })
}

/** 不成对的 token */
function leaf(token: Token): VNodeChild[] {
  switch (token.type) {
    case "inline":
      return render(token.children ?? [])
    case "text":
      return textNodes(token.content)
    case "code_inline":
      return [h("code", token.content)]
    case "softbreak":
    case "hardbreak":
      return [h("br")]
    case "fence":
      return [h(FlowAgentCodeBlock, { code: token.content, lang: token.info.trim().split(/\s+/)[0] || undefined })]
    case "code_block":
      return [h(FlowAgentCodeBlock, { code: token.content })]
    case "hr":
      return [h("hr")]
    // 图片不直接加载：URL 来自模型输出，可能被画布里的内容诱导成外部追踪地址。显示成链接，点了才打开
    case "image":
      return [link(attr(token, "src"), [token.content || attr(token, "src") || "图片"])]
    default:
      return token.content ? [token.content] : []
  }
}

/** 扁平的 token 流 → 树：`nesting` 1 入栈、-1 出栈，0 是叶子 */
function render(tokens: Token[]): VNodeChild[] {
  const root: VNodeChild[] = []
  const stack: { token: Token; children: VNodeChild[] }[] = []
  const current = () => stack[stack.length - 1]?.children ?? root
  for (const token of tokens) {
    if (token.nesting === 1) {
      stack.push({ token, children: [] })
    } else if (token.nesting === -1) {
      const frame = stack.pop()
      if (frame) current().push(element(frame.token, frame.children))
    } else {
      current().push(...leaf(token))
    }
  }
  // 正常不会剩下；防御一下没闭合的结构，别把内容丢了
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    current().push(element(frame.token, frame.children))
  }
  return root
}

const nodes = computed(() => render(md.parse(props.text, {})))

const Content = () => nodes.value
</script>

<template>
  <div
    class="prose prose-sm max-w-none break-words prose-headings:mb-2 prose-headings:mt-3 prose-h1:text-base prose-h2:text-base prose-h3:text-sm prose-h4:text-sm prose-p:my-2 prose-blockquote:my-2 prose-blockquote:font-normal prose-blockquote:not-italic prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5 prose-hr:my-3 prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_[data-role=code-block]]:my-2"
    data-role="markdown"
  >
    <Content />
  </div>
</template>
