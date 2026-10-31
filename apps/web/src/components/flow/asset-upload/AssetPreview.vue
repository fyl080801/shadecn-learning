<script setup lang="ts">
import { File as FileIcon } from "@lucide/vue"
import type { AssetSize } from "@shadecn/shared/canvas"
import AssetImage from "@/components/flow/AssetImage.vue"
import type { AssetUploadKind } from "@/composables/useAssetUpload"

/**
 * 一个资源的预览内容，放在 `ui/attachment` 的 `AttachmentMedia` 里：图片画图、视频画第一帧
 * （`preload="metadata"`，静音、不播），其余是文件图标 + 名字。上传中的附件（本地预览地址）和对话里
 * 已发出去的附件（对象存储地址）用的是同一个。
 * 图片按 `size` 取档（docs/27；本地预览地址推不出档位，照常显示原图）。`draggable="false"`：别让浏览器原生的拖图片拖出去。
 */
const props = defineProps<{
  kind: AssetUploadKind
  /** 预览地址；没有（或文件类）就画图标 */
  src: string | null
  name: string
  /** 图片取哪一档；缺省原图 */
  size?: AssetSize
}>()
</script>

<template>
  <AssetImage
    v-if="props.kind === 'image' && props.src"
    :src="props.src"
    :size="props.size ?? 'original'"
    :alt="props.name"
    draggable="false"
    class="size-full object-cover"
    data-testid="asset-preview"
    data-kind="image"
  />
  <video
    v-else-if="props.kind === 'video' && props.src"
    :src="props.src"
    muted
    playsinline
    preload="metadata"
    class="size-full object-cover"
    data-testid="asset-preview"
    data-kind="video"
  />
  <span
    v-else
    class="flex size-full flex-col items-center justify-center gap-0.5 px-1 text-muted-foreground"
    data-testid="asset-preview"
    data-kind="file"
  >
    <FileIcon class="size-4 shrink-0" />
    <span class="w-full truncate text-center text-[9px] leading-tight" data-role="file-name">{{ props.name }}</span>
  </span>
</template>
