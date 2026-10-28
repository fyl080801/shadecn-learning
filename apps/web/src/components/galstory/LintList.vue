<script setup lang="ts">
import { computed } from "vue"
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "@lucide/vue"

import type { LintIssue, LintLevel } from "@/types/galstory"

/**
 * 装载期体检的结论列表。
 *
 * 三级的语义**跟着引擎走，不要在界面上重新定义**：
 * - `error` 会让 `gal-story lint` 退出码变 1（挂得住 CI），
 * - `warn` 是「配了但到不了 / 少做了一件事」，不阻断，
 * - `info` 是「这是受支持的降级，只是成本结构变了」。
 *
 * 所以这里没有「忽略」按钮：一条 info 不该被当成待办清掉，
 * 它本来就只是在说明成本。
 */

const props = defineProps<{
  issues: LintIssue[]
  /** 全都通过时显示什么；不给就整块不渲染 */
  emptyText?: string
}>()

/** 严重的排前面 —— 一屏放不下时，先看到的应该是会让 CI 挂掉的那几条 */
const ORDER: Record<LintLevel, number> = { error: 0, warn: 1, info: 2 }
const sorted = computed(() => [...props.issues].sort((a, b) => ORDER[a.level] - ORDER[b.level]))

const ICONS: Record<LintLevel, typeof Info> = {
  error: CircleAlert,
  warn: TriangleAlert,
  info: Info
}

/** 图标的颜色就是唯一的严重度信号；warn 的 amber 与 `Settings.vue` 那处同源 */
const TONES: Record<LintLevel, string> = {
  error: "text-destructive",
  warn: "text-amber-600",
  info: "text-muted-foreground"
}

const LABELS: Record<LintLevel, string> = { error: "错误", warn: "警告", info: "提示" }

/**
 * 引擎的体检文案是**写给日志看的**，里面用 `**…**` 标重点（那是它整个仓库的行文习惯）。
 * 原样渲染就是一串星号；而它标的恰恰是「这句话里最该看到的那半句」，丢掉也可惜。
 *
 * 故切成段自己渲染 —— **不走 `v-html`**：这串文本来自后端，哪怕后端是本机的引擎，
 * 把它当 HTML 插进 DOM 也是一条不该开的口子。
 */
function segments(text: string) {
  return text.split("**").map((chunk, index) => ({ text: chunk, strong: index % 2 === 1 }))
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      v-if="issues.length === 0 && emptyText"
      class="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
    >
      <CircleCheck class="size-4 shrink-0" />
      {{ emptyText }}
    </div>

    <template v-else-if="issues.length > 0">
      <div
        v-for="(issue, index) in sorted"
        :key="`${issue.code}-${issue.where}-${index}`"
        class="flex items-start gap-3 rounded-lg border p-3"
      >
        <component :is="ICONS[issue.level]" :class="['mt-0.5 size-4 shrink-0', TONES[issue.level]]" />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <p class="text-sm">
            <template v-for="(seg, i) in segments(issue.message)" :key="i">
              <strong v-if="seg.strong" class="font-medium">{{ seg.text }}</strong>
              <template v-else>{{ seg.text }}</template>
            </template>
          </p>
          <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{{ LABELS[issue.level] }}</span>
            <span aria-hidden="true">·</span>
            <code class="font-mono">{{ issue.code }}</code>
            <template v-if="issue.where">
              <span aria-hidden="true">·</span>
              <code class="font-mono">{{ issue.where }}</code>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
