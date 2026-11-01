<script setup lang="ts">
import { computed } from "vue"
import { History } from "@lucide/vue"

import { Button } from "@/components/ui/button"
import { useNodePart } from "../context"
import { generationsOf } from "./generations"

/**
 * 右上角的生成数量（能力 `generations`，badge 区）：点一下展开 / 收起右侧的生成历史。
 * 和上传按钮一样**悬停节点才显示**（`flow-node-hover-reveal`；触屏设备常显）；**历史展开期间一直显示**，随时能收起
 */
const ctx = useNodePart()

const count = computed(() => generationsOf(ctx).length)
const open = computed(() => ctx.slots.isOpen("aside"))

function toggle() {
  if (open.value) ctx.slots.close("aside")
  else ctx.slots.open("aside")
}
</script>

<template>
  <Button
    :variant="open ? 'default' : 'secondary'"
    size="sm"
    class="nodrag nopan pointer-events-auto h-7 gap-1 rounded-full px-2 text-xs tabular-nums shadow-sm"
    :class="{ 'flow-node-hover-reveal': !open }"
    :title="open ? '收起生成历史' : '展开生成历史'"
    :aria-label="`生成历史（${count}）`"
    :aria-expanded="open"
    data-testid="node-generation-count"
    @click.stop="toggle()"
    @dblclick.stop
  >
    <History class="size-3.5" />
    {{ count }}
  </Button>
</template>
