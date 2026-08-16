import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue"
import { useRouter } from "vue-router"
import { toast } from "vue-sonner"
import { flowApi } from "@/lib/api"
import { usePageTitle } from "@/composables/usePageTitle"
import { useAsyncAction } from "@/composables/useAsyncAction"
import type { useFlowStore } from "@/stores/flow"
import type { FlowCollab } from "./useFlowCollab"

type FlowStore = ReturnType<typeof useFlowStore>

/**
 * 「这张画布」这一层：加载元信息、改名、复制、删除。
 * 都是文档级动作，跟画布上画了什么无关 —— 内容走协同那条路，不经过这里。
 */
export function useFlowDocument(
  flowId: Ref<string>,
  store: FlowStore,
  collab: FlowCollab
) {
  const router = useRouter()

  const loading = ref(true)
  const loadError = ref<string | null>(null)

  async function reload() {
    loading.value = true
    loadError.value = null
    try {
      // 只取元信息（名字、所属项目…）；内容来自 Y.Doc，不从这个响应里读
      store.load(await flowApi.get(flowId.value))
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  watch(flowId, reload, { immediate: true })

  // 标签页标题跟着画布名走，开多张时才分得清
  usePageTitle("画布", () => store.meta?.name)

  onBeforeUnmount(() => {
    store.reset()
  })

  // —— 同步状态 ——

  /**
   * 画布上那行小字。
   *
   * **没有「保存」这回事了** —— 改动进 Y.Doc 的那一刻就已经同步出去、并由服务端落库。
   * 用户需要知道的只剩一件事：这条连接还在不在。断了的话本地改动会攒在
   * Y.Doc 里，重连后自动补发（CRDT 合并，不会冲突），所以也不必惊慌。
   */
  const syncText = computed(() => {
    // 断网时改的东西存在本地 IndexedDB 里，刷新也不丢，重连后自动补发 —— 说清楚这一点，
    // 用户才不会以为「断了就白改了」而不敢动
    if (!collab.connected.value) return "已离线，改动存在本地，恢复连接后自动同步"
    return collab.session.value?.synced.value ? "已同步" : "同步中…"
  })

  /** 断线时给个视觉提醒，但不做成可点的动作 —— 用户没什么能做的，重连是自动的 */
  const syncWarning = computed(() => !collab.connected.value)

  // —— 文档动作 ——

  /**
   * 离开这张画布之前把「我怎么看」（视口）落库。
   * 内容不用管：它一直是同步的。
   */
  async function flushBeforeLeave() {
    await store.saveNow()
  }

  /**
   * 下面这些都要先 `flushBeforeLeave()` 再发请求，中间有两次 await，
   * 是最容易被连点打穿的一类动作 —— 一律走 useAsyncAction，重复触发当场丢弃。
   */

  const { run: rename } = useAsyncAction(
    async (next: string) => {
      const name = next.trim()
      if (!store.meta || !name || name === store.meta.name) return

      // 先改本地：改名不进撤销历史，失败了也只是提示一下
      store.renameLocally(name)
      await flowApi.update(flowId.value, { name })
    },
    { errorMessage: "改名失败" }
  )

  function projectPath() {
    const projectId = store.meta?.projectId
    return projectId ? `/projects/${projectId}` : "/projects"
  }

  const { run: backToProject } = useAsyncAction(async () => {
    await flushBeforeLeave()
    void router.push(projectPath())
  })

  const { run: createSibling, pending: creatingSibling } = useAsyncAction(async () => {
    const projectId = store.meta?.projectId
    if (!projectId) return

    await flushBeforeLeave()
    const flow = await flowApi.create(projectId, { name: "无标题" })
    void router.push(`/flows/${flow.id}`)
  }, { errorMessage: "创建失败" })

  const { run: duplicate, pending: duplicating } = useAsyncAction(async () => {
    await flushBeforeLeave()
    const copy = await flowApi.duplicate(flowId.value)
    toast.success(`已复制为「${copy.name}」`)
    void router.push(`/flows/${copy.id}`)
  }, { errorMessage: "复制失败" })

  const { run: remove, pending: removing } = useAsyncAction(async () => {
    const target = projectPath()
    await flowApi.remove(flowId.value)
    void router.push(target)
  }, { errorMessage: "删除失败" })

  return {
    loading,
    loadError,
    reload,
    syncText,
    syncWarning,
    flushBeforeLeave,
    rename,
    backToProject,
    createSibling,
    creatingSibling,
    duplicate,
    duplicating,
    remove,
    removing
  }
}

export type FlowDocument = ReturnType<typeof useFlowDocument>
