<script setup lang="ts">
import { Handle, Position, useNodeConnections, useNodeId, type HandleType } from "@vue-flow/core"

import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 节点左右两个连接点（左进右出），每种节点共用这一份。
 *
 * 没接线的那一侧平时不显示，只在悬停 / 选中节点、或者画布上有人正在拉线时露出来
 * （规则在 vue-flow.css 的 `.flow-handle`）—— 满屏空心圆是噪音，但要拉线时得找得到。
 *
 * 悬停在连接点上它会放大成一个加号：**点一下**就在这一侧长出一个新节点并连上；
 * **拉线到空白处松手**也一样，新节点落在松手的位置（那一路在 `useFlowCanvas` 的
 * `onConnectEnd` 里）。为此画布关掉了 Vue Flow 的「点一个连接点、再点另一个」连线方式
 * （`connect-on-click`），否则单击会先进入那个模式。
 *
 * 节点 id 由 Vue Flow 从节点上下文注入，所以这里不用传。
 */
const { canvas } = useFlowEditor()
const nodeId = useNodeId()

const targetConnections = useNodeConnections({ handleType: "target" })
const sourceConnections = useNodeConnections({ handleType: "source" })

function grow(handleType: HandleType) {
  if (nodeId) void canvas.addConnectedNode(nodeId, handleType)
}
</script>

<template>
  <!-- .stop：别让这次点击冒到节点上，把原节点选中 —— 选中的应该是新长出来的那个 -->
  <Handle
    type="target"
    :position="Position.Left"
    class="flow-handle"
    :class="{ 'flow-handle--connected': targetConnections.length > 0 }"
    title="点击或拖出连线，新建节点"
    @click.stop="grow('target')"
  />

  <Handle
    type="source"
    :position="Position.Right"
    class="flow-handle"
    :class="{ 'flow-handle--connected': sourceConnections.length > 0 }"
    title="点击或拖出连线，新建节点"
    @click.stop="grow('source')"
  />
</template>
