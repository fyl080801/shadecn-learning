import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { defineComponent, nextTick } from "vue"
import { mount } from "@vue/test-utils"

import {
  activeDirectorSelectionKind,
  activeDirectorSelectionOf,
  resetDirectorSelection,
  selectDirectorItem
} from "@/components/director/directorSelection"
import {
  selectDirectorObject,
  useDirectorSelection
} from "@/components/director/useDirectorSelection"

// 选区与引擎 `editor.selected` 的对账（见 useDirectorSelection 的文件头三条规则）。
//
// 本组用例钉的是规则③——**「点中一个对象」必须让选区归位**。它容易被读成多余的：
// 「不是已经有 objectSelected 那条了吗？」不是：`Selector.select` 在对象没变时直接返回、
// 连信号都不派发，而「对象没变」恰恰是常态——在时间轴上点一格片段时，规则②已经把宿主对象
// 选上了。缺了③，用户点了模型、选区还停在那一格上，删除键删的是那一格、Ctrl+C 复制的也是
// 那一格。

/** 按优先级从高到低派发的极简 signal（priority 大的先跑，halt 停掉后面的）。 */
class FakeSignal {
  private bindings: { fn: (...args: any[]) => void; priority: number }[] = []
  private halted = false

  add(fn: (...args: any[]) => void, _context?: any, priority = 0): void {
    this.bindings.push({ fn, priority })
    this.bindings.sort((a, b) => b.priority - a.priority)
  }

  remove(fn: (...args: any[]) => void): void {
    this.bindings = this.bindings.filter((binding) => binding.fn !== fn)
  }

  halt(): void {
    this.halted = true
  }

  dispatch(...args: any[]): void {
    this.halted = false
    for (const binding of [...this.bindings]) {
      if (this.halted) return
      binding.fn(...args)
    }
  }
}

function createEditor() {
  const scene: any = { name: "scene" }
  const objects = new Map<string, any>()
  const signals = {
    objectSelected: new FakeSignal(),
    intersectionsDetected: new FakeSignal()
  }

  const editor: any = {
    scene,
    selected: null as any,
    signals,
    objectByUuid: (uuid: string) => objects.get(uuid) ?? null,
    // 与 Selector.select 同构：**对象没变就直接返回，连信号都不派发**——规则③存在的理由。
    select(object: any) {
      if (this.selected === object) return
      this.selected = object
      signals.objectSelected.dispatch(object)
    },
    register(object: any) {
      objects.set(object.uuid, object)
      return object
    }
  }
  return editor
}

/** 视口点击：Selector 在优先级 0 上按最近命中选中对象，本 composable 排在它之后。 */
function attachSelector(editor: any) {
  editor.signals.intersectionsDetected.add(
    (intersects: any[]) => {
      const nearest = intersects[0]?.object
      // 命中的是 picker 时 Selector 会解析回它的宿主对象（这里的替身直接给宿主）。
      editor.select(nearest ? (nearest.userData?.object ?? nearest) : null)
    },
    null,
    0
  )
}

let wrapper: ReturnType<typeof mount> | null = null

/**
 * 挂载对账 composable。**每条用例结束必须卸载**（见下方 afterEach）：它的 watcher 盯的是
 * 模块级选区，留着的话上一条用例的实例会继续对账它自己那个 editor——表现是后面的用例莫名
 * 其妙地失败（选区被那个陈旧实例的兜底规则改写）。
 */
function mountSelection(editor: any) {
  wrapper = mount(
    defineComponent({
      setup() {
        useDirectorSelection(editor)
        return () => null
      }
    })
  )
  return wrapper
}

const CHARACTER = { uuid: "char-1", name: "角色1" }

describe("选区与 editor.selected 的对账", () => {
  beforeEach(() => {
    resetDirectorSelection()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it("规则②：在时间轴上点一格片段，宿主对象跟着被选中", async () => {
    const editor = createEditor()
    editor.register(CHARACTER)
    mountSelection(editor)

    selectDirectorItem({
      kind: "clip",
      uuid: CHARACTER.uuid,
      track: "action",
      clipId: "c1"
    })
    await nextTick()

    expect(editor.selected).toBe(CHARACTER)
    // 宿主被选中这件事**不能**把选区从片段打回对象（否则在轴上根本选不中一格）。
    expect(activeDirectorSelectionKind.value).toBe("clip")
  })

  it("规则③：选着一格片段时再在视口里点中这个对象，选区归位到对象本体", async () => {
    const editor = createEditor()
    editor.register(CHARACTER)
    attachSelector(editor)
    mountSelection(editor)

    selectDirectorItem({
      kind: "clip",
      uuid: CHARACTER.uuid,
      track: "action",
      clipId: "c1"
    })
    await nextTick()
    expect(editor.selected).toBe(CHARACTER)

    // 这一下 Selector 什么也不会做（对象没变、不派发 objectSelected）——规则③是唯一的出路。
    editor.signals.intersectionsDetected.dispatch([{ object: CHARACTER }])

    expect(activeDirectorSelectionKind.value).toBe("object")
    expect(activeDirectorSelectionOf("object")?.uuid).toBe(CHARACTER.uuid)
  })

  it("规则③对关键帧、连线段一视同仁", async () => {
    const editor = createEditor()
    editor.register(CHARACTER)
    attachSelector(editor)
    mountSelection(editor)

    for (const item of [
      { kind: "keyframe", uuid: CHARACTER.uuid, property: "position", time: 1 },
      { kind: "span", uuid: CHARACTER.uuid, property: "position", from: 1 }
    ] as const) {
      selectDirectorItem(item as any)
      await nextTick()
      editor.signals.intersectionsDetected.dispatch([{ object: CHARACTER }])
      expect(activeDirectorSelectionKind.value).toBe("object")
    }
  })

  it("点中的是子元素的抓手（picker）时不归位——那一层自己说了算", async () => {
    const editor = createEditor()
    editor.register(CHARACTER)
    attachSelector(editor)
    mountSelection(editor)

    selectDirectorItem({
      kind: "joint",
      uuid: CHARACTER.uuid,
      groupKey: "leftArm"
    })
    await nextTick()

    // 关节手柄是 sceneHelpers 里名为 picker 的小球，Selector 会把它解析回角色本身。
    editor.signals.intersectionsDetected.dispatch([
      {
        object: {
          name: "picker",
          userData: { object: CHARACTER, jointGroupKey: "leftArm" }
        }
      }
    ])

    expect(activeDirectorSelectionKind.value).toBe("joint")
  })

  it("子元素叠加层 halt 掉这次点击时（一次点击只剥一层）选区不动", async () => {
    const editor = createEditor()
    editor.register(CHARACTER)
    attachSelector(editor)
    mountSelection(editor)
    // 叠加层在优先级 100 上消费掉这次点击（如「已选中路径点 → 本次只退回上一层」）。
    editor.signals.intersectionsDetected.add(
      () => editor.signals.intersectionsDetected.halt(),
      null,
      100
    )

    selectDirectorItem({
      kind: "pathNode",
      uuid: CHARACTER.uuid,
      track: "motion",
      clipId: "c1",
      index: 0
    })
    await nextTick()
    editor.signals.intersectionsDetected.dispatch([{ object: CHARACTER }])

    expect(activeDirectorSelectionKind.value).toBe("pathNode")
  })

  it("点空白处：取消选中，选区一并清空", async () => {
    const editor = createEditor()
    editor.register(CHARACTER)
    attachSelector(editor)
    mountSelection(editor)

    selectDirectorItem({ kind: "object", uuid: CHARACTER.uuid })
    await nextTick()
    editor.signals.intersectionsDetected.dispatch([])

    expect(editor.selected).toBeNull()
    expect(activeDirectorSelectionKind.value).toBeNull()
  })

  it("selectDirectorObject：面板/时间轴那两个入口在对象已选中时同样归位", async () => {
    const editor = createEditor()
    editor.register(CHARACTER)
    mountSelection(editor)

    selectDirectorItem({
      kind: "clip",
      uuid: CHARACTER.uuid,
      track: "action",
      clipId: "c1"
    })
    await nextTick()

    selectDirectorObject(editor, CHARACTER)

    expect(activeDirectorSelectionKind.value).toBe("object")
    expect(editor.selected).toBe(CHARACTER)
  })
})
