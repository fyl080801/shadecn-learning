<script setup lang="ts">
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
</script>

<template>
  <!-- 「运行中」角标（能力 status，badge 区；只在 processing 时挂上） -->
  <Badge
    variant="secondary"
    class="bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-400"
    data-testid="node-status-processing"
  >
    <Spinner class="size-3" />
    运行中
  </Badge>
</template>
