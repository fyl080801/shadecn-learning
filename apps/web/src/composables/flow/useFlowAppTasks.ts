import { computed, inject, onBeforeUnmount, provide, reactive, ref, watch, type InjectionKey, type Ref } from "vue"
import { parseAppTasksMessage, type AppTaskView } from "@shadecn/shared/apps"
import { APP_TASKS_MESSAGE } from "@shadecn/shared/collab"
import type { FlowSummary } from "@shadecn/shared/canvas"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { ApiError, appApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { useProjectAdmin } from "./agent-panel"
import type { FlowAgentChannel } from "./useFlowAgent"

/**
 * 画布上进行中的生成任务（docs/29 §3.10）—— 节点角标的进度、右上角会话按钮的计数和「生成任务」列表都读这**一份**。
 *
 * - **没有轮询**：打开时 `GET` 一次、每次重连（`connected` 由断到通）再 `GET` 一次，其余只收房间的 `apps:tasks` 推送（全量，整份替换），
 *   同 agent 任务列表。推送到的时候还在飞的 `GET` 回来不覆盖它（推送更新）。
 * - **和文档对账**：节点 `runtime.taskId` 是这个任务、`runtime.status` 却已经不是 `processing` 的，按已结束处理不再显示 ——
 *   执行副本先写节点、后推送，文档可能先到。
 * - **节点的 `runtime` 只有执行副本写**（这里和运行器都不写）：`processing` = 执行副本已经在跑；
 *   排队中（还没有执行副本接手）只在这份列表里，节点的「排队中」、发送键转圈都要看这里（{@link FlowAppTasks.taskOn}）。
 *   排队中被取消的任务由服务端让执行副本补推一次列表。
 */

export interface FlowAppTasksHost {
  flowId: Ref<string>
  store: {
    readonly meta: FlowSummary | null
    readonly nodeById: ReadonlyMap<string, { runtime: { status: string; taskId?: string } }>
  }
  sync: FlowAgentChannel
}

export interface FlowAppTasks {
  /** 进行中的任务，按创建先后 */
  tasks: Readonly<Ref<readonly AppTaskView[]>>
  taskOf(taskId: string | undefined): AppTaskView | undefined
  /** 这个节点上进行中的任务（同一节点同时只有一个；排队中的也算） */
  taskOn(nodeId: string): AppTaskView | undefined
  /** 本窗口刚提交的任务先放进来（推送到了会整份替换） */
  upsert(task: AppTaskView): void
  /** 发起人或项目管理员才能取消（服务端照样判） */
  canCancel(task: AppTaskView): boolean
  cancel(task: AppTaskView): Promise<void | undefined>
  isCancelling(taskId: string): boolean
  /**
   * 这个节点是不是正在生成：本窗口的提交请求还在路上（{@link markSubmitting}），或者它有进行中（排队 / 生成中）的任务。
   * 底部输入框据此让发送按钮转圈、不可再点。`runtime` 是 processing 却找不到进行中的任务（残留的状态）不算 —— 不能让节点永远发不出去
   */
  isGenerating(nodeId: string): boolean
  /** 运行器提交前标上、提交回来（成功失败都）去掉；返回去掉的函数 */
  markSubmitting(nodeId: string): () => void
}

export const FLOW_APP_TASKS_KEY: InjectionKey<FlowAppTasks> = Symbol("flow-app-tasks")

/** 按画布 id 找到这份（节点运行器不在组件 setup 里，拿不到 inject） */
const registry = new Map<string, FlowAppTasks>()

export function flowAppTasksFor(flowId: string): FlowAppTasks | undefined {
  return registry.get(flowId)
}

/** 登记成这张画布的那一份；返回撤销函数（只撤自己）。{@link createFlowAppTasks} 用它，测试也可以直接登记一份假的 */
export function registerFlowAppTasks(flowId: string, api: FlowAppTasks): () => void {
  registry.set(flowId, api)
  return () => {
    if (registry.get(flowId) === api) registry.delete(flowId)
  }
}

export function createFlowAppTasks(host: FlowAppTasksHost): FlowAppTasks {
  const { flowId, store, sync } = host
  const raw = ref<AppTaskView[]>([])
  /** 本窗口里提交请求还在路上的节点 */
  const submitting = reactive(new Set<string>())
  let generation = 0
  /** 推送的版本号：`GET` 发出之后来过推送，回包就作废 */
  let pushes = 0

  const meta = computed(() => (store.meta && store.meta.id === flowId.value ? store.meta : null))
  const { user } = useAuth()
  const isAdmin = useProjectAdmin(computed(() => (meta.value?.mode === "collab" ? meta.value.projectId : null)))

  const tasks = computed<readonly AppTaskView[]>(() =>
    raw.value.filter((task) => {
      const runtime = store.nodeById.get(task.nodeId)?.runtime
      return !(runtime && runtime.taskId === task.id && runtime.status !== "processing")
    })
  )

  async function refresh() {
    const ticket = ++generation
    const before = pushes
    try {
      const { tasks: list } = await appApi.listFlowTasks(flowId.value)
      if (ticket === generation && before === pushes) raw.value = list
    } catch (error) {
      // 模块没开（没有配置应用）= 没有任务
      if (error instanceof ApiError && error.status === 404) {
        if (ticket === generation) raw.value = []
        return
      }
      console.warn("[apps] 读取生成任务列表失败", error)
    }
  }

  function onMessage(payload: string) {
    const parsed = parseAppTasksMessage(payload)
    if (!parsed || parsed.flowId !== flowId.value) return
    pushes++
    raw.value = parsed.tasks
  }

  const { run: cancel, isPending } = useAsyncAction(
    async (task: AppTaskView) => {
      await appApi.cancelFlowTask(flowId.value, task.id)
      // 节点不用改：在跑的由执行副本改回 idle，排队中的节点上本来就没写过 processing
      raw.value = raw.value.filter((item) => item.id !== task.id)
    },
    { key: (task) => task.id, errorMessage: "取消失败" }
  )

  const api: FlowAppTasks = {
    tasks,
    taskOf: (taskId) => (taskId ? raw.value.find((task) => task.id === taskId) : undefined),
    taskOn: (nodeId) => tasks.value.find((task) => task.nodeId === nodeId),
    upsert(task) {
      raw.value = [...raw.value.filter((item) => item.id !== task.id), task]
    },
    // 个人画布上只有所有者自己（服务端按管理员算），不用等登录态（没开登录时 user 是 null）
    canCancel: (task) => meta.value?.mode === "solo" || task.owner.id === user.value?.id || isAdmin.value,
    cancel,
    isCancelling: (taskId) => isPending(taskId),
    isGenerating(nodeId) {
      return submitting.has(nodeId) || api.taskOn(nodeId) !== undefined
    },
    markSubmitting(nodeId) {
      submitting.add(nodeId)
      return () => submitting.delete(nodeId)
    }
  }

  let unregister = () => {}
  watch(
    flowId,
    (id) => {
      unregister()
      unregister = registerFlowAppTasks(id, api)
      raw.value = []
      submitting.clear()
      void refresh()
    },
    { immediate: true }
  )
  const stopListening = sync.onStateless(APP_TASKS_MESSAGE, onMessage)
  watch(sync.connected, (now, before) => {
    if (now && !before) void refresh()
  })

  onBeforeUnmount(() => {
    generation++
    stopListening()
    unregister()
  })
  return api
}

/** 编辑器根组件的 setup 里调一次 */
export function provideFlowAppTasks(host: FlowAppTasksHost): FlowAppTasks {
  const api = createFlowAppTasks(host)
  provide(FLOW_APP_TASKS_KEY, api)
  return api
}

/** 可能不在编辑器子树里的地方用（节点组件的单测不 provide）：没有就是 null */
export function useOptionalFlowAppTasks(): FlowAppTasks | null {
  return inject(FLOW_APP_TASKS_KEY, null)
}
