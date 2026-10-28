<script setup lang="ts">
import { computed } from "vue"
import { Handle, Position, useNodeConnections, type HandleType } from "@vue-flow/core"
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
 * - 没声明端口的类型（text / process）：左右各一个，和谁都能连；
 * - 声明了端口、但一个输入都没有的（text-input）：不画左边；没有输出的同理不画右边。
 *
 * 没接线的那一侧平时不显示，只在悬停 / 选中节点、或者画布上有人正在拉线时露出来
 * （规则在 vue-flow.css 的 `.flow-handle`）—— 满屏空心圆是噪音，但要拉线时得找得到。
 *
 * 悬停在连接点上它会放大成一个加号：**点一下**就在这一侧长出一个新节点并连上；
 * **拉线到空白处松手**也一样，新节点落在松手的位置（那一路在 `useFlowCanvas` 的
 * `onConnectEnd` 里）。带端口的节点长出来的，是注册表里第一个能和它连上的类型。
 * 为此画布关掉了 Vue Flow 的「点一个连接点、再点另一个」连线方式（`connect-on-click`），
 * 否则单击会先进入那个模式。
 *
 * 能不能连由 `canvas.isValidConnection` 判（和 agent 的 connect 共用 shared 的 `resolveConnection`）。
 * 它挂在 **Handle 上**而不是 `<VueFlow>` 上：Vue Flow 每次同步边都会拿全局那个校验一遍，
 * 判不过的边直接不渲染 —— 而「端口已满」这条规则拿已经存在的边去判，必然判自己不合法。
 * 挂在 Handle 上的只在拉线的那一刻用。
 */
const props = defineProps<{
  nodeId: string
  type: string
}>()

const { canvas } = useFlowEditor()

const targetConnections = useNodeConnections({ handleType: "target" })
const sourceConnections = useNodeConnections({ handleType: "source" })

const hasInput = computed(() => hasSide(props.type, "inputs"))
const hasOutput = computed(() => hasSide(props.type, "outputs"))

function grow(handleType: HandleType) {
  void canvas.addConnectedNode(props.nodeId, handleType)
}
</script>

<template>
  <!-- .stop：别让这次点击冒到节点上，把原节点选中 —— 选中的应该是新长出来的那个 -->
  <Handle
    v-if="hasInput"
    type="target"
    :position="Position.Left"
    class="flow-handle"
    :class="{ 'flow-handle--connected': targetConnections.length > 0 }"
    title="点击或拖出连线，新建节点"
    :is-valid-connection="canvas.isValidConnection"
    @click.stop="grow('target')"
  />

  <Handle
    v-if="hasOutput"
    type="source"
    :position="Position.Right"
    class="flow-handle"
    :class="{ 'flow-handle--connected': sourceConnections.length > 0 }"
    title="点击或拖出连线，新建节点"
    :is-valid-connection="canvas.isValidConnection"
    @click.stop="grow('source')"
  />
</template>
