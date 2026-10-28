<script setup lang="ts">
import { Button } from "@/components/ui/button"

import { useNodeKitRuntime, useNodePart } from "./context"
import type { NodeActionDef } from "./protocol"

/**
 * 一个区域里的动作（工具），统一画成画布浮动工具栏那种圆按钮。
 *
 * 动作是数据，不是组件：加一个工具只写一条 `defineNodeAction`，按钮长什么样由这里说了算。
 * 要特殊外观的（下拉选模型之类）就别做成动作，做成部件。
 *
 * 执行走编辑器级的那一个执行器（`node-kit/actions.ts`）—— 和快捷键同一把锁、同一对
 * `action:invoke` / `action:done` 事件。按钮的 title 带上快捷键，按钮就是快捷键唯一的说明书。
 */
defineProps<{
  actions: readonly NodeActionDef[]
}>()

const ctx = useNodePart()
const { actions: runner } = useNodeKitRuntime()

function title(action: NodeActionDef) {
  return action.shortcut ? `${action.label}（${action.shortcut}）` : action.label
}
</script>

<template>
  <Button
    v-for="action in actions"
    :key="action.id"
    variant="ghost"
    size="icon"
    :class="
      action.tone === 'destructive'
        ? 'size-8 rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive'
        : 'size-8 rounded-full'
    "
    :title="title(action)"
    :aria-label="action.label"
    :disabled="!runner.enabled(ctx, action)"
    :loading="runner.isPending(ctx.id, action.id)"
    :data-node-action="action.id"
    @click.stop="runner.run(ctx, action)"
  >
    <component :is="action.icon" />
  </Button>
</template>
