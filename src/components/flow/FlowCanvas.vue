<script setup lang="ts">
import {
  ConnectionMode,
  MarkerType,
  PanOnScrollMode,
  Position,
  VueFlow
} from "@vue-flow/core"
import { Background } from "@vue-flow/background"
import { MiniMap } from "@vue-flow/minimap"

import ProcessNode from "@/components/flow/ProcessNode.vue"
// import FlowViewControls from "@/components/flow/FlowViewControls.vue"
import { useFlowEditor } from "@/composables/flow"

/**
 * 画布本体：只负责渲染 Vue Flow 和转发交互，不含任何业务动作。
 *
 * 数据与事件处理都来自 `useFlowEditor()` 的 canvas / selection ——
 * 这个组件里没有一处直接改 store。
 */
const { canvas, selection } = useFlowEditor()
</script>

<template>
  <!-- 滚轮缩放拦在捕获阶段，必须挂在 VueFlow 外面这层 -->
  <div
    class="h-full w-full"
    :class="{ 'flow-canvas-panning': canvas.spacePanning.value }"
    @wheel.capture="canvas.onWheelZoom"
  >
    <VueFlow
      :nodes="canvas.nodes.value"
      :edges="canvas.edges.value"
      :node-types="{ process: ProcessNode }"
      :connection-mode="ConnectionMode.Strict"
      :default-edge-options="{ type: 'smoothstep', markerEnd: MarkerType.ArrowClosed }"
      :source-position="Position.Right"
      :target-position="Position.Left"
      :pan-on-scroll="true"
      :pan-on-scroll-mode="PanOnScrollMode.Vertical"
      :pan-on-drag="canvas.panOnDrag.value"
      :nodes-draggable="canvas.nodesDraggable.value"
      :zoom-on-scroll="false"
      :zoom-on-pinch="false"
      class="h-full w-full"
      @nodes-change="canvas.onNodesChange"
      @node-click="selection.select($event.node.id)"
      @pane-click="selection.clearSelection()"
      @move-end="canvas.syncViewport"
    >
      <Background :gap="16" />
      <!-- <FlowViewControls /> -->
      <MiniMap pannable zoomable />

      <!-- 给上层留的扩展位：想往画布里再塞浮层（对齐线、批注…）从这儿进 -->
      <slot />
    </VueFlow>
  </div>
</template>
