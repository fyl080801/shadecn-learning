import { ref } from "vue"

// 导演控制台的共享 UI 状态。每页只显示一个控制台，
// 因此使用模块级单例比通过 props/provide 在标签页、工具栏和属性面板间传递更简单。
export const showCharacterLabels = ref(true)
export const activeView = ref<"director" | "camera">("director")
export const activeCameraUuid = ref<string | null>(null)
