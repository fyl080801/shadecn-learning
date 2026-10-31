<script setup lang="ts">
import { computed, h, type VNodeChild } from "vue"
import { renderMarkdown } from "@/lib/markdown-vnodes"
import FlowAgentCodeBlock from "./FlowAgentCodeBlock.vue"
import FlowAgentAttachmentMention from "./FlowAgentAttachmentMention.vue"
import FlowAgentMention from "./FlowAgentMention.vue"
import { splitMentions } from "./nodeMention"

/**
 * agent 回复的 Markdown 正文（REQ-AGENT，docs/20 F16）。
 *
 * 解析和安全规则在 `@/lib/markdown-vnodes`（不走 `v-html`）；这里只决定两样：
 * 代码块是 shadcn 的 `CodeBlock` 组件、`@{node:<id>}` 是和输入框同一个提及 badge。
 *
 * 流式时每来一段就整篇重新解析：几 KB 的文字解析成本可以忽略；没闭合的 ``` 会一直按代码块渲染到末尾。
 */
const props = defineProps<{ text: string }>()

/** 文字里的 `@{node:<id>}` / `@{attachment:<key>}` 换成提及 badge，其余原样当文本 */
function textNodes(content: string): VNodeChild[] {
  return splitMentions(content).map((segment) => {
    if (segment.kind === "mention") return h(FlowAgentMention, { nodeId: segment.id, class: "mx-0.5" })
    if (segment.kind === "attachment") return h(FlowAgentAttachmentMention, { attachmentKey: segment.key, class: "mx-0.5" })
    return segment.text
  })
}

const nodes = computed(() =>
  renderMarkdown(props.text, {
    text: textNodes,
    code: (code, lang) => h(FlowAgentCodeBlock, { code, lang })
  })
)

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
