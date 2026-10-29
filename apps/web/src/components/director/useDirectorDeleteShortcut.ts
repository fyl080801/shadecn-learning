import { onBeforeUnmount, onMounted } from "vue"

import { RemoveObjectCommand } from "@/components/three-editor/commands/RemoveObjectCommand"
import {
  deleteActiveDirectorSelection,
  registerDirectorSelectionDelete
} from "./directorSelection"

/**
 * 事件落在可编辑的文本控件里吗——落在里面时全部快捷键让路（那儿的删除/复制是在编辑文本）。
 *
 * 导出供 useDirectorCopyShortcut 共用：两处判据必须一致，各写一份的表现是「删除键在时长
 * 输入框里让路、复制键不让」这类只在其中一处修好的分叉。
 */
export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA"
}

// 导演台里 Delete/Backspace 的**唯一**监听。删什么由选区的 activeKind 决定：各方在自己挂载
// 时经 `registerDirectorSelectionDelete` 注册自己那一类的动作（关键帧/片段/连线段在
// DirectorTimeline、路径点在 useDirectorMotionPath、对象本体在本文件），按下时查表分派。
//
// 此前是**三处** document 监听按注册顺序排优先级（关键帧 > 路径点 > 场景对象），靠
// 「Vue 里子组件的 onMounted 先于父组件」外加 stopImmediatePropagation 兜另一半——注释里
// 就是这么写的，而那是个会被任何一次组件树调整悄悄推翻的前提。改成查表之后，优先级不再是
// 一个需要维护的东西：选区里同时只有一类，问它即可。
//
// 一条比原先更强的护栏在注册表那边（见 deleteActiveDirectorSelection）：**没有注册动作的
// 子元素类一律「消费掉但什么也不删」**。用户正在调机位注视点、关节、间补段时按下删除键，
// 绝不会穿透到宿主对象把整个模型删掉——那正是这套机制最初要挡住的那个事故。
//
// 厂商的 Delete/Backspace 处理在 SidebarSettings.vue，导演台不挂载它，故这一处是全部。
// 删除对象走 RemoveObjectCommand（而非 editor.removeObject）以保留撤销，并复用
// DirectorScenePanel 已监听的 sceneGraphChanged 让左侧列表自动同步。
export function useDirectorDeleteShortcut(editor: any) {
  let unregister: (() => void) | null = null

  function deleteSelectedObject() {
    const object = editor.selected
    if (!object || object.parent === null) return
    editor.execute(new RemoveObjectCommand(editor, object))
  }

  function onKeydown(event: KeyboardEvent) {
    const key = event.key.toLowerCase()
    if (key !== "delete" && key !== "backspace") return
    if (isEditableTarget(event.target)) return

    // 分派返回「这次按键有没有被选区消费掉」。
    //
    // 选区为空时退回引擎的 `editor.selected`：这不是「两份状态各判各的」那类分叉——选区为空
    // 恰恰意味着没有更细的东西被选中，删对象本体就是唯一正确的答案。留这条兜底是为了让删除
    // 键不依赖 `useDirectorSelection` 有没有挂上（对账那一侧只负责让两份状态一致，删除键的
    // 可用性不该建立在它之上）。
    if (!deleteActiveDirectorSelection()) {
      if (!editor.selected) return
      deleteSelectedObject()
    }

    if (key === "backspace") event.preventDefault() // 阻止浏览器后退
  }

  onMounted(() => {
    unregister = registerDirectorSelectionDelete("object", deleteSelectedObject)
    document.addEventListener("keydown", onKeydown)
  })

  onBeforeUnmount(() => {
    unregister?.()
    unregister = null
    document.removeEventListener("keydown", onKeydown)
  })
}
