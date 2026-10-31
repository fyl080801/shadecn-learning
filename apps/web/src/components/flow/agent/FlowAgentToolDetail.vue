<script setup lang="ts">
import { computed } from "vue"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
  CodeBlockToken,
  useHighlightedCode
} from "@/components/ui/code-block"

/**
 * 工具调用展开后的一块：参数或结果（ai-elements Tool 的 input / output）。
 *
 * 文字是服务端截过的（`AgentToolCallView.input` / `output`），这里原样显示：能整段解析成 JSON 的按 JSON 高亮并缩进，
 * 不然按纯文本。复制的是显示的那份。高度封顶，超出在块内滚动，不撑长对话。
 */
const props = defineProps<{
  title: string
  text: string
}>()

const parsed = computed(() => {
  const raw = props.text.trim()
  if (!raw.startsWith("{") && !raw.startsWith("[")) return null
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // 截短了的 JSON 解析不了：按纯文本
    return null
  }
})

const code = computed(() => parsed.value ?? props.text)
const lines = useHighlightedCode(code, () => (parsed.value === null ? "" : "json"))
</script>

<template>
  <CodeBlock size="sm" class="not-prose" data-role="tool-detail" :data-detail="props.title">
    <CodeBlockHeader>
      <CodeBlockTitle class="text-muted-foreground">{{ props.title }}</CodeBlockTitle>
      <CodeBlockActions>
        <CodeBlockCopyButton :value="code" />
      </CodeBlockActions>
    </CodeBlockHeader>
    <CodeBlockContent wrap class="max-h-48">
      <CodeBlockLine v-for="(line, index) in lines" :key="index">
        <CodeBlockToken v-for="(token, tokenIndex) in line" :key="tokenIndex" :token="token" />
      </CodeBlockLine>
    </CodeBlockContent>
  </CodeBlock>
</template>
