<script setup lang="ts">
import { computed, type CSSProperties } from "vue"
import { Film } from "@lucide/vue"
import { portsOf, readGenerations } from "@shadecn/shared/flow-node-types"

import AssetImage from "@/components/flow/AssetImage.vue"
import { MEDIA_FIXED_SIDE } from "@/lib/flow-media-size"
import { cn } from "@/lib/utils"
import { useNodePart } from "../context"

/**
 * 生成历史（能力 `generations`，节点右侧画布里的 `aside` 区）：一列缩略图，最新的在最上面。
 *
 * 高度随条数增长，最高 `MEDIA_FIXED_SIDE`（= 媒体节点固定的那条边），到顶后在里面滚动；和节点垂直居中（宿主的 aside 区），最新的在最上面；
 * 宽度固定。都按画布坐标画、跟着缩放。缩略图一律正方形（`object-cover` 裁中间），不跟主图的高宽比。
 * 点一条 → 换成主图（`selectGeneration`，只换 `src` / `poster`，一步撤销）。和主图同一个地址的那条描边高亮。
 * 图片画它本身，视频画它的预览图（没有预览图画个图标）。
 */
const ctx = useNodePart()

const items = computed(() => [...readGenerations(ctx.node.data.value)].reverse())
const current = computed(() => {
  const src = ctx.node.data.value.src
  return typeof src === "string" ? src : ""
})

const panelStyle: CSSProperties = { maxHeight: `${MEDIA_FIXED_SIDE}px` }

/** 产物本身就是图（输出端口是 image）就画它；否则（视频）画预览图，没有预览图画图标 */
const outputsImage = computed(() => portsOf(ctx.type, "outputs").some((port) => port.dataType === "image"))
const thumbOf = (item: { src: string; poster?: string }) => (outputsImage.value ? item.src : item.poster)

function select(id: string, src: string) {
  if (src === current.value) return
  ctx.node.selectGeneration(id)
}
</script>

<template>
  <div
    class="flex w-[88px] flex-col gap-1.5 overflow-y-auto rounded-md border bg-card/95 p-1.5 shadow-sm"
    :style="panelStyle"
    data-testid="node-generation-history"
    @dblclick.stop
  >
    <button
      v-for="(item, index) in items"
      :key="item.id"
      type="button"
      :class="
        cn(
          'relative aspect-square w-full shrink-0 overflow-hidden rounded-sm bg-muted outline-offset-1 transition-opacity hover:opacity-90',
          item.src === current ? 'outline-2 outline-primary' : 'outline-1 outline-border'
        )
      "
      :title="`第 ${items.length - index} 次生成`"
      :aria-label="`第 ${items.length - index} 次生成`"
      :aria-pressed="item.src === current"
      data-testid="node-generation-item"
      @click.stop="select(item.id, item.src)"
    >
      <AssetImage
        v-if="thumbOf(item)"
        :src="thumbOf(item)"
        size="icon"
        alt=""
        loading="lazy"
        draggable="false"
        class="block h-full w-full object-cover"
      />
      <span v-else class="flex h-full w-full items-center justify-center text-muted-foreground">
        <Film class="size-4" />
      </span>
    </button>
  </div>
</template>
