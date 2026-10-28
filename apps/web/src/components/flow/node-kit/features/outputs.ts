import { computed } from "vue"
import { portsOf, type PortDef } from "@shadecn/shared/flow-node-types"

import type { NodePartContext } from "../protocol"

/**
 * 一个节点各输出端口当前的产出（`runtime.outputs.<portId>`），能力 `output-preview` 的两个部件共用。
 */

export interface NodeOutputRow {
  port: PortDef
  value: unknown
  /** 能画成图片时的地址；认不出来是 null，退回文本预览 */
  src: string | null
}

/** 文本预览最多几个字 */
const EXCERPT = 40

export function excerpt(value: string): string {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > EXCERPT ? `${line.slice(0, EXCERPT)}…` : line
}

/**
 * 图片端口的产出能不能画成图：裸 URL 字符串，或样例数据里的 `{ url, coverUrl }`。
 * `preferCover`：缩略图先用封面（小得多）；大图预览要原图
 */
export function imageSrc(port: PortDef, value: unknown, preferCover = true): string | null {
  if (port.dataType !== "image") return null
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return null
  const { coverUrl, url } = value as Record<string, unknown>
  const cover = typeof coverUrl === "string" && coverUrl ? coverUrl : null
  const full = typeof url === "string" && url ? url : null
  return preferCover ? (cover ?? full) : (full ?? cover)
}

export function previewText(value: unknown): string {
  if (typeof value === "string") return excerpt(value)
  if (value === null || value === undefined) return ""
  return excerpt(JSON.stringify(value) ?? "")
}

export function useNodeOutputs(ctx: NodePartContext, preferCover = true) {
  const rows = computed<NodeOutputRow[]>(() =>
    portsOf(ctx.type, "outputs")
      .map((port) => {
        const value = ctx.node.runtime.value.outputs?.[port.id]
        return { port, value, src: imageSrc(port, value, preferCover) }
      })
      .filter((row) => row.value !== undefined)
  )
  const images = computed(() => rows.value.filter((row) => row.src))
  return { rows, images }
}

/** 这个节点此刻有没有能放大看的图 —— 「展开预览」只在有图时出现 */
export function hasImageOutput(ctx: NodePartContext): boolean {
  return portsOf(ctx.type, "outputs").some(
    (port) => imageSrc(port, ctx.node.runtime.value.outputs?.[port.id]) !== null
  )
}
