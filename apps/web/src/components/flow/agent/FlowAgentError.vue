<script setup lang="ts">
import { computed } from "vue"
import { parseModelError } from "./modelError"

/**
 * 一轮 / 一个任务失败的原因（docs/20 F21）。原因按 `parseModelError` 拆：认出「状态码 + 上游 JSON 错误体」时，
 * 正文是体里的 `message`，下面一行灰字标状态码、错误类型、错误码，原文收进「原始报错」（展开看，可选中复制）；
 * 认不出的原样整句显示（和 pi 自己的 TUI 一样不丢字）。外层的图标、颜色、`data-role` 由使用处给。
 */
const props = defineProps<{ text: string }>()

const view = computed(() => parseModelError(props.text))

const meta = computed(() =>
  [
    view.value.source,
    view.value.status !== null ? `HTTP ${view.value.status}` : null,
    view.value.type,
    view.value.code
  ].filter((part): part is string => Boolean(part))
)
</script>

<template>
  <div class="min-w-0 flex-1">
    <span class="break-words" data-role="error-message">{{ view.message }}</span>
    <span
      v-if="meta.length > 0"
      class="mt-0.5 flex flex-wrap gap-x-1.5 font-mono text-[11px] text-muted-foreground"
      data-role="error-meta"
    >
      <span v-for="(part, index) in meta" :key="index">{{ index > 0 ? `· ${part}` : part }}</span>
    </span>
    <details v-if="view.raw" class="mt-0.5 text-muted-foreground" data-role="error-raw">
      <summary class="cursor-pointer select-none">原始报错</summary>
      <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-1.5 font-mono text-[11px]">{{ view.raw }}</pre>
    </details>
  </div>
</template>
