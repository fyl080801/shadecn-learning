import { beforeEach, describe, expect, it } from "vitest"
import { defineComponent, nextTick } from "vue"
import { mount } from "@vue/test-utils"

import {
  allowedDirectorTransformModes,
  isDirectorTransformModeAllowed,
  resetDirectorGizmoOwner
} from "@/components/director/directorGizmoOwner"
import {
  resetDirectorSelection,
  selectDirectorItem,
  type DirectorSelectionItem
} from "@/components/director/directorSelection"
import { useDirectorObjectGizmo } from "@/components/director/useDirectorObjectGizmo"

// 所有权是选区的派生量（见 directorGizmoOwner），故这里一律经选区驱动：选中一格轨迹片段
// 等同于此前的「声明 motionPath 所有权」，选回对象等同于「交还」。
const CLIP: DirectorSelectionItem = {
  kind: "clip",
  uuid: "clip-owner",
  track: "motion",
  clipId: "c1"
}
const JOINT: DirectorSelectionItem = {
  kind: "joint",
  uuid: "joint-owner",
  groupKey: null
}

// 对象自己那个变换 gizmo 的裁决点。这里验的正是它存在的理由：Viewport 在**每一次**
// objectSelected 里都会无条件 attach，故「摘一次就当摘掉了」在导演台里不成立。

/** 按优先级从高到低派发的极简 signal（与 signals 库同一语义，priority 大的先跑）。 */
class FakeSignal {
  private bindings: { fn: (...args: any[]) => void; priority: number }[] = []

  add(fn: (...args: any[]) => void, _context?: any, priority = 0): void {
    this.bindings.push({ fn, priority })
    this.bindings.sort((a, b) => b.priority - a.priority)
  }

  remove(fn: (...args: any[]) => void): void {
    this.bindings = this.bindings.filter((binding) => binding.fn !== fn)
  }

  dispatch(...args: any[]): void {
    for (const binding of [...this.bindings]) binding.fn(...args)
  }
}

function createEditor() {
  const scene = { name: "scene" }
  const camera = { name: "camera" }
  const selected: any = { name: "model" }

  const controls = {
    object: null as any,
    // 工具栏当前模式的那一份实况：Viewport 在 transformModeChanged 里 setMode，
    // 这里照做，使「切模式」在替身里也是真的改变了状态。
    mode: "translate" as string,
    attach(object: any) {
      this.object = object
    },
    detach() {
      this.object = null
    },
    // 裁决点还要在抬手时结算派生编辑（见 listenForDragEnd），故替身也得是个事件源。
    listeners: {} as Record<string, ((event?: any) => void)[]>,
    addEventListener(type: string, fn: (event?: any) => void) {
      const list = (this.listeners[type] ??= [])
      if (!list.includes(fn)) list.push(fn)
    },
    removeEventListener(type: string, fn: (event?: any) => void) {
      const list = this.listeners[type]
      const index = list?.indexOf(fn) ?? -1
      if (index >= 0) list!.splice(index, 1)
    },
    dispatchEvent(event: { type: string }) {
      for (const fn of this.listeners[event.type] ?? []) fn(event)
    }
  }

  const signals = {
    objectSelected: new FakeSignal(),
    // 选中对象自身的变化也参与裁决（换注视模式只派发这一条，见 onObjectChanged）。
    objectChanged: new FakeSignal(),
    rendererCreated: new FakeSignal(),
    cameraChanged: new FakeSignal(),
    sceneAnimated: new FakeSignal(),
    transformModeChanged: new FakeSignal()
  }

  signals.transformModeChanged.add((mode: string) => {
    controls.mode = mode
  })

  const editor: any = {
    scene,
    camera,
    viewportCamera: camera,
    selected,
    transformControls: controls,
    signals
  }

  // Viewport 的那一份：默认优先级，在每次选中变化时无条件挂上（引擎层行为，导演台不改它）。
  signals.objectSelected.add((object: any) => {
    controls.detach()
    if (object && object !== scene && object !== camera) controls.attach(object)
  })

  return editor
}

function mountHost(editor: any) {
  return mount(
    defineComponent({
      setup() {
        useDirectorObjectGizmo(editor)
        return () => null
      }
    })
  )
}

describe("对象 gizmo 的裁决", () => {
  beforeEach(() => {
    resetDirectorSelection()
    resetDirectorGizmoOwner()
  })

  it("所有权归对象时挂在选中对象上", () => {
    const editor = createEditor()
    mountHost(editor)
    expect(editor.transformControls.object).toBe(editor.selected)
  })

  it("选区换到别的调节器后收起", async () => {
    const editor = createEditor()
    mountHost(editor)

    selectDirectorItem(CLIP)
    await nextTick()
    expect(editor.transformControls.object).toBeNull()
  })

  // 这条就是「选中轨迹后再点一下模型，视口里出现两个调节器」的回归用例：Viewport 把 gizmo
  // 挂了回来，而摘它的那一方以为自己还摘着。裁决点排在 Viewport 之后，故那次挂载会被收回。
  it("Viewport 在选中变化时挂回来，也要按选区收掉", async () => {
    const editor = createEditor()
    mountHost(editor)

    selectDirectorItem(CLIP)
    await nextTick()

    editor.signals.objectSelected.dispatch(editor.selected)
    expect(editor.transformControls.object).toBeNull()
  })

  it("选区回到对象后自己挂回来", async () => {
    const editor = createEditor()
    mountHost(editor)

    selectDirectorItem(JOINT)
    await nextTick()
    selectDirectorItem({ kind: "object", uuid: "back" })
    await nextTick()
    expect(editor.transformControls.object).toBe(editor.selected)
  })

  it("没有选中对象时什么也不挂", async () => {
    const editor = createEditor()
    editor.selected = null
    mountHost(editor)
    expect(editor.transformControls.object).toBeNull()

    // 场景与编辑器相机本身不是可变换的对象（判据与 Viewport 一致）。
    editor.selected = editor.scene
    selectDirectorItem(CLIP)
    await nextTick()
    selectDirectorItem({ kind: "object", uuid: "back" })
    await nextTick()
    expect(editor.transformControls.object).toBeNull()
  })
})

// 「gizmo 挂在谁身上」除了决定手柄出不出现，还决定工具栏上哪几个按钮能按：机位没有缩放
// （镜头没有大小，取景范围由 FOV 表达）。裁决点是唯一知道 gizmo 现在挂着谁的地方，故这条
// 限制也由它发布。
describe("对象带来的工具栏模式限制", () => {
  beforeEach(() => {
    resetDirectorSelection()
    resetDirectorGizmoOwner()
  })

  it("选中普通图形时三种模式全开", () => {
    const editor = createEditor()
    mountHost(editor)
    expect(isDirectorTransformModeAllowed("scale")).toBe(true)
  })

  it("选中机位时缩放不可用，移动与旋转照常", () => {
    const editor = createEditor()
    editor.selected = { name: "机位A", isCamera: true }
    mountHost(editor)

    expect(allowedDirectorTransformModes.value).toEqual(["translate", "rotate"])
    expect(isDirectorTransformModeAllowed("scale")).toBe(false)
  })

  // 只把按钮置灰是不够的：那时视口里还挂着缩放手柄，拖它照样能把机位拉变形，而用户看到的
  // 是一个自己按不动的按钮正亮着。
  it("停在缩放上时选中机位：当场切回移动", () => {
    const editor = createEditor()
    editor.signals.transformModeChanged.dispatch("scale")
    mountHost(editor)
    expect(editor.transformControls.mode).toBe("scale")

    editor.selected = { name: "机位A", isCamera: true }
    editor.signals.objectSelected.dispatch(editor.selected)

    expect(editor.transformControls.mode).toBe("translate")
  })

  it("从机位换回普通图形，缩放重新可用（模式不自己跳回去）", () => {
    const editor = createEditor()
    const camera = { name: "机位A", isCamera: true }
    const mesh = editor.selected

    editor.signals.transformModeChanged.dispatch("scale")
    mountHost(editor)

    editor.selected = camera
    editor.signals.objectSelected.dispatch(camera)
    expect(isDirectorTransformModeAllowed("scale")).toBe(false)

    editor.selected = mesh
    editor.signals.objectSelected.dispatch(mesh)
    expect(isDirectorTransformModeAllowed("scale")).toBe(true)
    // 切回来的是「移动」这个用户看得见的状态，不擅自替用户恢复到缩放——他刚刚在机位上
    // 用的就是移动。
    expect(editor.transformControls.mode).toBe("translate")
  })

  // 所有权归别人时对象侧的限制随之解除（调节器已经不挂在这个对象上了），交还后照旧。
  it("选区在别的调节器上时对象侧的限制解除，回到对象后恢复", async () => {
    const editor = createEditor()
    editor.selected = { name: "机位A", isCamera: true }
    mountHost(editor)
    expect(allowedDirectorTransformModes.value).toEqual(["translate", "rotate"])

    selectDirectorItem({
      kind: "pathNode",
      track: "motion",
      uuid: "node-owner",
      clipId: "c1",
      index: 0
    })
    await nextTick()
    expect(isDirectorTransformModeAllowed("scale")).toBe(true)

    selectDirectorItem({ kind: "object", uuid: "back" })
    await nextTick()
    expect(allowedDirectorTransformModes.value).toEqual(["translate", "rotate"])
  })
})

// 被注视驱动的机位：那一下归装置调节器（整体平移 / 绕注视点转），故对象 gizmo 不挂。
// 判据与装置那一侧共用（resolveCameraRigMode），这里验的是「裁决点确实照它让位」。
describe("机位装置调节器出场时对象 gizmo 让位", () => {
  beforeEach(() => {
    resetDirectorSelection()
    resetDirectorGizmoOwner()
  })

  function aimedCamera(mode: string) {
    return {
      name: "机位A",
      isCamera: true,
      userData: {
        lookAt: {
          mode,
          targetUuid: null as string | null,
          target: { x: 0, y: 0, z: 0 }
        }
      }
    }
  }

  it("位置模式的机位：移动与旋转都让位", async () => {
    const editor = createEditor()
    editor.selected = aimedCamera("point")
    mountHost(editor)
    expect(editor.transformControls.object).toBeNull()

    editor.signals.transformModeChanged.dispatch("rotate")
    await nextTick()
    expect(editor.transformControls.object).toBeNull()
  })

  // 跟随模式同样两下都让位：那时的「移动」是挪机位并重新对准（装置那一侧顺带把倾斜留住），
  // 交给对象 gizmo 的话，它的旋转会把整份朝向写进只该装倾斜的 authored。
  it("跟随模式的机位：移动与旋转也都让位", async () => {
    const editor = createEditor()
    editor.selected = aimedCamera("object")
    mountHost(editor)
    expect(editor.transformControls.object).toBeNull()

    editor.signals.transformModeChanged.dispatch("rotate")
    await nextTick()
    expect(editor.transformControls.object).toBeNull()
  })

  it("手动调整的机位与普通图形一样，一直挂着", async () => {
    const editor = createEditor()
    editor.selected = aimedCamera("free")
    mountHost(editor)
    expect(editor.transformControls.object).toBe(editor.selected)

    editor.signals.transformModeChanged.dispatch("rotate")
    await nextTick()
    expect(editor.transformControls.object).toBe(editor.selected)
  })

  // 让位判据问的是 `isCameraAimed`，而它读 userData.lookAt——换注视模式**只派发
  // objectChanged**（选中态、所有权、变换模式一个都没变）。不听这条的话：给一台已经选中的
  // 机位切到「注视对象」，装置调节器出场了、对象 gizmo 却没人收回去，视口里两个位置手柄
  // 并存（用户报的正是它）。
  it("已选中的机位切到注视模式：对象 gizmo 当场让位", async () => {
    const editor = createEditor()
    const camera = aimedCamera("free")
    editor.selected = camera
    mountHost(editor)
    expect(editor.transformControls.object).toBe(camera)

    // 面板换模式走 SetCameraLookAtCommand，它派发的就是 objectChanged。
    camera.userData.lookAt = {
      mode: "object",
      targetUuid: "someone",
      target: { x: 0, y: 0, z: 0 }
    }
    editor.signals.objectChanged.dispatch(camera)
    await nextTick()

    expect(editor.transformControls.object).toBeNull()
  })

  it("切回自由调整即自己挂回来", async () => {
    const editor = createEditor()
    const camera = aimedCamera("object")
    editor.selected = camera
    mountHost(editor)
    expect(editor.transformControls.object).toBeNull()

    camera.userData.lookAt = {
      mode: "free",
      targetUuid: null,
      target: { x: 0, y: 0, z: 0 }
    }
    editor.signals.objectChanged.dispatch(camera)
    await nextTick()

    expect(editor.transformControls.object).toBe(camera)
  })

  // 别的对象每次指针移动都会派发 objectChanged（拖动一次 gizmo 就是几十发），与「谁拥有
  // 调节器」无关，故只认选中的那一个。
  it("别的对象变化不触发重裁", async () => {
    const editor = createEditor()
    const camera = aimedCamera("free")
    editor.selected = camera
    mountHost(editor)
    const other = { uuid: "other", isCamera: false, userData: {} }

    editor.transformControls.detach()
    editor.signals.objectChanged.dispatch(other)
    await nextTick()

    // 没有重裁，故仍是被我们摘掉的那个状态。
    expect(editor.transformControls.object).toBeNull()
  })
})
