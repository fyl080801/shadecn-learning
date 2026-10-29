import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, nextTick } from "vue"
import { mount } from "@vue/test-utils"
import * as THREE from "three"

import {
  activeDirectorSelectionKind,
  activeDirectorSelectionOf,
  clearDirectorSelection,
  clearDirectorSelectionOfKind,
  deleteActiveDirectorSelection,
  directorSelectionItems,
  directorSelectionsOf,
  extendDirectorSelection,
  isDirectorItemSelected,
  pruneDirectorSelection,
  registerDirectorSelectionDelete,
  resetDirectorSelection,
  restoreDirectorSelection,
  retargetDirectorSelection,
  selectDirectorItem,
  selectedDirectorHostUuid,
  toggleDirectorItem
} from "@/components/director/directorSelection"
import { useDirectorSelection } from "@/components/director/useDirectorSelection"

// 导演台「现在选中的是什么」的单点源。这一层是纯状态，故不必搭编辑器；与引擎
// `editor.selected` 的对账那一半在文末单独一组。

const A = "obj-a"
const B = "obj-b"

beforeEach(() => {
  resetDirectorSelection()
})

describe("选区的构成规则", () => {
  it("缺省为空，宿主与类型都是 null", () => {
    expect(directorSelectionItems.value).toEqual([])
    expect(activeDirectorSelectionKind.value).toBe(null)
    expect(selectedDirectorHostUuid.value).toBe(null)
  })

  // 跨类互斥：一个选区里不混两种东西——那样的选区回答不了「删除键删什么」。
  it("选中一项即替换整个选区（跨类互斥）", () => {
    selectDirectorItem({
      kind: "keyframe",
      uuid: A,
      property: "position",
      time: 1
    })
    expect(activeDirectorSelectionKind.value).toBe("keyframe")

    selectDirectorItem({ kind: "clip", uuid: A, track: "action", clipId: "c1" })
    expect(activeDirectorSelectionKind.value).toBe("clip")
    expect(directorSelectionItems.value).toHaveLength(1)
  })

  // 多选的位置：同类可以攒多项，UI 上第一版不开放，接口先留好。
  it("同类可多选，跨类追加即替换", () => {
    selectDirectorItem({
      kind: "keyframe",
      uuid: A,
      property: "position",
      time: 1
    })
    extendDirectorSelection({
      kind: "keyframe",
      uuid: A,
      property: "position",
      time: 2
    })
    expect(directorSelectionsOf("keyframe")).toHaveLength(2)

    // 已在选区里的项再追加不重复。
    extendDirectorSelection({
      kind: "keyframe",
      uuid: A,
      property: "position",
      time: 2
    })
    expect(directorSelectionsOf("keyframe")).toHaveLength(2)

    extendDirectorSelection({
      kind: "clip",
      uuid: A,
      track: "action",
      clipId: "c1"
    })
    expect(directorSelectionItems.value).toHaveLength(1)
    expect(activeDirectorSelectionKind.value).toBe("clip")
  })

  it("toggle 加减同一项，减到空即清空", () => {
    const frame = {
      kind: "keyframe",
      uuid: A,
      property: "position",
      time: 1
    } as const
    toggleDirectorItem(frame)
    expect(isDirectorItemSelected(frame)).toBe(true)

    toggleDirectorItem(frame)
    expect(isDirectorItemSelected(frame)).toBe(false)
    expect(directorSelectionItems.value).toEqual([])
  })

  // 逐字段判等：选中态要跨「整表替换」存活（轨道每次编辑都换成新对象），不能用引用比。
  it("判等按字段而不是引用", () => {
    selectDirectorItem({ kind: "span", uuid: A, property: "pose", from: 3 })
    expect(
      isDirectorItemSelected({
        kind: "span",
        uuid: A,
        property: "pose",
        from: 3
      })
    ).toBe(true)
    expect(
      isDirectorItemSelected({
        kind: "span",
        uuid: A,
        property: "pose",
        from: 4
      })
    ).toBe(false)
    expect(
      isDirectorItemSelected({
        kind: "span",
        uuid: B,
        property: "pose",
        from: 3
      })
    ).toBe(false)
  })

  // 路径点的祖先坐标是「哪条轴 + 哪一格 + 第几个点」三件套，**track 也要比**：机位身上
  // 站位与注视点两条轴各可以有一格轨迹，漏掉它的话「同一个下标、换了一条轴」会被判成没变
  // ——retargetDirectorSelection 据此短路，选中态就留在另一条轴的那一格上。
  it("路径点判等把轨道也算上", () => {
    const node = {
      kind: "pathNode",
      uuid: A,
      track: "motion",
      clipId: "c1",
      index: 1
    } as const
    selectDirectorItem({ ...node })
    expect(isDirectorItemSelected({ ...node })).toBe(true)
    expect(isDirectorItemSelected({ ...node, track: "aimMotion" })).toBe(false)
    expect(isDirectorItemSelected({ ...node, handle: "out" })).toBe(false)
  })

  it("按类清空只在正好选中那一类时生效", () => {
    selectDirectorItem({ kind: "clip", uuid: A, track: "motion", clipId: "c1" })
    clearDirectorSelectionOfKind("keyframe")
    expect(activeDirectorSelectionKind.value).toBe("clip")

    clearDirectorSelectionOfKind("clip")
    expect(activeDirectorSelectionKind.value).toBe(null)
  })

  it("retarget 就地改写（拖动改了时刻，选中的还是同一段）", () => {
    selectDirectorItem({
      kind: "keyframe",
      uuid: A,
      property: "position",
      time: 1
    })
    retargetDirectorSelection((item) =>
      item.kind === "keyframe" ? { ...item, time: 5 } : item
    )
    expect(activeDirectorSelectionOf("keyframe")?.time).toBe(5)
  })

  it("prune 逐项过滤（宿主被删）", () => {
    selectDirectorItem({
      kind: "keyframe",
      uuid: A,
      property: "position",
      time: 1
    })
    pruneDirectorSelection((item) => item.uuid !== A)
    expect(directorSelectionItems.value).toEqual([])
  })

  // 录制要 editor.select(null) 才摘得掉变换 gizmo，那一下会把选区整个清掉；录完得把用户
  // 正编的那样东西原样放回去，而不是只还原到对象那一层。
  it("整份恢复选区（录制前后），跨类的项丢掉", () => {
    const frame = {
      kind: "keyframe",
      uuid: A,
      property: "position",
      time: 1
    } as const
    restoreDirectorSelection([frame, { ...frame, time: 2 }])
    expect(directorSelectionItems.value).toHaveLength(2)
    expect(activeDirectorSelectionKind.value).toBe("keyframe")

    restoreDirectorSelection([frame, { kind: "object", uuid: B }])
    expect(directorSelectionItems.value).toEqual([frame])

    restoreDirectorSelection([])
    expect(directorSelectionItems.value).toEqual([])
  })
})

// 组合关系：每一项自带完整的祖先坐标，故「它属于哪一格片段/哪个对象」是**派生量**，
// 不必再存一条上下文链去和它对账。
describe("组合关系由数据派生", () => {
  it("每一项都带得出宿主对象", () => {
    selectDirectorItem({
      kind: "pathNode",
      track: "motion",
      uuid: A,
      clipId: "c1",
      index: 2
    })
    expect(selectedDirectorHostUuid.value).toBe(A)

    selectDirectorItem({ kind: "joint", uuid: B, groupKey: "leftArm" })
    expect(selectedDirectorHostUuid.value).toBe(B)
  })

  it("关节的 groupKey 为 null = 正在调关节但还没点具体哪一个", () => {
    selectDirectorItem({ kind: "joint", uuid: A, groupKey: null })
    expect(activeDirectorSelectionKind.value).toBe("joint")
    expect(activeDirectorSelectionOf("joint")?.groupKey).toBe(null)
  })
})

// 删除键的作用目标此前靠三处 document 监听的注册顺序排优先级。现在只有一处监听 + 一张表。
describe("删除动作的分派", () => {
  it("按类查表调用，注销后不再调用", () => {
    const onKeyframe = vi.fn()
    const off = registerDirectorSelectionDelete("keyframe", onKeyframe)

    selectDirectorItem({
      kind: "keyframe",
      uuid: A,
      property: "position",
      time: 1
    })
    expect(deleteActiveDirectorSelection()).toBe(true)
    expect(onKeyframe).toHaveBeenCalledTimes(1)

    off()
    expect(deleteActiveDirectorSelection()).toBe(true) // 仍然消费
    expect(onKeyframe).toHaveBeenCalledTimes(1)
  })

  // 这条是护栏本身：用户正在调注视点/关节/间补段时按删除键，绝不能穿透到宿主对象把整个
  // 模型删掉（那是这套机制最初要挡住的事故）。故「有这一类但没注册动作」= 消费掉不删。
  it("没有注册动作的子元素类：消费掉这次按键，什么也不删", () => {
    const onObject = vi.fn()
    const off = registerDirectorSelectionDelete("object", onObject)

    selectDirectorItem({ kind: "cameraTarget", uuid: A })
    expect(deleteActiveDirectorSelection()).toBe(true)
    expect(onObject).not.toHaveBeenCalled()
    // 注册表的生命周期归注册方（resetDirectorSelection 不碰它，理由见那里），故用例
    // 自己注销，不靠 beforeEach 顺手清表。
    off()
  })

  it("选区为空时不消费（调用方按自己的缺省处理）", () => {
    expect(deleteActiveDirectorSelection()).toBe(false)
  })
})

// 选区与引擎 editor.selected 的对账：两个方向都收在 useDirectorSelection 一处。
describe("与 editor.selected 的对账", () => {
  class FakeSignal {
    private fns: ((...args: any[]) => void)[] = []
    add(fn: (...args: any[]) => void) {
      this.fns.push(fn)
    }
    remove(fn: (...args: any[]) => void) {
      this.fns = this.fns.filter((current) => current !== fn)
    }
    dispatch(...args: any[]) {
      for (const fn of [...this.fns]) fn(...args)
    }
  }

  function createEditor() {
    const scene = new THREE.Scene()
    const first = new THREE.Group()
    const second = new THREE.Group()
    scene.add(first, second)

    // 视口点击那一条（规则③：点中一个对象即选区归位，见 useDirectorSelection）也挂在
    // 这个替身上；本组用例只驱动 objectSelected，故它派不派发都不影响下面的断言。
    const signals = {
      objectSelected: new FakeSignal(),
      intersectionsDetected: new FakeSignal()
    }
    const editor: any = {
      scene,
      selected: null as any,
      signals,
      objectByUuid: (uuid: string) =>
        scene.getObjectByProperty("uuid", uuid) ?? null,
      select(object: any) {
        if (editor.selected === object) return
        editor.selected = object
        signals.objectSelected.dispatch(object)
      }
    }
    return { editor, first, second }
  }

  function mountHost(editor: any) {
    return mount(
      defineComponent({
        setup() {
          useDirectorSelection(editor)
          return () => null
        }
      })
    )
  }

  it("引擎选中了别的对象 → 选区整体归位到该对象", async () => {
    const { editor, first } = createEditor()
    const wrapper = mountHost(editor)

    editor.select(first)
    await nextTick()

    expect(activeDirectorSelectionKind.value).toBe("object")
    expect(selectedDirectorHostUuid.value).toBe(first.uuid)
    wrapper.unmount()
  })

  // 「子元素是在它里面」：在时间轴上点一格片段，它所属的对象跟着选中，属性面板与视口
  // 因此对准同一个东西。
  it("选中子元素 → 宿主对象也跟着选中", async () => {
    const { editor, first } = createEditor()
    const wrapper = mountHost(editor)

    selectDirectorItem({
      kind: "clip",
      uuid: first.uuid,
      track: "action",
      clipId: "c1"
    })
    await nextTick()

    expect(editor.selected).toBe(first)
    // 而且不会被自己引起的那次 objectSelected 回声打回 'object'。
    expect(activeDirectorSelectionKind.value).toBe("clip")
    wrapper.unmount()
  })

  it("引擎换到另一个对象 → 子元素选中被顶掉", async () => {
    const { editor, first, second } = createEditor()
    const wrapper = mountHost(editor)

    selectDirectorItem({
      kind: "pathNode",
      track: "motion",
      uuid: first.uuid,
      clipId: "c1",
      index: 0
    })
    await nextTick()

    editor.select(second)
    await nextTick()

    expect(activeDirectorSelectionKind.value).toBe("object")
    expect(selectedDirectorHostUuid.value).toBe(second.uuid)
    wrapper.unmount()
  })

  // 「选区非空 ⟺ 有东西被选中」这条不变式：调节器归属正是据它派生的，断了的表现是
  // 删掉一帧之后视口里的变换 gizmo 一起消失。
  it("选区被清空而对象仍选中 → 退回对象本体", async () => {
    const { editor, first } = createEditor()
    const wrapper = mountHost(editor)

    editor.select(first)
    await nextTick()
    selectDirectorItem({
      kind: "keyframe",
      uuid: first.uuid,
      property: "position",
      time: 1
    })
    await nextTick()

    clearDirectorSelection()
    await nextTick()

    expect(activeDirectorSelectionKind.value).toBe("object")
    expect(selectedDirectorHostUuid.value).toBe(first.uuid)
    wrapper.unmount()
  })

  it("引擎取消选中 → 选区清空", async () => {
    const { editor, first } = createEditor()
    const wrapper = mountHost(editor)

    editor.select(first)
    await nextTick()
    editor.select(null)
    await nextTick()

    expect(directorSelectionItems.value).toEqual([])
    wrapper.unmount()
  })
})
