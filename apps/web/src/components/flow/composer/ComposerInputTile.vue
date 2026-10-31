<script setup lang="ts">
import { computed } from "vue"

import AssetImage from "@/components/flow/AssetImage.vue"
import { flowNodeTypeOf } from "@/components/flow/node-types"
import { nodeUploadById } from "@/components/flow/node-upload"
import { Spinner } from "@/components/ui/spinner"
import { useNodePart } from "@/components/flow/node-kit/context"

/**
 * 连入预览里的一格：一个上游节点的缩略样子（固定 56 × 56）。
 *
 * - 图片：`data.src` 的图标档；视频：预览图 `data.poster`；文本：正文开头几个字；其余（导演台…）：类型图标。
 * - 左下角压一枚类型图标，名字在 `title` 里 —— 格子里不放名字那一行，整排高度不变。
 * - 上游正在上传（`node-upload.ts` 的登记表）：盖一层转圈。
 *
 * 只读：拖动排序由外面那一排（`ComposerInputs.vue`）管，这里只画。
 */
const props = defineProps<{ nodeId: string }>()

const ctx = useNodePart()
const store = ctx.editor.store

const node = computed(() => store.nodeById.get(props.nodeId) ?? null)
const typeDef = computed(() => flowNodeTypeOf(node.value?.type ?? ""))

const label = computed(() => node.value?.metadata.label.trim() || typeDef.value.view.fallbackLabel || typeDef.value.label)

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** 有图就画图：图片取 src，视频只取预览图（不放 `<video>`） */
const image = computed(() => {
  const data = node.value?.data ?? {}
  if (node.value?.type === "image") return str(data.src)
  if (node.value?.type === "video") return str(data.poster)
  return ""
})

const excerpt = computed(() => {
  if (node.value?.type !== "text") return ""
  return str(node.value.data.text).replace(/\s+/g, " ").slice(0, 24)
})

const uploading = computed(() => nodeUploadById(ctx.editor.flowId.value, props.nodeId) !== undefined)
</script>

<template>
  <div
    class="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/50"
    :title="label"
    :data-input-node="props.nodeId"
  >
    <AssetImage
      v-if="image"
      :src="image"
      size="icon"
      :alt="label"
      draggable="false"
      class="size-full object-cover"
    />
    <span
      v-else-if="excerpt"
      class="line-clamp-3 px-1 text-[10px] leading-3 break-all text-muted-foreground"
    >{{ excerpt }}</span>
    <component :is="typeDef.icon" v-else class="size-5 text-muted-foreground" />

    <span
      v-if="image || excerpt"
      class="absolute bottom-0.5 left-0.5 flex size-4 items-center justify-center rounded-sm bg-background/80 text-muted-foreground"
    >
      <component :is="typeDef.icon" class="size-3" />
    </span>

    <span
      v-if="uploading"
      class="absolute inset-0 flex items-center justify-center bg-background/60"
      data-testid="composer-input-uploading"
    >
      <Spinner class="size-4" />
    </span>
  </div>
</template>
