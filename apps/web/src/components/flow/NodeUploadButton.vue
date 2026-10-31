<script setup lang="ts">
import { computed, ref } from "vue"
import { Upload } from "@lucide/vue"

import { Button } from "@/components/ui/button"
import { useNodePart } from "@/components/flow/node-kit/context"
import { nodeUploadKindOf, useNodeUpload } from "@/components/flow/node-upload"

/**
 * 节点右上角（`badge` 区）的「上传」图标 + 隐藏的文件选择框。按节点类型取接受的文件和上传任务（`nodeUploadKindOf`），
 * 选中了就开一次上传（`useNodeUpload`）；进度、取消在 body 的占位上（`NodeUploadProgress`）。
 *
 * 角标区整块 `pointer-events-none`（不挡拖节点），按钮自己要 `pointer-events-auto` 拿回点击。
 * `nodrag nopan`：在按钮上按下鼠标不该变成拖节点 / 拖画布；`@dblclick.stop` 免得双击按钮被当成双击节点。
 */
const ctx = useNodePart()
const kind = computed(() => nodeUploadKindOf(ctx.type))

const { upload } = useNodeUpload(ctx, async (file, io) => {
  await kind.value?.task(ctx.editor.flowId.value, file, io, ctx.node.attachAsset)
})

const input = ref<HTMLInputElement | null>(null)

function onChange(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  // 清空，下次选同一个文件也能触发 change
  target.value = ""
  if (file) upload(file)
}
</script>

<template>
  <template v-if="kind">
    <Button
      variant="secondary"
      size="icon"
      class="nodrag nopan pointer-events-auto size-7 rounded-full shadow-sm"
      :title="kind.label"
      :aria-label="kind.label"
      data-testid="node-upload-button"
      @click.stop="input?.click()"
      @dblclick.stop
    >
      <Upload class="size-3.5" />
    </Button>
    <input ref="input" type="file" :accept="kind.accept" class="hidden" data-testid="node-upload-input" @change="onChange" />
  </template>
</template>
