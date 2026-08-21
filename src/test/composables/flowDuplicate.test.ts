import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, defineComponent, h, ref } from "vue"
import { mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import * as Y from "yjs"
import { useFlowStore } from "@/stores/flow"
import { useFlowCanvas } from "@/composables/flow/useFlowCanvas"
import type { FlowPresence } from "@/composables/flow/useFlowPresence"
import type { FlowSelection } from "@/composables/flow/useFlowSelection"
import { collectionKey, readCollection, spreadCollection } from "@/lib/flow-collection"
import { defaultNodeData, GRAPH_SCHEMA_VERSION, type FlowDetail, type FlowNode } from "@/types/flow"

/**
 * 复制节点这条路径盯的是一件事：**「平铺分键」经得起复制**。
 *
 * `duplicateNode` 走的是「投影 → structuredClone → toYNode」，也就是说副本是从
 * *读出来的* 数据重建的，而不是把 Y 结构拷一份。平铺分键的值全是普通 JSON，
 * 所以这条路无损；换成嵌套 Y 类型（或 `Y.Text`）就会在这里被悄悄压扁成
 * 普通对象/字符串 —— 副本从此失去逐键合并的能力，而且没有任何报错。
 * 见 docs/13 §3.7.1、§3.7.2。
 */

const OBJ = "dc.obj"
const TRACK = "dc.track"

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

/** presence / selection 在这条路径上没有参与，给个够用的替身即可 */
function stubPresence(): FlowPresence {
  return {
    nodePositions: computed(() => new Map()),
    setCursor: vi.fn(),
    setSelection: vi.fn(),
    setTransform: vi.fn(),
    clearTransform: vi.fn(),
    setConnecting: vi.fn()
  } as unknown as FlowPresence
}

function stubSelection(): FlowSelection {
  return {
    selectedNodeId: ref<string | null>(null),
    select: vi.fn(),
    clearSelection: vi.fn()
  } as unknown as FlowSelection
}

let wrapper: VueWrapper | null = null

/**
 * 起一个接好文档的 store + 画布。
 *
 * `useFlowCanvas` 内部会 `useVueFlow()`（要 inject/provide）并注册 watch，
 * 所以挂进一个真组件的 setup 里跑，而不是裸调 —— 裸调能跑通，但会刷一屏
 * 「inject() can only be used inside setup()」的告警。
 */
function setup() {
  const store = useFlowStore()
  store.load(detail())
  const doc = new Y.Doc()
  store.attachDoc(doc)

  let canvas!: ReturnType<typeof useFlowCanvas>
  wrapper = mount(
    defineComponent({
      setup() {
        canvas = useFlowCanvas(store, stubPresence(), stubSelection())
        return () => h("div")
      }
    })
  )
  return { store, doc, canvas }
}

/** 一个「导演台」形状的节点：一批角色 + 一批轨，全部平铺成独立的键 */
function directorNode(id: string): FlowNode {
  const objects = Array.from({ length: 15 }, (_, i) => ({
    uuid: `obj-${i}`,
    name: `角色 ${i}`,
    position: [i, 0, 0],
    poseValues: { leftElbow_bend: i, rightKnee_bend: -i }
  }))
  const tracks = Array.from({ length: 4 }, (_, i) => ({
    id: `obj-${i}:fov`,
    objectUuid: `obj-${i}`,
    property: "fov",
    keyframes: [{ time: 0, value: 50 }]
  }))

  return {
    id,
    type: "director-console",
    position: { x: 0, y: 0 },
    data: defaultNodeData("导演台", {
      ...spreadCollection(OBJ, objects, (o) => o.uuid),
      ...spreadCollection(TRACK, tracks, (t) => t.id),
      aspectRatio: "16:9"
    })
  }
}

describe("复制节点与平铺分键", () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it("42 个平铺键一个不少地进入副本", async () => {
    const { store, canvas } = setup()
    const source = directorNode("n1")
    store.addNode(source)

    const copyId = await canvas.duplicateNode("n1")
    expect(copyId).toBeTruthy()

    const copy = store.nodes.find((node) => node.id === copyId)!
    // 15 个角色 + 4 条轨 + label/status/createdAt/aspectRatio
    expect(Object.keys(source.data)).toHaveLength(23)
    expect(Object.keys(copy.data).sort()).toEqual(Object.keys(source.data).sort())
    expect(readCollection(copy.data, OBJ).size).toBe(15)
    expect(readCollection(copy.data, TRACK).size).toBe(4)
    expect(copy.type).toBe("director-console")
  })

  it("副本的每个集合元素都是深拷贝，改一个不影响另一个", async () => {
    const { store, canvas } = setup()
    store.addNode(directorNode("n1"))
    const copyId = (await canvas.duplicateNode("n1"))!

    // 只改副本里的一个角色
    store.updateNodeData(copyId, {
      [collectionKey(OBJ, "obj-3")]: { uuid: "obj-3", poseValues: { leftElbow_bend: 999 } }
    })

    const origin = store.nodes.find((node) => node.id === "n1")!
    const copy = store.nodes.find((node) => node.id === copyId)!
    const originObj = readCollection<{ poseValues: Record<string, number> }>(origin.data, OBJ)
    const copyObj = readCollection<{ poseValues: Record<string, number> }>(copy.data, OBJ)

    expect(copyObj.get("obj-3")!.poseValues.leftElbow_bend).toBe(999)
    // 浅拷贝的话两个节点会共用同一份对象，原节点会跟着变
    expect(originObj.get("obj-3")!.poseValues.leftElbow_bend).toBe(3)
    // 没碰的元素两边仍然一致
    expect(copyObj.get("obj-4")).toEqual(originObj.get("obj-4"))
  })

  it("副本里的键各自独立合并：同伴改原节点的元素，不会波及副本", async () => {
    const { store, canvas, doc } = setup()
    store.addNode(directorNode("n1"))
    const copyId = (await canvas.duplicateNode("n1"))!

    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))

    // 远端改原节点的 obj-1，本地改副本的 obj-1
    const remoteData = remote.getMap<Y.Map<unknown>>("nodes").get("n1")!.get("data") as Y.Map<unknown>
    remote.transact(() => remoteData.set(collectionKey(OBJ, "obj-1"), { uuid: "obj-1", tag: "远端" }))
    store.updateNodeData(copyId, { [collectionKey(OBJ, "obj-1")]: { uuid: "obj-1", tag: "本地" } })

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), "remote")

    const origin = store.nodes.find((node) => node.id === "n1")!
    const copy = store.nodes.find((node) => node.id === copyId)!
    expect(readCollection<{ tag: string }>(origin.data, OBJ).get("obj-1")!.tag).toBe("远端")
    expect(readCollection<{ tag: string }>(copy.data, OBJ).get("obj-1")!.tag).toBe("本地")
  })
})
