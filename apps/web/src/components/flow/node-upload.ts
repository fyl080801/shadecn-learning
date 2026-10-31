import { computed, reactive } from "vue"
import { toast } from "vue-sonner"

import type { NodePartContext } from "@/components/flow/node-kit/protocol"
import { startUpload, type AssetUpload, type AssetUploadIo } from "@/composables/useAssetUpload"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { isUploadCanceled, uploadFlowAsset } from "@/lib/asset-upload"
import { captureVideoPoster } from "@/lib/video-poster"

/**
 * 节点的「上传中」状态 —— **本地的，不进 Y.Doc**：别的协作者看不到，刷新页面就没了。
 * 写进文档的话，上传的人中途关掉页面，节点就永远卡在「上传中」，没人能把它改回来。
 *
 * 登记表放在模块级、按 `画布 id:节点 id` 记，而不是放在 body 组件里：节点被虚拟化卸掉、
 * 或宿主重挂 body 时，上传还在跑，回来的组件得接着显示同一份进度、能取消同一个请求。
 * 每一项就是 `useAssetUpload.ts` 的上传句柄（进度：分片的有百分比，不分片的为 null 只转圈；能取消）。
 */
export type NodeUploadState = AssetUpload<void>

export type NodeUploadIo = AssetUploadIo

const uploads = reactive(new Map<string, NodeUploadState>())

function keyOf(flowId: string, nodeId: string) {
  return `${flowId}:${nodeId}`
}

/** 这个节点此刻在不在上传（角标、body 都看它） */
export function nodeUploadOf(ctx: NodePartContext): NodeUploadState | undefined {
  return uploads.get(keyOf(ctx.editor.flowId.value, ctx.id))
}

/**
 * 往某个节点上开一次上传 —— **不依赖组件**，body 的按钮和画布右键菜单（先建节点、再往里传）走的都是它。
 * 登记是同步的：调用返回前节点就已经「上传中」，body 一渲染就显示进度、能取消。
 * 同一个节点正在传就什么都不做。失败 / 取消照原样抛出，提示交给调用方（`reportNodeUploadError`）。
 */
export async function runNodeUpload(flowId: string, nodeId: string, task: (io: NodeUploadIo) => Promise<void>) {
  const key = keyOf(flowId, nodeId)
  if (uploads.has(key)) return
  const handle = startUpload(task)
  uploads.set(key, handle)
  try {
    await handle.done
  } finally {
    if (uploads.get(key) === handle) uploads.delete(key)
  }
}

/** 上传失败的提示：取消不提示，别的照常 toast */
export function reportNodeUploadError(error: unknown) {
  if (!isUploadCanceled(error)) toast.error(error instanceof Error ? error.message : "上传失败")
}

/** 把素材挂到目标节点上（`useFlowNode().attachAsset` / `store.attachAsset` 绑好节点 id 的那一版） */
export type AttachNodeAsset = (asset: { src: string; poster?: string }, actionLabel: string) => void

/**
 * 图片节点的上传：经后端转存到 S3（大文件自动分片），回来的 S3 原始地址经 `attachAsset` 写进 `data.src`
 * （同一步定形态，docs/13 §3.7）。传完那一刻刚好点了取消：以取消为准，不挂上去。
 */
export async function uploadImageToNode(flowId: string, file: File, io: NodeUploadIo, attach: AttachNodeAsset) {
  const asset = await uploadFlowAsset(flowId, file, io)
  io.signal.throwIfAborted()
  attach({ src: asset.url }, "上传图片")
}

/**
 * 视频节点的上传：先在本地截一帧当预览图，再把视频和预览图一起传到 S3，两个地址经 `attachAsset` 一次写进
 * `data.src` / `data.poster`（一步撤销）。截不出预览图就只写 `src`；进度只算视频本身。
 */
export async function uploadVideoToNode(flowId: string, file: File, io: NodeUploadIo, attach: AttachNodeAsset) {
  const frame = await captureVideoPoster(file)
  const [video, cover] = await Promise.all([
    uploadFlowAsset(flowId, file, io),
    frame ? uploadFlowAsset(flowId, frame, { filename: "poster.jpg", signal: io.signal }) : null
  ])
  io.signal.throwIfAborted()
  attach({ src: video.url, ...(cover ? { poster: cover.url } : {}) }, "上传视频")
}

/** 一种节点怎么上传：文件选择框接受什么、按钮上叫什么、选中文件后跑哪个任务 */
export interface NodeUploadKind {
  accept: string
  label: string
  task: (flowId: string, file: File, io: NodeUploadIo, attach: AttachNodeAsset) => Promise<void>
}

const NODE_UPLOAD_KINDS: Record<string, NodeUploadKind> = {
  image: { accept: "image/*", label: "上传图片", task: uploadImageToNode },
  video: { accept: "video/*", label: "上传视频", task: uploadVideoToNode }
}

/** 这种节点能不能上传、怎么传；不能就是 undefined */
export function nodeUploadKindOf(type: string): NodeUploadKind | undefined {
  return NODE_UPLOAD_KINDS[type]
}

/**
 * 上传按钮（`NodeUploadButton`）里用：`upload(file)` 开始一次上传（`runNodeUpload`），`task` 拿到 `signal` / `onProgress`。
 * 同一个节点正在传就不再开第二次（`useAsyncAction` 只锁本组件，登记表按节点再锁一层）。
 */
export function useNodeUpload(ctx: NodePartContext, task: (file: File, io: NodeUploadIo) => Promise<void>) {
  const state = computed(() => nodeUploadOf(ctx))

  const { run: upload } = useAsyncAction(
    (file: File) => runNodeUpload(ctx.editor.flowId.value, ctx.id, (io) => task(file, io)),
    { onError: reportNodeUploadError }
  )

  function cancel() {
    state.value?.cancel()
  }

  return { upload, state, cancel }
}
