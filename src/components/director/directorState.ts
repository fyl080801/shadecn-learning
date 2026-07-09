import { ref } from "vue"

// 导演控制台的共享 UI 状态。每页只显示一个控制台，
// 因此使用模块级单例比通过 props/provide 在标签页、工具栏和属性面板间传递更简单。
export const showCharacterLabels = ref(true)
export const activeView = ref<"director" | "camera">("director")
export const activeCameraUuid = ref<string | null>(null)

// 画幅比例取景框。`auto` 表示不显示取景框；其余为常用画幅比例，
// 由导演台工具栏的"选择画幅比例"按钮设置，取景框与周边模糊在
// 3DScene.vue 中以 CSS 叠加层实现（不进入 three-editor 的视口渲染）。
export type AspectRatioKey =
  | "auto"
  | "21:9"
  | "16:9"
  | "4:3"
  | "1:1"
  | "3:4"
  | "9:16"
export const aspectRatio = ref<AspectRatioKey>("auto")
