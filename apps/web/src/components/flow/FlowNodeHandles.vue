<script setup lang="ts">
import { computed, watch } from "vue"
import { Handle, Position, useNodeConnections, useVueFlow } from "@vue-flow/core"
import { hasSide } from "@shadecn/shared/flow-node-types"

import { FLOW_HANDLE_PLUS_RADIUS, flowHandleFollow, flowHandleZone } from "@/components/flow/flow-handle"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 节点的连接点，每种节点共用这一份（由能力 `connectable` 挂到宿主的 `handles` 区，见 `node-kit/features/display.ts`）。
 *
 * **每个节点最多两个：左边一个进、右边一个出，都不带 id。** 端口（`@shadecn/shared/flow-node-types`
 * 的 `inputs` / `outputs`）不画成多个连接点 —— 它只决定这一侧有没有连接点、能连什么、
 * 连上之后是哪对端口：连线时由 shared 的 `resolveConnection` 按声明顺序自动选，
 * 写进边的 `data.sourcePort` / `data.targetPort`。
 *
 * 画不画哪一侧由 shared 的 `hasSide(type, side, data)` 判 —— **带着节点数据**，和连线规则是同一个函数：
 * - 没声明端口的类型（兜底的 process）：左右各一个，和谁都能连；
 * - 没有输入的（text）：不画左边；
 * - 输入此刻关着的（asset 形态的图片 / 视频，`nodeFormOf`）：没有连线时左边收起；还连着线时**左边照旧画**，
 *   只是 `connectable-end=false` 落不了新线。不能直接去掉：Vue Flow 找不到边的目标连接点，
 *   会把线接到节点**顶部中点**（`Position.Top` 兜底）。
 *
 * 连接点出现 / 消失时要 `updateNodeInternals` 重新量一次：没带 id 的 Handle 挂载时不会自己登记位置，
 * 节点尺寸又没变，Vue Flow 不会重量，边就还按旧的连接点（或顶部兜底）画。
 *
 * **连线只有一个方向：从右边（出口）拉到左边（入口）。**
 * - 左边只是落点：`connectable-start=false`（Vue Flow 的官方开关），从它按下拉不出线；没有加号、点了也没反应。
 * - 右边只是起点：`connectable-end=false`，别的线落不到出口上。
 * - 右边是一枚加号：**悬停节点**时出现（不是空心的连接点）。手柄里套着一条看不见的感应区
 *   （`.flow-handle-zone`，节点右边框往外 `FLOW_HANDLE_ZONE` 屏幕像素、上下以手柄为中心同样的范围），鼠标进了这块方区，
 *   加号的圆心就跟着鼠标走（`flowHandleFollow`，夹在方区里）—— 不用瞄准那个小圆，方区里哪儿都点得中。
 *   感应区是手柄的**子元素**：在它上面按下 / 点击都冒泡到手柄，Vue Flow 认作按在这个连接点上；
 *   手柄自己的盒子不变，量出来的连线端点也就不变。跟随只改伪元素的 `translate`（CSS 变量），不触发布局。
 *   **点一下**弹出候选类型菜单（`canvas.openGrowMenu`，锚在加号此刻的位置），
 *   选一种就在右边长出那种节点并连上；**拉线到空白处松手**也弹同一个菜单，锚在落点（那一路在
 *   `useFlowCanvas` 的 `onConnectEnd` 里）。为此画布关掉了 Vue Flow 的「点一个连接点、再点另一个」
 *   连线方式（`connect-on-click`），否则单击会先进入那个模式。
 *
 * 没接线的连接点平时不显示（选没选中、有没有资源都一样）—— 满屏空心圆是噪音；**已经接了线的一侧一直画**。
 * 另外只在**正在拉线**时，露出**能接这条线**的节点的入口（左边，`flow-handle--droppable`）：
 * 拉线的起点是别的节点的出口，且 `canvas.isValidConnection` 认可这对节点。出口只在悬停节点时变成加号。
 * （规则在 vue-flow.css 的 `.flow-handle`。）
 *
 * 能不能连由 `canvas.isValidConnection` 判（先过 shared 的交互门 `interactionGate`，再过和 agent 共用的 `resolveConnection`）。
 * 它挂在 **Handle 上**而不是 `<VueFlow>` 上：Vue Flow 每次同步边都会拿全局那个校验一遍，
 * 判不过的边直接不渲染 —— 而「这对端口已经连过」这些规则拿已经存在的边去判，
 * 必然判自己不合法。挂在 Handle 上的只在拉线的那一刻用。
 */
const props = defineProps<{
  nodeId: string
  type: string
  /** 节点的业务 data（`useFlowNode` 读的那份）：输入开不开放要看它 */
  data: Readonly<Record<string, unknown>>
}>()

const { canvas } = useFlowEditor()

const targetConnections = useNodeConnections({ handleType: "target" })
const sourceConnections = useNodeConnections({ handleType: "source" })

const { updateNodeInternals, viewport, connectionStartHandle } = useVueFlow()

const hasInput = computed(() => hasSide(props.type, "inputs", props.data))
const hasOutput = computed(() => hasSide(props.type, "outputs", props.data))
/** 输入关着、但还连着线：照旧画左边，只是不让落新线 */
const showInput = computed(() => hasInput.value || targetConnections.value.length > 0)

/** 有人正从别的节点的出口拉线、而且这条线能接到本节点：入口露出来当落点 */
const droppable = computed(() => {
  const start = connectionStartHandle.value
  if (!start || start.type !== "source" || start.nodeId === props.nodeId || !hasInput.value) return false
  return canvas.isValidConnection({ source: start.nodeId, target: props.nodeId, sourceHandle: null, targetHandle: null })
})

watch([showInput, hasOutput], () => updateNodeInternals([props.nodeId]), { flush: "post" })

/** 感应区（加号能被感知、能跟着鼠标移动的范围）的尺寸按缩放折算（画布坐标；屏幕上的大小不随缩放变） */
const zoneStyle = computed(() => {
  const zone = flowHandleZone(viewport.value.zoom)
  return { width: `${zone.width}px`, height: `${zone.height}px` }
})

/** 加号此刻圆心的屏幕坐标；没在跟随时为 null，菜单就锚在手柄元素上 */
let plusAt: { x: number; y: number } | null = null

function followPointer(event: PointerEvent) {
  const el = event.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const zoom = viewport.value.zoom || 1
  const at = flowHandleFollow(event.clientX - cx, event.clientY - cy, zoom)
  el.style.setProperty("--flow-handle-follow-x", `${at.x}px`)
  el.style.setProperty("--flow-handle-follow-y", `${at.y}px`)
  plusAt = { x: cx + at.x * zoom, y: cy + at.y * zoom }
}

function stopFollowing(event: PointerEvent) {
  const el = event.currentTarget as HTMLElement
  el.style.removeProperty("--flow-handle-follow-x")
  el.style.removeProperty("--flow-handle-follow-y")
  plusAt = null
}

function openGrowMenu(event: MouseEvent) {
  const handle = event.currentTarget as Element
  const at = plusAt
  // 加号按屏幕像素画（不随缩放变），屏幕上的半径就是这个常量
  const r = FLOW_HANDLE_PLUS_RADIUS
  canvas.openGrowMenu(props.nodeId, {
    anchor: at ? { getBoundingClientRect: () => new DOMRect(at.x - r, at.y - r, r * 2, r * 2) } : handle
  })
}
</script>

<template>
  <Handle
    v-if="showInput"
    type="target"
    :position="Position.Left"
    class="flow-handle"
    :class="{ 'flow-handle--connected': targetConnections.length > 0, 'flow-handle--droppable': droppable }"
    :connectable-start="false"
    :connectable-end="hasInput"
    :is-valid-connection="canvas.isValidConnection"
    data-testid="flow-handle-target"
  />

  <!-- .stop：别让这次点击冒到节点上，把原节点选中 —— 要选中的是新长出来的那个 -->
  <Handle
    v-if="hasOutput"
    type="source"
    :position="Position.Right"
    class="flow-handle"
    :class="{ 'flow-handle--connected': sourceConnections.length > 0 }"
    title="点击或拖出连线，新建相连的节点"
    :connectable-end="false"
    :is-valid-connection="canvas.isValidConnection"
    data-testid="flow-handle-source"
    @pointermove="followPointer"
    @pointerleave="stopFollowing"
    @click.stop="openGrowMenu($event)"
  >
    <span class="flow-handle-zone" :style="zoneStyle" aria-hidden="true" />
  </Handle>
</template>
