<script setup lang="ts">
import { X } from "@lucide/vue"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"

/**
 * 节点 body 里的上传进度：分片上传有进度就画进度条 + 百分比；一次传完的（不分片）没有中间进度，只转圈。
 * 两种都能取消（`cancel` 出去，断开请求是 body 的事）。
 *
 * `nodrag nopan`、`@dblclick.stop`：同 `NodeUploadButton`。
 */
defineProps<{ progress: number | null }>()
const emit = defineEmits<{ cancel: [] }>()
</script>

<template>
  <div class="flex w-full max-w-[200px] flex-col items-center gap-2 px-4" data-testid="node-upload-progress">
    <template v-if="progress === null">
      <Spinner class="size-5" />
      <span class="text-xs">上传中…</span>
    </template>
    <template v-else>
      <Progress :model-value="progress" class="h-1.5" />
      <span class="text-xs tabular-nums" data-testid="node-upload-percent">上传中 {{ progress }}%</span>
    </template>
    <Button
      variant="ghost"
      size="sm"
      class="nodrag nopan h-7"
      data-testid="node-upload-cancel"
      @click.stop="emit('cancel')"
      @dblclick.stop
    >
      <X class="size-3.5" />
      取消
    </Button>
  </div>
</template>
