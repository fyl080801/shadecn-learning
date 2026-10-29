import * as THREE from "three"

// 机位真实的裁剪远平面——用于实际渲染（切换到该机位视角时的场景裁剪），
// 与下面仅用于辅助线视觉效果的常量相互独立，不随 FOV 变化，避免场景内容
// 被意外裁掉。取值需覆盖场景可达到的最大尺度：地面/全景球半径可调至 500
// （scenePanelFields.ts 的 panoramaRadius 滑块上限），场景整体缩放
// 又可放大至 500%（sceneScalePercent 上限），机位一旦被拖至稍远处就可能
// 超出过小的 far 而把角色裁没；这里留出充分余量。
export const DIRECTOR_SHOT_FAR = 2000

// FOV 示意椎体"底面"的半高固定为该值（底面积固定、不过大）。底面本身不绘制
// 线框，仅作为固定张角的参考。
export const FRUSTUM_BASE_HALF_HEIGHT = 1

// 椎体横截面的固定宽高比（宽 / 高）。取 16:9，使示意椎体横截面始终保持
// 16:9 长方形。注意：不能直接读取 camera.aspect——编辑器视口的
// updateAspectRatio（Viewport.ts）会遍历 editor.cameras 把所有相机（含机位）
// 的 aspect 改写为视口容器的像素宽高比，导致移动/缩放后横截面形状漂移成不确定
// 的矩形。这里用固定常量解耦，保证形状确定。该比例只用于辅助线视觉效果，
// 不影响镜头实际渲染（机位作为视口相机时仍按容器宽高比渲染）。
export const FRUSTUM_FOOTPRINT_ASPECT = 16 / 9

// 机位 FOV 的可调区间——**单点源**。属性面板的滑杆量程、机位视角滚轮变焦的夹取、
// 以及下面示意椎体的底面张角都读它；各处各写一个数字的话，滑杆拖到头的位置与滚轮
// 滚到头的位置就会对不上，示意椎体也会在某一端露出底面之外。
export const CAMERA_FOV_MIN = 15
export const CAMERA_FOV_MAX = 90

// 椎体底面与镜头的固定距离。取最小 FOV 对应的距离，使椎体垂直张角 = CAMERA_FOV_MIN；
// 横截面在垂直方向始终落在底面之内。该距离只用于辅助线视觉效果，不写回相机真实 far，
// 不影响实际渲染裁剪（见 useCameraFrustumFootprint.ts）。
export const FRUSTUM_BASE_DISTANCE =
  FRUSTUM_BASE_HALF_HEIGHT /
  Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_MIN) / 2)

// 横截面与镜头的示意距离：FOV 越大视野越宽，横截面越近、越小（随 FOV 增大
// 而减小）。取值范围 [FRUSTUM_BASE_HALF_HEIGHT, FRUSTUM_BASE_DISTANCE]，始终
// 落在底面之内。仅作示意，不影响镜头实际 FOV 与渲染裁剪。
export function computeCrossDistance(fov: number): number {
  const halfFovRad = THREE.MathUtils.degToRad(fov) / 2
  return FRUSTUM_BASE_HALF_HEIGHT / Math.tan(halfFovRad)
}
