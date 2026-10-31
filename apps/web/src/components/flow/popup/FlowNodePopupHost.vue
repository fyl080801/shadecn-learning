<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue"
import { useEventListener } from "@vueuse/core"
import { Check } from "@lucide/vue"

import { Button } from "@/components/ui/button"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { isEditableTarget } from "@/composables/flow/editable"
import { suspendCanvasShortcuts } from "@/composables/flow/shortcut-layer"
import { provideNodePopupActions, type NodePopupContent, type NodePopupDef } from "./node-popup"
import { FLOW_NODE_POPUPS } from "./popups"

/**
 * 节点弹出编辑的宿主（docs/21 §4.10）—— 编辑器里挂一次（`FlowEditor.vue`），接住 `popups.ts` 里每一种的打开事件，
 * 盖一层半透明 backdrop、中间一块面板，把那个节点单独拿出来编辑。所有弹出编辑共用的规矩**只在这里写**，内容组件只管内容。
 * （导演台的全屏占用是另一种独立编辑，在 `FlowDirectorOverlay.vue`，不经这里。）
 *
 * 层级：
 * - **关着就不挂**（`v-if`），画布上一个元素都不多，不挡任何操作；
 * - 开着时 teleport 到 body、`fixed inset-0 z-40`：脱离 Vue Flow 的变换层（不跟着画布缩放、不被节点压住），
 *   遮罩挡住画布的指针 / 滚轮；低于对话框、toast 的 z-50，连接被终结的对话框照样能盖住它；
 * - 同一时刻只开一个；开着时打开另一种 / 另一个节点，旧的先卸载（按弹出编辑 + 节点做 key）。
 *
 * **外观**：遮罩 `bg-black/50` + 模糊，面板居中、宿主画外框和标题栏（节点名 + 内容自己的按钮 + 「完成」），内容填满标题栏以下。
 * 内容的按钮经 `useNodePopupActions()` teleport 进标题栏「完成」左边的按钮位。
 * **点遮罩关闭**（按下和松开都在遮罩本身上才算，在面板里拖选文字松手落到遮罩上不算）。
 *
 * **键盘**（同导演台全屏层的那套规矩，docs/07 §7.6）：
 * - 开着时登记 `suspendCanvasShortcuts()`：画布的快捷键一律让路。**不截断按键的传播**：在 window 捕获阶段截，
 *   面板里的输入框就收不到 keydown；在 document 上截，reka-ui 挂在 window 上的 Esc（关下拉菜单）也一起坏了；
 * - 内容自己的快捷键（`handleKey`）在 document 冒泡阶段接，焦点在输入框里、输入法组字时不给；Ctrl+S 一律吞掉。
 *
 * **Esc**：在下拉菜单 / 对话框里 = 交给它自己关；在输入框里 = 按 `escapeFromInput`（默认直接关；`blur` 先失焦）；其余 = 关闭。
 *
 * **关闭**只有一种：卸载内容组件 —— 草稿由内容组件在卸载时提交。开着的节点被删了（撤销、协作者删掉）就收起来。
 */
const { nodeKit, store } = useFlowEditor()

interface OpenPopup {
  def: NodePopupDef
  nodeId: string
  payload: unknown
}

const current = shallowRef<OpenPopup | null>(null)
const root = ref<HTMLElement | null>(null)
const content = ref<NodePopupContent | null>(null)
/** 标题栏里给内容组件的按钮位 */
const actions = ref<HTMLElement | null>(null)
provideNodePopupActions(actions)

const offs = FLOW_NODE_POPUPS.map((def) =>
  nodeKit.kit.on(
    def.event,
    (payload, ctx) => {
      const open = current.value
      // 已经开着同一个节点的同一种：不重挂，交给它
      if (open && open.def.id === def.id && open.nodeId === ctx.id) {
        content.value?.reopen?.(payload)
        return
      }
      current.value = { def, nodeId: ctx.id, payload }
      // 焦点别留在底下画布的按钮 / 输入框上（空格 / 回车会再作用到画布）；内容组件挂上后自己再聚焦
      void nextTick(() => {
        const active = document.activeElement as HTMLElement | null
        if (active && !root.value?.contains(active)) {
          active.blur()
          root.value?.focus()
        }
      })
    },
    { match: def.match }
  )
)
onBeforeUnmount(() => offs.forEach((off) => off()))

function close() {
  current.value = null
}

watch(
  () => current.value !== null && !store.nodeById.has(current.value.nodeId),
  (gone) => {
    if (gone) close()
  }
)

const title = computed(() => {
  const open = current.value
  if (!open) return ""
  const label = store.nodeById.get(open.nodeId)?.metadata.label
  return typeof label === "string" && label.trim() ? label : open.def.fallbackTitle
})

/**
 * 正在打字的地方：`isEditableTarget` 之外再认一次 `contenteditable` 祖先 —— 按键可能落在编辑区里的某个子节点上，
 * 而 `isContentEditable` 在 jsdom 里没有实现
 */
function isTyping(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true
  return target instanceof Element && target.closest('[contenteditable="true"],[contenteditable=""]') !== null
}

/** 目标在一个会自己处理 Esc 的弹层里（下拉菜单、对话框、候选列表） */
function inPopup(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"]') !== null
}

// 开着就让画布的快捷键让路；关上 / 卸载时解除
let releaseCanvasShortcuts: (() => void) | null = null
watch(
  () => current.value !== null,
  (open) => {
    if (open && !releaseCanvasShortcuts) releaseCanvasShortcuts = suspendCanvasShortcuts()
    else if (!open) {
      releaseCanvasShortcuts?.()
      releaseCanvasShortcuts = null
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => releaseCanvasShortcuts?.())

useEventListener(document, "keydown", (event: KeyboardEvent) => {
  const open = current.value
  if (!open) return

  if (event.key === "Escape") {
    if (inPopup(event.target)) return
    if (isTyping(event.target) && open.def.escapeFromInput === "blur") {
      ;(event.target as HTMLElement).blur()
      root.value?.focus()
      return
    }
    event.preventDefault()
    close()
    return
  }
  if (isTyping(event.target) || event.isComposing) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault()
    return
  }
  if (content.value?.handleKey?.(event)) event.preventDefault()
})

let pressedOnBackdrop = false
function onBackdropPointerDown(event: PointerEvent) {
  pressedOnBackdrop = event.target === event.currentTarget
}
function onBackdropClick(event: MouseEvent) {
  if (pressedOnBackdrop && event.target === event.currentTarget) close()
  pressedOnBackdrop = false
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="current"
      ref="root"
      tabindex="-1"
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 outline-none backdrop-blur-sm sm:p-8"
      :data-testid="`${current.def.id}-popup`"
      data-role="node-popup-backdrop"
      @pointerdown="onBackdropPointerDown"
      @click="onBackdropClick"
    >
      <section
        role="region"
        :aria-label="title"
        class="flex h-full max-h-[48rem] w-full max-w-5xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
        data-testid="node-popup-panel"
      >
        <header class="flex h-12 shrink-0 items-center gap-2 border-b pl-4 pr-2">
          <h2 class="min-w-0 flex-1 truncate text-sm font-medium" data-testid="node-popup-title">{{ title }}</h2>
          <div ref="actions" class="flex shrink-0 items-center gap-1" data-node-popup-actions />
          <Button size="sm" variant="ghost" title="完成（Esc）" data-testid="node-popup-close" @click="close()">
            <Check />
            完成
          </Button>
        </header>
        <div class="min-h-0 flex-1">
          <component
            :is="current.def.component"
            :key="`${current.def.id}:${current.nodeId}`"
            ref="content"
            :node-id="current.nodeId"
            :payload="current.payload"
            @close="close()"
          />
        </div>
      </section>
    </div>
  </Teleport>
</template>
