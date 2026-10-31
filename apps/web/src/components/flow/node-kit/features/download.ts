import { Download } from "@lucide/vue"
import { assetDownloadName, assetDownloadUrl } from "@shadecn/shared/canvas"
import { hasNodeResource } from "@shadecn/shared/flow-node-types"

import { defineNodeAction, defineNodeFeature } from "../protocol"

/** 节点的资源地址（图片 / 视频都在 `data.src`）；没有就是 '' */
function srcOf(data: Readonly<Record<string, unknown>>): string {
  return typeof data.src === "string" ? data.src.trim() : ""
}

/** 隐藏 iframe 留多久再拆：下载一旦开始就交给了浏览器的下载管理器，拆掉 iframe 不影响它 */
export const DOWNLOAD_FRAME_TTL = 60_000

/**
 * 我们的素材：在隐藏 iframe 里打开带 `response-content-disposition` 的地址（`assetDownloadUrl`）。
 * 对象存储回 `attachment` + 文件名，浏览器直接存盘，字节不经后端、也不进内存（几百 MB 的视频照样）。
 *
 * **不用 `<a>`**：跨源时 `download` 属性被忽略、变成导航 —— 不带 target 会把编辑器整页导航走（回的是错误页时），
 * 带 `target=_blank` 又会闪开一个新标签。iframe 里的导航怎么样都不影响当前页面。
 */
function downloadViaFrame(href: string): void {
  const frame = document.createElement("iframe")
  frame.style.display = "none"
  frame.src = href
  document.body.appendChild(frame)
  window.setTimeout(() => frame.remove(), DOWNLOAD_FRAME_TTL)
}

/** 同源的地址（`blob:` / `data:` / 自己造的 object URL）：`<a download>` 能改名，也不会导航 */
function saveSameOrigin(href: string, filename: string): void {
  const a = document.createElement("a")
  a.href = href
  a.download = filename
  a.style.display = "none"
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * 外部链接：先把字节 fetch 成 blob，再按同源存盘（才能改名）。
 * 对方不给 CORS 就拿不到 —— 抛错交给 `useAsyncAction` 提示，**不退回导航**（那就跳走了）。
 */
async function downloadViaFetch(href: string, filename: string): Promise<void> {
  let blob: Blob
  try {
    const res = await fetch(href)
    if (!res.ok) throw new Error(String(res.status))
    blob = await res.blob()
  } catch {
    throw new Error("这个资源的地址不允许直接下载")
  }
  const url = URL.createObjectURL(blob)
  try {
    saveSameOrigin(url, filename)
  } finally {
    // 点击已经同步把下载交出去了，下一轮再回收
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

async function downloadAsset(src: string, filename: string): Promise<void> {
  const signed = assetDownloadUrl(src, filename)
  if (signed) return downloadViaFrame(signed)
  if (/^(data|blob):/i.test(src)) return saveSameOrigin(src, filename)
  return downloadViaFetch(src, filename)
}

/** 下载节点的资源，文件名 = 节点名 + 原扩展名。只给有资源的媒体类型（图片 / 视频）启用 */
export const downloadFeature = defineNodeFeature({
  id: "download",
  actions: [
    defineNodeAction({
      id: "node.download",
      slot: "toolbar",
      icon: Download,
      label: "下载",
      // 还没有资源（空占位、正在上传）就不出现；「有没有资源」只问 hasNodeResource
      when: (ctx) => hasNodeResource(ctx.type, ctx.node.data.value),
      run: (ctx) => {
        const src = srcOf(ctx.node.data.value)
        const filename = assetDownloadName(ctx.label.value, src)
        return downloadAsset(src, filename)
      }
    })
  ]
})
