// 导演台的「中心视口」：渲染与视口内交互的 composable 和叠加层。
//
// 源项目里同目录的顶栏（视角标签）、工具栏、各类面板、时间轴、轨迹绘制、角色素体 /
// 动作库（依赖后端资源索引）、截图与录制、场景持久化都没有迁移。

// 视口叠加层
export { default as DirectorAspectRatioOverlay } from "./DirectorAspectRatioOverlay.vue"
export { default as DirectorViewHelper } from "./DirectorViewHelper.vue"
export { default as DirectorTransformControls } from "./DirectorTransformControls.vue"

// 只渲染的舞台（画布导演台节点全屏打开的那一块）与它和 /3d-viewport 共用的默认场景
export { default as DirectorStage } from "./DirectorStage.vue"
export { buildDirectorDefaultScene } from "./directorDefaultScene"

// 渲染器与场景背景
export { useDirectorRenderer } from "./useDirectorRenderer"
export { useDirectorSceneBackdrop } from "./useDirectorSceneBackdrop"
export { resetDirectorSceneSession } from "./directorSceneProperties"
export { useDirectorShapeMaterial } from "./useDirectorShapeMaterial"
export {
  createShapeMaterial,
  normalizeShapeMaterial,
  SHAPE_DEFAULT_COLOR,
  SHAPE_SURFACE
} from "./directorShapeMaterial"

// 机位：注视、注视装置、视锥示意、机位视角导航
export {
  useCameraLookAt,
  getCameraLookAtMode,
  isCameraAimed,
  planCameraLookAtSwitch,
  migrateLegacyCameraLookAt
} from "./cameraLookAt"
export type {
  CameraLookAtMode,
  CameraLookAtState,
  CameraOrbit
} from "./cameraLookAt"
export { useDirectorCameraRig } from "./useDirectorCameraRig"
export { useCameraFrustumFootprint } from "./useCameraFrustumFootprint"
export { useCameraModelVisibility } from "./useCameraModelVisibility"
export { useDirectorCameraControls } from "./useDirectorCameraControls"
export { DIRECTOR_SHOT_FAR } from "./cameraFrustum"
export {
  useCameraAspectGate,
  computeAspectGateFrame
} from "./directorAspectGate"

// 对象中心 / 图形容器（root → pivot → 网格三层装配）
export {
  createShapeContainer,
  ensureShapeContainer,
  getObjectCenter,
  getObjectCenterWorld,
  isShapeContainer,
  setObjectCenter,
  SHAPE_CONTAINER_FLAG
} from "./directorObjectCenter"
export type { ObjectCenter, ObjectCenterAnchor } from "./directorObjectCenter"

// 选区与调节器归属
export {
  directorSelectionItems,
  activeDirectorSelection,
  activeDirectorSelectionKind,
  selectDirectorItem,
  clearDirectorSelection,
  registerDirectorSelectionDelete,
  deleteActiveDirectorSelection,
  resetDirectorSelection
} from "./directorSelection"
export type {
  DirectorSelectionKind,
  DirectorSelectionItem
} from "./directorSelection"
export {
  useDirectorSelection,
  selectDirectorObject
} from "./useDirectorSelection"
export {
  directorGizmoOwner,
  ownsDirectorGizmo,
  resetDirectorGizmoOwner,
  allowedDirectorTransformModes,
  isDirectorTransformModeAllowed
} from "./directorGizmoOwner"
export type { DirectorGizmoOwner } from "./directorGizmoOwner"
export { useDirectorObjectGizmo } from "./useDirectorObjectGizmo"
export { useDirectorTransform } from "./useDirectorTransform"
export type { DirectorTransformMode } from "./useDirectorTransform"
export { useDirectorDeleteShortcut } from "./useDirectorDeleteShortcut"

// 视口共享状态（画幅、全景来源、视角复位令牌）
export {
  aspectRatio,
  ASPECT_RATIOS,
  panoramaSources,
  activePanoramaNodeId,
  uploadedPanoramaUrl,
  viewportResetRequestId
} from "./directorState"
export type { AspectRatioKey, DirectorPanoramaSource } from "./directorState"
