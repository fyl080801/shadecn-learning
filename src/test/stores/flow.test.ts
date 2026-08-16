import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import { LOCAL_ORIGIN, USER_STATE_FLUSH_DELAY, useFlowStore } from "@/stores/flow"
import { metaMap, nodesMap, toYNode } from "@/lib/flow-doc"
import { defaultNodeData, type FlowDetail, type FlowEdge, type FlowNode } from "@/types/flow"

/**
 * store 是 Y.Doc 的响应式投影 —— 这一组用例盯的就是这层契约：
 * 改动进得去、别人的改动看得到、撤销只撤自己的、视口不进内容。
 */

function node(id: string, x = 0, y = 0): FlowNode {
  return { id, type: "process", position: { x, y }, data: defaultNodeData(`节点 ${id}`) }
}

function edge(id: string, source: string, target: string): FlowEdge {
  return { id, source, target, sourceHandle: null, targetHandle: null, data: { config: {} } }
}

function detail(overrides: Partial<FlowDetail> = {}): FlowDetail {
  return {
    id: "flow-1",
    projectId: "project-1",
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
    graph: {
      schemaVersion: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      meta: {}
    },
    userState: {},
    ...overrides
  }
}

/** 起一个接好文档的 store，外加一个「远端」文档用来模拟别人 */
function setup() {
  const store = useFlowStore()
  store.load(detail())
  const doc = new Y.Doc()
  store.attachDoc(doc)
  return { store, doc }
}

/** 同 setup()，外加一个记账用的 fetch 桩：断言「发了几个请求」 */
function setupWithFetch() {
  const calls: { url: string; body: unknown }[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return new Response(null, { status: 204 })
    })
  )
  return { calls, ...setup() }
}

/** 把 a 的状态同步给 b，模拟一次网络往返 */
function sync(from: Y.Doc, to: Y.Doc) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from), "remote")
}

describe("内容读写", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("加节点会进 Y.Doc，并反映到投影上", () => {
    const { store, doc } = setup()
    store.addNode(node("n1", 10, 20))

    expect(store.nodes.map((item) => item.id)).toEqual(["n1"])
    expect(nodesMap(doc).has("n1")).toBe(true)
  })

  it("没接文档时写操作是空转，不抛异常", () => {
    const store = useFlowStore()
    store.load(detail())
    expect(() => store.addNode(node("n1"))).not.toThrow()
    expect(store.nodes).toHaveLength(0)
  })

  it("移动节点只改 position，不动别的字段", () => {
    const { store } = setup()
    store.addNode(node("n1"))
    store.moveNodes(new Map([["n1", { x: 99, y: 88 }]]))

    expect(store.nodes[0]!.position).toEqual({ x: 99, y: 88 })
    expect(store.nodes[0]!.data.label).toBe("节点 n1")
  })

  it("改节点数据是按 key 合并，没提到的字段保持原样", () => {
    const { store } = setup()
    store.addNode(node("n1"))
    store.updateNodeData("n1", { label: "改过的" })

    expect(store.nodes[0]!.data.label).toBe("改过的")
    expect(store.nodes[0]!.data.kind).toBe("process")
    expect(store.nodes[0]!.data.config).toEqual({})
  })

  it("删节点时连着的边一起删，不留悬空的边", () => {
    const { store, doc } = setup()
    store.addNode(node("n1"))
    store.addNode(node("n2"))
    store.addEdge(edge("e1", "n1", "n2"))
    expect(store.edges).toHaveLength(1)

    store.removeElements(["n1"], [])

    expect(store.nodes.map((item) => item.id)).toEqual(["n2"])
    expect(store.edges).toHaveLength(0)
    // 不是只在投影里过滤掉，Y.Doc 里也真的没了
    expect(doc.getMap("edges").has("e1")).toBe(false)
  })

  it("端点还在的边不会被误删", () => {
    const { store } = setup()
    store.addNode(node("n1"))
    store.addNode(node("n2"))
    store.addEdge(edge("e1", "n1", "n2"))

    store.removeElements([], [])
    expect(store.edges).toHaveLength(1)
  })

  it("分组 / 层级字段（zIndex、parentNode、extent）写得进也读得出", () => {
    const { store } = setup()
    store.addNode(node("group"))
    store.addNode({ ...node("n1"), zIndex: 3, parentNode: "group", extent: "parent" })

    const projected = store.nodes.find((item) => item.id === "n1")!
    expect(projected.zIndex).toBe(3)
    expect(projected.parentNode).toBe("group")
    expect(projected.extent).toBe("parent")
  })
})

describe("协同合并", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("别人加的节点会出现在我的投影里", () => {
    const { store, doc } = setup()
    const remote = new Y.Doc()
    sync(doc, remote)

    remote.getMap<Y.Map<unknown>>("nodes").set("n-remote", toYNode(node("n-remote")))
    sync(remote, doc)

    expect(store.nodes.map((item) => item.id)).toEqual(["n-remote"])
  })

  it("两人同时改同一个节点的不同字段，两边的改动都留下", () => {
    const { store, doc } = setup()
    store.addNode(node("n1"))

    const remote = new Y.Doc()
    sync(doc, remote)

    // 各自从同一份状态出发离线改
    store.updateNodeData("n1", { label: "我改的标题" })
    const remoteData = remote.getMap<Y.Map<unknown>>("nodes").get("n1")!.get("data") as Y.Map<unknown>
    remoteData.set("description", "他写的说明")

    sync(remote, doc)

    expect(store.nodes[0]!.data.label).toBe("我改的标题")
    expect(store.nodes[0]!.data.description).toBe("他写的说明")
  })

  it("同一条改动应用两次不会变成两个节点（更新是幂等的）", () => {
    const { store, doc } = setup()
    const remote = new Y.Doc()
    remote.getMap<Y.Map<unknown>>("nodes").set("n1", toYNode(node("n1")))

    const update = Y.encodeStateAsUpdate(remote)
    Y.applyUpdate(doc, update, "remote")
    Y.applyUpdate(doc, update, "remote")

    expect(store.nodes).toHaveLength(1)
  })
})

describe("撤销", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("撤销 / 重做自己的改动", () => {
    const { store } = setup()
    expect(store.canUndo).toBe(false)

    store.addNode(node("n1"))
    expect(store.canUndo).toBe(true)

    store.undo()
    expect(store.nodes).toHaveLength(0)
    expect(store.canRedo).toBe(true)

    store.redo()
    expect(store.nodes.map((item) => item.id)).toEqual(["n1"])
  })

  it("**只撤自己的**：别人的改动不进我的撤销栈", () => {
    const { store, doc } = setup()
    const remote = new Y.Doc()
    sync(doc, remote)

    remote.getMap<Y.Map<unknown>>("nodes").set("n-remote", toYNode(node("n-remote")))
    sync(remote, doc)

    // 只有别人动过，我没什么可撤的
    expect(store.canUndo).toBe(false)

    store.addNode(node("n-mine"))
    store.undo()

    // 撤掉的是我加的那个，别人的还在
    expect(store.nodes.map((item) => item.id)).toEqual(["n-remote"])
  })

  it("separateUndo 之间的改动各成一条记录", () => {
    const { store } = setup()
    store.addNode(node("n1"))
    store.separateUndo()
    store.addNode(node("n2"))

    store.undo()
    expect(store.nodes.map((item) => item.id)).toEqual(["n1"])
  })

  it("本地改动带的是 LOCAL_ORIGIN —— UndoManager 靠它区分谁干的", () => {
    const { store, doc } = setup()
    const origins: unknown[] = []
    doc.on("afterTransaction", (transaction: Y.Transaction) => origins.push(transaction.origin))

    store.addNode(node("n1"))
    expect(origins).toContain(LOCAL_ORIGIN)
  })
})

describe("视口：按用户存，不是画布内容", () => {
  beforeEach(() => setActivePinia(createPinia()))

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("移动视口不进 Y.Doc、不进撤销栈", () => {
    const { store, doc } = setup()
    const before = Y.encodeStateAsUpdate(doc).length

    store.setViewport({ x: 100, y: 200, zoom: 2 })

    expect(store.viewport).toEqual({ x: 100, y: 200, zoom: 2 })
    expect(store.canUndo).toBe(false)
    expect(Y.encodeStateAsUpdate(doc).length).toBe(before)
  })

  it("光是移动视口不发请求 —— 看一眼画布不该产生写流量", async () => {
    vi.useFakeTimers()
    const { calls, store } = setupWithFetch()

    store.setViewport({ x: 1, y: 2, zoom: 1 })
    store.setViewport({ x: 3, y: 4, zoom: 1 })

    await vi.advanceTimersByTimeAsync(USER_STATE_FLUSH_DELAY * 3)

    expect(calls).toHaveLength(0)
  })

  it("本地编辑之后才搭车 PATCH，发的是最后那个视口值", async () => {
    vi.useFakeTimers()
    const { calls, store } = setupWithFetch()

    store.setViewport({ x: 1, y: 2, zoom: 1 })
    store.setViewport({ x: 3, y: 4, zoom: 1 })
    store.addNode(node("n1"))

    await vi.advanceTimersByTimeAsync(USER_STATE_FLUSH_DELAY + 10)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain("/user-state")
    expect(calls[0]!.body).toEqual({ viewport: { x: 3, y: 4, zoom: 1 } })
  })

  it("连续编辑不会把窗口一直往后推，也不会一次编辑一个请求", async () => {
    vi.useFakeTimers()
    const { calls, store } = setupWithFetch()

    store.setViewport({ x: 1, y: 2, zoom: 1 })
    for (let i = 0; i < 5; i++) {
      store.addNode(node(`n${i}`))
      await vi.advanceTimersByTimeAsync(USER_STATE_FLUSH_DELAY / 2)
    }

    // 5 次编辑跨了 2.5 个窗口，但只有第一个窗口里有攒着的视口
    expect(calls).toHaveLength(1)
  })

  it("没有可存的东西时，编辑不会凭空发请求", async () => {
    vi.useFakeTimers()
    const { calls, store } = setupWithFetch()

    store.addNode(node("n1"))
    await vi.advanceTimersByTimeAsync(USER_STATE_FLUSH_DELAY + 10)

    expect(calls).toHaveLength(0)
  })

  it("只平移没编辑，离开时兜底存一次", async () => {
    const { calls, store } = setupWithFetch()

    store.setViewport({ x: 9, y: 9, zoom: 2 })
    await store.saveNow()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({ viewport: { x: 9, y: 9, zoom: 2 } })
  })

  it("首开（自己没存过视口）时，能在同步完成后应用快照里的兜底视口", () => {
    const { store, doc } = setup()

    // 模拟同步：meta.viewport 在接管**之后**才随内容到达 —— 首开时序就是这样
    metaMap(doc).set("viewport", { x: 42, y: 7, zoom: 0.5 })

    expect(store.applyFallbackViewport()).toBe(true)
    expect(store.viewport).toEqual({ x: 42, y: 7, zoom: 0.5 })
  })

  it("自己存过视口的话，兜底不生效 —— 各人看各人的", () => {
    const store = useFlowStore()
    store.load(detail({ userState: { viewport: { x: 1, y: 1, zoom: 1 } } }))
    const doc = new Y.Doc()
    store.attachDoc(doc)
    metaMap(doc).set("viewport", { x: 42, y: 7, zoom: 0.5 })

    expect(store.applyFallbackViewport()).toBe(false)
    expect(store.viewport).toEqual({ x: 1, y: 1, zoom: 1 })
  })

  it("快照里没有（或不合法的）兜底视口时按兵不动", () => {
    const { store, doc } = setup()
    metaMap(doc).set("viewport", { x: 1, y: 2, zoom: -3 })

    expect(store.applyFallbackViewport()).toBe(false)
    expect(store.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })
})

describe("增量投影", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("改一个节点，其余节点的对象引用保持不变", () => {
    const { store } = setup()
    store.addNode(node("n1"))
    store.addNode(node("n2"))
    store.addNode(node("n3"))

    const before = new Map(store.nodes.map((n) => [n.id, n]))
    store.updateNodeData("n2", { label: "只改了我" })

    const after = new Map(store.nodes.map((n) => [n.id, n]))
    // 变的那个是新对象
    expect(after.get("n2")).not.toBe(before.get("n2"))
    expect(after.get("n2")!.data.label).toBe("只改了我")
    // 没变的还是原来那个对象 —— Vue Flow 靠引用判断要不要重新同步
    expect(after.get("n1")).toBe(before.get("n1"))
    expect(after.get("n3")).toBe(before.get("n3"))
  })

  it("拖动一个节点，别的节点不重新解析", () => {
    const { store } = setup()
    store.addNode(node("n1"))
    store.addNode(node("n2"))

    const before = new Map(store.nodes.map((n) => [n.id, n]))
    store.moveNodes(new Map([["n1", { x: 500, y: 500 }]]))

    const after = new Map(store.nodes.map((n) => [n.id, n]))
    expect(after.get("n1")!.position).toEqual({ x: 500, y: 500 })
    expect(after.get("n2")).toBe(before.get("n2"))
  })

  it("远端改动同样走增量，且投影正确", () => {
    const { store, doc } = setup()
    store.addNode(node("n1"))
    store.addNode(node("n2"))

    const remote = new Y.Doc()
    sync(doc, remote)
    const before = new Map(store.nodes.map((n) => [n.id, n]))

    const data = remote.getMap<Y.Map<unknown>>("nodes").get("n1")!.get("data") as Y.Map<unknown>
    data.set("label", "远端改的")
    sync(remote, doc)

    const after = new Map(store.nodes.map((n) => [n.id, n]))
    expect(after.get("n1")!.data.label).toBe("远端改的")
    expect(after.get("n2")).toBe(before.get("n2"))
  })

  it("节点顺序跟着 Y.Map 的键顺序走，不会因为增量而乱序", () => {
    const { store } = setup()
    for (const id of ["a", "b", "c", "d"]) store.addNode(node(id))
    expect(store.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"])

    store.updateNodeData("b", { label: "改了 b" })
    expect(store.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"])

    store.removeElements(["b"], [])
    expect(store.nodes.map((n) => n.id)).toEqual(["a", "c", "d"])
  })

  it("删掉节点后，缓存里也不留残影（再加回同 id 是全新对象）", () => {
    const { store } = setup()
    store.addNode(node("n1", 10, 10))
    const first = store.nodes[0]!

    store.removeElements(["n1"], [])
    expect(store.nodes).toHaveLength(0)

    store.addNode(node("n1", 99, 99))
    expect(store.nodes[0]).not.toBe(first)
    expect(store.nodes[0]!.position).toEqual({ x: 99, y: 99 })
  })

  it("删掉端点后那条边从投影里消失，加回端点又出现", () => {
    const { store } = setup()
    store.addNode(node("n1"))
    store.addNode(node("n2"))
    store.addEdge(edge("e1", "n1", "n2"))
    expect(store.edges).toHaveLength(1)

    // 只删节点、不删边（模拟并发：别人删了节点，我这边边还在）
    store.mutate(({ nodes: map }) => map.delete("n2"))
    expect(store.edges).toHaveLength(0)

    store.mutate(({ nodes: map }) => map.set("n2", toYNode(node("n2"))))
    expect(store.edges.map((e) => e.id)).toEqual(["e1"])
  })
})
