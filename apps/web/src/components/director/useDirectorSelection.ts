import { onBeforeUnmount, onMounted, watch } from "vue"

import {
  activeDirectorSelectionKind,
  clearDirectorSelection,
  directorSelectionItems,
  selectDirectorItem,
  selectedDirectorHostUuid
} from "./directorSelection"

// 选区（directorSelection）与引擎的 `editor.selected` 之间的**唯一对账点**。
//
// 两份状态并存不是重复：`editor.selected` 是对象那一层的权威存储，three-editor 完整编辑器
// 与引擎自己的 Viewport/Selector 都在用它，导演台不改引擎层（见 .claude/rules/three-editor.md
// §1）。选区是它的**细化**——同一个对象上还能再选中注视点、路径点、关节、某一帧、某一格
// 片段。故这里只做三件事：
//
//   ①**引擎选中了别的对象** → 选区整体归位到 `{kind:'object'}`。视口点选、场景面板点行、
//     代码里的 editor.select 全部走这一条，选区不必各自去接。
//   ②**选区的宿主对象变了** → 把那个对象也选中。这是「子元素是在它里面」这条规则的落地：
//     在时间轴上点一格片段，它所属的对象跟着选中，属性面板/视口因此对准同一个东西。
//   ③**用户在视口里点中了一个对象** → 选区归位到 `{kind:'object'}`，**哪怕它已经是
//     `editor.selected`**。这一条不能由 ① 覆盖：`Selector.select` 在对象没变时直接返回、
//     连 objectSelected 都不派发（见 Selector.ts），而「对象没变」恰恰是常态——②刚把宿主
//     对象选上了。缺了它的表现是：在时间轴上点一格动作，再回视口点一下这个模型，选区仍停在
//     那一格上，于是删除键删的是那一格、Ctrl+C 复制的是那一格、属性面板也还停在「动作」页，
//     而用户明明刚点了模型本身。这一条与 ① 不会打架：两者都是「归位到 object」，重复设置由
//     selectDirectorItem 的判等短路吃掉。
//
// ① 与 ② 不会打架：①判「incoming uuid 与当前宿主相同就不动」，故②引起的那次 objectSelected
// 派发不会把选区从子元素打回对象。**不要**改成加一个 isSyncing 布尔闩——判等本身就是那个
// 答案，而闩会在信号同步派发的路径上漏掉一半。
//
// 另有一条兜底：选区被清空（删掉了选中的那一帧）而对象仍选中时，退回 `{kind:'object'}`。
// 不退的话「选区非空 ⟺ 有东西被选中」这条不变式就断了，而调节器归属正是据它派生的
// ——表现是删掉一帧之后视口里的变换 gizmo 一起消失。

/**
 * 「用户选中了这个对象」——三个入口共用的**唯一**写法：视口点击（本文件的规则③）、
 * 场景面板的行、时间轴的对象行。
 *
 * **不要**再直接写 `editor.select(object)`：那只对账了引擎那一份，而选区停在子元素上时它
 * 还是个空操作（理由见上方规则③）。两份状态要一起说话，就都从这里说。
 */
export function selectDirectorObject(editor: any, object: any): void {
  if (!object) return
  selectDirectorItem({ kind: "object", uuid: object.uuid })
  // 宿主没变时上面那句不会带动引擎（watch 只在 uuid 变了时跑），而此刻引擎多半已经选着它；
  // 判等短路后这一句在两种情形下都不产生多余的信号派发。
  if (editor?.selected !== object) editor?.select(object)
}

export function useDirectorSelection(editor: any) {
  const signals = editor.signals

  function onObjectSelected(object: any) {
    if (!object) {
      clearDirectorSelection()
      return
    }
    // 同一个宿主：这次派发要么正是下面那个 watcher 引起的，要么是重复选中，选区不动
    // （否则在片段/路径点上做的选中会被自己引起的回声打回对象）。
    if (selectedDirectorHostUuid.value === object.uuid) return
    selectDirectorItem({ kind: "object", uuid: object.uuid })
  }

  /**
   * 规则③：视口里点中一个对象即选区归位。
   *
   * 优先级取**负数**，即排在 Selector（默认 0）之后——那时 `editor.selected` 已经是这次点击
   * 的最终答案，直接读它就不必再解析一遍命中（两处各解析一遍必然会分叉）。子元素叠加层的
   * 监听器都在优先级 100 上，消费掉的那些点击会 `halt()`，本监听器根本不会跑到，故「一次
   * 点击只剥一层」原样成立。
   *
   * 命中的最近一个是 `picker`（sceneHelpers 里唯一参与拾取的那类名字，见 Selector 的
   * getIntersects）时**一律不动选区**：那是路径点、注视点、关节手柄这些子元素的抓手，它们
   * 各自决定这一下是什么意思——尤其是「已选中关节时又点了另一颗关节手柄」那条放行路径
   * （见 useCharacterJointControls），归位会把 pointerdown 刚选中的关节当场打回对象。
   */
  function onIntersectionsDetected(intersects: any[]) {
    const nearest = intersects?.[0]?.object
    if (!nearest || nearest.name === "picker") return
    const object = editor.selected
    if (!object || object === editor.scene) return
    selectDirectorItem({ kind: "object", uuid: object.uuid })
  }

  const stopHost = watch(selectedDirectorHostUuid, (uuid) => {
    if (uuid === null) return
    if (editor.selected?.uuid === uuid) return
    const object = editor.objectByUuid(uuid)
    if (object) editor.select(object)
  })

  const stopEmpty = watch(directorSelectionItems, (current) => {
    if (current.length > 0) return
    const object = editor.selected
    if (object && object !== editor.scene) {
      selectDirectorItem({ kind: "object", uuid: object.uuid })
    }
  })

  onMounted(() => {
    signals.objectSelected.add(onObjectSelected)
    signals.intersectionsDetected.add(onIntersectionsDetected, null, -100)
    // 组件挂载晚于场景恢复时补一次：那时 editor.selected 可能已经有值。
    if (editor.selected && activeDirectorSelectionKind.value === null) {
      selectDirectorItem({ kind: "object", uuid: editor.selected.uuid })
    }
  })

  onBeforeUnmount(() => {
    stopHost()
    stopEmpty()
    signals.objectSelected.remove(onObjectSelected)
    signals.intersectionsDetected.remove(onIntersectionsDetected)
  })
}
