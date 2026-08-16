import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { FLUSH_DEBOUNCE, useFlowStore } from "@/stores/flow"
import {
  defaultNodeData,
  type FlowDetail,
  type FlowNode,
  type FlowOp,
  type FlowTransaction
} from "@/types/flow"

/**
 * 协同同步在 store 这一侧的契约（yjs 那半边在 `composables/flow/useFlowSync`）：
 *
 * - 本地每条事务都要吐给广播钩子；
 * - 远端来的事务只改内容，**不进历史、不进待提交队列** —— 落库是发起方的事；
 * - 别人提交成功后我要对齐 revision，否则我下次提交必定撞 409。
 */

function node(id: string, x = 0, y = 0): FlowNode {
  return { id, type: "process", position: { x, y }, data: defaultNodeData(`节点 ${id}`) }
}

function addNodeOp(id: string, x = 0, y = 0): FlowOp {
  return { type: "node.add", targetId: id, before: null, after: node(id, x, y) }
}

function remoteTx(label: string, ops: FlowOp[]): FlowTransaction {
  return { id: `tx-remote-${label}`, label, kind: "do", ts: 1, ops }
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
    revision: 3,
    createdById: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    graph: { schemaVersion: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [], meta: {} },
    userState: {},
    ...overrides
  }
}

describe("store 的协同同步", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("本地每条事务都会吐给广播钩子", () => {
    const store = useFlowStore()
    store.load(detail())

    const sent: FlowTransaction[] = []
    store.setSyncHooks({ onTransaction: (tx) => sent.push(tx) })

    store.apply([addNodeOp("n1")], "新增节点")
    store.undo()

    expect(sent.map((tx) => tx.kind)).toEqual(["do", "undo"])
    expect(sent[0]?.ops).toHaveLength(1)
  })

  it("没挂钩子时行为不变", () => {
    const store = useFlowStore()
    store.load(detail())

    expect(() => store.apply([addNodeOp("n1")], "新增节点")).not.toThrow()
    expect(store.nodes).toHaveLength(1)
  })

  it("远端事务改内容，但不进历史、不进待提交队列", () => {
    const store = useFlowStore()
    store.load(detail())

    store.applyRemote(remoteTx("新增节点", [addNodeOp("n1", 10, 20)]))

    expect(store.nodes.map((n) => n.id)).toEqual(["n1"])
    // 落库是发起方的责任，我这边不能也排一份
    expect(store.pending).toHaveLength(0)
    expect(store.dirty).toBe(false)
    expect(store.saveState).toBe("saved")
    // 撤销只该撤自己干的事
    expect(store.canUndo).toBe(false)
  })

  it("远端事务不会触发广播，否则两边会来回弹", () => {
    const store = useFlowStore()
    store.load(detail())

    const sent: FlowTransaction[] = []
    store.setSyncHooks({ onTransaction: (tx) => sent.push(tx) })

    store.applyRemote(remoteTx("新增节点", [addNodeOp("n1")]))

    expect(sent).toHaveLength(0)
  })

  it("同一条远端事务重放一次不会加出第二个节点", () => {
    const store = useFlowStore()
    store.load(detail())

    const tx = remoteTx("新增节点", [addNodeOp("n1")])
    store.applyRemote(tx)
    store.applyRemote(tx)

    expect(store.nodes).toHaveLength(1)
  })

  it("adoptRevision 抬高基线，落后的 revision 不理", () => {
    const store = useFlowStore()
    store.load(detail({ revision: 3 }))

    store.adoptRevision(7)
    expect(store.baseRevision).toBe(7)
    expect(store.meta?.revision).toBe(7)

    store.adoptRevision(5)
    expect(store.baseRevision).toBe(7)
  })

  it("对齐过 revision 之后，我的提交带的是新基线（不会撞 409）", async () => {
    vi.useFakeTimers()

    const bodies: { baseRevision: number }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith("/commit")) return new Response(null, { status: 204 })
        bodies.push(JSON.parse(String(init?.body)) as { baseRevision: number })
        return new Response(JSON.stringify({ revision: 9 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      })
    )

    const store = useFlowStore()
    store.load(detail({ revision: 3 }))

    // 别人先提交了，我收到内容 + 新基线
    store.applyRemote(remoteTx("新增节点", [addNodeOp("n1")]))
    store.adoptRevision(8)

    store.apply([addNodeOp("n2")], "新增节点")
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE + 10)

    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.baseRevision).toBe(8)
    expect(store.saveState).toBe("saved")
  })

  it("提交成功后把新的 revision 广播出去", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/commit")
          ? new Response(JSON.stringify({ revision: 4 }), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
          : new Response(null, { status: 204 })
      )
    )

    const store = useFlowStore()
    store.load(detail({ revision: 3 }))

    const revisions: number[] = []
    store.setSyncHooks({ onRevision: (revision) => revisions.push(revision) })

    store.apply([addNodeOp("n1")], "新增节点")
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE + 10)

    expect(revisions).toEqual([4])
  })
})
