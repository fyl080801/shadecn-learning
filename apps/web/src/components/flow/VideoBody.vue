<script setup lang="ts">
import { computed } from "vue"
import { Film } from "@lucide/vue"

import HoverVideo from "@/components/flow/HoverVideo.vue"
import CanvasAssetImage from "@/components/flow/CanvasAssetImage.vue"
import { useMediaFit } from "@/components/flow/media-fit"
import NodeUploadProgress from "@/components/flow/NodeUploadProgress.vue"
import { useNodePart } from "@/components/flow/node-kit/context"
import { nodeUploadOf } from "@/components/flow/node-upload"

/**
 * 视频节点的 body —— 平时**只画预览图 `data.poster`**，不放 `<video>`：画布上几十个节点各挂一个播放器
 * （各占一个合成层）太重。鼠标移上来才由 `HoverVideo` 临时挂一个 `<video>` 盖满整个区域静音循环播放，
 * 移出就卸掉、换回预览图。没有预览图就是空占位（有视频地址但没预览图时说「暂无预览图」，移上来一样能播）。
 *
 * 没有视频时节点右上角有「上传视频」图标（`NodeUploadButton`，挂在 `badge` 区）：先在本地截一帧当预览图，再把视频和预览图一起传到 S3，
 * 两个 **S3 原始地址**经 `attachAsset` 一次写进 `data.src` / `data.poster`（一步撤销，同一步按「有没有连入」
 * 定形态）。截不出预览图就只写 `src`。上传中占位上换成进度（只算视频本身的进度，预览图很小），能取消。
 *
 * 预览图同图片节点：按缩放取 `icon` / `low` 档、先垫毛玻璃占位（`CanvasAssetImage`，docs/27 §4.1），取不到退回原图。
 * 节点尺寸跟着预览图的高宽比走（预览图就是视频的一帧，比例相同；规则同图片，`media-fit.ts`）。
 */
const ctx = useNodePart()
const { boxStyle, onLoad, assetSize } = useMediaFit()

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

const poster = computed(() => text(ctx.node.data.value.poster))
const src = computed(() => text(ctx.node.data.value.src))
const hasVideo = computed(() => src.value !== "")

// 上传由右上角的按钮（或右键菜单）发起；这里只按本地登记表显示进度、能取消
const uploading = computed(() => nodeUploadOf(ctx))
</script>

<template>
  <!--
    圆角 = 卡片圆角（rounded-md）：卡片的边框是外扩的一圈 box-shadow（vue-flow.css 的 `.flow-node`），
    不占内容区，内容和外框同一个半径
  -->
  <HoverVideo
    :src="src"
    :poster="poster"
    class="overflow-hidden rounded-md bg-muted/40"
    :style="boxStyle"
    data-testid="video-body"
  >
    <CanvasAssetImage
      v-if="poster"
      :src="poster"
      :size="assetSize"
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
      <NodeUploadProgress v-if="uploading" :progress="uploading.progress" @cancel="uploading?.cancel()" />
      <!-- 空占位的图标 + 文字是界面提示，按屏幕尺寸画、不随缩放变（flow-screen.ts） -->
      <div v-else class="flow-screen-fixed flex flex-col items-center gap-2" data-flow-screen-fixed>
        <Film class="size-6" />
        <span class="text-xs">{{ hasVideo ? "暂无预览图" : "暂无视频" }}</span>
      </div>
    </div>
  </HoverVideo>
</template>
