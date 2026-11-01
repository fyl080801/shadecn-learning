import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { defineComponent, h, nextTick, ref } from "vue"
import { mount } from "@vue/test-utils"
import * as Y from "yjs"
import { formatAppTasksMessage, type AppInfo, type AppTaskView } from "@shadecn/shared/apps"
import { APP_TASKS_MESSAGE } from "@shadecn/shared/collab"
import { GRAPH_SCHEMA_VERSION, type FlowNodeRecord } from "@shadecn/shared/flow-graph"
import { buildNodeRecord, nodeFormOf } from "@shadecn/shared/flow-node-types"
import { formatNodeMention } from "@shadecn/shared/agent"
import type { FlowDetail } from "@shadecn/shared/canvas"

import { appInputLimit, collectNodeAppInputs, referenceImageLimit, resolveNodeApp } from "@/components/flow/apps/node-app"
import { runNodeApp } from "@/components/flow/node-kit/features/app-run"
import type { NodeEventSource } from "@/components/flow/node-kit/protocol"
import { useFlowNode } from "@/composables/flow/useFlowNode"
import { createFlowAppTasks, flowAppTasksFor, type FlowAppTasks } from "@/composables/flow/useFlowAppTasks"
import { resetApps } from "@/composables/useApps"
import { ApiError } from "@/lib/api"
import { useFlowStore } from "@/stores/flow"

/**
 * 生成节点（docs/29 §3.8、§3.10）：节点选的应用 / 模型、节点输入 → 应用参数、运行器提交任务、
 * 画布的任务列表（推送替换、重连拉取、和文档对账、取消）。接口打桩（`appApi`），文档是真的 store + Y.Doc。
 */

const api = vi.hoisted(() => ({ list: vi.fn(), submitOnFlow: vi.fn(), listFlowTasks: vi.fn(), cancelFlowTask: vi.fn() }))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  appApi: api,
  projectApi: { get: vi.fn().mockResolvedValue({ myRole: "member" }) }
}))
const auth = vi.hoisted(() => ({ user: { value: { id: "user-1", name: "我" } as { id: string; name: string } | null } }))
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: auth.user }) }))
const toasts = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock("vue-sonner", () => ({ toast: toasts }))

const SEEDREAM: AppInfo = {
  id: "seedream",
  title: "Seedream",
  category: "image",
  driver: "ark",
  params: {
    model: { type: "string", enum: ["pro", "v45"], default: "pro" },
    prompt: { type: "string", required: true },
    image: { type: "images", maxLength: 2 }
  },
  models: [
    { id: "pro", title: "5.0", params: { prompt: { type: "string", required: true }, image: { type: "images", maxLength: 2 } } },
    { id: "v45", title: "4.5", params: { prompt: { type: "string", required: true }, image: { type: "images", maxLength: 14 } } }
  ],
  defaultModel: "pro"
}
const BROKEN: AppInfo = { ...SEEDREAM, id: "broken", title: "坏的", unavailable: "ARK_API_KEY 没有设置" }
const VIDEO: AppInfo = { ...SEEDREAM, id: "seedance", category: "video" }

function detail(): FlowDetail {
  return {
    id: "flow-1",
    projectId: "project-1",
    mode: "collab",
    name: "测试画布",
    description: null,
    status: "draft",
    tags: [],
    thumbnail: null,
    nodeCount: 0,
    edgeCount: 0,
    revision: 0,
    createdById: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    graph: { schemaVersion: GRAPH_SCHEMA_VERSION, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [], meta: {} },
    userState: {}
  }
}

function node(id: string, type: string, data: Record<string, unknown> = {}, label = id): FlowNodeRecord {
  const record = buildNodeRecord({ id, type, label, position: { x: 0, y: 0 } })
  return { ...record, data: { ...record.data, ...data } }
}

/** 一张画布：两张参考图 + 一个文本 → 生成节点 gen */
function canvas(mode: FlowDetail["mode"] = "collab") {
  const store = useFlowStore()
  store.load({ ...detail(), mode })
  store.attachDoc(new Y.Doc())
  store.addNode(node("ref1", "image", { src: "https://s3/a.png", form: "asset" }, "猫"))
  store.addNode(node("ref2", "image", { src: "https://s3/b.png", form: "asset" }, "衣服"))
  store.addNode(node("note", "text", { text: "电影感，暖色调" }))
  store.addNode(node("gen", "image"))
  store.connect("ref1", "gen")
  store.connect("ref2", "gen")
  store.connect("note", "gen")
  store.separateUndo()
  return store
}

function eventSource(id: string, type = "image"): NodeEventSource {
  const store = useFlowStore()
  return {
    id,
    type,
    node: useFlowNode(id),
    label: ref("生成"),
    editor: { flowId: ref("flow-1"), store }
  } as unknown as NodeEventSource
}

function taskView(overrides: Partial<AppTaskView> = {}): AppTaskView {
  return {
    id: "task-1",
    flowId: "flow-1",
    nodeId: "gen",
    appId: "seedream",
    appTitle: "Seedream",
    status: "queued",
    owner: { id: "user-1", name: "我", avatarUrl: null },
    createdAt: 1,
    ...overrides
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetApps()
  api.list.mockResolvedValue([BROKEN, SEEDREAM, VIDEO])
  api.submitOnFlow.mockResolvedValue(taskView())
  api.listFlowTasks.mockResolvedValue({ tasks: [], now: 1 })
  api.cancelFlowTask.mockResolvedValue(undefined)
})

/** 挂着任务列表的组件：每个用例后卸掉（按画布 id 的登记跟着清掉，不串到下一个用例） */
const mounted: { unmount(): void }[] = []

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.clearAllMocks()
})

describe("节点选哪个应用 / 模型", () => {
  it("没选：这个类别里第一个可用的应用、它的默认模型；选了就用选的；选的模型不在了退回默认", () => {
    const apps = [BROKEN, SEEDREAM, VIDEO]
    expect(resolveNodeApp(apps, "image", {})).toMatchObject({ app: { id: "seedream" }, model: "pro" })
    expect(resolveNodeApp(apps, "image", { appId: "seedream", appModel: "v45" })).toMatchObject({ model: "v45" })
    expect(resolveNodeApp(apps, "image", { appId: "seedream", appModel: "gone" })).toMatchObject({ model: "pro" })
    expect(resolveNodeApp(apps, "video", {})).toMatchObject({ app: { id: "seedance" } })
    expect(resolveNodeApp(apps, "audio", {})).toBeNull()
  })

  it("参考图上限按所选模型；连线上限只收紧图片端口，没有应用就不收紧", () => {
    expect(referenceImageLimit({ app: SEEDREAM, model: "pro" })).toBe(2)
    expect(referenceImageLimit({ app: SEEDREAM, model: "v45" })).toBe(14)
    const imagePort = { id: "image", dataType: "image" as const }
    expect(appInputLimit([SEEDREAM], "image", {}, imagePort)).toEqual({ max: 2, reason: "5.0 最多连 2 张参考图" })
    expect(appInputLimit([SEEDREAM], "image", { appId: "seedream", appModel: "v45" }, imagePort)?.max).toBe(14)
    expect(appInputLimit([SEEDREAM], "image", {}, { id: "text", dataType: "text" })).toBeUndefined()
    expect(appInputLimit([], "image", {}, imagePort)).toBeUndefined()
  })
})

describe("节点的输入 → 应用的输入", () => {
  it("参考图按连入顺序；提及参考图换成「图N」、提及文本换成正文；没被提及的文本接在最前", () => {
    const store = canvas()
    const gen = store.nodeById.get("gen")!
    const prompt = `把${formatNodeMention("ref1")}的衣服换成${formatNodeMention("ref2")}`
    expect(collectNodeAppInputs(gen, prompt, store.nodeById)).toEqual({
      prompt: "电影感，暖色调\n把图1的衣服换成图2",
      images: ["https://s3/a.png", "https://s3/b.png"]
    })
    const mentionText = collectNodeAppInputs(gen, `${formatNodeMention("note")}，一只猫`, store.nodeById)
    expect(mentionText.prompt).toBe("电影感，暖色调，一只猫")
  })

  it("还没有图的上游不算参考图", () => {
    const store = canvas()
    store.addNode(node("empty", "image"))
    store.connect("empty", "gen")
    expect(collectNodeAppInputs(store.nodeById.get("gen")!, "x", store.nodeById).images).toHaveLength(2)
  })
})

describe("运行器 app-run", () => {
  it("提交任务：提示词 + 参考图 + 模型 + 节点；节点的 runtime 和 src 都不写（只有执行副本写）", async () => {
    const store = canvas()
    store.writeNode("gen", "data", { set: { appId: "seedream", appModel: "v45" } })
    await runNodeApp(eventSource("gen"), "一只猫")

    expect(api.submitOnFlow).toHaveBeenCalledWith("flow-1", "seedream", {
      nodeId: "gen",
      params: { model: "v45", prompt: "电影感，暖色调\n一只猫", image: ["https://s3/a.png", "https://s3/b.png"] }
    })
    const gen = store.nodeById.get("gen")!
    expect(gen.runtime).toEqual({ status: "idle" })
    expect(gen.data.src).toBe("")
    expect(nodeFormOf("image", gen.data)).toBe("generate")
  })

  it("节点上设的尺寸（appParam.size）带进请求；不合所选模型的不带", async () => {
    const sized: AppInfo = {
      ...SEEDREAM,
      models: SEEDREAM.models.map((model) => ({
        ...model,
        params: { ...model.params, size: { type: "size", tiers: ["1K", "2K"], maxPixels: model.id === "pro" ? 4624220 : 16777216 } }
      }))
    }
    api.list.mockResolvedValue([sized])
    const store = canvas()
    store.writeNode("gen", "data", { set: { appModel: "v45", appId: "seedream", "appParam.size": "4096x4096" } })
    await runNodeApp(eventSource("gen"), "x")
    expect(api.submitOnFlow.mock.calls[0]![2].params.size).toBe("4096x4096")

    store.writeNode("gen", "data", { set: { appModel: "pro" } })
    await runNodeApp(eventSource("gen"), "x")
    expect(api.submitOnFlow.mock.calls[1]![2].params).not.toHaveProperty("size")
  })

  it("超出模型上限的参考图截掉并提示", async () => {
    const store = canvas()
    store.addNode(node("ref3", "image", { src: "https://s3/c.png", form: "asset" }))
    store.connect("ref3", "gen")
    await runNodeApp(eventSource("gen"), "x")
    expect(api.submitOnFlow.mock.calls[0]![2].params.image).toEqual(["https://s3/a.png", "https://s3/b.png"])
    expect(toasts.warning).toHaveBeenCalledWith(expect.stringContaining("1 张参考图"))
  })

  it("提交失败：只提示服务端那句话，节点状态和内容都不动", async () => {
    const store = canvas()
    api.submitOnFlow.mockRejectedValue(new ApiError("生成服务不可用（没有正在运行的 agent 实例）", 503, { code: "unavailable" }))
    await runNodeApp(eventSource("gen"), "x")
    expect(toasts.error).toHaveBeenCalledWith("生成没有提交成功", { description: "生成服务不可用（没有正在运行的 agent 实例）" })
    const gen = store.nodeById.get("gen")!
    expect(gen.runtime).toEqual({ status: "idle" })
    expect(gen.data.src).toBe("")
  })

  it("服务端说这个节点已有进行中的任务（409）：只提示，不改状态", async () => {
    const store = canvas()
    api.submitOnFlow.mockRejectedValue(new ApiError("这个节点正在生成", 409, { code: "busy" }))
    await runNodeApp(eventSource("gen"), "x")
    expect(toasts.info).toHaveBeenCalled()
    expect(store.nodeById.get("gen")!.runtime.status).toBe("idle")
  })

  it("选的应用不可用 / 没有应用：只提示，不发请求、不改状态", async () => {
    const store = canvas()
    store.writeNode("gen", "data", { set: { appId: "broken" } })
    await runNodeApp(eventSource("gen"), "x")
    expect(toasts.error).toHaveBeenCalledWith("「坏的」现在用不了", { description: "ARK_API_KEY 没有设置" })

    resetApps()
    api.list.mockResolvedValue([])
    await runNodeApp(eventSource("gen"), "x")
    expect(api.submitOnFlow).not.toHaveBeenCalled()
    expect(store.nodeById.get("gen")!.runtime.status).toBe("idle")
  })

  it("同一拍点两次：只发一个请求", async () => {
    canvas()
    let release!: () => void
    api.submitOnFlow.mockImplementation(() => new Promise((resolve) => (release = () => resolve(taskView()))))
    const first = runNodeApp(eventSource("gen"), "x")
    await vi.waitFor(() => expect(api.submitOnFlow).toHaveBeenCalledTimes(1))
    await runNodeApp(eventSource("gen"), "x")
    expect(toasts.info).toHaveBeenCalled()
    expect(api.submitOnFlow).toHaveBeenCalledTimes(1)
    release()
    await first
  })
})

describe("画布的生成任务列表 useFlowAppTasks", () => {
  function setup(mode: FlowDetail["mode"] = "collab") {
    const store = canvas(mode)
    const handlers = new Map<string, (payload: string) => void>()
    const connected = ref(true)
    const sync = {
      onStateless: (type: string, handler: (payload: string) => void) => {
        handlers.set(type, handler)
        return () => handlers.delete(type)
      },
      connected
    }
    let tasks!: FlowAppTasks
    const wrapper = mount(
      defineComponent({
        setup() {
          tasks = createFlowAppTasks({ flowId: ref("flow-1"), store, sync })
          return () => h("div")
        }
      })
    )
    mounted.push(wrapper)
    const push = (list: AppTaskView[], flowId = "flow-1") => handlers.get(APP_TASKS_MESSAGE)!(formatAppTasksMessage(flowId, list))
    return { store, tasks, push, connected }
  }

  it("打开时拉一次；推送整份替换，别的画布的推送丢掉；重连再拉一次", async () => {
    api.listFlowTasks.mockResolvedValue({ tasks: [taskView()], now: 1 })
    const { tasks, push, connected } = setup()
    await vi.waitFor(() => expect(tasks.tasks.value).toHaveLength(1))
    push([taskView({ status: "running", progress: { status: "running", ratio: 0.4 } })])
    expect(tasks.taskOf("task-1")).toMatchObject({ status: "running", progress: { ratio: 0.4 } })
    push([], "flow-2")
    expect(tasks.tasks.value).toHaveLength(1)

    api.listFlowTasks.mockResolvedValue({ tasks: [], now: 2 })
    connected.value = false
    await nextTick()
    connected.value = true
    await vi.waitFor(() => expect(tasks.tasks.value).toHaveLength(0))
    expect(api.listFlowTasks).toHaveBeenCalledTimes(2)
  })

  it("拉取还在路上时来了推送：回包不覆盖推送", async () => {
    let resolve!: (value: { tasks: AppTaskView[]; now: number }) => void
    api.listFlowTasks.mockImplementation(() => new Promise((done) => (resolve = done)))
    const { tasks, push } = setup()
    push([taskView({ id: "fresh" })])
    resolve({ tasks: [taskView({ id: "stale" })], now: 1 })
    await nextTick()
    await nextTick()
    expect(tasks.tasks.value.map((task) => task.id)).toEqual(["fresh"])
  })

  it("和文档对账：节点 runtime 指着这个任务却已不是 processing → 不显示", async () => {
    const { store, tasks, push } = setup()
    push([taskView()])
    store.writeNode("gen", "runtime", { set: { status: "processing", taskId: "task-1" } })
    expect(tasks.tasks.value).toHaveLength(1)
    store.writeNode("gen", "runtime", { set: { status: "idle" } })
    expect(tasks.tasks.value).toHaveLength(0)
  })

  it("运行器提交的任务马上进列表（按画布 id 找到这一份）", async () => {
    const { tasks } = setup()
    expect(flowAppTasksFor("flow-1")).toBe(tasks)
    await runNodeApp(eventSource("gen"), "x")
    expect(tasks.tasks.value.map((task) => task.id)).toEqual(["task-1"])
    // 节点正在生成、任务也在列表里：再发只提示
    await runNodeApp(eventSource("gen"), "x")
    expect(api.submitOnFlow).toHaveBeenCalledTimes(1)
    expect(toasts.info).toHaveBeenCalled()
  })

  it("个人画布：只有所有者自己，不看登录态就能取消（没开登录时当前用户是 null）", () => {
    auth.user.value = null
    try {
      const { tasks, push } = setup("solo")
      push([taskView({ owner: { id: "someone", name: "", avatarUrl: null } })])
      expect(tasks.canCancel(tasks.taskOf("task-1")!)).toBe(true)
    } finally {
      auth.user.value = { id: "user-1", name: "我" }
    }
  })

  it("isGenerating：提交在路上、节点有进行中（含排队）的任务都算；processing 却找不到进行中的任务（残留状态）不算", async () => {
    const { store, tasks, push } = setup()
    let release!: () => void
    api.submitOnFlow.mockImplementation(() => new Promise((resolve) => (release = () => resolve(taskView()))))
    const pending = runNodeApp(eventSource("gen"), "x")
    await vi.waitFor(() => expect(api.submitOnFlow).toHaveBeenCalled())
    expect(tasks.isGenerating("gen")).toBe(true)
    release()
    await pending
    // 节点上还没有任何痕迹（排队中，执行副本还没接手），列表里的任务就够了
    expect(store.nodeById.get("gen")!.runtime.status).toBe("idle")
    expect(tasks.taskOn("gen")?.id).toBe("task-1")
    expect(tasks.isGenerating("gen")).toBe(true)

    // 执行副本接手后写了 processing（模拟远端写入）；之后推送说已经没有进行中的任务了，节点却还停在 processing（服务端没能写回）：不把输入框锁死
    store.writeNode("gen", "runtime", { set: { status: "processing", taskId: "task-1" } })
    expect(tasks.isGenerating("gen")).toBe(true)
    push([])
    expect(store.nodeById.get("gen")!.runtime.status).toBe("processing")
    expect(tasks.isGenerating("gen")).toBe(false)
  })

  it("取消：发起人才有按钮；调接口、移出列表，节点不由前端改（执行副本改回 idle）", async () => {
    const { store, tasks, push } = setup()
    push([taskView(), taskView({ id: "other", nodeId: "ref1", owner: { id: "user-2", name: "别人", avatarUrl: null } })])
    store.writeNode("gen", "runtime", { set: { status: "processing", taskId: "task-1" } })
    expect(tasks.canCancel(tasks.taskOf("task-1")!)).toBe(true)
    expect(tasks.canCancel(tasks.taskOf("other")!)).toBe(false)

    await tasks.cancel(tasks.taskOf("task-1")!)
    expect(api.cancelFlowTask).toHaveBeenCalledWith("flow-1", "task-1")
    expect(tasks.tasks.value.map((task) => task.id)).toEqual(["other"])
    expect(store.nodeById.get("gen")!.runtime).toMatchObject({ status: "processing", taskId: "task-1" })
  })
})
