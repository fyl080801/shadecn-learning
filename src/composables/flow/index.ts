export { provideFlowEditor } from "./context"
// 读取侧从叶子模块出，不经过 context.ts —— 组件也该直接引它，别走这个 barrel，
// 原因见 editor-context.ts 顶部（barrel ↔ useFlowCanvas 会成跨 chunk 的环）
export { useFlowEditor, type FlowEditorContext } from "./editor-context"
export {
  useFlowCanvas,
  FLOW_EDGE_TYPE,
  type FlowCanvas,
  type FlowInteractionMode
} from "./useFlowCanvas"
export {
  useFlowSync,
  classifyClose,
  type FlowSync,
  type FlowSyncSession,
  type FatalClose
} from "./sync"
export { useFlowDocument, type FlowDocument } from "./useFlowDocument"
export { useFlowPresence, type FlowPresence } from "./useFlowPresence"
export { useFlowSelection, type FlowSelection } from "./useFlowSelection"
export { useFlowSnapping, FLOW_GRID_SIZE, FLOW_GRID_GAP, type FlowSnapping } from "./useFlowSnapping"
export { useFlowShortcuts } from "./useFlowShortcuts"
