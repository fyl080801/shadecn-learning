/**
 * 媒体节点（图片 / 视频）按资源的高宽比定尺寸 —— 纯几何，不认识 Vue、也不认识 Vue Flow。
 *
 * - 竖图（高 > 宽）：**宽固定**为 `MEDIA_FIXED_SIDE`，高按比例跟着资源走；
 * - 横图（宽 > 高）：**高固定**为 `MEDIA_FIXED_SIDE`，宽按比例跟着资源走；
 * - 方图两边都是 `MEDIA_FIXED_SIDE`。两条规则在方图处衔接，比例略变尺寸也只略变，不会跳。
 *
 * 比例夹在 `MEDIA_MAX_RATIO` 以内：一张 10:1 的长条全景按原比例摊开是一块 2400px 宽的节点，
 * 超出部分由 body 的 `object-cover` 裁掉。
 */

/** 竖图的宽 / 横图的高 */
export const MEDIA_FIXED_SIDE = 240

/** 长边最多是短边的几倍 */
export const MEDIA_MAX_RATIO = 3

/** 还没量到资源尺寸（老节点第一次打开、资源还没加载完）时的节点宽度 */
export const MEDIA_DEFAULT_WIDTH = 320

export interface MediaSize {
  width: number
  height: number
}

/**
 * 资源的原始像素尺寸 → 节点该有的尺寸（取整，方便和已记录的值做相等比较）。
 * 量不出来（0、NaN、负数 —— 图片解码失败时 `naturalWidth` 就是 0）返回 null。
 */
export function fitMediaSize(naturalWidth: number, naturalHeight: number): MediaSize | null {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null
  const ratio = Math.min(Math.max(naturalWidth / naturalHeight, 1 / MEDIA_MAX_RATIO), MEDIA_MAX_RATIO)
  return ratio >= 1
    ? { width: Math.round(MEDIA_FIXED_SIDE * ratio), height: MEDIA_FIXED_SIDE }
    : { width: MEDIA_FIXED_SIDE, height: Math.round(MEDIA_FIXED_SIDE / ratio) }
}

/**
 * 画布缩小到这个程度就只用图标档：节点在屏幕上的长边（物理像素）不超过图标长边的这么多倍。
 * 留 1.5 倍余量 —— 缩得很小时略糊一点看不出来，换来几十个节点不必各解一张低清图。
 */
export const CANVAS_ICON_SLACK = 1.5

/**
 * 画布上的媒体节点该取哪一档缩略图（docs/27 §4.1）：按节点**在屏幕上实际占的物理像素**定，
 * 图标档（长边 `iconMaxEdge`）够用就用图标，否则低清。原图从不在画布上用。
 *
 * `longEdge` 是节点的长边（画布坐标，CSS px），`zoom` 是画布缩放，`dpr` 是设备像素比。
 */
export function canvasAssetSize(longEdge: number, zoom: number, dpr: number, iconMaxEdge: number): "icon" | "low" {
  const onScreen = longEdge * zoom * (dpr > 0 ? dpr : 1)
  return onScreen <= iconMaxEdge * CANVAS_ICON_SLACK ? "icon" : "low"
}
