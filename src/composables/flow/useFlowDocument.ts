import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue"
import { useRouter } from "vue-router"
import { toast } from "vue-sonner"
import { flowApi } from "@/lib/api"
import { usePageTitle } from "@/composables/usePageTitle"
import { useAsyncAction } from "@/composables/useAsyncAction"
import type { useFlowStore } from "@/stores/flow"
import type { FlowSync } from "./sync"

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
   * 画布上那行小字。
   *
   * **两种画布这里的说法不一样，而且不能混**（REQ-SOLO §4.6）：
   * 项目画布是「同步」（改动进 Y.Doc 就走了，没有保存这一步），
   * 个人画布是「保存」（推一次 HTTP 才算落地）。跟个人画布的用户说
   * 「协作会话已过期」，他会去找那个根本不存在的协作者。
   */
  const syncText = computed(() => {
    /*
     * 终局失败要**先判、且分开判**。这些都不会自己好，套用下面那句
     * 「恢复连接后自动同步」就是在骗人：用户会照着继续画，而那些改动进得了本地
     * IndexedDB、永远发不出去。几种原因几条出路，所以文案也得分开写。
     */
    switch (sync.fatal.value) {
      case "superseded":
        return "协作会话已过期，请刷新页面"
      case "unauthorized":
        return "登录态已过期，请重新登录"
      case "forbidden":
        return "已失去访问权限，改动不再同步"
      case "too-large":
        return "画布太大，最近的改动没能保存"
    }

    if (store.meta?.mode === "solo") {
      // 断网时改的东西存在本地 IndexedDB 里，刷新也不丢，恢复后自动补发
      if (!sync.connected.value) {
        return sync.session.value?.synced.value
          ? "已离线，改动存在本地，恢复网络后自动保存"
          : "连不上服务器，改动只存在本地"
      }
      return sync.pending.value ? "保存中…" : "已保存"
    }

    if (!sync.connected.value) return "已离线，改动存在本地，恢复连接后自动同步"
    return sync.session.value?.synced.value ? "已同步" : "同步中…"
  })

  /** 断线时给个视觉提醒，但不做成可点的动作 —— 用户没什么能做的，重试是自动的 */
  const syncWarning = computed(() => !sync.connected.value || sync.fatal.value !== null)

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
