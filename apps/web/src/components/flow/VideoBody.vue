<script setup lang="ts">
import { computed } from "vue"
import { Film } from "@lucide/vue"

import { useMediaFit } from "@/components/flow/media-fit"
import NodeUploadButton from "@/components/flow/NodeUploadButton.vue"
import { useNodePart } from "@/components/flow/node-kit/context"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { uploadFlowAsset } from "@/lib/asset-upload"
import { captureVideoPoster } from "@/lib/video-poster"

/**
 * 视频节点的 body —— **只画预览图 `data.poster`**，不放 `<video>`：画布上几十个节点各挂一个播放器太重，
 * 播放是将来点开之后的事。没有预览图就是空占位（有视频地址但没预览图时说「暂无预览图」）。
 *
 * 没有视频时占位上有「上传视频」：先在本地截一帧当预览图，再把视频和预览图一起传到 S3，
 * 两个 **S3 原始地址**一次写进 `data.src` / `data.poster`（一步撤销）。截不出预览图就只写 `src`。
 *
 * 节点尺寸跟着预览图的高宽比走（预览图就是视频的一帧，比例相同；规则同图片，`media-fit.ts`）。
 */
const ctx = useNodePart()
const { boxStyle, onLoad } = useMediaFit()

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

const poster = computed(() => text(ctx.node.data.value.poster))
const hasVideo = computed(() => text(ctx.node.data.value.src) !== "")

const { run: upload, pending } = useAsyncAction(
  async (file: File) => {
    const flowId = ctx.editor.flowId.value
    const frame = await captureVideoPoster(file)
    const [video, cover] = await Promise.all([
      uploadFlowAsset(flowId, file),
      frame ? uploadFlowAsset(flowId, frame, "poster.jpg") : null
    ])
    ctx.node.setData({ src: video.url, ...(cover ? { poster: cover.url } : {}) }, "上传视频")
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
    data-testid="video-body"
  >
    <img
      v-if="poster"
      :src="poster"
      :alt="ctx.label.value"
      draggable="false"
      class="block h-full w-full object-cover"
      @load="onLoad"
    />
    <div
      v-else
      class="flex aspect-video h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground"
      data-testid="video-body-empty"
    >
      <Film class="size-6" />
      <span class="text-xs">{{ hasVideo ? "暂无预览图" : "暂无视频" }}</span>
      <NodeUploadButton
        v-if="!hasVideo"
        accept="video/*"
        label="上传视频"
        :loading="pending"
        @select="upload($event)"
      />
    </div>
  </div>
</template>
