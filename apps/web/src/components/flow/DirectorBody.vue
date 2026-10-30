<script setup lang="ts">
import { Clapperboard } from "@lucide/vue"

import { Button } from "@/components/ui/button"
import { DIRECTOR_OPEN_EVENT } from "@/components/flow/director"
import { useNodePart } from "@/components/flow/node-kit/context"

/**
 * 导演台节点的 body —— 一个「打开导演台」按钮。
 *
 * 点了只发 `director:open` 事件（发出方就是这个节点），由编辑器级的 `FlowDirectorOverlay.vue` 接住、
 * 全屏打开导演台；这里不跳路由、不弹层，也不写文档（导演台数据还没进节点）。
 *
 * nodrag：在按钮上按下不该变成拖节点。
 */
const ctx = useNodePart()
</script>

<template>
  <div class="flex aspect-square w-full items-center justify-center rounded-[inherit] bg-muted/30"
    data-testid="director-body">
    <Button variant="secondary" size="sm" class="nodrag" data-testid="director-open"
      @click="ctx.emit(DIRECTOR_OPEN_EVENT, {})">
      <Clapperboard />
      打开导演台
    </Button>
  </div>
</template>
