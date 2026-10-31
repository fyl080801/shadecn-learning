<script setup lang="ts">
import { Maximize2 } from "@lucide/vue"

import { Button } from "@/components/ui/button"
import { DIRECTOR_OPEN_EVENT } from "@/components/flow/director"
import { useNodePart } from "@/components/flow/node-kit/context"

/**
 * 导演台节点右上角（`badge` 区）的「打开导演台」图标按钮，和图片 / 视频的上传按钮（`NodeUploadButton.vue`）同款、同位置。
 *
 * 点了只发 `director:open` 事件（发出方就是这个节点），由编辑器级的 `FlowDirectorOverlay.vue` 接住、
 * 全屏打开导演台；这里不跳路由、不弹层，也不写文档。
 *
 * 角标区整块 `pointer-events-none`（不挡拖节点），按钮自己要 `pointer-events-auto` 拿回点击。
 * `nodrag nopan`：在按钮上按下不该变成拖节点 / 拖画布；`@dblclick.stop` 免得双击按钮被当成双击节点。
 */
const ctx = useNodePart()
</script>

<template>
  <Button
    variant="secondary"
    size="icon"
    class="nodrag nopan pointer-events-auto size-7 rounded-full shadow-sm"
    title="打开导演台"
    aria-label="打开导演台"
    data-testid="director-open"
    @click.stop="ctx.emit(DIRECTOR_OPEN_EVENT, {})"
    @dblclick.stop
  >
    <Maximize2 class="size-3.5" />
  </Button>
</template>
