<script setup lang="ts">
import { computed } from "vue"
import { Image } from "@lucide/vue"

import { useMediaFit } from "@/components/flow/media-fit"
import NodeUploadButton from "@/components/flow/NodeUploadButton.vue"
import { useNodePart } from "@/components/flow/node-kit/context"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { uploadFlowAsset } from "@/lib/asset-upload"

/**
 * 图片节点的 body —— 画 `data.src` 那张图；没有就是一块空占位，上面一个「上传图片」按钮。
 *
 * 上传经后端转存到 S3（`uploadFlowAsset`：大文件自动分片），回来的 **S3 原始地址**原样写进 `data.src`，
 * 显示时浏览器直接从 S3 读，不经后端。
 * `draggable="false"`：浏览器原生的拖图片会抢走 Vue Flow 的拖节点。
 *
 * 节点尺寸跟着图片的高宽比走（竖图定宽、横图定高，`media-fit.ts`）：图加载完记进布局，下次打开直接是这个大小。
 * 图片区按记录的比例定高，`object-cover` 铺满（比例被夹过的超长图裁掉两头）；报错行接在下面，不挤图片。
 */
const ctx = useNodePart()
const { boxStyle, onLoad } = useMediaFit()

const src = computed(() => {
  const value = ctx.node.data.value.src
  return typeof value === "string" ? value.trim() : ""
})

const { run: upload, pending } = useAsyncAction(
  async (file: File) => {
    const asset = await uploadFlowAsset(ctx.editor.flowId.value, file)
    ctx.node.setData({ src: asset.url }, "上传图片")
  },
  { errorMessage: "上传失败" }
)
</script>

<template>
  <!--
    圆角 = 卡片圆角（rounded-md）减去卡片 1px 边框：内容在边框里面，直接 inherit 同样的半径，
    四个角会和外框错开一圈
  -->
  <div
    class="overflow-hidden rounded-[calc(var(--radius-md)-1px)] bg-muted/40"
    :style="boxStyle"
    data-testid="image-body"
  >
    <img
      v-if="src"
      :src="src"
      :alt="ctx.label.value"
      draggable="false"
      class="block h-full w-full object-cover"
      @load="onLoad"
    />
    <div
      v-else
      class="flex aspect-video h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground"
      data-testid="image-body-empty"
    >
      <Image class="size-6" />
      <span class="text-xs">暂无图片</span>
      <NodeUploadButton accept="image/*" label="上传图片" :loading="pending" @select="upload($event)" />
    </div>
  </div>
</template>
