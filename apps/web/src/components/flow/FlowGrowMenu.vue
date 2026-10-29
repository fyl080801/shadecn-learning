<script setup lang="ts">
import { computed } from "vue"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from "@/components/ui/dropdown-menu"
import { flowNodeTypeOf } from "@/components/flow/node-types"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 「从出口长出新节点」的候选菜单 —— 点出口上的加号、或拉线到空白处松手时弹出（`canvas.openGrowMenu`）。
 *
 * 列的是 `canvas.growCandidates`（shared 的 `connectableNodeTypes`：按全新的空节点去试连线规则，只留连得上的），
 * 每项是注册表里的图标 + 名字；选一种由 `canvas.growFromMenu` 建节点并连线（一条撤销）。
 * 一种都连不上时给一条置灰的「没有可连接的节点」，而不是什么都不弹 —— 点了加号没反应像是坏了。
 *
 * **没有触发器**：菜单的位置交给 reka-ui 的 `reference`（连接点元素，或松手那一点的虚拟元素），
 * 由它的定位（floating-ui）算，不手写坐标。Esc / 点菜单外关掉，什么都不建。
 */
const { canvas } = useFlowEditor()

const menu = canvas.growMenu

const items = computed(() =>
  canvas.growCandidates.value.map((candidate) => {
    const def = flowNodeTypeOf(candidate.type)
    return { type: candidate.type, label: def.label, icon: def.icon }
  })
)

function onOpenChange(open: boolean) {
  if (!open) canvas.closeGrowMenu()
}

function pick(type: string) {
  void canvas.growFromMenu(type)
}
</script>

<template>
  <DropdownMenu
    :open="menu !== null"
    :modal="false"
    @update:open="onOpenChange"
  >
    <DropdownMenuContent
      v-if="menu"
      :reference="menu.reference"
      side="right"
      align="start"
      :side-offset="8"
      class="w-44"
      data-testid="flow-grow-menu"
    >
      <DropdownMenuLabel class="text-xs text-muted-foreground">连接到新节点</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        v-for="item in items"
        :key="item.type"
        :data-node-type="item.type"
        @select="pick(item.type)"
      >
        <component :is="item.icon" />
        {{ item.label }}
      </DropdownMenuItem>
      <DropdownMenuItem
        v-if="items.length === 0"
        disabled
      >
        没有可连接的节点
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
