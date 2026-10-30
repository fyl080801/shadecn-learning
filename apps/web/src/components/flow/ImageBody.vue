<script setup lang="ts">
import { computed } from "vue"
import { Image } from "@lucide/vue"

import { useMediaFit } from "@/components/flow/media-fit"
import NodeUploadButton from "@/components/flow/NodeUploadButton.vue"
import NodeUploadProgress from "@/components/flow/NodeUploadProgress.vue"
import { useNodePart } from "@/components/flow/node-kit/context"
import { useNodeUpload } from "@/components/flow/node-upload"
import { uploadFlowAsset } from "@/lib/asset-upload"

/**
 * 图片节点的 body —— 画 `data.src` 那张图；没有就是一块空占位，上面一个「上传图片」按钮。
 *
 * 上传经后端转存到 S3（`uploadFlowAsset`：大文件自动分片），回来的 **S3 原始地址**经 `attachAsset` 写进
 * `data.src`（同一步按「有没有连入」定形态：没有就成素材，见 docs/13 §3.7），显示时浏览器直接从 S3 读，不经后端。
 * 上传中（`useNodeUpload`，本地状态）占位上换成进度：分片的有进度条，不分片的只转圈，都能取消；取消了什么都不写。
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

const { upload, state: uploading, cancel } = useNodeUpload(ctx, async (file, io) => {
  const asset = await uploadFlowAsset(ctx.editor.flowId.value, file, io)
  // 传完的那一刻刚好点了取消：以取消为准，不挂上去
  io.signal.throwIfAborted()
  ctx.node.attachAsset({ src: asset.url }, "上传图片")
})
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
      <NodeUploadProgress v-if="uploading" :progress="uploading.progress" @cancel="cancel()" />
      <template v-else>
        <Image class="size-6" />
        <span class="text-xs">暂无图片</span>
        <NodeUploadButton accept="image/*" label="上传图片" @select="upload($event)" />
      </template>
    </div>
  </div>
</template>
