import * as THREE from "three"

// 机位真实的裁剪远平面——用于实际渲染（切换到该机位视角时的场景裁剪），
// 与下面仅用于辅助线视觉效果的常量相互独立，不随 FOV 变化，避免场景内容
// 被意外裁掉。
export const DIRECTOR_SHOT_FAR = 15

// FOV 示意椎体"底面"的半高固定为该值（底面积固定、不过大）。底面本身不绘制
// 线框，仅作为固定张角的参考。
export const FRUSTUM_BASE_HALF_HEIGHT = 1

// 椎体底面与镜头的固定距离。取最小 FOV（15°，与面板滑块最小值一致）对应的
// 距离，使椎体张角 = 15°；横截面始终落在底面之内，不超出底面大小。该距离
// 只用于辅助线视觉效果，不写回相机真实 far，不影响实际渲染裁剪
//（见 useCameraFrustumFootprint.ts）。
export const FRUSTUM_BASE_DISTANCE =
  FRUSTUM_BASE_HALF_HEIGHT / Math.tan(THREE.MathUtils.degToRad(15) / 2)

// 横截面与镜头的示意距离：FOV 越大视野越宽，横截面越近、越小（随 FOV 增大
// 而减小）。取值范围 [FRUSTUM_BASE_HALF_HEIGHT, FRUSTUM_BASE_DISTANCE]，始终
// 落在底面之内。仅作示意，不影响镜头实际 FOV 与渲染裁剪。
export function computeCrossDistance(fov: number): number {
  const halfFovRad = THREE.MathUtils.degToRad(fov) / 2
  return FRUSTUM_BASE_HALF_HEIGHT / Math.tan(halfFovRad)
}
