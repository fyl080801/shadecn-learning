<script setup lang="ts">
import FlowNodeHandles from "@/components/flow/FlowNodeHandles.vue"

import { useNodePart } from "../context"

/** 能力 `connectable` 挂在 `handles` 区的部件：把上下文接到现成的连接点组件上 */
const ctx = useNodePart()
</script>

<template>
  <FlowNodeHandles :node-id="ctx.id" :type="ctx.type" :data="ctx.node.data.value" />
</template>
