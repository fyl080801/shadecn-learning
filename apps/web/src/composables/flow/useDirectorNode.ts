import { computed, onScopeDispose, type ComputedRef } from "vue"
import { readDirectorScene, radToDeg, type DirectorScene, type Vec3 } from "@shadecn/shared/director-doc"
import {
  animatedProperties,
  compileDirectorTimeline,
  objectStateAt,
  type DirectorTimeline
} from "@shadecn/shared/director-eval"
import * as ops from "@shadecn/shared/flow-ops"
import type {
  DirectorDeleteInput,
  DirectorObjectInput,
  DirectorSettingsInput,
  DirectorWriteResult,
  FlowOpContext
} from "@shadecn/shared/flow-ops"
import type { NodeDataChange, NodeHistory, useFlowStore } from "@/stores/flow"

/** 导演台写入要用到的那部分 store（测试可以给真 store） */
type DirectorStore = Pick<
  ReturnType<typeof useFlowStore>,
  "nodeById" | "mutateDirector" | "createNodeHistory" | "onNodeDataChange"
>

/** gizmo 松手时提交的变换：存储单位（米、弧度） */
export interface DirectorTransformCommit {
  position?: Vec3
  rotation?: Vec3
  scale?: Vec3
}

/** gizmo 提交的结果：哪些属性写成了播放头处的关键帧（而不是静态值） */
export interface DirectorTransformOutcome {
  keyframed: ("position" | "rotation" | "scale")[]
}

const MS_PER_SECOND = 1000
const toSeconds = (ms: number) => ms / MS_PER_SECOND
const degrees = (v: Readonly<Vec3>): Vec3 => [radToDeg(v[0]), radToDeg(v[1]), radToDeg(v[2])]

/**
 * 一个导演台节点的数据面（docs/07 §7.2、§7.6）：从 store 的投影里读场景、编译时间线，
 * 写一律经 `store.mutateDirector`（`DIRECTOR_ORIGIN`）调 shared 的导演台 ops —— 编辑器和 agent 只有这一套写入词汇。
 *
 * 建的时候为这个节点开一份自己的撤销栈（只跟踪 `DIRECTOR_ORIGIN`），所在的 effect scope 结束时销毁。
 *
 * 写操作失败（`FlowOpError`：参数不合法、对象被别人删了、超上限）**原样抛出**，文档没被改动；
 * 按钮的点击经 `useAsyncAction` 会把原因 toast 出来，gizmo 那条路由调用方接住。
 */
export function useDirectorNode(store: DirectorStore, nodeId: string) {
  const node = computed(() => store.nodeById.get(nodeId) ?? null)
  /** 节点 `data` 换了对象才重读（store 的投影对没变的节点保持引用） */
  const scene: ComputedRef<DirectorScene> = computed(() => readDirectorScene(node.value?.data ?? {}))
  /** 数据变了重编；逐帧求值都用这一份 */
  const timeline: ComputedRef<DirectorTimeline> = computed(() => compileDirectorTimeline(scene.value))

  const history: NodeHistory | null = store.createNodeHistory(nodeId)
  onScopeDispose(() => history?.destroy())

  function write<T>(label: string, change: (ctx: FlowOpContext) => T): T | undefined {
    // 每次写都是一条独立的撤销记录（同画布：语义上独立的操作之间 separateUndo）
    history?.separate()
    const result = store.mutateDirector(change, label)
    history?.separate()
    return result
  }

  function addObject(input: DirectorObjectInput): string | null {
    const result = write("导演台：新建对象", (ctx) => ops.addDirectorObjects(ctx, nodeId, [input]))
    return result?.objects[0]?.id ?? null
  }

  function deleteElements(input: DirectorDeleteInput): DirectorWriteResult | undefined {
    return write("导演台：删除", (ctx) => ops.deleteDirectorElements(ctx, nodeId, input))
  }

  function setSettings(input: DirectorSettingsInput): DirectorWriteResult | undefined {
    return write("导演台：设置", (ctx) => ops.setDirectorSettings(ctx, nodeId, input))
  }

  /**
   * gizmo 松手：把这一次拖动提交成**一个**事务（一条撤销记录）。
   *
   * 属性上有关键帧时，静态值播放时看不见（会被轨道覆盖），所以这一项写成**播放头处的关键帧**（同一时刻已有帧就覆盖）；
   * 没有关键帧的属性写静态值。结果里列出哪些写成了关键帧，界面据此给一句提示。
   */
  function commitTransform(objectId: string, change: DirectorTransformCommit, atMs: number): DirectorTransformOutcome {
    const animated = new Set(animatedProperties(timeline.value, objectId))
    const keyframed: DirectorTransformOutcome["keyframed"] = []
    const staticSet: { position?: Vec3; rotation?: Vec3; scale?: Vec3 } = {}
    const keyframes: { property: "position" | "rotation" | "scale"; value: Vec3 }[] = []
    for (const property of ["position", "rotation", "scale"] as const) {
      const value = change[property]
      if (!value) continue
      // 模型面向的单位：米、度
      const outward = property === "rotation" ? degrees(value) : ([...value] as Vec3)
      if (animated.has(property)) {
        keyframes.push({ property, value: outward })
        keyframed.push(property)
      } else {
        staticSet[property] = outward
      }
    }
    if (keyframes.length === 0 && Object.keys(staticSet).length === 0) return { keyframed }
    write("导演台：变换", (ctx) => {
      if (Object.keys(staticSet).length > 0) ops.transformDirectorObjects(ctx, nodeId, [{ id: objectId, set: staticSet }])
      for (const { property, value } of keyframes) {
        ops.setDirectorKeyframes(ctx, nodeId, { objectId, property, keyframes: [{ t: toSeconds(atMs), value }] })
      }
    })
    return { keyframed }
  }

  /**
   * 在播放头处给对象打关键帧：位置、旋转、缩放（机位再加 fov），值取**这一时刻求出来的状态**（看到的就是记下的）。
   * 一个事务、一条撤销记录。
   */
  function keyframeAt(objectId: string, atMs: number): boolean {
    const state = objectStateAt(timeline.value, objectId, atMs)
    if (!state) return false
    const t = toSeconds(atMs)
    write("导演台：打关键帧", (ctx) => {
      ops.setDirectorKeyframes(ctx, nodeId, { objectId, property: "position", keyframes: [{ t, value: state.position }] })
      ops.setDirectorKeyframes(ctx, nodeId, { objectId, property: "rotation", keyframes: [{ t, value: degrees(state.rotation) }] })
      ops.setDirectorKeyframes(ctx, nodeId, { objectId, property: "scale", keyframes: [{ t, value: state.scale }] })
      if (state.fov !== undefined) {
        ops.setDirectorKeyframes(ctx, nodeId, { objectId, property: "fov", keyframes: [{ t, value: state.fov }] })
      }
    })
    return true
  }

  /** 订这个节点 `data` 的变化（是不是远端来的）—— 只给界面反馈用 */
  function onDataChange(listener: (change: NodeDataChange) => void): () => void {
    const stop = store.onNodeDataChange(nodeId, listener)
    onScopeDispose(stop)
    return stop
  }

  return {
    nodeId,
    node,
    scene,
    timeline,
    history,
    addObject,
    deleteElements,
    setSettings,
    commitTransform,
    keyframeAt,
    onDataChange
  }
}

export type DirectorNodeHandle = ReturnType<typeof useDirectorNode>
