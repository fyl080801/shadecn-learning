<script setup lang="ts">
import { computed, h } from "vue"

import { renderMarkdown } from "@/lib/markdown-vnodes"

/**
 * 文本节点正文的 Markdown 展示（节点上的展示态、独立编辑面板的预览共用）。
 *
 * 解析和安全规则在 `@/lib/markdown-vnodes`（不走 `v-html`，原始 HTML 当文字，图片显示成链接）。
 * 和 agent 回复那份的区别：没有提及 badge，代码块是一块朴素的 `<pre>` —— 画布上可能有几百个文本节点，
 * 不在每个节点里起语法高亮。
 */
const props = defineProps<{ text: string }>()

const nodes = computed(() =>
  renderMarkdown(props.text, {
    code: (code) => h("pre", { class: "my-2 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs text-foreground" }, [h("code", code)])
  })
)

const Content = () => nodes.value
</script>

<template>
  <div
    class="prose prose-sm max-w-none break-words text-foreground prose-headings:mb-2 prose-headings:mt-3 prose-headings:text-foreground prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-h4:text-sm prose-p:my-2 prose-a:text-primary prose-blockquote:my-2 prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-muted-foreground prose-strong:text-foreground prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5 prose-hr:my-3 prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none prose-pre:p-0 [&>:first-child]:mt-0 [&>:last-child]:mb-0"
    data-role="markdown"
  >
    <Content />
  </div>
</template>
