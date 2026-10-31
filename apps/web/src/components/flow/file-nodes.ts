import { toast } from "vue-sonner"

import {
  reportNodeUploadError,
  runNodeUpload,
  uploadImageToNode,
  uploadVideoToNode
} from "@/components/flow/node-upload"
import type { FlowEditorContext } from "@/composables/flow/editor-context"

/**
 * 「选文件 → 建节点」：画布右键菜单的「上传」走这里（docs/13 §4.4.4）。
 *
 * 一个文件一个节点，按文件类型挑节点类型：图片 → 图片节点，视频 → 视频节点，文本 → 文本节点。
 * **先建节点、再往里传**：图片 / 视频节点建好立刻登记成「上传中」（`runNodeUpload`，和节点 body 上的
 * 「上传」按钮是同一个登记表），body 显示进度、能取消；传完经 `attachAsset` 挂上，失败 / 取消就留一个空节点，
 * 和在 body 上点上传失败一样，可以再传或删掉。文本不上传对象存储 —— 读出内容直接当正文，和建节点同一个事务。
 */

/** 文件选择框的 accept：图片、视频、常见纯文本 */
export const FILE_NODE_ACCEPT = "image/*,video/*,text/*,.txt,.md,.markdown,.json,.csv,.log,.yaml,.yml"

/**
 * 文本文件的大小上限：正文整段进 Y.Doc（每个协作者都要同步、整张画布的投影还有 2MB 上限），
 * 超过就拒收，不截断 —— 截一半的内容比没有更容易误导人。
 */
export const TEXT_FILE_MAX_BYTES = 200 * 1024

/** 同时选了多个文件时，后一个节点相对前一个错开多少（屏幕像素） */
const FILE_NODE_STEP = 32

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "csv", "log", "yaml", "yml"])

export type FileNodeKind = "image" | "video" | "text"

/** 按 MIME 认，认不出（有的系统给文本文件的 type 是空串）再按扩展名；都不是就 null */
export function fileNodeKind(file: Pick<File, "name" | "type">): FileNodeKind | null {
  const type = file.type.toLowerCase()
  if (type.startsWith("image/")) return "image"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("text/") || type === "application/json") return "text"
  const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
  return file.name.includes(".") && TEXT_EXTENSIONS.has(ext) ? "text" : null
}

/** 节点名取文件名去掉扩展名（`.env` 这种只有扩展名的保留原名） */
export function fileNodeLabel(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

type FileNodeEditor = Pick<FlowEditorContext, "canvas" | "store" | "flowId">

/**
 * 把选中的文件逐个建成节点，第一个以 `point`（屏幕坐标，右键那一点）为中心，后面的依次往右下错开。
 * 节点建好就返回，**不等上传完**：上传在各自节点上跑，进度和取消都在节点里。
 */
export async function addNodesFromFiles(editor: FileNodeEditor, files: readonly File[], point: { x: number; y: number }) {
  const { canvas, store } = editor
  const flowId = editor.flowId.value
  let index = 0
  for (const file of files) {
    const kind = fileNodeKind(file)
    if (!kind) {
      toast.error(`不支持的文件类型：${file.name}`)
      continue
    }
    const at = { x: point.x + index * FILE_NODE_STEP, y: point.y + index * FILE_NODE_STEP }
    const label = fileNodeLabel(file.name)

    if (kind === "text") {
      if (file.size > TEXT_FILE_MAX_BYTES) {
        toast.error(`文本文件太大：${file.name}（上限 ${TEXT_FILE_MAX_BYTES / 1024}KB）`)
        continue
      }
      const text = await file.text()
      if (await canvas.addNode("text", { point: at, label, data: { text } })) index++
      continue
    }

    const nodeId = await canvas.addNode(kind, { point: at, label })
    if (!nodeId) continue
    index++
    const attach = (asset: { src: string; poster?: string }, actionLabel: string) =>
      store.attachAsset(nodeId, asset, actionLabel)
    const task = kind === "image" ? uploadImageToNode : uploadVideoToNode
    void runNodeUpload(flowId, nodeId, (io) => task(flowId, file, io, attach)).catch(reportNodeUploadError)
  }
}
