<script setup lang="ts">
import { computed } from "vue"
import { Image } from "@lucide/vue"

import CanvasAssetImage from "@/components/flow/CanvasAssetImage.vue"
import { useMediaFit } from "@/components/flow/media-fit"
import NodeUploadProgress from "@/components/flow/NodeUploadProgress.vue"
import { useNodePart } from "@/components/flow/node-kit/context"
import { nodeUploadOf } from "@/components/flow/node-upload"

/**
 * 图片节点的 body —— 画 `data.src` 那张图；没有就是一块空占位，上传入口是节点右上角的图标（`NodeUploadButton`，挂在 `badge` 区）。
 *
 * 上传经后端转存到 S3（`uploadFlowAsset`：大文件自动分片），回来的 **S3 原始地址**经 `attachAsset` 写进
 * `data.src`（同一步按「有没有连入」定形态：没有就成素材，见 docs/13 §3.7），显示时浏览器直接从 S3 读，不经后端。
 * 画布上按缩放取 `icon` / `low` 档，目标档没加载完先垫毛玻璃的图标档（`CanvasAssetImage`，docs/27 §4.1），取不到退回原图。
 * 上传中（`nodeUploadOf`，本地状态）占位上换成进度：分片的有进度条，不分片的只转圈，都能取消；取消了什么都不写。
 * `draggable="false"`：浏览器原生的拖图片会抢走 Vue Flow 的拖节点。
 *
 * 节点尺寸跟着图片的高宽比走（竖图定宽、横图定高，`media-fit.ts`）：图加载完记进布局，下次打开直接是这个大小。
 * 图片区按记录的比例定高，`object-cover` 铺满（比例被夹过的超长图裁掉两头）；报错行接在下面，不挤图片。
 */
const ctx = useNodePart()
const { boxStyle, onLoad, assetSize } = useMediaFit()

const src = computed(() => {
  const value = ctx.node.data.value.src
  return typeof value === "string" ? value.trim() : ""
})

// 上传由右上角的按钮（或右键菜单）发起；这里只按本地登记表显示进度、能取消
const uploading = computed(() => nodeUploadOf(ctx))
</script>

<template>
  <!--
    圆角 = 卡片圆角（rounded-md）：卡片的边框是外扩的一圈 box-shadow（vue-flow.css 的 `.flow-node`），
    不占内容区，内容和外框同一个半径
  -->
  <div
    class="overflow-hidden rounded-md bg-muted/40"
    :style="boxStyle"
    data-testid="image-body"
  >
    <CanvasAssetImage
      v-if="src"
      :src="src"
      :size="assetSize"
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
      <NodeUploadProgress v-if="uploading" :progress="uploading.progress" @cancel="uploading?.cancel()" />
      <!-- 空占位的图标 + 文字是界面提示，按屏幕尺寸画、不随缩放变（flow-screen.ts） -->
      <div v-else class="flow-screen-fixed flex flex-col items-center gap-2" data-flow-screen-fixed>
        <Image class="size-6" />
        <span class="text-xs">暂无图片</span>
      </div>
    </div>
  </div>
</template>
