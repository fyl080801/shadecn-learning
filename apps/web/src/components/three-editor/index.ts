// 本仓库只保留 three-editor 的渲染核心（Editor / Viewport / 命令与历史 / 加载器），
// 源项目里的菜单栏、侧栏、工具栏、脚本/动画/播放器面板与各类弹窗都没有迁移。
export { createEditor } from "./composables/useEditorContext"

export { default as ThreeEditor } from "./ThreeEditor.vue"
export { default as EditorViewport } from "./EditorViewport.vue"
