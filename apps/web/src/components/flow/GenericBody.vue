<script setup lang="ts">
import { computed } from "vue"
import { findPort } from "@shadecn/shared/flow-node-types"

import { useNodePart } from "@/components/flow/node-kit/context"

/**
 * 通用节点的 body —— 带端口的业务节点（text-input / image-config / video-config …）共用的这一张卡片。
 *
 * 不给每种类型各写一个组件：它们眼下没有专门的编辑界面，要看的东西都一样 ——
 * 名字和说明、关键的业务字段、连进来的输入（各输出端口的产出由能力 `output-preview` 挂在 footer 区）。真要给某种类型做专门的 UI，
 * 在注册表里换掉它的 `view.body` 就行，数据和端口不用动。
 *
 * 名字、工具条、连接点、运行态都是能力，由宿主 `NodeHost` 挂上，这里只是 body。
 */
const ctx = useNodePart()
const { node } = ctx
const { store } = ctx.editor

/** 摘要最多列几个业务字段、每个值最多几个字 */
const SUMMARY_FIELDS = 4
const EXCERPT = 40

function excerpt(value: string): string {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > EXCERPT ? `${line.slice(0, EXCERPT)}…` : line
}

/** 关键业务字段：只挑能一行说清的（字符串、数字、布尔），大对象（导演台的场景）不展开 */
const summary = computed(() => {
  const rows: { key: string; value: string }[] = []
  for (const [key, value] of Object.entries(node.data.value)) {
    if (rows.length >= SUMMARY_FIELDS) break
    if (typeof value === "string") {
      if (value.trim()) rows.push({ key, value: excerpt(value) })
    } else if (typeof value === "number" || typeof value === "boolean") {
      rows.push({ key, value: String(value) })
    }
  }
  return rows
})

/** 连进来的输入：端口名 + 序号 + 上游节点的名字 */
const inputRows = computed(() =>
  node.inputs.value.map((input) => {
    const port = findPort(ctx.type, "inputs", input.port)
    const upstream = store.nodeById.get(input.source)
    return {
      key: input.edgeId,
      port: port?.label ?? input.port ?? "输入",
      index: input.index,
      source: upstream?.metadata.label || input.source,
      value: input.value
    }
  })
)
</script>

<template>
  <div class="contents">
    <div class="pr-12">
      <p class="truncate font-medium" data-testid="generic-node-label">
        {{ node.label.value || ctx.type }}
      </p>
      <p
        v-if="node.metadata.value.description"
        class="line-clamp-2 text-xs text-muted-foreground"
      >
        {{ node.metadata.value.description }}
      </p>
    </div>

    <dl v-if="summary.length > 0" class="space-y-0.5 text-xs" data-testid="generic-node-summary">
      <div v-for="row in summary" :key="row.key" class="flex gap-1.5">
        <dt class="shrink-0 text-muted-foreground">{{ row.key }}</dt>
        <dd class="truncate">{{ row.value }}</dd>
      </div>
    </dl>

    <ul
      v-if="inputRows.length > 0"
      class="space-y-0.5 border-t pt-1.5 text-xs"
      data-testid="generic-node-inputs"
    >
      <li v-for="row in inputRows" :key="row.key" class="flex items-center gap-1.5">
        <span class="shrink-0 text-muted-foreground">{{ row.port }} #{{ row.index }}</span>
        <span class="truncate">← {{ row.source }}</span>
      </li>
    </ul>
  </div>
</template>
