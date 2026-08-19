<script setup lang="ts">
import {
  ConnectionLineType,
  ConnectionMode,
  PanOnScrollMode,
  Position,
  VueFlow
} from "@vue-flow/core"
import { Background } from "@vue-flow/background"
import { MiniMap } from "@vue-flow/minimap"
import { markRaw } from "vue"

import FlowPresenceCursors from "@/components/flow/FlowPresenceCursors.vue"
import FlowSnapGuides from "@/components/flow/FlowSnapGuides.vue"
import FlowViewControls from "@/components/flow/FlowViewControls.vue"
import ProcessNode from "@/components/flow/ProcessNode.vue"
import {
  FLOW_EDGE_TYPE,
  FLOW_GRID_GAP,
  useFlowEditor
} from "@/composables/flow"

/**
 * 画布本体：只负责渲染 Vue Flow 和转发交互，不含任何业务动作。
 *
 * 数据与事件处理都来自 `useFlowEditor()` 的 canvas / selection ——
 * 这个组件里没有一处直接改 store。
 */
const { canvas, selection } = useFlowEditor()

/**
 * 节点类型表要在模板外面定义并 markRaw。
 *
 * 写成 `:node-types="{ process: ProcessNode }"` 的话，这个对象每次渲染都新建一个，
 * Vue Flow 又会把它存进自己的响应式 state —— 组件定义被 reactive() 包一层，
 * Vue 会警告 "received a Component that was made a reactive object"，
 * 而且每次渲染换新对象也会让节点类型白白重新解析。
 */
const nodeTypes = markRaw({ process: ProcessNode })

/**
 * 边的默认样式：只定类型，**不带箭头**。
 *
 * `markerEnd` 一旦给了值，Vue Flow 会在每条边尾部画一个 marker；这里要的是
 * 干净的曲线，所以整个字段都不出现（给 `undefined` 也行，但显式不写更清楚）。
 * 同样提到模板外面：内联字面量每次渲染都是新对象，会让边白白重算。
 */
const defaultEdgeOptions = { type: FLOW_EDGE_TYPE }
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
      :node-types="nodeTypes"
      :connection-mode="ConnectionMode.Strict"
      :default-edge-options="defaultEdgeOptions"
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
      @node-click="selection.select($event.node.id)"
      @pane-click="selection.clearSelection()"
      @move-end="canvas.syncViewport"
    >
      <!--
        zoom-pane 插槽在 .vue-flow__transformationpane 里面，和节点连线同一层，
        所以放进去的东西天然跟着缩放平移走；默认插槽在变换之外，别搞反了。
      -->
      <template #zoom-pane>
        <FlowSnapGuides />
        <FlowPresenceCursors />
      </template>

      <!-- 点阵的间距就是网格吸附的格子（同一个常量），否则「吸到网格上」对不齐任何看得见的东西 -->
      <Background :gap="FLOW_GRID_GAP" />
      <FlowViewControls />
      <MiniMap pannable zoomable />

      <!-- 给上层留的扩展位：想往画布里再塞浮层（对齐线、批注…）从这儿进 -->
      <slot />
    </VueFlow>
  </div>
</template>
