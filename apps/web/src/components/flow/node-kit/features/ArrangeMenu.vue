<script setup lang="ts">
import { Columns3, LayoutDashboard, LayoutGrid, Rows3 } from "@lucide/vue"
import type { GroupArrangement } from "@shadecn/shared/flow-layout"
import type { Component } from "vue"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

import { useNodePart } from "../context"

/**
 * 分组工具栏最左边的「布局」按钮（能力 `arrange`，挂在 `toolbar` 区）：点开是三种排法，
 * 选一个就把组员重排、分组框收放到正好罩住它们（`canvas.arrangeGroup` → `ops.arrangeGroup`，一次 = 一条撤销）。
 *
 * 要下拉菜单，不是一枚按一下就完事的按钮，所以做成部件而不是动作；外观照抄动作按钮（`ActionBar`）那枚圆按钮。
 */
const ctx = useNodePart()

const OPTIONS: readonly { value: GroupArrangement; label: string; icon: Component }[] = [
  { value: "horizontal", label: "横向排列", icon: Columns3 },
  { value: "vertical", label: "纵向排列", icon: Rows3 },
  { value: "grid", label: "宫格排列", icon: LayoutGrid }
]
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="ghost"
        size="icon"
        class="size-8 rounded-full data-[state=open]:bg-accent"
        title="布局（重新排列组内节点）"
        aria-label="布局"
        data-node-part="arrange.menu"
      >
        <LayoutDashboard />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      side="top"
      align="start"
      :side-offset="12"
      class="w-36"
    >
      <DropdownMenuItem
        v-for="option in OPTIONS"
        :key="option.value"
        :data-arrangement="option.value"
        @select="ctx.editor.canvas.arrangeGroup(ctx.id, option.value)"
      >
        <component :is="option.icon" />
        {{ option.label }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
