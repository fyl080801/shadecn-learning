import { ref } from "vue"

// 导演台视口的共享 UI 状态。每页只显示一个视口，
// 因此使用模块级单例比通过 props/provide 在叠加层与 composable 间传递更简单。
//
// 本仓库只迁移了「中心视口」：源项目里同文件的视角标签（activeView/activeCameraUuid）、
// 角色标签开关、截图列表与画布连线断开等面板/持久化状态没有消费方，故未保留。

/**
 * 全景背景来源：源项目里由画布上入边连接的 720 全景节点派生（原定义在
 * studio-flow 的节点类型里）。本仓库没有画布连线，列表默认为空，保留形状以便
 * useDirectorSceneBackdrop 的「连线来源优先、否则取上传原图」规则原样成立。
 */
export interface DirectorPanoramaSource {
  /** 来源节点 id，用于选择/追踪连接是否仍然存在 */
  nodeId: string
  /** 全景原图链接 */
  url: string
  /** 来源节点的显示名 */
  label?: string
}

// 全景背景来源列表，及当前选中作为背景的来源节点 id。
export const panoramaSources = ref<DirectorPanoramaSource[]>([])
export const activePanoramaNodeId = ref<string | null>(null)
// 本地上传/资产选择的全景背景原图 URL。与连线来源互斥：连线存在时以连线来源为背景。
export const uploadedPanoramaUrl = ref<string | null>(null)

// 画幅比例取景框。`auto` 表示不显示取景框；其余为常用画幅比例，
// 取景框与周边模糊由 DirectorAspectRatioOverlay 以 CSS 叠加层实现（不进入 three-editor 的视口渲染）。
export type AspectRatioKey =
  | "auto"
  | "21:9"
  | "16:9"
  | "4:3"
  | "1:1"
  | "3:4"
  | "9:16"
export const aspectRatio = ref<AspectRatioKey>("auto")

// 各画幅比例的宽高比（宽 / 高）。`auto` 无固定比例，不在此表中，
// 消费方（取景框叠加层、相机分辨率闸门）按需判断 'auto' 分支。
export const ASPECT_RATIOS: Record<Exclude<AspectRatioKey, "auto">, number> = {
  "21:9": 21 / 9,
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
  "3:4": 3 / 4,
  "9:16": 9 / 16
}

// 视角重置请求令牌：DirectorTransformControls 的"重置视角"按钮每次点击自增，
// DirectorViewHelper 侦听该值变化并执行其内部的轨道复位动画（保持缩放不变，
// 仅将朝向旋回默认视角）。两者非父子关系，复用模块级单例避免 prop 透传。
export const viewportResetRequestId = ref(0)

/**
 * 解析「当前生效的全景来源」：优先取用户选中的来源（activePanoramaNodeId），
 * 选中项不在列表时回退到列表最后一个。无来源返回 null。
 */
export function resolveActivePanoramaSource(): DirectorPanoramaSource | null {
  const byId = panoramaSources.value.find(
    (s) => s.nodeId === activePanoramaNodeId.value
  )
  return byId ?? panoramaSources.value[panoramaSources.value.length - 1] ?? null
}
