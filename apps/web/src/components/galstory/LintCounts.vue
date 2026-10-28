<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "@lucide/vue"
import type { LintLevel } from "@/types/galstory"

/**
 * 体检三级的计数，一行摆开。
 *
 * **0 的那一级不显示** —— 一排「0 错误 0 警告 2 提示」里，读者要先做三次比较
 * 才知道该看哪个；只留非 0 的，那两个数字自己会跳出来。全 0 时显示一个通过标记，
 * 因为「没问题」和「还没体检」在界面上不能长得一样。
 */
defineProps<{ counts: Record<LintLevel, number>; compact?: boolean }>()

const ICONS: Record<LintLevel, typeof Info> = { error: CircleAlert, warn: TriangleAlert, info: Info }
const TONES: Record<LintLevel, string> = {
  error: "text-destructive",
  warn: "text-amber-600",
  info: "text-muted-foreground"
}
const LABELS: Record<LintLevel, string> = { error: "错误", warn: "警告", info: "提示" }
const LEVELS: LintLevel[] = ["error", "warn", "info"]
</script>

<template>
  <div class="flex items-center gap-3 text-xs text-muted-foreground">
    <template v-if="counts.error + counts.warn + counts.info > 0">
      <span
        v-for="level in LEVELS.filter((l) => counts[l] > 0)"
        :key="level"
        class="flex items-center gap-1"
      >
        <component :is="ICONS[level]" :class="['size-3.5', TONES[level]]" />
        <span class="tabular-nums">{{ counts[level] }}</span>
        <span v-if="!compact">{{ LABELS[level] }}</span>
      </span>
    </template>
    <span v-else class="flex items-center gap-1">
      <CircleCheck class="size-3.5" />
      <span v-if="!compact">体检通过</span>
    </span>
  </div>
</template>
