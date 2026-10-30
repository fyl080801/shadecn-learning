import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { effectScope, nextTick, ref, type EffectScope } from "vue"
import * as THREE from "three"
import * as Y from "yjs"
import { directorObjectKey, readDirectorScene } from "@shadecn/shared/director-doc"
import { GRAPH_SCHEMA_VERSION, type FlowNodeRecord } from "@shadecn/shared/flow-graph"
import { buildNodeRecord } from "@shadecn/shared/flow-node-types"
import type { FlowDetail } from "@shadecn/shared/canvas"
import { DIRECTOR_ORIGIN, LOCAL_ORIGIN, useFlowStore } from "@/stores/flow"
import { useDirectorNode } from "@/composables/flow/useDirectorNode"
import { createDirectorProjection } from "@/components/director/directorProjection"
import { bindDirectorGizmoCommit } from "@/components/director/directorGizmoCommit"
import { useDirectorPlayback, type FrameScheduler } from "@/components/director/useDirectorPlayback"

/**
 * 导演台的数据面（docs/07 §7.6）：写入走 `DIRECTOR_ORIGIN`、导演台自己的撤销栈和画布的互不影响、
 * 播放与拖播放头不写 doc、gizmo 一次拖动只写一次、远端改动能被认出来（给高亮用）。
 *
 * 真的 store + Y.Doc；「远端」是第二个 Y.Doc，互相灌 update。
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
    graph: { schemaVersion: GRAPH_SCHEMA_VERSION, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [], meta: {} },
    userState: {}
  }
}

function record(id: string, type: string): FlowNodeRecord {
  return buildNodeRecord({ id, type, label: `节点 ${id}`, position: { x: 0, y: 0 } })
}

let scope: EffectScope | null = null

function setup() {
  const store = useFlowStore()
  store.load(detail())
  const doc = new Y.Doc()
  store.attachDoc(doc)
  store.addNode(record("dc", "director"))
  store.addNode(record("t1", "text"))
  store.separateUndo()
  scope = effectScope()
  const director = scope.run(() => useDirectorNode(store, "dc"))!
  /** 每个事务的 origin（谁写的） */
  const origins: unknown[] = []
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    if (transaction.changed.size > 0) origins.push(transaction.origin)
  })
  return { store, doc, director, origins }
}

/** 一个和 doc 双向同步的「远端」 */
function peerOf(doc: Y.Doc) {
  const peer = new Y.Doc()
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "peer") Y.applyUpdate(peer, update, "local")
  })
  peer.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "local") Y.applyUpdate(doc, update, "peer")
  })
  return peer
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  scope?.stop()
  scope = null
})

describe("导演台写入与撤销", () => {
  it("写入经 shared 的导演台 ops、事务 origin 是 DIRECTOR_ORIGIN；投影出来的场景跟着变", () => {
    const { director, origins } = setup()
    const id = director.addObject({ kind: "box", name: "桌子" })
    expect(id).toBeTruthy()
    expect(origins[origins.length - 1]).toBe(DIRECTOR_ORIGIN)
    expect(director.scene.value.objects.get(id!)?.name).toBe("桌子")
  })

  it("导演台的撤销栈只撤导演台里的改动；画布的撤销栈撤不到导演台的改动", () => {
    const { store, director } = setup()
    // 画布上一次改名（LOCAL_ORIGIN），之后在导演台里加两个对象
    store.writeNode("t1", "metadata", { set: { label: "改过的名字" } })
    store.separateUndo()
    const a = director.addObject({ kind: "box" })!
    const b = director.addObject({ kind: "sphere" })!
    expect(director.history?.canUndo.value).toBe(true)

    // 导演台里 Ctrl+Z：只撤掉最后加的那个对象，画布上的改名还在
    director.history?.undo()
    expect([...director.scene.value.objects.keys()]).toEqual([a])
    expect(store.nodeById.get("t1")?.metadata.label).toBe("改过的名字")

    // 画布的 Ctrl+Z：撤的是改名，导演台里的对象不动
    store.undo()
    expect(store.nodeById.get("t1")?.metadata.label).toBe("节点 t1")
    expect([...director.scene.value.objects.keys()]).toEqual([a])

    // 导演台重做回来
    director.history?.redo()
    expect(new Set(director.scene.value.objects.keys())).toEqual(new Set([a, b]))
  })

  it("关掉导演台（撤销栈销毁）之后，画布上的 Ctrl+Z 撤不到导演台里的改动", () => {
    const { store, director } = setup()
    const a = director.addObject({ kind: "box" })!
    scope?.stop()
    scope = null
    expect(store.canUndo).toBe(true) // 撤销栈里只有「新建节点」那两步
    store.undo()
    store.undo()
    // 撤到头：两个节点没了（这是画布自己的操作）；中途导演台的对象一直在，直到节点被撤掉
    const again = useFlowStore()
    expect(again.nodeById.has("dc")).toBe(false)
    // 重做回来，导演台的对象还在 —— 画布的撤销从没把它当成自己的
    store.redo()
    store.redo()
    expect(readDirectorScene(store.nodeById.get("dc")!.data).objects.has(a)).toBe(true)
  })

  it("别人的改动不进导演台的撤销栈；能认出是远端来的（给高亮用）", () => {
    const { doc, director } = setup()
    const peer = peerOf(doc)
    const changes: { keys: string[] | null; remote: boolean }[] = []
    director.onDataChange(({ keys, remote }) => changes.push({ keys: keys ? [...keys] : null, remote }))

    const mine = director.addObject({ kind: "box" })!
    // 远端（agent / 同伴）在同一个导演台里加一个对象
    const peerData = (peer.getMap("nodes").get("dc") as Y.Map<unknown>).get("data") as Y.Map<unknown>
    peer.transact(() => peerData.set(directorObjectKey("obj_peer"), { kind: "sphere", name: "远端的球", position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], geometry: { radius: 0.5 } }))

    expect(changes).toEqual([
      { keys: [directorObjectKey(mine)], remote: false },
      { keys: [directorObjectKey("obj_peer")], remote: true }
    ])
    expect(director.scene.value.objects.has("obj_peer")).toBe(true)
    // 撤销只撤自己的
    director.history?.undo()
    expect([...director.scene.value.objects.keys()]).toEqual(["obj_peer"])
  })

  it("操作的前提不满足（对象被别人删了）抛 FlowOpError、文档不动", () => {
    const { director, origins } = setup()
    const before = origins.length
    expect(() => director.commitTransform("obj_missing", { position: [1, 0, 0] }, 0)).toThrow()
    expect(origins.length).toBe(before)
  })
})

describe("播放不写 doc", () => {
  it("播放、拖播放头只改投影对象，不产生任何事务", async () => {
    const { director, origins } = setup()
    const id = director.addObject({ kind: "box" })!
    director.keyframeAt(id, 0)
    director.commitTransform(id, { position: [4, 0.5, 0] }, 2000)
    const before = origins.length

    const objects = new Map<string, THREE.Object3D>()
    const projection = createDirectorProjection({
      add: (object) => objects.set(object.uuid, object),
      remove: (object) => objects.delete(object.uuid),
      changed: () => {}
    })
    projection.reconcile(director.scene.value)

    // 手动推进的帧调度
    let pending: ((now: number) => void) | null = null
    const scheduler: FrameScheduler = {
      request: (callback) => {
        pending = callback
        return 1
      },
      cancel: () => {
        pending = null
      }
    }
    const seen: number[] = []
    const playbackScope = effectScope()
    const playback = playbackScope.run(() =>
      useDirectorPlayback({
        duration: ref(director.scene.value.duration),
        fps: ref(30),
        onFrame: (t) => {
          projection.applyStateAt(director.timeline.value, t)
          seen.push(projection.objectOf(id)!.position.x)
        },
        scheduler
      })
    )!
    playback.play()
    for (const now of [0, 500, 1000, 1500, 2000]) {
      const frame = pending as ((now: number) => void) | null
      frame?.(now)
      await nextTick()
    }
    playback.pause()
    playback.seek(1000)
    await nextTick()

    expect(seen[seen.length - 1]).toBeCloseTo(2, 5) // 0 → 4 线性，1 秒处在中间
    expect(Math.max(...seen)).toBeCloseTo(4, 5)
    expect(origins.length).toBe(before)
    // 存的静态值也没被播放改动
    expect(director.scene.value.objects.get(id)?.position[0]).toBe(0)
    playbackScope.stop()
  })
})

describe("gizmo 拖动", () => {
  class FakeControls extends THREE.EventDispatcher<{ mouseDown: object; mouseUp: object; objectChange: object }> {
    object: THREE.Object3D | null = null
    mode = "translate"
    getMode() {
      return this.mode
    }
  }

  function bound() {
    const ctx = setup()
    const id = ctx.director.addObject({ kind: "box" })!
    const projection = createDirectorProjection({ add: () => {}, remove: () => {}, changed: () => {} })
    projection.reconcile(ctx.director.scene.value)
    projection.applyStateAt(ctx.director.timeline.value, 0)
    const controls = new FakeControls()
    controls.object = projection.objectOf(id)
    let dragging = false
    const unbind = bindDirectorGizmoCommit(controls as never, {
      onStart: () => (dragging = true),
      onCommit: (objectId, change) => ctx.director.commitTransform(objectId, change, 1000),
      onEnd: () => (dragging = false)
    })
    return { ...ctx, id, controls, unbind, isDragging: () => dragging }
  }

  it("拖动中途不写 doc，松手只写一次（一条撤销记录）", () => {
    const { controls, origins, director, id, isDragging } = bound()
    const before = origins.length
    controls.dispatchEvent({ type: "mouseDown" })
    expect(isDragging()).toBe(true)
    for (let i = 1; i <= 10; i++) {
      controls.object!.position.x = i * 0.1
      controls.dispatchEvent({ type: "objectChange" })
    }
    expect(origins.length).toBe(before)
    controls.dispatchEvent({ type: "mouseUp" })
    expect(isDragging()).toBe(false)
    expect(origins.length).toBe(before + 1)
    expect(origins[origins.length - 1]).toBe(DIRECTOR_ORIGIN)
    expect(director.scene.value.objects.get(id)?.position[0]).toBeCloseTo(1, 9)

    // 一次撤销撤掉整次拖动
    director.history?.undo()
    expect(director.scene.value.objects.get(id)?.position[0]).toBe(0)
  })

  it("按下又松开、没动：什么都不写", () => {
    const { controls, origins } = bound()
    const before = origins.length
    controls.dispatchEvent({ type: "mouseDown" })
    controls.dispatchEvent({ type: "mouseUp" })
    expect(origins.length).toBe(before)
  })

  it("属性上有关键帧时，拖动写成播放头处的关键帧，静态值不变", () => {
    const { controls, director, id } = bound()
    director.keyframeAt(id, 0)
    const staticBefore = director.scene.value.objects.get(id)!.position
    controls.dispatchEvent({ type: "mouseDown" })
    controls.object!.position.set(3, 0.5, 0)
    controls.dispatchEvent({ type: "mouseUp" })

    const scene = director.scene.value
    expect(scene.objects.get(id)!.position).toEqual(staticBefore)
    const positionTrack = [...scene.tracks.values()].find((track) => track.objectId === id && track.property === "position")!
    const frames = [...scene.keyframes.values()].filter((kf) => kf.trackId === positionTrack.id).map((kf) => [kf.t, kf.value])
    expect(frames).toEqual(expect.arrayContaining([[1000, [3, 0.5, 0]]]))
  })

  it("画布的 origin 不受影响：导演台写入不算画布的撤销", () => {
    const { controls, store, origins } = bound()
    controls.dispatchEvent({ type: "mouseDown" })
    controls.object!.position.x = 2
    controls.dispatchEvent({ type: "mouseUp" })
    // 记账从建好两个节点之后开始：导演台里的新建、拖动都不是 LOCAL_ORIGIN
    expect(origins.length).toBeGreaterThan(0)
    expect(origins.every((origin) => origin === DIRECTOR_ORIGIN)).toBe(true)
    expect(origins).not.toContain(LOCAL_ORIGIN)
    // 画布撤销栈里只有建节点那两步
    store.undo()
    store.undo()
    expect(store.canUndo).toBe(false)
  })
})
