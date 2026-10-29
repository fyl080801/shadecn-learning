import { onBeforeUnmount, onMounted, ref } from "vue"

import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import {
  allowedDirectorTransformModes,
  isDirectorTransformModeAllowed
} from "./directorGizmoOwner"

export type DirectorTransformMode = "translate" | "rotate" | "scale"

const DEFAULT_MODE: DirectorTransformMode = "translate"

/**
 * 导演台元素变换模式控制。
 *
 * 复用 three-editor Viewport 内置的 TransformControls：模式切换由
 * `editor.signals.transformModeChanged` 驱动，Viewport 监听该信号后调用
 * `transformControls.setMode(mode)`。这里仅做语义封装与当前模式的状态同步，
 * 不直接持有 TransformControls 实例，保持导演台与编辑器解耦。
 *
 * 群众分组的缩放手柄语义（调整成员间距、隐藏竖直轴手柄）由 Viewport.ts 的
 * TransformControls 事件处理直接实现（见其 crowdSpacing 相关注释），此处
 * 无需感知分组这一概念。
 */
export function useDirectorTransform() {
  const editor = useEditor()
  const signals = editor.signals

  const mode = ref<DirectorTransformMode>(DEFAULT_MODE)

  function onModeChanged(next: DirectorTransformMode) {
    mode.value = next
  }

  function setTransformMode(next: DirectorTransformMode) {
    if (next === mode.value) return
    // 当前调节器不认这个模式就一律不切（按钮那一侧同样按它置灰，见
    // DirectorTransformControls）。闸门放在这里而不是只放在按钮上：模式还有
    // 键盘/别处的入口，只禁按钮的话它们绕过去之后工具栏读数与实际行为就分了岔。
    if (!isDirectorTransformModeAllowed(next)) return
    signals.transformModeChanged.dispatch(next)
  }

  onMounted(() => {
    signals.transformModeChanged.add(onModeChanged)
  })

  onBeforeUnmount(() => {
    signals.transformModeChanged.remove(onModeChanged)
  })

  return {
    mode,
    /** 此刻可用的模式（随调节器所有权变化，见 directorGizmoOwner）。 */
    allowedModes: allowedDirectorTransformModes,
    isModeAllowed: isDirectorTransformModeAllowed,
    setTransformMode,
    translate: () => setTransformMode("translate"),
    rotate: () => setTransformMode("rotate"),
    scale: () => setTransformMode("scale")
  }
}
