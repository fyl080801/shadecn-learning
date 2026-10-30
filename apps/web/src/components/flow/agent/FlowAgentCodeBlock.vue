<script setup lang="ts">
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
 * agent 回复里的一个代码块（fence / 缩进代码）。
 *
 * 高亮交给 shadcn 的 `code-block`：Shiki 按语言首次用到时才加载，没列出的语言按纯文本显示；
 * 流式时已写完的行不再重算，只重算最后一行。复制的是原文，不是高亮后的文本。
 */
const props = defineProps<{
  code: string
  /** fence 的 info 串第一个词；缩进代码块没有 */
  lang?: string
}>()

const lines = useHighlightedCode(
  () => props.code,
  () => props.lang ?? ""
)
</script>

<template>
  <CodeBlock size="sm" class="not-prose" data-role="code-block" :data-lang="props.lang || undefined">
    <CodeBlockHeader>
      <CodeBlockTitle class="font-mono text-muted-foreground">{{ props.lang || "代码" }}</CodeBlockTitle>
      <CodeBlockActions>
        <CodeBlockCopyButton :value="props.code" />
      </CodeBlockActions>
    </CodeBlockHeader>
    <CodeBlockContent>
      <CodeBlockLine v-for="(line, index) in lines" :key="index">
        <CodeBlockToken v-for="(token, tokenIndex) in line" :key="tokenIndex" :token="token" />
      </CodeBlockLine>
    </CodeBlockContent>
  </CodeBlock>
</template>
