<script setup lang="ts">
import { Clapperboard } from "@lucide/vue"

import { Button } from "@/components/ui/button"

/**
 * 导演台节点的 body —— 一个「打开导演台」按钮。
 *
 * 导演台本身还没做，按钮**先空着**：不接点击、不发事件。等导演台落地时再给它接上去处
 * （那时用节点事件把「要打开哪个节点」发出去，由编辑器级的订阅方打开，别在这里直接跳路由）。
 *
 * nodrag：在按钮上按下不该变成拖节点。
 */
</script>

<template>
  <div class="flex min-h-[120px] flex-1 items-center justify-center rounded-[inherit] bg-muted/30"
    data-testid="director-body">
    <Button variant="secondary" size="sm" class="nodrag" data-testid="director-open">
      <Clapperboard />
      打开导演台
    </Button>
  </div>
</template>
