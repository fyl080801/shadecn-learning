<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue"
import { useEventListener } from "@vueuse/core"

import { directorShortcutOf } from "@/components/director/directorShortcuts"
import { DIRECTOR_OPEN_EVENT } from "@/components/flow/director"
import FlowDirectorWorkspace from "@/components/flow/FlowDirectorWorkspace.vue"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { isEditableTarget } from "@/composables/flow/editable"
import { suspendCanvasShortcuts } from "@/composables/flow/shortcut-layer"

/**
 * 全屏导演台：接住导演台节点发的 `director:open`，整屏盖一层导演台（`FlowDirectorWorkspace`），右上角关闭。
 *
 * 层级：
 * - **关着就不挂**（`v-if`），画布上一个元素都不多，不挡任何操作；
 * - 开着时 teleport 到 body、`fixed inset-0 z-40`：脱离 Vue Flow 的变换层（不跟着画布缩放、不被节点压住），
 *   指针 / 滚轮只落在导演台上；低于对话框、toast 的 z-50，连接被终结的对话框照样能盖住它。
 *
 * **键盘**（docs/07 §2.1、§7.6）：
 * - 开着时登记 `suspendCanvasShortcuts()`：画布的快捷键（`useFlowShortcuts`）**一律**让路 —— 在 3D 里按 Delete / Ctrl+Z
 *   不会删掉、撤销画布上的东西。**不截断按键的传播**：在 window 捕获阶段截，全屏层里的输入框就收不到 keydown
 *   （对话面板的回车发送就是这么坏的）；在 document 上截，reka-ui 挂在 window 上的 Esc（关下拉菜单）也一起坏了；
 * - 导演台自己的快捷键在 document 的冒泡阶段接（目标元素自己的处理已经跑完）；
 * - 焦点在输入框里（`isEditableTarget`）时不触发导演台快捷键 —— 那里的 Delete / Ctrl+Z / 空格是在编辑文字；
 * - 别的按键交给导演台（`directorShortcutOf`：Delete、撤销 / 重做、空格播放）。
 *
 * **Esc**：在输入框里 = 让输入框失焦（不关，里面的字不丢；再按一次才关）；在下拉菜单 / 对话框里 = 交给它自己关
 * （不连带关导演台）；其余 = 关闭导演台。
 *
 * 开着的节点被删了（撤销、协作者删掉）就收起来。
 */
const { nodeKit, store } = useFlowEditor()

const openNodeId = ref<string | null>(null)
/** 打开时要发的那句话（节点底部输入框来的）；交给新挂上的工作区 */
const initialPrompt = ref<string | null>(null)
const root = ref<HTMLElement | null>(null)
const workspace = ref<InstanceType<typeof FlowDirectorWorkspace> | null>(null)

const off = nodeKit.kit.on(DIRECTOR_OPEN_EVENT, ({ prompt }, ctx) => {
  const text = prompt?.trim() || null
  // 已经开着同一个：不重挂，只把这句话发出去
  if (openNodeId.value === ctx.id) {
    if (text) workspace.value?.submitPrompt(text)
    return
  }
  initialPrompt.value = text
  openNodeId.value = ctx.id
  // 焦点别留在底下画布的按钮 / 输入框上（空格 / 回车会再作用到画布）
  void nextTick(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && !root.value?.contains(active)) active.blur()
    root.value?.focus()
  })
}, { match: { types: ["director"] } })
onBeforeUnmount(off)

function close() {
  openNodeId.value = null
  initialPrompt.value = null
}

watch(
  () => openNodeId.value !== null && !store.nodeById.has(openNodeId.value),
  (gone) => {
    if (gone) close()
  }
)

/**
 * 正在打字的地方：`isEditableTarget` 之外再认一次 `contenteditable` 祖先 —— 按键可能落在编辑区里的某个子节点上，
 * 而 `isContentEditable` 在 jsdom 里没有实现
 */
function isTyping(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true
  return target instanceof Element && target.closest('[contenteditable="true"],[contenteditable=""]') !== null
}

/** 目标在一个会自己处理 Esc 的弹层里（下拉菜单、对话框、提及候选） */
function inPopup(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"]') !== null
}

// 开着就让画布的快捷键让路；关上 / 卸载时解除
let releaseCanvasShortcuts: (() => void) | null = null
watch(
  openNodeId,
  (id) => {
    if (id && !releaseCanvasShortcuts) releaseCanvasShortcuts = suspendCanvasShortcuts()
    else if (!id) {
      releaseCanvasShortcuts?.()
      releaseCanvasShortcuts = null
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => releaseCanvasShortcuts?.())

useEventListener(document, "keydown", (event: KeyboardEvent) => {
  if (openNodeId.value === null) return

  if (event.key === "Escape") {
    if (isTyping(event.target)) {
      ;(event.target as HTMLElement).blur()
      root.value?.focus()
      return
    }
    if (inPopup(event.target)) return
    event.preventDefault()
    close()
    return
  }
  if (isTyping(event.target) || event.isComposing) return
  // Ctrl+S 不该弹浏览器的保存网页
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault()
    return
  }
  const action = directorShortcutOf(event)
  if (!action) return
  // 空格落在按钮上就是按那个按钮
  if (action === "toggle-play" && event.target instanceof Element && event.target.closest("button,[role='button'],a")) return
  if (action === "delete" && inPopup(event.target)) return
  if (workspace.value?.runShortcut(action)) event.preventDefault()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="openNodeId"
      ref="root"
      tabindex="-1"
      class="fixed inset-0 z-40 bg-background outline-none"
      data-testid="director-overlay"
    >
      <FlowDirectorWorkspace
        :key="openNodeId"
        ref="workspace"
        :node-id="openNodeId"
        :initial-prompt="initialPrompt"
        @close="close()"
      />
    </div>
  </Teleport>
</template>
