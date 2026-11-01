<script setup lang="ts">
import { computed } from "vue"
import { X } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { useOptionalFlowAppTasks } from "@/composables/flow/useFlowAppTasks"

import { useNodePart } from "../context"

/**
 * 运行中的状态（能力 status，overlay 区；只在 processing 时挂上）：盖在节点主体上，和出错的「生成失败」同一个位置、同一套外观，
 * **不占位、不撑开节点**；节点的一圈高亮来自能力的 `rootClass`。
 *
 * 节点是生成任务在跑（`runtime.taskId` 在画布的任务列表里）或排队（列表里有这个节点还没被接手的任务，docs/29 §3.10）时显示「排队中」/「生成中」，
 * 上游给了进度就换成进度条 +「生成中 42%」，发起人和项目管理员多一个「取消」；找不到任务（别的运行器、列表还没到）就是转圈 +「运行中」。
 *
 * 整层 `pointer-events-none`：节点照常能选中、拖动；只有取消按钮接点击（`nodrag nopan`，双击不算双击节点）。
 */
const ctx = useNodePart()
const appTasks = useOptionalFlowAppTasks()

const task = computed(() => appTasks?.taskOf(ctx.node.runtime.value.taskId) ?? appTasks?.taskOn(ctx.id))
const queued = computed(() => task.value?.status === "queued" || task.value?.progress?.status === "queued")
const percent = computed(() => {
  const ratio = task.value?.progress?.ratio
  return ratio === undefined || queued.value ? null : Math.round(ratio * 100)
})
const text = computed(() => {
  if (!task.value) return "运行中"
  if (queued.value) return "排队中"
  return percent.value === null ? "生成中" : `生成中 ${percent.value}%`
})

const cancellable = computed(() => (task.value && appTasks?.canCancel(task.value)) || false)
const cancelling = computed(() => (task.value && appTasks?.isCancelling(task.value.id)) || false)

function cancel() {
  if (task.value) void appTasks?.cancel(task.value)
}
</script>

<template>
  <div
    class="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden rounded-[inherit] bg-card/85 p-3 backdrop-blur-[2px]"
    data-testid="node-status-processing"
  >
    <div class="flex w-full max-w-[200px] flex-col items-center gap-2 text-sky-600 dark:text-sky-400">
      <Progress v-if="percent !== null" :model-value="percent" class="h-1.5" />
      <Spinner v-else class="size-5" />
      <span class="text-xs tabular-nums" data-role="status-text">{{ text }}</span>
      <Button
        v-if="cancellable"
        variant="ghost"
        size="sm"
        class="nodrag nopan pointer-events-auto h-7 text-muted-foreground"
        :loading="cancelling"
        data-testid="node-status-cancel"
        @click.stop="cancel()"
        @dblclick.stop
      >
        <X class="size-3.5" />
        取消
      </Button>
    </div>
  </div>
</template>
