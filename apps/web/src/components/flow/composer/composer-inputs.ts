import type { FlowNodeInput } from "@shadecn/shared/flow-graph"
import { isDataTypeCompatible, portsOf } from "@shadecn/shared/flow-node-types"

/**
 * 底部输入框「连入预览」那一排的纯逻辑（docs/13 §3.7「底部输入框」）：哪些上游、按什么顺序、加号能选哪些文件。
 * 不碰组件、不碰文档 —— 写顺序由组件经 `ctx.node.write` 走。
 */

/**
 * 连入顺序存在**目标节点**的 `data.inputOrder`：上游节点 id 的数组，整个值一次写（一个键，一条撤销）。
 * 两个人同时排序后写的赢 —— 顺序本来就是一个整体，合并两份半截顺序没有意义。
 */
export const INPUT_ORDER_KEY = "inputOrder"

/** 读 `data.inputOrder`：不是字符串数组就当没有（老数据、坏数据都不抛） */
export function readInputOrder(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string" && item !== "") : []
}

/**
 * 连进来的上游节点 id，**每个上游只出现一次**（同一个上游可能经两对端口连进来，比如导演台的截图和录制）。
 *
 * 排序：`inputOrder` 里记着的按它排在前面；没记着的（刚连进来的、别人连的）接在后面，按派生 `inputs` 的顺序
 * （端口、序号）。`inputOrder` 里已经不再连着的 id 直接跳过 —— 读的一侧不回写清理。
 * `exists` 过滤悬空边（上游已经被删、边还没清掉）。
 */
export function orderedUpstreams(
  inputs: readonly FlowNodeInput[],
  order: readonly string[],
  exists: (id: string) => boolean
): string[] {
  const connected: string[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    if (seen.has(input.source) || !exists(input.source)) continue
    seen.add(input.source)
    connected.push(input.source)
  }
  const rank = new Map(order.map((id, index) => [id, index]))
  const known = connected.filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!)
  return [...known, ...connected.filter((id) => !rank.has(id))]
}

/** 把 `list` 里的 `id` 挪到 `toIndex`（挪动前的下标口径：落在第几个元素的位置上）；不在列表里原样返回 */
export function moveItem(list: readonly string[], id: string, toIndex: number): string[] {
  const from = list.indexOf(id)
  if (from < 0) return [...list]
  const next = list.filter((item) => item !== id)
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, id)
  return next
}

/** 加号里能选的媒体：文件种类 = 连进来之后建成的节点类型 */
export type InputMediaKind = "image" | "video"

const MEDIA_ACCEPT: Record<InputMediaKind, string> = { image: "image/*", video: "video/*" }

/**
 * 这个类型能接哪几种媒体节点连进来：媒体节点的输出端口和它的输入端口有一对数据类型兼容就算（端口声明，
 * 和 `resolveConnection` 同一份）。图片 / 视频收图和视频，导演台只收图；文本没有输入，一种都没有 —— 那就没有加号。
 */
export function acceptedInputMedia(type: string): InputMediaKind[] {
  const inputs = portsOf(type, "inputs")
  return (["image", "video"] as const).filter((kind) =>
    portsOf(kind, "outputs").some((out) => inputs.some((port) => isDataTypeCompatible(out.dataType, port.dataType)))
  )
}

/** 文件选择框的 accept：只列能接的媒体 */
export function inputMediaAccept(kinds: readonly InputMediaKind[]): string {
  return kinds.map((kind) => MEDIA_ACCEPT[kind]).join(",")
}

/** 选中的文件是哪种媒体；不是能接的那几种返回 null（accept 只是提示，拖进来的、改了扩展名的都得再判一次） */
export function inputMediaKindOf(file: Pick<File, "type">, kinds: readonly InputMediaKind[]): InputMediaKind | null {
  const type = file.type.toLowerCase()
  const kind = type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : null
  return kind && kinds.includes(kind) ? kind : null
}
