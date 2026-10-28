<script setup lang="ts">
import { LoaderCircle } from "@lucide/vue"
</script>

<template>
  <!-- 「运行中」角标（能力 status，badge 区；只在 processing 时挂上） -->
  <span
    class="flex items-center gap-1 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400"
    data-testid="node-status-processing"
  >
    <LoaderCircle class="size-3 animate-spin" />
    运行中
  </span>
</template>
