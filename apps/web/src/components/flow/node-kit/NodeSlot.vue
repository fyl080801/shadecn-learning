<script setup lang="ts">
import type { NodePartDef } from "./protocol"

/**
 * 一个区域里的部件，按宿主算好的顺序挨个渲染。
 *
 * 只是个渲染器：挂哪些、什么顺序、露不露出全是宿主（`NodeHost`）算的，
 * 部件组件自己 `useNodePart()` 取上下文，这里不传 props。
 */
defineProps<{
  parts: readonly NodePartDef[]
}>()
</script>

<template>
  <!-- 不往部件上加任何属性：部件可以是多根的（连接点就是左右两个 Handle），透传不了会报警告 -->
  <component :is="part.component" v-for="part in parts" :key="part.id" />
</template>
