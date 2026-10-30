import { computed, ref } from "vue"

/**
 * 画布快捷键的「上面盖着一层」开关（docs/07 §2.1）。
 *
 * 全屏层（导演台）开着时，画布的快捷键（`useFlowShortcuts`：Delete、撤销 / 重做、节点动作）一律不生效 ——
 * 但**不能**靠在 document / window 上 `stopPropagation` 截住按键：reka-ui 的弹层（下拉菜单的 Esc 关闭等）
 * 用 `onKeyStroke` 挂在 window 上，截住就连它们一起坏了；在 window 捕获阶段截住，连全屏层里的输入框都收不到 keydown。
 * 所以由盖上来的那一层登记一下，`useFlowShortcuts` 自己让路。
 *
 * 模块级：一页只有一个画布编辑器。登记返回解除函数，盖着的层卸载时必须调。
 */
const layers = ref(0)

export const canvasShortcutsSuspended = computed(() => layers.value > 0)

export function suspendCanvasShortcuts(): () => void {
  layers.value++
  let released = false
  return () => {
    if (released) return
    released = true
    layers.value--
  }
}
