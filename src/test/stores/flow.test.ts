import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import {
  FLUSH_DEBOUNCE,
  FLUSH_OP_THRESHOLD,
  HISTORY_LIMIT,
  invertOps,
  useFlowStore
} from "@/stores/flow"
import { defaultNodeData, type FlowDetail, type FlowNode, type FlowOp } from "@/types/flow"

function node(id: string, x = 0, y = 0): FlowNode {
  return {
    id,
    type: "process",
    position: { x, y },
    data: defaultNodeData(`节点 ${id}`)
  }
}

function addNodeOp(id: string, x = 0, y = 0): FlowOp {
  return { type: "node.add", targetId: id, before: null, after: node(id, x, y) }
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
    ...overrides
  }
}

/** 打桩 /api/flows/:id/commit，记录每次请求体 */
function stubCommit(
  responder: (body: {
    baseRevision: number
    transactions: { id: string; kind: string; label: string; ts: number; ops: FlowOp[] }[]
  }) => { status: number; body: unknown }
) {
  const calls: {
    baseRevision: number
    transactions: { id: string; kind: string; label: string; ts: number; ops: FlowOp[] }[]
  }[] = []

  const fetchStub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as (typeof calls)[number]
    calls.push(body)
    const result = responder(body)
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" }
    })
  })

  vi.stubGlobal("fetch", fetchStub)
  return { calls, fetchStub }
}

/** 一路成功的 commit：revision 按事务条数递增 */
function stubOkCommit() {
  let revision = 0
  return stubCommit((body) => {
    revision = body.baseRevision + body.transactions.length
    return { status: 200, body: { revision } }
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe("apply —— 唯一的写入口", () => {
  it("新增节点后进入历史栈与待提交队列", () => {
    const store = useFlowStore()
    store.load(detail())

    store.apply([addNodeOp("n1")], "新增节点")

    expect(store.nodes).toHaveLength(1)
    expect(store.canUndo).toBe(true)
    expect(store.pending).toHaveLength(1)
    expect(store.saveState).toBe("dirty")
  })

  it("空操作数组不产生历史", () => {
    const store = useFlowStore()
    store.load(detail())

    store.apply([], "什么都没做")
    expect(store.canUndo).toBe(false)
    expect(store.pending).toHaveLength(0)
  })

  it("node.update 只合并 data，不整个替换节点", () => {
    const store = useFlowStore()
    store.load(detail({ graph: { ...detail().graph, nodes: [node("n1", 10, 20)] } }))

    store.apply(
      [
        {
          type: "node.update",
          targetId: "n1",
          before: { data: { label: "节点 n1" } },
          after: { data: { label: "改过的" } }
        }
      ],
      "改标题"
    )

    expect(store.nodes[0]!.data.label).toBe("改过的")
    // 没被 patch 到的字段原样保留
    expect(store.nodes[0]!.position).toEqual({ x: 10, y: 20 })
    expect(store.nodes[0]!.data.kind).toBe("process")
  })
})

describe("撤销 / 重做", () => {
  it("5 步操作后连撤 5 次回到初始，再重做 5 次完全恢复", () => {
    const store = useFlowStore()
    store.load(detail())

    for (let i = 1; i <= 5; i += 1) store.apply([addNodeOp(`n${i}`)], `新增 n${i}`)
    expect(store.nodes).toHaveLength(5)

    for (let i = 0; i < 5; i += 1) store.undo()
    expect(store.nodes).toHaveLength(0)
    expect(store.canUndo).toBe(false)

    for (let i = 0; i < 5; i += 1) store.redo()
    expect(store.nodes.map((item) => item.id)).toEqual(["n1", "n2", "n3", "n4", "n5"])
    expect(store.canRedo).toBe(false)
  })

  it("撤销之后再做新操作，重做栈被清空", () => {
    const store = useFlowStore()
    store.load(detail())

    store.apply([addNodeOp("n1")], "新增 n1")
    store.undo()
    expect(store.canRedo).toBe(true)

    store.apply([addNodeOp("n2")], "新增 n2")
    expect(store.canRedo).toBe(false)
  })

  it("撤销 / 重做各自产生一条要落库的事务，kind 分别是 undo / redo", () => {
    const store = useFlowStore()
    store.load(detail())

    store.apply([addNodeOp("n1")], "新增 n1")
    store.undo()
    store.redo()

    expect(store.pending.map((tx) => tx.kind)).toEqual(["do", "undo", "redo"])
  })

  it("空栈时撤销 / 重做是安全的空操作", () => {
    const store = useFlowStore()
    store.load(detail())

    store.undo()
    store.redo()
    expect(store.pending).toHaveLength(0)
    expect(store.nodes).toHaveLength(0)
  })

  it("invertOps 反转顺序并交换 before/after", () => {
    const ops: FlowOp[] = [
      { type: "node.add", targetId: "a", before: null, after: { id: "a" } },
      { type: "node.move", targetId: "b", before: { x: 0 }, after: { x: 1 } }
    ]

    expect(invertOps(ops)).toEqual([
      { type: "node.move", targetId: "b", before: { x: 1 }, after: { x: 0 } },
      { type: "node.remove", targetId: "a", before: { id: "a" }, after: null }
    ])
  })
})

describe("事务合并", () => {
  it("框选拖动多个节点只需一次撤销", () => {
    const store = useFlowStore()
    store.load(detail({ graph: { ...detail().graph, nodes: [node("n1"), node("n2"), node("n3")] } }))

    store.beginTransaction("移动 3 个节点")
    for (const id of ["n1", "n2", "n3"]) {
      store.apply(
        [
          {
            type: "node.move",
            targetId: id,
            before: { position: { x: 0, y: 0 } },
            after: { position: { x: 100, y: 100 } }
          }
        ],
        "移动"
      )
    }
    store.commitTransaction()

    expect(store.undoStack).toHaveLength(1)
    expect(store.undoStack[0]!.ops).toHaveLength(3)
    expect(store.nodes.every((item) => item.position.x === 100)).toBe(true)

    store.undo()
    expect(store.nodes.every((item) => item.position.x === 0)).toBe(true)
    expect(store.canUndo).toBe(false)
  })

  it("事务里一条操作都没有时不留下空历史", () => {
    const store = useFlowStore()
    store.load(detail())

    store.beginTransaction("什么也没干")
    store.commitTransaction()

    expect(store.undoStack).toHaveLength(0)
    expect(store.pending).toHaveLength(0)
  })
})

describe("历史深度上限", () => {
  it(`超过 ${HISTORY_LIMIT} 条时丢弃最旧的`, () => {
    const store = useFlowStore()
    store.load(detail())

    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
      store.apply([addNodeOp(`n${i}`)], `新增 n${i}`)
    }

    expect(store.undoStack).toHaveLength(HISTORY_LIMIT)
    // 最旧的 10 条被丢掉了，栈底是第 10 条
    expect(store.undoStack[0]!.label).toBe("新增 n10")
  })
})

describe("提交", () => {
  it("防抖窗口内的多次修改合并成一次请求", async () => {
    vi.useFakeTimers()
    const { calls, fetchStub } = stubOkCommit()

    const store = useFlowStore()
    store.load(detail())

    store.apply([addNodeOp("n1")], "新增 n1")
    store.apply([addNodeOp("n2")], "新增 n2")
    expect(fetchStub).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE)

    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(calls[0]!.transactions).toHaveLength(2)
    expect(store.saveState).toBe("saved")
    expect(store.pending).toHaveLength(0)
  })

  it("攒够阈值条操作立刻提交，不等防抖", async () => {
    vi.useFakeTimers()
    const { fetchStub } = stubOkCommit()

    const store = useFlowStore()
    store.load(detail())

    for (let i = 0; i < FLUSH_OP_THRESHOLD; i += 1) {
      store.apply([addNodeOp(`n${i}`)], `新增 n${i}`)
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it("提交成功后 baseRevision 跟上服务端", async () => {
    vi.useFakeTimers()
    stubOkCommit()

    const store = useFlowStore()
    store.load(detail())

    store.apply([addNodeOp("n1")], "新增 n1")
    store.apply([addNodeOp("n2")], "新增 n2")
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE)

    expect(store.baseRevision).toBe(2)
    expect(store.meta?.revision).toBe(2)
  })

  it("每条事务都带 UTC 毫秒时间戳，id 各不相同", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"))
    const { calls } = stubOkCommit()

    const store = useFlowStore()
    store.load(detail())

    store.apply([addNodeOp("n1")], "新增 n1")
    store.apply([addNodeOp("n2")], "新增 n2")
    store.undo()
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE)

    const sent = calls[0]!.transactions
    expect(sent).toHaveLength(3)
    for (const tx of sent) {
      expect(tx.ts).toBe(Date.parse("2026-01-02T03:04:05.000Z"))
      expect(Number.isSafeInteger(tx.ts)).toBe(true)
    }
    // 同一毫秒内产生的三条，id 不能撞（协同时两个客户端也一样）
    expect(new Set(sent.map((tx) => tx.id)).size).toBe(3)
  })

  it("lastSavedAt 先取服务端 updatedAt，提交成功后换成刚才那一刻", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"))
    stubOkCommit()

    const store = useFlowStore()
    store.load(detail({ updatedAt: "2026-01-01T00:00:00.000Z" }))
    expect(store.lastSavedAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"))

    store.apply([addNodeOp("n1")], "新增 n1")
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE)

    expect(store.lastSavedAt).toBe(Date.parse("2026-01-02T03:04:05.000Z") + FLUSH_DEBOUNCE)

    store.reset()
    expect(store.lastSavedAt).toBeNull()
  })

  it("提交的 graph 是当前全量快照", async () => {
    vi.useFakeTimers()
    const fetchBodies: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchBodies.push(String(init?.body))
        return new Response(JSON.stringify({ revision: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      })
    )

    const store = useFlowStore()
    store.load(detail())
    store.setViewport({ x: 5, y: 6, zoom: 2 })
    store.apply([addNodeOp("n1", 10, 20)], "新增 n1")
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE)

    const sent = JSON.parse(fetchBodies[0]!) as {
      graph: { nodes: { id: string }[]; viewport: { zoom: number } }
    }
    expect(sent.graph.nodes.map((item) => item.id)).toEqual(["n1"])
    expect(sent.graph.viewport).toEqual({ x: 5, y: 6, zoom: 2 })
  })

  it("409 → 进入 conflict 并停止自动提交", async () => {
    vi.useFakeTimers()
    const { fetchStub } = stubCommit(() => ({
      status: 409,
      body: { error: "该画布已在别处修改，请重新加载", reason: "conflict", revision: 7 }
    }))

    const store = useFlowStore()
    store.load(detail())

    store.apply([addNodeOp("n1")], "新增 n1")
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE)

    expect(store.saveState).toBe("conflict")
    expect(store.saveError).toContain("已在别处修改")

    // 继续编辑不会再往上推陈旧快照
    store.apply([addNodeOp("n2")], "新增 n2")
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE * 5)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it("网络失败时保留 pending，下次触发补提交成功", async () => {
    vi.useFakeTimers()
    let fail = true
    const fetchStub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (fail) throw new Error("网络不可用")
      const body = JSON.parse(String(init?.body)) as { transactions: unknown[] }
      return new Response(JSON.stringify({ revision: body.transactions.length }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    })
    vi.stubGlobal("fetch", fetchStub)

    const store = useFlowStore()
    store.load(detail())

    store.apply([addNodeOp("n1")], "新增 n1")
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE)

    expect(store.saveState).toBe("error")
    expect(store.pending).toHaveLength(1)

    // 断网期间继续编辑，操作不丢
    store.apply([addNodeOp("n2")], "新增 n2")
    expect(store.pending).toHaveLength(2)

    fail = false
    await store.saveNow()

    expect(store.saveState).toBe("saved")
    expect(store.pending).toHaveLength(0)
    expect(store.nodes).toHaveLength(2)
  })

  it("提交期间产生的新操作不会被误标为已提交", async () => {
    vi.useFakeTimers()
    const gate: { release: (() => void) | null } = { release: null }
    let blocked = true
    const fetchStub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        baseRevision: number
        transactions: unknown[]
      }
      // 只把第一次请求挂起，用来制造「提交还没回来又改了一笔」的窗口
      if (blocked) {
        blocked = false
        await new Promise<void>((resolve) => {
          gate.release = resolve
        })
      }
      return new Response(
        JSON.stringify({ revision: body.baseRevision + body.transactions.length }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    })
    vi.stubGlobal("fetch", fetchStub)

    const store = useFlowStore()
    store.load(detail())

    store.apply([addNodeOp("n1")], "新增 n1")
    const flushed = store.flush()
    await vi.advanceTimersByTimeAsync(0)

    // 请求还没回来，这时又改了一笔
    store.apply([addNodeOp("n2")], "新增 n2")

    gate.release?.()
    await flushed
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE)

    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(store.pending).toHaveLength(0)
    expect(store.saveState).toBe("saved")
  })
})

describe("load / reset", () => {
  it("load 会清空历史栈 —— 撤销不跨会话，但内容还在", () => {
    const store = useFlowStore()
    store.load(detail())
    store.apply([addNodeOp("n1")], "新增 n1")

    store.load(detail({ revision: 3, graph: { ...detail().graph, nodes: [node("a"), node("b")] } }))

    expect(store.canUndo).toBe(false)
    expect(store.canRedo).toBe(false)
    expect(store.pending).toHaveLength(0)
    expect(store.saveState).toBe("saved")
    expect(store.baseRevision).toBe(3)
    expect(store.nodes).toHaveLength(2)
  })

  it("load 出来的节点与传入对象不共享引用", () => {
    const source = detail({ graph: { ...detail().graph, nodes: [node("n1")] } })
    const store = useFlowStore()
    store.load(source)

    store.apply(
      [{ type: "node.update", targetId: "n1", before: null, after: { data: { label: "改了" } } }],
      "改名"
    )

    expect(source.graph.nodes[0]!.data.label).toBe("节点 n1")
  })

  it("reset 清干净所有状态", () => {
    const store = useFlowStore()
    store.load(detail())
    store.apply([addNodeOp("n1")], "新增 n1")

    store.reset()

    expect(store.meta).toBeNull()
    expect(store.nodes).toHaveLength(0)
    expect(store.pending).toHaveLength(0)
    expect(store.canUndo).toBe(false)
  })
})
