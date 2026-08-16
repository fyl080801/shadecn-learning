<script setup lang="ts">
import {
  ConnectionLineType,
  ConnectionMode,
  MarkerType,
  PanOnScrollMode,
  Position,
  VueFlow
} from "@vue-flow/core"
import { Background } from "@vue-flow/background"
import { MiniMap } from "@vue-flow/minimap"

import FlowPresenceCursors from "@/components/flow/FlowPresenceCursors.vue"
import ProcessNode from "@/components/flow/ProcessNode.vue"
// import FlowViewControls from "@/components/flow/FlowViewControls.vue"
import { FLOW_EDGE_TYPE, useFlowEditor } from "@/composables/flow"

/**
 * 画布本体：只负责渲染 Vue Flow 和转发交互，不含任何业务动作。
 *
 * 数据与事件处理都来自 `useFlowEditor()` 的 canvas / selection ——
 * 这个组件里没有一处直接改 store。
 */
const { canvas, selection } = useFlowEditor()

/**
 * 被别人占住的节点点了也不选中。
 *
 * 节点数据上已经带了 `selectable: false`（Vue Flow 自己的选中态因此不会亮），
 * 但 `nodeClick` 照样会派发，我们自己的选中态得在这儿挡一道 ——
 * 否则属性面板会打开一个改不动的节点。
 */
function onNodeClick(nodeId: string) {
  // 只读判断一律走 canvas.isLocked：它是含派生占用的那一份
  if (canvas.isLocked("node", nodeId)) return
  selection.select(nodeId)
}
</script>

<template>
  <!--
    滚轮缩放拦在捕获阶段，必须挂在 VueFlow 外面这层。

    `delete-key-code=null` 是把删除键从 Vue Flow 手里收回来：它自带的那个会直接改
    自己内部的 nodes/edges，绕过 store.apply —— 删掉的东西不进历史、不落库、
    也不会广播给别人。改由 useFlowShortcuts 调 canvas.deleteSelection()。
  -->
  <div
    class="h-full w-full"
    :class="{ 'flow-canvas-panning': canvas.spacePanning.value }"
    @wheel.capture="canvas.onWheelZoom"
    @pointermove="canvas.onPointerMove"
    @pointerleave="canvas.onPointerLeave"
  >
    <VueFlow
      :nodes="canvas.nodes.value"
      :edges="canvas.edges.value"
      :node-types="{ process: ProcessNode }"
      :connection-mode="ConnectionMode.Strict"
      :default-edge-options="{ type: FLOW_EDGE_TYPE, markerEnd: MarkerType.ArrowClosed }"
      :connection-line-type="ConnectionLineType.Bezier"
      :source-position="Position.Right"
      :target-position="Position.Left"
      :pan-on-scroll="true"
      :pan-on-scroll-mode="PanOnScrollMode.Vertical"
      :pan-on-drag="canvas.panOnDrag.value"
      :nodes-draggable="canvas.nodesDraggable.value"
      :zoom-on-scroll="false"
      :zoom-on-pinch="false"
      :delete-key-code="null"
      class="h-full w-full"
      @nodes-change="canvas.onNodesChange"
      @node-click="onNodeClick($event.node.id)"
      @pane-click="selection.clearSelection()"
      @move-end="canvas.syncViewport"
    >
      <!--
        zoom-pane 插槽在 .vue-flow__transformationpane 里面，和节点连线同一层，
        所以放进去的东西天然跟着缩放平移走；默认插槽在变换之外，别搞反了。
      -->
      <template #zoom-pane>
        <FlowPresenceCursors />
      </template>

      <Background :gap="16" />
      <!-- <FlowViewControls /> -->
      <MiniMap pannable zoomable />

      <!-- 给上层留的扩展位：想往画布里再塞浮层（对齐线、批注…）从这儿进 -->
      <slot />
    </VueFlow>
  </div>
</template>
