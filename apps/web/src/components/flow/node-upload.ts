import { computed, reactive } from "vue"
import { toast } from "vue-sonner"

import type { NodePartContext } from "@/components/flow/node-kit/protocol"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { isUploadCanceled } from "@/lib/asset-upload"

/**
 * 节点的「上传中」状态 —— **本地的，不进 Y.Doc**：别的协作者看不到，刷新页面就没了。
 * 写进文档的话，上传的人中途关掉页面，节点就永远卡在「上传中」，没人能把它改回来。
 *
 * 登记表放在模块级、按 `画布 id:节点 id` 记，而不是放在 body 组件里：节点被虚拟化卸掉、
 * 或宿主重挂 body 时，上传还在跑，回来的组件得接着显示同一份进度、能取消同一个请求。
 */
export interface NodeUploadState {
  /** 0–100；`null` = 没有中间进度（一次传完的小文件、分片上传开始之前），只转圈 */
  progress: number | null
  controller: AbortController
}

export interface NodeUploadIo {
  signal: AbortSignal
  onProgress: (loaded: number, total: number) => void
}

const uploads = reactive(new Map<string, NodeUploadState>())

function keyOf(ctx: NodePartContext) {
  return `${ctx.editor.flowId.value}:${ctx.id}`
}

/** 这个节点此刻在不在上传（角标、body 都看它） */
export function nodeUploadOf(ctx: NodePartContext): NodeUploadState | undefined {
  return uploads.get(keyOf(ctx))
}

/**
 * body 里用：`upload(file)` 开始一次上传，`task` 拿到 `signal` / `onProgress` 交给 `uploadFlowAsset`。
 * 同一个节点正在传就不再开第二次（`useAsyncAction` 只锁本组件，这里按节点再锁一层）。
 * 取消不提示；别的失败照常 toast。
 */
export function useNodeUpload(ctx: NodePartContext, task: (file: File, io: NodeUploadIo) => Promise<void>) {
  const state = computed(() => nodeUploadOf(ctx))

  const { run: upload } = useAsyncAction(
    async (file: File) => {
      const key = keyOf(ctx)
      if (uploads.has(key)) return
      const controller = new AbortController()
      uploads.set(key, { progress: null, controller })
      // 取回来的是 reactive 代理，改它的 progress 才会触发重绘
      const entry = uploads.get(key)!
      try {
        await task(file, {
          signal: controller.signal,
          onProgress: (loaded, total) => {
            entry.progress = total > 0 ? Math.round((loaded / total) * 100) : null
          }
        })
      } finally {
        if (uploads.get(key)?.controller === controller) uploads.delete(key)
      }
    },
    {
      onError: (error) => {
        if (!isUploadCanceled(error)) toast.error(error instanceof Error ? error.message : "上传失败")
      }
    }
  )

  function cancel() {
    state.value?.controller.abort()
  }

  return { upload, state, cancel }
}
