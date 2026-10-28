<script setup lang="ts">
import { computed } from "vue"
import { CircleAlert } from "@lucide/vue"

import { useNodePart } from "../context"

/** 出错时的错误信息（能力 status，footer 区；只在 error 时挂上）。没有错误文案时给兜底 */
const ctx = useNodePart()

const text = computed(() => ctx.node.runtime.value.error || "运行出错")
</script>

<template>
  <p class="mt-1 flex items-start gap-1 break-words text-xs text-destructive" data-testid="node-status-error">
    <CircleAlert class="mt-px size-3 shrink-0" />
    <span>{{ text }}</span>
  </p>
</template>
