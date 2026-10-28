import { computed, ref, type Ref } from "vue"
import { NODE_MENTION_PATTERN, formatNodeMention, parseNodeMentions } from "@shadecn/shared/agent"
import type { FlowNode } from "@shadecn/shared/flow-graph"
import {
  definePlugin,
  splitByRegex,
  type ParsedSegment,
  type PromptPlugin,
  type TriggerContext
} from "@/components/prompt-input"

/**
 * 「提及节点」—— prompt-input 的一个插件，给画布 Agent 的输入框用（REQ-AGENT）。
 *
 * 输入 `@` 弹出当前画布的节点，选中后在输入框里是一枚 badge，在 v-model 的字符串里是
 * `@{node:<id>}`（格式只认 `@shadecn/shared/agent` 那一份，服务端按同一个正则把 id
 * 换成节点当前的名字和内容）。**存的是 id，不是名字**：badge 每次渲染都去画布上查
 * 节点当前叫什么，节点改名了 badge 跟着变，节点删了显示「已删除的节点」——
 * 发给 agent 的仍是那个 id，服务端自己会发现它不在了。
 *
 * 插件放在 flow 这边而不是 prompt-input 目录里：那个组件的规矩是只依赖 vue，
 * 它不该知道画布是什么。这里用的全是它公开的扩展点（`definePlugin` / `splitByRegex` /
 * `#element:<name>` / `#portal:<name>` / 插件的 `onKeyDown`），没有改它一行。
 */

/** 插件名 = inline 节点的 `type` = 两个插槽名的后缀。**发布后不能改**（影响 round-trip） */
export const NODE_MENTION = "node-mention"

/** 提及 badge 的载荷：只有 id，名字每次现查 */
export interface NodeMentionData {
  id: string
}

/** 弹出列表最多列几条：画布上可能有几百个节点，列全了既找不到也渲染不起 */
export const NODE_MENTION_LIMIT = 8

/** 摘要最多多少字 —— 列表里只占一行 */
const EXCERPT_LENGTH = 40

export interface NodeMentionCandidate {
  id: string
  type: string
  /** 节点名；没起名时为空串，由界面决定怎么称呼 */
  label: string
  /** 一行正文摘要（文本节点的正文 / 节点描述），没有就是空串 */
  excerpt: string
}

/** 把多行、多空白压成一行 */
function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

/** 节点的正文：文本节点是 `data.text`，生成类节点退而取 `data.prompt` */
function bodyOf(node: FlowNode): string {
  return oneLine(node.data.text) || oneLine(node.data.prompt)
}

/** 节点在列表 / badge 里露出来的那两样：名字（`metadata.label`）+ 一行摘要 */
export function describeNode(node: FlowNode): NodeMentionCandidate {
  const body = bodyOf(node) || oneLine(node.metadata.description)
  return {
    id: node.id,
    type: node.type ?? "",
    label: oneLine(node.metadata.label),
    excerpt: body.length > EXCERPT_LENGTH ? `${body.slice(0, EXCERPT_LENGTH)}…` : body
  }
}

/**
 * 按关键词挑候选，**模糊到「包含」为止**（大小写不敏感），排序：
 * 名字以关键词开头 > 名字里包含 > 只有正文里包含。同一档内保持画布上的原有顺序。
 *
 * 没输关键词（刚敲下 `@`）就按画布顺序列前几个。分组也在里面 —— 「把这一组里的都改一下」
 * 正是提及分组的用处。
 */
export function nodeMentionCandidates(
  nodes: readonly FlowNode[],
  search: string,
  limit = NODE_MENTION_LIMIT
): NodeMentionCandidate[] {
  const keyword = search.trim().toLowerCase()
  if (!keyword) return nodes.slice(0, limit).map(describeNode)

  const ranked: Array<{ rank: number; index: number; item: NodeMentionCandidate }> = []
  nodes.forEach((node, index) => {
    const item = describeNode(node)
    const label = item.label.toLowerCase()
    // 摘要被截断过，匹配要看完整正文
    const body = bodyOf(node).toLowerCase()
    let rank = -1
    if (label.startsWith(keyword)) rank = 0
    else if (label.includes(keyword)) rank = 1
    else if (body.includes(keyword) || item.excerpt.toLowerCase().includes(keyword)) rank = 2
    if (rank >= 0) ranked.push({ rank, index, item })
  })
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return ranked.slice(0, limit).map((entry) => entry.item)
}

/** 读 badge 的载荷；数据不像样时返回 null（别让一枚坏 badge 把整个输入框带崩） */
export function nodeMentionIdOf(data: unknown): string | null {
  const id = (data as Partial<NodeMentionData> | null | undefined)?.id
  return typeof id === "string" && id ? id : null
}

/**
 * 插件本体。`onKeyDown` 由外面给 —— 键盘要动的是弹出列表的高亮项，那份状态在
 * `useNodeMentionMenu` 里；不给就只做 parse / serialize（只读展示消息时用）。
 */
export function createNodeMentionPlugin(
  options: { onKeyDown?: (event: KeyboardEvent, ctx: TriggerContext) => boolean } = {}
): PromptPlugin {
  return definePlugin({
    name: NODE_MENTION,
    trigger: { key: "@" },
    inline: { type: NODE_MENTION },
    parse(text): ParsedSegment[] {
      return splitByRegex(text, NODE_MENTION_PATTERN, (match) => ({
        kind: "node",
        type: NODE_MENTION,
        data: { id: match[1] ?? "" } satisfies NodeMentionData
      }))
    },
    serialize(node): string {
      const id = nodeMentionIdOf(node.data)
      // 没有 id 的 badge 序列化成空串：宁可丢掉一枚坏 badge，也不往 prompt 里塞 `@{node:}`
      return id ? formatNodeMention(id) : ""
    },
    onKeyDown: options.onKeyDown
  })
}

/**
 * 把一段带提及的文本切成「文字 / 提及」两种片段 —— 消息列表里渲染用户消息时用。
 * 和插件的 `parse` 是同一个正则，所以输入框里看到什么，发出去之后就还是什么。
 */
export function splitMentions(
  text: string
): Array<{ kind: "text"; text: string } | { kind: "mention"; id: string }> {
  return splitByRegex(text, NODE_MENTION_PATTERN, (match) => ({
    kind: "node",
    type: NODE_MENTION,
    data: { id: match[1] ?? "" }
  })).map((segment) =>
    segment.kind === "text"
      ? { kind: "text" as const, text: segment.text }
      : { kind: "mention" as const, id: nodeMentionIdOf(segment.data) ?? "" }
  )
}

/**
 * 弹出列表的状态 + 键盘：上下移动高亮、Enter / Tab 选中、Esc 交给 PromptInput 关掉。
 *
 * `commit` 要等 PromptInput 挂上之后才有（`#portal` 插槽的 scope / 组件暴露的
 * `commitActive`），所以用 `bindCommit` 晚绑定。
 */
export function useNodeMentionMenu(nodes: () => readonly FlowNode[]) {
  const open = ref(false)
  const search = ref("")
  const active = ref(0)

  const candidates = computed(() =>
    open.value ? nodeMentionCandidates(nodes(), search.value) : []
  )

  let commitFn: ((payload: { data: unknown }) => void) | null = null

  function bindCommit(fn: (payload: { data: unknown }) => void) {
    commitFn = fn
  }

  function pick(candidate: NodeMentionCandidate) {
    commitFn?.({ data: { id: candidate.id } satisfies NodeMentionData })
  }

  function onOpen(ctx: TriggerContext) {
    open.value = true
    search.value = ctx.search
    active.value = 0
  }

  function onClose() {
    open.value = false
    search.value = ""
    active.value = 0
  }

  function onKeyDown(event: KeyboardEvent): boolean {
    const list = candidates.value
    // 一个都没匹配上：不拦，Enter 照常是「发送」，`@xxx` 就当普通文字
    if (list.length === 0) return false
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        active.value = (active.value + 1) % list.length
        return true
      case "ArrowUp":
        event.preventDefault()
        active.value = (active.value - 1 + list.length) % list.length
        return true
      case "Enter":
      case "Tab": {
        // 输入法组合中的 Enter 是「上屏」，不是选中
        if (event.isComposing) return false
        event.preventDefault()
        const chosen = list[Math.min(active.value, list.length - 1)]
        if (chosen) pick(chosen)
        return true
      }
    }
    return false
  }

  const plugin = createNodeMentionPlugin({ onKeyDown })

  return {
    plugin,
    open: open as Readonly<Ref<boolean>>,
    search,
    active,
    candidates,
    bindCommit,
    pick,
    onOpen,
    /** 搜索词变了 —— 和打开是同一套处理：重置高亮到第一项 */
    onSearch: onOpen,
    onClose
  }
}

export type NodeMentionMenu = ReturnType<typeof useNodeMentionMenu>

/**
 * 把一批节点作为提及追加到输入框文本末尾（「引用选中的节点」那个快捷按钮）。
 * 已经提及过的跳过；前面没有空白就补一个，末尾留一个空格好接着打字。
 */
export function appendMentions(text: string, nodeIds: readonly string[]): string {
  const known = new Set(parseNodeMentions(text))
  const fresh = nodeIds.filter((id) => !known.has(id))
  if (fresh.length === 0) return text
  const joined = fresh.map(formatNodeMention).join(" ")
  const separator = text === "" || /\s$/.test(text) ? "" : " "
  return `${text}${separator}${joined} `
}
