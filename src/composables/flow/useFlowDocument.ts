import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue"
import { useRouter } from "vue-router"
import { toast } from "vue-sonner"
import { flowApi } from "@/lib/api"
import { usePageTitle } from "@/composables/usePageTitle"
import { useAsyncAction } from "@/composables/useAsyncAction"
import type { useFlowStore } from "@/stores/flow"
import type { FlowSync } from "./sync"
import { syncTextOf, syncWarningOf } from "./sync-text"

type FlowStore = ReturnType<typeof useFlowStore>

/**
 * 「这张画布」这一层：加载元信息、改名、复制、删除。
 * 都是文档级动作，跟画布上画了什么无关 —— 内容走同步层，不经过这里。
 */
export function useFlowDocument(
  flowId: Ref<string>,
  store: FlowStore,
  sync: FlowSync
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
   * 画布上那行小字，以及它要不要标成警告色。
   *
   * 判断本身在 `./sync-text.ts`（纯函数，能被真的测到）；这里只负责把当前状态
   * 收集成它要的形状。
   */
  const syncInput = computed(() => ({
    fatal: sync.fatal.value,
    mode: store.meta?.mode ?? null,
    connected: sync.connected.value,
    synced: sync.session.value?.synced.value ?? false,
    pending: sync.pending.value,
    saveFailed: sync.saveFailed.value,
    cacheFailed: sync.cacheFailed.value
  }))

  const syncText = computed(() => syncTextOf(syncInput.value))
  const syncWarning = computed(() => syncWarningOf(syncInput.value))


  // —— 文档动作 ——

  /**
   * 离开这张画布之前，把还没送出去的都送走：「我怎么看」（视口）——
   * 以及个人画布那边可能还攒着的内容改动。
   *
   * 项目画布的内容不用管，它一直是同步的；`sync.flush()` 在那边是个空动作。
   */
  async function flushBeforeLeave() {
    await Promise.all([store.saveNow(), sync.flush()])
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

  /**
   * 「返回」回哪儿 —— **按画布自己的种类，不按它挂在哪个项目下**。
   *
   * 个人空间在接口层面是个 `kind='personal'` 的项目，`meta.projectId` 也确实指着它，
   * 但那是存储上的事实，不是用户看到的事实：个人画布的列表页是 `/personal`，
   * 那个「项目主页」（成员、分享、返回全部项目）从来就不该被走到。
   * 所以这里认 `mode`，不认 `projectId`。
   */
  function backPath() {
    if (store.meta?.mode === "solo") return "/personal"
    const projectId = store.meta?.projectId
    return projectId ? `/projects/${projectId}` : "/projects"
  }

  /** 文案和落点是同一个判断，放在一起，免得哪天只改了一半 */
  const backLabel = computed(() => (store.meta?.mode === "solo" ? "返回个人画布" : "返回项目"))

  const { run: goBack } = useAsyncAction(async () => {
    await flushBeforeLeave()
    void router.push(backPath())
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
    // 先算好再删：删完 meta 还在，但「删除后该回哪儿」是删之前那张画布的属性
    const target = backPath()
    /*
     * **在发请求之前**打招呼：服务端删完会把这张画布的连接全部当场掐掉（含我自己这条），
     * 而且是先踢人再回 204 —— 关闭信号往往比响应先到。不先说一声，删完自己会先吃到
     * 一个「已失去这张画布的访问权限」的模态框，然后才被路由带走。
     */
    sync.leave()
    try {
      await flowApi.remove(flowId.value)
    } catch (err) {
      // 没删成，人还在这张画布上：撤回标记，否则之后真被踢也会一声不响
      sync.stay()
      throw err
    }
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
    goBack,
    backLabel,
    createSibling,
    creatingSibling,
    duplicate,
    duplicating,
    remove,
    removing
  }
}

export type FlowDocument = ReturnType<typeof useFlowDocument>
