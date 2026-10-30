import { computed, onScopeDispose, reactive, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue"
import { toast } from "vue-sonner"
import { agentAttachmentKind } from "@shadecn/shared/agent"
import type { UploadedAsset } from "@shadecn/shared/canvas"
import { isUploadCanceled, uploadFlowAsset } from "@/lib/asset-upload"
import { createId } from "@/lib/id"

/**
 * 画布资源上传的**有状态**那一半，前端各处复用：节点 body（`components/flow/node-upload.ts`）、
 * agent 会话的附件（`AssetUploadList.vue`）。无状态的那一半 —— 小文件一次传完、大文件分片并发 + 重试、
 * 取消即放弃分片 —— 在 `lib/asset-upload.ts` 的 `uploadFlowAsset`，这里不重复。
 *
 * - {@link startUpload}：跑一次上传任务，给出一个**响应式**的句柄（状态、进度、结果、错误、取消）；
 * - {@link startFlowAssetUpload}：上面那个 + `uploadFlowAsset`，传一个文件到某张画布；
 * - {@link useAssetUploadList}：一组文件各自上传（附件列表）：加、删（上传中删 = 取消）、重试、清空、
 *   发送时摘走 / 失败时还回来、本地预览地址的回收。
 *
 * **进度**：只有分片上传有中间进度（0–100）；不分片的（≤ `ASSET_PART_SIZE`）一次传完，`progress` 一直是 `null`，
 * 界面只转圈、不画百分比。
 */

/** `uploading` 传着；`done` 成功；`error` 失败（`error` 里是给人看的原因）；`canceled` 被取消（不算失败、不提示） */
export type AssetUploadStatus = "uploading" | "done" | "error" | "canceled"

/** 交给上传任务的：断开用的 `signal`、报进度的 `onProgress`（和 `uploadFlowAsset` 的选项同形，直接透传） */
export interface AssetUploadIo {
  signal: AbortSignal
  onProgress: (loaded: number, total: number) => void
}

export interface AssetUpload<T> {
  readonly status: AssetUploadStatus
  /** 0–100；`null` = 没有中间进度（一次传完的小文件、分片上传开始之前），只转圈 */
  readonly progress: number | null
  /** 成功时的结果，其余为 null */
  readonly result: T | null
  /** 失败的原因（给人看的），其余为 null */
  readonly error: string | null
  /** 正在传就断开请求（状态变 `canceled`）；已经结束的没有效果 */
  cancel(): void
  /**
   * 这一次上传的结局：成功给结果，失败 / 取消 reject（取消的错误 `isUploadCanceled` 为真）。
   * 已经挂了一个空的 catch：没人 await 它也不会变成未处理的 rejection。
   */
  readonly done: Promise<T>
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * 开始一次上传：`task` 拿到 `signal` / `onProgress`，返回什么 `result` 就是什么。
 * 句柄是 `reactive` 的，组件里直接读 `status` / `progress` 就能跟着重绘。
 */
export function startUpload<T>(task: (io: AssetUploadIo) => Promise<T>): AssetUpload<T> {
  const controller = new AbortController()
  const state = reactive({
    status: "uploading" as AssetUploadStatus,
    progress: null as number | null,
    result: null as T | null,
    error: null as string | null,
    cancel() {
      if (state.status === "uploading") controller.abort()
    }
  })

  const done = (async () => {
    try {
      const result = await task({
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (state.status === "uploading") state.progress = total > 0 ? Math.round((loaded / total) * 100) : null
        }
      })
      // 传完的那一刻刚好点了取消：以取消为准
      controller.signal.throwIfAborted()
      state.result = result as never
      state.status = "done"
      return result
    } catch (error) {
      if (controller.signal.aborted || isUploadCanceled(error)) {
        state.status = "canceled"
      } else {
        state.status = "error"
        state.error = messageOf(error, "上传失败")
      }
      throw error
    }
  })()
  done.catch(() => undefined)

  return Object.assign(state, { done }) as AssetUpload<T>
}

/** 把一个文件传到这张画布（大文件自动分片），结果是 `UploadedAsset` */
export function startFlowAssetUpload(flowId: string, file: File): AssetUpload<UploadedAsset> {
  return startUpload((io) => uploadFlowAsset(flowId, file, io))
}

// —— 一组上传（附件列表） ——

/** 按类型决定怎么预览：图片 / 视频有预览，其余显示文件图标 + 名字（和对话里附件的显示同一个判断） */
export type AssetUploadKind = ReturnType<typeof agentAttachmentKind>

/** 列表里的一项：一个本地文件 + 它这一次的上传 */
export interface AssetUploadItem {
  /** 本地 id（列表的 key、删除 / 重试用），和对象键无关 */
  id: string
  file: File
  name: string
  kind: AssetUploadKind
  /** 本地预览（`URL.createObjectURL`）：图片 / 视频才有；从列表里删掉 / 回收时撤销 */
  previewUrl: string | null
  upload: AssetUpload<UploadedAsset>
}

export interface AssetUploadListOptions {
  /** 最多几项；超出的那几个文件不加，提示一声 */
  max?: number
}

export interface AssetUploadList {
  readonly items: readonly AssetUploadItem[]
  /** 还有在传的 */
  readonly uploading: boolean
  /** 有传失败的（还挂在列表里等重试或删除） */
  readonly failed: boolean
  /** 全部传完了的那些（按添加的先后） */
  readonly ready: readonly AssetUploadItem[]
  /** 还能再加几个；不限为 Infinity */
  readonly remaining: number
  /** 选了文件：逐个加进列表并立刻开始上传 */
  add(files: Iterable<File>): void
  /** 删一项：在传就取消，预览地址撤销 */
  remove(id: string): void
  /** 失败（或被取消）的那项重新传 */
  retry(id: string): void
  /** 清空：在传的全部取消 */
  clear(): void
  /**
   * 发送时摘走全部项（列表变空，**预览地址不撤销**）。发送没被接下时 {@link restore} 还回来，
   * 接下了就 {@link release}。
   */
  detach(): AssetUploadItem[]
  /** 把摘走的项放回列表开头（用户这期间新加的排在后面） */
  restore(items: readonly AssetUploadItem[]): void
  /** 摘走的项用完了：撤销它们的预览地址 */
  release(items: readonly AssetUploadItem[]): void
}

/**
 * 附件列表：每项一个文件、各自上传，状态都在这里，组件只管画。
 * **换画布时自动清空**（在传的取消）—— 资源是传到某一张画布的，带到另一张画布上就成了别的画布的资源，服务端也不认。
 * 作用域销毁时同样清空。
 */
export function useAssetUploadList(
  flowId: MaybeRefOrGetter<string>,
  options: AssetUploadListOptions = {}
): AssetUploadList {
  const max = options.max ?? Infinity
  // 每项里的上传句柄自己是 reactive 的；列表本身只在增删时换引用
  const items = shallowRef<AssetUploadItem[]>([])

  function revoke(item: AssetUploadItem) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
  }

  function create(file: File): AssetUploadItem {
    const kind = agentAttachmentKind(file.type)
    return {
      id: createId("att"),
      file,
      name: file.name || "未命名文件",
      kind,
      previewUrl: kind === "file" ? null : URL.createObjectURL(file),
      upload: startFlowAssetUpload(toValue(flowId), file)
    }
  }

  function add(files: Iterable<File>) {
    const list = [...files]
    if (list.length === 0) return
    const room = Math.max(0, max - items.value.length)
    if (list.length > room) toast.warning(`最多 ${max} 个附件，多出的 ${list.length - room} 个没有加上`)
    const added = list.slice(0, room).map(create)
    if (added.length > 0) items.value = [...items.value, ...added]
  }

  function remove(id: string) {
    const item = items.value.find((entry) => entry.id === id)
    if (!item) return
    item.upload.cancel()
    revoke(item)
    items.value = items.value.filter((entry) => entry !== item)
  }

  function retry(id: string) {
    const index = items.value.findIndex((entry) => entry.id === id)
    const item = items.value[index]
    if (!item || item.upload.status === "uploading" || item.upload.status === "done") return
    const next = [...items.value]
    next[index] = { ...item, upload: startFlowAssetUpload(toValue(flowId), item.file) }
    items.value = next
  }

  function clear() {
    for (const item of items.value) {
      item.upload.cancel()
      revoke(item)
    }
    items.value = []
  }

  function detach() {
    const taken = items.value
    items.value = []
    return taken
  }

  function restore(taken: readonly AssetUploadItem[]) {
    if (taken.length === 0) return
    items.value = [...taken, ...items.value]
  }

  function release(taken: readonly AssetUploadItem[]) {
    for (const item of taken) revoke(item)
  }

  watch(() => toValue(flowId), clear)
  onScopeDispose(clear)

  const uploading = computed(() => items.value.some((item) => item.upload.status === "uploading"))
  const failed = computed(() => items.value.some((item) => item.upload.status === "error" || item.upload.status === "canceled"))
  const ready = computed(() => items.value.filter((item) => item.upload.status === "done"))
  const remaining = computed(() => Math.max(0, max - items.value.length))

  return reactive({
    items,
    uploading,
    failed,
    ready,
    remaining,
    add,
    remove,
    retry,
    clear,
    detach,
    restore,
    release
  }) as AssetUploadList
}
