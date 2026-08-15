<script setup lang="ts">
import { Controls, ControlButton } from "@vue-flow/controls"
import { Redo2, Undo2 } from "lucide-vue-next"
import { useFlowEditor } from "@/composables/flow"

/**
 * 右上角控件组：Vue Flow 自带的缩放 / 适应视图 / 锁定，加上撤销 / 重做。
 *
 * 画布内的编辑动作都归这一组，胶囊那边只放「这张画布是什么、拿它怎么办」。
 * 必须渲染在 `<VueFlow>` 的插槽里 —— Controls 依赖它注入的画布实例。
 */
const { store, selection } = useFlowEditor()
</script>

<template>
  <!-- 属性面板展开时整组左移让位，否则会被压在面板下面 -->
  <Controls
    position="top-right"
    class="transition-transform"
    :class="selection.selectedNode.value ? '-translate-x-80' : ''"
  >
    <ControlButton title="撤销 (Ctrl+Z)" :disabled="!store.canUndo" @click="store.undo()">
      <Undo2 class="size-3.5" />
    </ControlButton>
    <ControlButton title="重做 (Ctrl+Shift+Z)" :disabled="!store.canRedo" @click="store.redo()">
      <Redo2 class="size-3.5" />
    </ControlButton>
  </Controls>
</template>
