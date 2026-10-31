import { computed, type CSSProperties } from "vue"
import { useDevicePixelRatio } from "@vueuse/core"
import { ASSET_VARIANT_SPECS, type AssetSize } from "@shadecn/shared/canvas"

import { useNodePart } from "@/components/flow/node-kit/context"
import type { NodePartContext } from "@/components/flow/node-kit/protocol"
import { canvasAssetSize, fitMediaSize, MEDIA_DEFAULT_WIDTH, MEDIA_FIXED_SIDE } from "@/lib/flow-media-size"

/**
 * 媒体节点（图片 / 视频）「按资源比例定尺寸」的两半：
 *
 * - **读**：布局里记过 `width` / `height` 就直接用 —— 打开画布时节点立刻是对的大小，不等资源加载。
 *   节点根元素只定**宽**（`mediaNodeStyle`，`view.style`），**高由 body 的图片区按记录的比例撑出来**
 *   （`useMediaFit().boxStyle`）。高度不钉在根元素上，footer 区（报错行）就是接在图片下面多出来的一截，
 *   不会把图片挤扁或裁掉。没记过就先给默认宽度、高度随图片。
 * - **写**：`useMediaFit().onLoad` 在资源（图片 / 视频预览图）加载完时量原始像素，
 *   按 `fitMediaSize` 的规则算出节点尺寸，记进布局（`store.recordNodeSize`：不进撤销栈，值没变不写）。
 *
 *   **图标档量出来的不算数**（只有百来像素，取整后比例有出入）：布局里已经有尺寸就不按它改，
 *   免得缩放画布时图标 / 低清来回换、节点尺寸跟着抖（`recordNodeSize` 会写文档）；还没尺寸时先按它记个近似值。
 * - **取哪一档**：`useMediaFit().assetSize` 按节点在屏幕上的物理像素定 `icon` / `low`（`canvasAssetSize`，docs/27 §4.1）。
 *
 * 图片区用 `aspect-ratio` 而不是按记录的高度写死像素：根元素有边框，写死像素就得在这里重复一遍边框宽度。
 *
 * 不是能力（feature）：尺寸跟着的是 body 画的那张图，只有 body 知道它什么时候加载完。
 */
export function mediaNodeStyle(ctx: NodePartContext): CSSProperties {
  return { width: `${ctx.node.node.value?.layout.width ?? MEDIA_DEFAULT_WIDTH}px` }
}

export function useMediaFit() {
  const ctx = useNodePart()

  /** body 图片区的样式：布局里记过尺寸就按那个比例 */
  const boxStyle = computed<CSSProperties | undefined>(() => {
    const layout = ctx.node.node.value?.layout
    if (layout?.width === undefined || layout.height === undefined) return undefined
    return { aspectRatio: `${layout.width} / ${layout.height}` }
  })

  /** 绑到 `<AssetImage @load>` / `<img @load>` 上；`loaded` 是实际加载的那一档 */
  function onLoad(event: Event, loaded: AssetSize = "original") {
    const layout = ctx.node.node.value?.layout
    if (loaded === "icon" && layout?.width !== undefined && layout.height !== undefined) return
    const image = event.target as HTMLImageElement
    const size = fitMediaSize(image.naturalWidth, image.naturalHeight)
    if (size) ctx.editor.store.recordNodeSize(ctx.id, size)
  }

  const { pixelRatio } = useDevicePixelRatio()

  /** 画布上取哪一档：节点长边 × 缩放 × 设备像素比，图标够用就用图标 */
  const assetSize = computed(() => {
    const layout = ctx.node.node.value?.layout
    const longEdge = Math.max(layout?.width ?? MEDIA_DEFAULT_WIDTH, layout?.height ?? MEDIA_FIXED_SIDE)
    return canvasAssetSize(longEdge, ctx.editor.canvas.zoomLevel.value, pixelRatio.value, ASSET_VARIANT_SPECS.icon.maxEdge)
  })

  return { boxStyle, onLoad, assetSize }
}
