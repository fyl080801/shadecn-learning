<script setup lang="ts">
import { computed } from "vue"
import { CircleAlert, X } from "@lucide/vue"
import { Attachment, AttachmentAction, AttachmentActions, AttachmentMedia, AttachmentTrigger } from "@/components/ui/attachment"
import { Spinner } from "@/components/ui/spinner"
import type { AssetUploadItem } from "@/composables/useAssetUpload"
import AssetPreview from "./AssetPreview.vue"

/**
 * 附件列表里的一项（`ui/attachment` 竖排的小方块）：预览 + 状态 + 右上角的删除角标（悬停才出现）。**不用进度条**：
 * - 上传中：`Attachment` 的 `uploading`（分片上传，有进度）/ `processing`（不分片，没有中间进度）——
 *   预览自动半透明，上面一层转圈（`ui/spinner`），分片的再写一个百分比；
 * - 失败：`error` 态（红色），整块可点重试（原因在 title 里），删除照样能点；
 * - 传完：`done`，只剩预览。
 * 删除 = 「不要这个附件了」：上传中删就是取消上传（`useAssetUploadList` 的 `remove`）。
 */
const props = defineProps<{ item: AssetUploadItem; disabled?: boolean }>()
const emit = defineEmits<{ remove: []; retry: [] }>()

const upload = computed(() => props.item.upload)

/** 映射到 `Attachment` 的 `state`：分片有进度 = uploading，不分片 = processing（只转圈）；取消了的也按失败显示（能重试 / 删） */
const state = computed(() => {
  switch (upload.value.status) {
    case "uploading":
      return upload.value.progress === null ? "processing" : "uploading"
    case "done":
      return "done"
    default:
      return "error"
  }
})

const removeLabel = computed(() =>
  upload.value.status === "uploading" ? `取消上传 ${props.item.name}` : `移除 ${props.item.name}`
)
</script>

<template>
  <Attachment
    :state="state"
    orientation="vertical"
    size="xs"
    class="w-16"
    :title="state === 'error' ? `${upload.error ?? '上传失败'}（点击重试）` : props.item.name"
    :data-status="upload.status"
    :data-attachment="props.item.id"
    data-testid="asset-upload-tile"
  >
    <!-- xs 尺寸的 w-7 会压过竖排的 w-full（同权重、CSS 里排在后面），预览就只剩 28px 宽：这里显式铺满 -->
    <AttachmentMedia
      :variant="props.item.kind === 'file' ? 'icon' : 'image'"
      class="group-data-[size=xs]/attachment:w-full"
    >
      <AssetPreview :kind="props.item.kind" :src="props.item.previewUrl" :name="props.item.name" />
    </AttachmentMedia>

    <!-- 上传中：盖在预览上的一层（不跟着预览半透明），不挡删除 -->
    <span
      v-if="state === 'uploading' || state === 'processing'"
      class="pointer-events-none absolute inset-1 flex flex-col items-center justify-center gap-0.5 rounded-md"
      data-testid="asset-upload-pending"
    >
      <Spinner class="size-5" />
      <span
        v-if="state === 'uploading'"
        class="text-[10px] font-medium tabular-nums"
        data-testid="asset-upload-percent"
      >{{ upload.progress }}%</span>
    </span>

    <template v-if="state === 'error'">
      <span class="pointer-events-none absolute inset-1 flex items-center justify-center text-destructive">
        <CircleAlert class="size-5" />
      </span>
      <AttachmentTrigger
        :aria-label="`重试上传 ${props.item.name}`"
        :disabled="props.disabled"
        data-testid="asset-upload-retry"
        @click="emit('retry')"
      />
    </template>

    <!-- 删除是右上角的角标（压在边框外），悬停 / 键盘聚焦时才出现；触屏没有悬停，一直显示 -->
    <AttachmentActions
      class="opacity-0 transition-opacity group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100 pointer-coarse:opacity-100 group-data-[orientation=vertical]/attachment:-top-1.5 group-data-[orientation=vertical]/attachment:-right-1.5"
    >
      <AttachmentAction
        size="icon-xs"
        class="size-4 rounded-full border bg-background shadow-sm hover:bg-muted"
        :aria-label="removeLabel"
        :disabled="props.disabled"
        data-testid="asset-upload-remove"
        @click="emit('remove')"
      >
        <X class="size-2.5" />
      </AttachmentAction>
    </AttachmentActions>
  </Attachment>
</template>
