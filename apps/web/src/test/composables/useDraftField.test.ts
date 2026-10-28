import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import { useFlowStore } from "@/stores/flow"
import { useDraftField } from "@/composables/flow/useDraftField"
import { defaultNodeData, GRAPH_SCHEMA_VERSION, type FlowDetail, type FlowNode } from "@/types/flow"

/**
 * 「本地草稿 + 一次提交」的样板（docs/13 §3.7.2）。
 * 这一组盯的是三件事：编辑期间一个字都不写文档、结束时正好写一次、一次编辑正好一条撤销。
 */

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
    graph: {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      meta: {}
    },
    userState: {}
  }
}

function node(id: string, text: string): FlowNode {
  return { id, type: "text", position: { x: 0, y: 0 }, data: defaultNodeData("节点", { text }) }
}

function setup() {
  const store = useFlowStore()
  store.load(detail())
  const doc = new Y.Doc()
  store.attachDoc(doc)
  return { store, doc }
}

/** 一个盯着 store 里 `data.text` 的草稿字段 */
function textField(store: ReturnType<typeof useFlowStore>, nodeId: string) {
  const current = () => {
    const found = store.nodes.find((item) => item.id === nodeId)
    return typeof found?.data.text === "string" ? found.data.text : ""
  }
  return {
    current,
    field: useDraftField<string>({
      current,
      commit: (next) => store.updateNodeData(nodeId, { text: next }, "修改文本")
    })
  }
}

describe("useDraftField", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("编辑期间一个字都不写文档，结束时才写一次", async () => {
    const { store, doc } = setup()
    store.addNode(node("n1", "原文"))
    const { field, current } = textField(store, "n1")

    let updates = 0
    doc.on("update", () => (updates += 1))

    await field.start()
    // 模拟连续输入：草稿变了很多次
    for (const char of "一二三四五") field.draft.value += char
    expect(updates).toBe(0)
    expect(current()).toBe("原文")

    field.commit()
    expect(updates).toBe(1)
    expect(current()).toBe("原文一二三四五")
  })

  it("草稿从当前值起步；focus 等到 DOM 更新之后才调，不是同步调的", async () => {
    const { store } = setup()
    store.addNode(node("n1", "原文"))
    const focus = vi.fn()
    const field = useDraftField<string>({ current: () => "原文", commit: vi.fn(), focus })

    const started = field.start()
    // 同步这一段：编辑态已经翻过来了，但 focus 还不能调 ——
    // 输入框是 v-if 出来的，这一刻它还没进 DOM
    expect(field.editing.value).toBe(true)
    expect(field.draft.value).toBe("原文")
    expect(focus).not.toHaveBeenCalled()

    await started
    expect(focus).toHaveBeenCalledOnce()
  })

  it("blur 和回车一起触发，只提交一次", async () => {
    const { store, doc } = setup()
    store.addNode(node("n1", "原文"))
    const { field } = textField(store, "n1")

    let updates = 0
    doc.on("update", () => (updates += 1))

    await field.start()
    field.draft.value = "改过的"
    // 回车提交，紧接着输入框失焦又提交一次 —— 这是真实会发生的顺序
    field.commit()
    field.commit()

    expect(updates).toBe(1)
  })

  it("值没变就不写文档，白省一次广播和一条撤销", async () => {
    const { store, doc } = setup()
    store.addNode(node("n1", "原文"))
    const { field } = textField(store, "n1")

    let updates = 0
    doc.on("update", () => (updates += 1))

    await field.start()
    field.draft.value = "原文"
    field.commit()

    expect(updates).toBe(0)
  })

  it("normalize 返回 null = 放弃这次提交（标题被清空不是一次改名）", async () => {
    const { store, doc } = setup()
    store.addNode(node("n1", "原文"))
    const field = useDraftField<string>({
      current: () => "原文",
      normalize: (raw) => raw.trim() || null,
      commit: (next) => store.updateNodeData("n1", { text: next }, "修改文本")
    })

    let updates = 0
    doc.on("update", () => (updates += 1))

    await field.start()
    field.draft.value = "   "
    field.commit()

    expect(updates).toBe(0)
    expect(field.editing.value).toBe(false)
  })

  it("cancel 丢掉草稿，什么都不写", async () => {
    const { store, doc } = setup()
    store.addNode(node("n1", "原文"))
    const { field, current } = textField(store, "n1")

    let updates = 0
    doc.on("update", () => (updates += 1))

    await field.start()
    field.draft.value = "不想要了"
    field.cancel()

    expect(updates).toBe(0)
    expect(current()).toBe("原文")
    // 取消之后再 commit 也不该补写 —— 已经不在编辑态了
    field.commit()
    expect(updates).toBe(0)
  })

  it("一次编辑正好一条撤销：连着改两次，撤销只退回上一次", async () => {
    const { store } = setup()
    store.addNode(node("n1", "原文"))
    const { field, current } = textField(store, "n1")

    await field.start()
    field.draft.value = "第一版"
    field.commit()

    await field.start()
    field.draft.value = "第二版"
    field.commit()

    // 没有前后那两次 separateUndo 的话，两次提交会落在 UndoManager 的
    // 400ms 捕获窗口里并成一条，撤一次直接退回「原文」
    store.undo()
    expect(current()).toBe("第一版")

    store.undo()
    expect(current()).toBe("原文")
  })
})
