import { Fragment, h, type VNodeChild } from "vue"
import MarkdownIt, { type Token } from "markdown-it"

/**
 * Markdown → VNode 的公共核心（agent 回复 `FlowAgentMarkdown`、文本节点 `TextMarkdown` 共用）。
 *
 * **不走 `v-html`**：markdown-it 只负责解析，token 在这里逐个转成 VNode ——
 * 文字永远是文本节点，原始 HTML 原样显示成字，不会变成元素。
 * 文字片段和代码块怎么画由调用方给（`hooks`）：agent 那边要把提及换成 badge、代码块用高亮组件，文本节点只要纯文本。
 *
 * `html: false`：原始 HTML 当文字；`breaks: true`：单个换行也换行（和纯文本显示一致）。实例只建一次，大家共用。
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

export interface MarkdownRenderHooks {
  /** 一段纯文字（`text` token 的内容）；不给就原样当文本 */
  text?: (content: string) => VNodeChild[]
  /** 代码块（围栏 ``` 或缩进）；`lang` 只在围栏上有 */
  code: (code: string, lang?: string) => VNodeChild
}

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

/** 不成对的 token */
function leaf(token: Token, hooks: MarkdownRenderHooks): VNodeChild[] {
  switch (token.type) {
    case "inline":
      return render(token.children ?? [], hooks)
    case "text":
      return hooks.text ? hooks.text(token.content) : [token.content]
    case "code_inline":
      return [h("code", token.content)]
    case "softbreak":
    case "hardbreak":
      return [h("br")]
    case "fence":
      return [hooks.code(token.content, token.info.trim().split(/\s+/)[0] || undefined)]
    case "code_block":
      return [hooks.code(token.content)]
    case "hr":
      return [h("hr")]
    // 图片不直接加载：URL 可能被诱导成外部追踪地址。显示成链接，点了才打开
    case "image":
      return [link(attr(token, "src"), [token.content || attr(token, "src") || "图片"])]
    default:
      return token.content ? [token.content] : []
  }
}

/** 扁平的 token 流 → 树：`nesting` 1 入栈、-1 出栈，0 是叶子 */
function render(tokens: Token[], hooks: MarkdownRenderHooks): VNodeChild[] {
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
      current().push(...leaf(token, hooks))
    }
  }
  // 正常不会剩下；防御一下没闭合的结构，别把内容丢了
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    current().push(element(frame.token, frame.children))
  }
  return root
}

/** 一整篇 Markdown → VNode 列表 */
export function renderMarkdown(source: string, hooks: MarkdownRenderHooks): VNodeChild[] {
  return render(md.parse(source, {}), hooks)
}
