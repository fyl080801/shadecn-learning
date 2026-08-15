import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue"
import { useRouter } from "vue-router"
import { toast } from "vue-sonner"
import { flowApi } from "@/lib/api"
import { formatTime } from "@/lib/format"
import { usePageTitle } from "@/composables/usePageTitle"
import { useAsyncAction } from "@/composables/useAsyncAction"
import type { useFlowStore } from "@/stores/flow"

type FlowStore = ReturnType<typeof useFlowStore>

/**
 * 「这张画布」这一层：加载、改名、复制、删除、离开前落库。
 * 都是文档级动作，跟画布上画了什么无关。
 */
export function useFlowDocument(flowId: Ref<string>, store: FlowStore) {
  const router = useRouter()

  const loading = ref(true)
  const loadError = ref<string | null>(null)

  async function reload() {
    loading.value = true
    loadError.value = null
    try {
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

  // —— 保存状态 ——

  const saveText = computed(() => {
    switch (store.saveState) {
      case "saving":
        return "保存中…"
      case "dirty":
        return "未保存"
      case "error":
        return "保存失败，点击重试"
      case "conflict":
        return "已在别处修改"
      default:
        // 保存过就带上时刻（跟随浏览器时区/习惯），没有就只说「已保存」
        return store.lastSavedAt
          ? `已保存 ${formatTime(store.lastSavedAt)}`
          : "已保存"
    }
  })

  /** 出问题的两种状态是可点的：失败重试、冲突重新加载 */
  const saveActionable = computed(
    () => store.saveState === "error" || store.saveState === "conflict"
  )

  function onSaveIndicatorClick() {
    if (store.saveState === "error") void store.saveNow()
    if (store.saveState === "conflict") void reload()
  }

  // —— 文档动作 ——

  /**
   * 离开这张画布之前，把没提交的先落库。
   * 不看 `dirty` 就直接调 `saveNow`：`dirty` 只算画布内容，
   * 而「只挪了一下视口」也得存 —— saveNow 里两条链路各自判断有没有活要干。
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
    saveText,
    saveActionable,
    onSaveIndicatorClick,
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
