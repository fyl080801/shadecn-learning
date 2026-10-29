<script setup lang="ts">
import { ref } from "vue"
import { Upload } from "@lucide/vue"

import { Button } from "@/components/ui/button"

/**
 * 节点 body 里的「上传」按钮 + 隐藏的文件选择框。只管选文件，选中了 `select` 出去，上传和写节点是 body 的事。
 *
 * `nodrag nopan`：在按钮上按下鼠标不该变成拖节点 / 拖画布；`@dblclick.stop` 免得双击按钮被当成双击节点。
 */
defineProps<{ accept: string; label: string; loading?: boolean }>()
const emit = defineEmits<{ select: [file: File] }>()

const input = ref<HTMLInputElement | null>(null)

function onChange(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  // 清空，下次选同一个文件也能触发 change
  target.value = ""
  if (file) emit("select", file)
}
</script>

<template>
  <Button
    variant="outline"
    size="sm"
    class="nodrag nopan"
    :loading="loading"
    data-testid="node-upload-button"
    @click.stop="input?.click()"
    @dblclick.stop
  >
    <Upload class="size-3.5" />
    {{ label }}
  </Button>
  <input ref="input" type="file" :accept="accept" class="hidden" data-testid="node-upload-input" @change="onChange" />
</template>
