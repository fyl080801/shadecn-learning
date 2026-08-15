import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { createPinia, setActivePinia } from "pinia"
import {
  FLOW_COMMANDS,
  applyOps,
  getFlowCommand,
  invertOps,
  registerFlowCommand,
  registeredFlowCommandTypes,
  useFlowStore,
  type FlowCommand,
  type FlowCommandContext
} from "@/stores/flow"
import { defaultNodeData, type FlowEdge, type FlowNode, type FlowOp } from "@/types/flow"

/**
 * 命令注册表是「加操作类型」的扩展点：
 * 新写一个命令文件 + 往清单里加一行，不用回来改 store。
 */

function context(nodes: FlowNode[] = [], edges: FlowEdge[] = []): FlowCommandContext {
  return {
    nodes: ref(nodes),
    edges: ref(edges),
    graphMeta: ref<Record<string, unknown>>({})
  }
}

function node(id: string, x = 0, y = 0): FlowNode {
  return { id, type: "process", position: { x, y }, data: defaultNodeData(`节点 ${id}`) }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe("注册表", () => {
  it("内置的九种操作全部注册到位", () => {
    expect(registeredFlowCommandTypes().sort()).toEqual(
      [
        "edge.add",
        "edge.remove",
        "edge.update",
        "graph.meta",
        "node.add",
        "node.move",
        "node.remove",
        "node.resize",
        "node.update"
      ].sort()
    )
    expect(FLOW_COMMANDS).toHaveLength(9)
  })

  it("每条命令声明的逆操作互相对得上", () => {
    for (const command of FLOW_COMMANDS) {
      const back = getFlowCommand(command.inverse)
      expect(back, `${command.type} 的逆操作 ${command.inverse} 没注册`).toBeDefined()
      // 逆操作的逆操作必须是自己，否则撤销再重做会走偏
      expect(back!.inverse).toBe(command.type)
    }
  })

  it("重复注册同一个 type 直接报错", () => {
    const fake: FlowCommand = {
      type: "node.add",
      inverse: "node.remove",
      name: "冒牌新增节点",
      apply: () => {}
    }
    expect(() => registerFlowCommand(fake)).toThrow(/重复注册/)
  })

  it("重复注册同一个对象是幂等的（模块被求值两次也不炸）", () => {
    const command = getFlowCommand("node.add")!
    expect(() => registerFlowCommand(command)).not.toThrow()
  })

  it("未注册的操作类型只告警不抛，画布状态保持不变", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const ctx = context([node("n1")])

    applyOps(ctx, [
      { type: "node.explode" as FlowOp["type"], targetId: "n1", before: null, after: null }
    ])

    expect(warn).toHaveBeenCalledOnce()
    expect(ctx.nodes.value).toHaveLength(1)
  })

  it("invertOps 用注册表里声明的逆类型，未知类型原样保留", () => {
    const ops: FlowOp[] = [
      { type: "edge.add", targetId: "e1", before: null, after: { id: "e1" } },
      { type: "unknown.op" as FlowOp["type"], targetId: "x", before: 1, after: 2 }
    ]

    expect(invertOps(ops)).toEqual([
      { type: "unknown.op", targetId: "x", before: 2, after: 1 },
      { type: "edge.remove", targetId: "e1", before: { id: "e1" }, after: null }
    ])
  })
})

describe("命令的具体行为", () => {
  it("node.add 重复应用不会加出第二个", () => {
    const ctx = context()
    const op: FlowOp = { type: "node.add", targetId: "n1", before: null, after: node("n1") }

    applyOps(ctx, [op, op])
    expect(ctx.nodes.value).toHaveLength(1)
  })

  it("node.add 存进去的是副本，改原对象不影响画布", () => {
    const source = node("n1")
    const ctx = context()

    applyOps(ctx, [{ type: "node.add", targetId: "n1", before: null, after: source }])
    source.data.label = "被外部改了"

    expect(ctx.nodes.value[0]!.data.label).toBe("节点 n1")
  })

  it("node.update 合并 data，不整个替换", () => {
    const ctx = context([node("n1", 10, 20)])

    applyOps(ctx, [
      { type: "node.update", targetId: "n1", before: null, after: { data: { label: "改过的" } } }
    ])

    expect(ctx.nodes.value[0]!.data.label).toBe("改过的")
    expect(ctx.nodes.value[0]!.data.kind).toBe("process")
    expect(ctx.nodes.value[0]!.position).toEqual({ x: 10, y: 20 })
  })

  it("改节点会换掉数组引用 —— Vue Flow 靠引用变化重渲染", () => {
    const ctx = context([node("n1")])
    const before = ctx.nodes.value

    applyOps(ctx, [
      { type: "node.move", targetId: "n1", before: null, after: { position: { x: 5, y: 5 } } }
    ])

    expect(ctx.nodes.value).not.toBe(before)
  })

  it("目标不存在时打补丁是安全的空操作", () => {
    const ctx = context([node("n1")])

    applyOps(ctx, [
      { type: "node.update", targetId: "不存在", before: null, after: { data: { label: "x" } } },
      { type: "edge.update", targetId: "不存在", before: null, after: { label: "x" } }
    ])

    expect(ctx.nodes.value[0]!.data.label).toBe("节点 n1")
  })

  it("graph.meta 是整体替换，好让「删掉一个键」能表达", () => {
    const ctx = context()
    ctx.graphMeta.value = { a: 1, b: 2 }

    applyOps(ctx, [{ type: "graph.meta", targetId: "graph", before: null, after: { a: 9 } }])

    expect(ctx.graphMeta.value).toEqual({ a: 9 })
  })

  it("删除节点不代劳删边 —— 边要由同一事务里的 edge.remove 负责", () => {
    const ctx = context(
      [node("n1"), node("n2")],
      [{ id: "e1", source: "n1", target: "n2", data: { config: {} } }]
    )

    applyOps(ctx, [{ type: "node.remove", targetId: "n1", before: null, after: null }])

    expect(ctx.nodes.value).toHaveLength(1)
    expect(ctx.edges.value).toHaveLength(1)
  })
})

describe("自定义命令接进 store", () => {
  it("注册一条新命令后，apply / undo 立刻能用，不用改 store", () => {
    /** 假想的业务操作：给节点打标记，自逆 */
    const NodeFlagCommand: FlowCommand = {
      type: "node.flag" as FlowOp["type"],
      inverse: "node.flag" as FlowOp["type"],
      name: "标记节点",
      apply(ctx, op) {
        const index = ctx.nodes.value.findIndex((item) => item.id === op.targetId)
        if (index === -1) return
        const current = ctx.nodes.value[index]!
        const patch = op.after as { flagged: boolean } | null
        ctx.nodes.value = ctx.nodes.value.map((item, i) =>
          i === index
            ? { ...current, data: { ...current.data, ui: { flagged: patch?.flagged ?? false } } }
            : item
        )
      }
    }
    registerFlowCommand(NodeFlagCommand)

    const store = useFlowStore()
    store.load({
      id: "flow-1",
      projectId: "p1",
      name: "画布",
      description: null,
      status: "draft",
      tags: [],
      thumbnail: null,
      nodeCount: 1,
      edgeCount: 0,
      revision: 0,
      createdById: "u1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      graph: {
        schemaVersion: 1,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [node("n1")],
        edges: [],
        meta: {}
      },
      userState: {}
    })

    store.apply(
      [
        {
          type: "node.flag" as FlowOp["type"],
          targetId: "n1",
          before: { flagged: false },
          after: { flagged: true }
        }
      ],
      "标记节点"
    )
    expect(store.nodes[0]!.data.ui).toEqual({ flagged: true })

    store.undo()
    expect(store.nodes[0]!.data.ui).toEqual({ flagged: false })
  })
})
