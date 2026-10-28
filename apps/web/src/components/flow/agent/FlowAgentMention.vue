<script setup lang="ts">
import { computed } from "vue"
import { CircleSlash } from "@lucide/vue"
import { flowNodeTypeOf } from "@/components/flow/node-types"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { cn } from "@/lib/utils"

/**
 * 一枚「提及节点」badge —— 输入框里和消息列表里长得一样。
 *
 * 只拿 id，名字**每次现查**画布：节点改了名 badge 跟着变；节点被删了显示「已删除的节点」灰态。
 * 发出去的 prompt 里存的始终是 id（`@{node:<id>}`），这里只决定给人看什么。
 */
const props = defineProps<{ nodeId: string }>()

const { store } = useFlowEditor()

const node = computed(() => store.nodes.find((item) => item.id === props.nodeId) ?? null)

const typeDef = computed(() => (node.value ? flowNodeTypeOf(node.value.type ?? "") : null))

const label = computed(() => {
  if (!node.value) return "已删除的节点"
  const name = typeof node.value.data.label === "string" ? node.value.data.label.trim() : ""
  return name || `未命名${typeDef.value?.label ?? "节点"}`
})
</script>

<template>
  <span
    :class="
      cn(
        'inline-flex max-w-48 items-center gap-1 rounded-md border px-1.5 align-middle text-xs leading-5',
        node
          ? 'border-primary/30 bg-primary/10 text-foreground'
          : 'border-dashed border-muted-foreground/40 bg-muted text-muted-foreground line-through decoration-muted-foreground/50'
      )
    "
    :title="node ? label : `这个节点已经不在画布上了（${props.nodeId}）`"
    :data-mention-id="props.nodeId"
    :data-mention-missing="node ? undefined : 'true'"
  >
    <component :is="typeDef.icon" v-if="typeDef" class="size-3 shrink-0 opacity-70" />
    <CircleSlash v-else class="size-3 shrink-0" />
    <span class="truncate">{{ label }}</span>
  </span>
</template>
