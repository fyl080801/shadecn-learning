<script setup lang="ts">
import { markRaw, ref } from "vue"
import { until } from "@vueuse/core"
import {
  ConnectionMode,
  MarkerType,
  PanOnScrollMode,
  Position,
  VueFlow,
  useVueFlow,
  type Edge,
  type Node
} from "@vue-flow/core"
import { Background } from "@vue-flow/background"
import { Controls } from "@vue-flow/controls"
import { MiniMap } from "@vue-flow/minimap"
import { Plus } from "@lucide/vue"

import { Button } from "@/components/ui/button"
import ProcessNode from "@/components/flow/ProcessNode.vue"

// 组件定义不能进响应式对象，理由同 FlowCanvas.vue
const nodeTypes = markRaw({ process: ProcessNode })

const nodes = ref<Node[]>([
  {
    id: "1",
    type: "process",
    position: { x: 0, y: 0 },
    data: { label: "开始" }
  },
  {
    id: "2",
    type: "process",
    position: { x: 240, y: 0 },
    data: { label: "结束" }
  }
])

const edges = ref<Edge[]>([
  { id: "e1-2", source: "1", target: "2", animated: true }
])

const {
  vueFlowRef,
  addNodes,
  addEdges,
  findNode,
  updateNode,
  screenToFlowCoordinate,
  getViewport,
  setViewport,
  minZoom,
  maxZoom,
  fitView,
  onPaneReady,
  onConnect
} = useVueFlow()

// 滚轮上下滚动画布、Ctrl + 滚轮缩放。
// 缩放这里自己实现：d3 的 wheelDelta 见到 ctrlKey 会把 delta ×10（那是为触控板
// 捏合准备的），鼠标滚轮一格 deltaY=120 会直接算出 5 倍多，一下就顶到缩放上/下限。
// 去掉这个 ×10 后，手感和 vue-flow 默认的滚轮缩放一致。
function onWheelZoom(event: WheelEvent) {
  if (!event.ctrlKey) return

  // 拦在捕获阶段，vue-flow 自己的 wheel 处理就不会再收到这个事件
  event.preventDefault()
  event.stopPropagation()

  const { x, y, zoom } = getViewport()
  const delta =
    -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002)
  const nextZoom = Math.min(
    maxZoom.value,
    Math.max(minZoom.value, zoom * 2 ** delta)
  )
  if (nextZoom === zoom) return

  // 以光标为锚点缩放：让光标下的那个点保持不动
  const point = screenToFlowCoordinate({ x: event.clientX, y: event.clientY })
  setViewport({
    x: x - point.x * (nextZoom - zoom),
    y: y - point.y * (nextZoom - zoom),
    zoom: nextZoom
  })
}

// 默认 fitView 最大会放大到 4 倍，这里限制成 1，保持节点原始大小
onPaneReady(() => {
  fitView({ maxZoom: 1, padding: 0.2 })
})

// 连线：拖动一端的连接点到另一个节点即可建立边
onConnect((connection) => {
  addEdges({ ...connection, animated: true })
})

let nodeId = nodes.value.length

// 连续新增时按屏幕像素做层叠偏移，避免节点完全重叠（第一个仍然正好在中心）
const CASCADE_STEP = 24
const CASCADE_COUNT = 6
let cascadeIndex = 0

async function addNode() {
  const bounds = vueFlowRef.value?.getBoundingClientRect()
  if (!bounds) return

  const id = `${++nodeId}`
  const offset = (cascadeIndex++ % CASCADE_COUNT) * CASCADE_STEP

  // 画布中心的屏幕坐标 -> 流程图内部坐标
  const center = screenToFlowCoordinate({
    x: bounds.left + bounds.width / 2 + offset,
    y: bounds.top + bounds.height / 2 + offset
  })

  addNodes({
    id,
    type: "process",
    position: center,
    data: { label: `节点 ${id}` }
  })

  // position 是左上角，要等节点渲染量出尺寸后才能换算成居中
  const node = findNode(id)
  if (!node) return

  await until(() => node.dimensions.width).toBeTruthy({ timeout: 1000 })

  updateNode(id, {
    position: {
      x: center.x - node.dimensions.width / 2,
      y: center.y - node.dimensions.height / 2
    }
  })
}
</script>

<template>
  <div class="relative h-full w-full" @wheel.capture="onWheelZoom">
    <VueFlow
      v-model:nodes="nodes"
      v-model:edges="edges"
      :node-types="nodeTypes"
      :connection-mode="ConnectionMode.Strict"
      :default-edge-options="{
        type: 'smoothstep',
        markerEnd: MarkerType.ArrowClosed
      }"
      :source-position="Position.Right"
      :target-position="Position.Left"
      :pan-on-scroll="true"
      :pan-on-scroll-mode="PanOnScrollMode.Vertical"
      :zoom-on-scroll="false"
      :zoom-on-pinch="false"
      class="h-full w-full"
    >
      <Background :gap="16" />
      <Controls position="top-left" />
      <MiniMap pannable zoomable />
    </VueFlow>

    <!-- 底部悬浮工具栏 -->
    <div
      class="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-card/95 p-1.5 shadow-lg backdrop-blur"
    >
      <Button variant="ghost" size="sm" title="添加节点" @click="addNode">
        <Plus />
        添加节点
      </Button>
    </div>
  </div>
</template>
