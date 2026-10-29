<script setup lang="ts">
import { computed, watch } from "vue"
import { Handle, Position, useNodeConnections, useVueFlow } from "@vue-flow/core"
import { hasSide } from "@shadecn/shared/flow-node-types"

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
 * - 输入此刻关着的（图片 / 视频已经有了资源 `data.src`）：没有连线时左边收起；还连着线时**左边照旧画**，
 *   只是 `connectable-end=false` 落不了新线。不能直接去掉：Vue Flow 找不到边的目标连接点，
 *   会把线接到节点**顶部中点**（`Position.Top` 兜底）。
 *
 * 连接点出现 / 消失时要 `updateNodeInternals` 重新量一次：没带 id 的 Handle 挂载时不会自己登记位置，
 * 节点尺寸又没变，Vue Flow 不会重量，边就还按旧的连接点（或顶部兜底）画。
 *
 * **连线只有一个方向：从右边（出口）拉到左边（入口）。**
 * - 左边只是落点：`connectable-start=false`（Vue Flow 的官方开关），从它按下拉不出线；没有加号、点了也没反应。
 * - 右边只是起点：`connectable-end=false`，别的线落不到出口上。
 * - 右边悬停时放大成加号：**点一下**弹出候选类型菜单（`canvas.openGrowMenu`，锚在这个连接点上），
 *   选一种就在右边长出那种节点并连上；**拉线到空白处松手**也弹同一个菜单，锚在落点（那一路在
 *   `useFlowCanvas` 的 `onConnectEnd` 里）。为此画布关掉了 Vue Flow 的「点一个连接点、再点另一个」
 *   连线方式（`connect-on-click`），否则单击会先进入那个模式。
 *
 * 没接线的那一侧平时不显示，只在悬停 / 选中节点、或者画布上有人正在拉线时露出来
 * （规则在 vue-flow.css 的 `.flow-handle`）—— 满屏空心圆是噪音，但要拉线时得找得到。
 *
 * 能不能连由 `canvas.isValidConnection` 判（和 agent 的 connect 共用 shared 的 `resolveConnection`）。
 * 它挂在 **Handle 上**而不是 `<VueFlow>` 上：Vue Flow 每次同步边都会拿全局那个校验一遍，
 * 判不过的边直接不渲染 —— 而「已经有资源不再接受连入」「这对端口已经连过」这些规则拿已经存在的边去判，
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

const { updateNodeInternals } = useVueFlow()

const hasInput = computed(() => hasSide(props.type, "inputs", props.data))
const hasOutput = computed(() => hasSide(props.type, "outputs", props.data))
/** 输入关着、但还连着线：照旧画左边，只是不让落新线 */
const showInput = computed(() => hasInput.value || targetConnections.value.length > 0)

watch([showInput, hasOutput], () => updateNodeInternals([props.nodeId]), { flush: "post" })

function openGrowMenu(event: MouseEvent) {
  canvas.openGrowMenu(props.nodeId, { anchor: event.currentTarget as Element })
}
</script>

<template>
  <Handle
    v-if="showInput"
    type="target"
    :position="Position.Left"
    class="flow-handle"
    :class="{ 'flow-handle--connected': targetConnections.length > 0 }"
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
    @click.stop="openGrowMenu($event)"
  />
</template>
