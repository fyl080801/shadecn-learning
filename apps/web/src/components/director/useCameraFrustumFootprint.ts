import * as THREE from "three"
import { onBeforeUnmount, onMounted } from "vue"

import {
  FRUSTUM_BASE_DISTANCE,
  FRUSTUM_BASE_HALF_HEIGHT,
  FRUSTUM_FOOTPRINT_ASPECT,
  computeCrossDistance
} from "./cameraFrustum"

// FOV 示意椎体辅助线：
//
// - 椎体底面（底面矩形）固定：半高 = FRUSTUM_BASE_HALF_HEIGHT、与镜头距离 =
//   FRUSTUM_BASE_DISTANCE，均不随 FOV 变化；底面不绘制线框（"底部不显示
//   线框"），仅作为四条侧棱的固定远端，由此定义椎体固定的张角。
// - 椎体侧棱从镜头画到横截面四角（不延伸到底面）。
// - FOV 用一个"横截面"矩形表示：它是侧棱上的一个切片，与镜头的距离 =
//   computeCrossDistance(fov)（FOV 越大视野越宽，横截面越近、越小），随 FOV
//   远近移动；其宽高按侧棱在该距离处的尺寸取值（切片），故始终落在侧棱上。
//   调整 FOV 即等价于移动该横截面与镜头的距离。仅示意，不影响镜头实际 FOV。
//
// 该椎体挂在编辑器自动创建的 CameraHelper 下（后者的 matrix 直接引用相机
// matrixWorld，故随相机移动/旋转自动跟随），其自带视锥线框被隐藏
// （material.visible = false）。椎体仅线段几何、无填充，raycast 被禁用不参与
// 拾取，也不会遮挡场景或角色，仅作示意。相机真实 far（见 cameraFrustum.ts 的
// DIRECTOR_SHOT_FAR）仍用于实际渲染裁剪，不受影响。
export function useCameraFrustumFootprint(editor: any) {
  const signals = editor.signals
  const COLOR = 0x6ba3ff

  function buildGeometry(fov: number): THREE.BufferGeometry {
    const baseHalfH = FRUSTUM_BASE_HALF_HEIGHT

    // 横截面：侧棱上的切片。距离随 FOV 远近变化，宽高按侧棱在该距离处的尺寸。
    // FOV 越大横截面越近、越小（示意，不影响实际 FOV）。宽高比使用固定常量
    // FRUSTUM_FOOTPRINT_ASPECT，不读取 camera.aspect——后者会被编辑器视口的
    // updateAspectRatio 改写为容器像素宽高比，导致横截面形状漂移成不确定矩形。
    const dCross = computeCrossDistance(fov)
    const crossHalfH = baseHalfH * (dCross / FRUSTUM_BASE_DISTANCE)
    const crossHalfW = crossHalfH * FRUSTUM_FOOTPRINT_ASPECT
    const crossZ = -dCross

    type Vec3 = [number, number, number]
    const apex: Vec3 = [0, 0, 0]
    // 横截面四角（绘制）
    const c0: Vec3 = [-crossHalfW, -crossHalfH, crossZ]
    const c1: Vec3 = [crossHalfW, -crossHalfH, crossZ]
    const c2: Vec3 = [crossHalfW, crossHalfH, crossZ]
    const c3: Vec3 = [-crossHalfW, crossHalfH, crossZ]

    const points: number[] = []
    const seg = (a: Vec3, b: Vec3) => {
      points.push(a[0], a[1], a[2], b[0], b[1], b[2])
    }

    // 四条侧棱（镜头 -> 横截面四角），不延伸到底面
    seg(apex, c0)
    seg(apex, c1)
    seg(apex, c2)
    seg(apex, c3)
    // 横截面矩形四条边
    seg(c0, c1)
    seg(c1, c2)
    seg(c2, c3)
    seg(c3, c0)

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(points, 3)
    )
    return geometry
  }

  function ensureFrustum(helper: any, camera: any): THREE.LineSegments {
    let frustum: THREE.LineSegments | undefined = helper.userData.fovFrustum
    if (!frustum) {
      const material = new THREE.LineBasicMaterial({
        color: COLOR,
        transparent: true,
        opacity: 0.85
      })
      frustum = new THREE.LineSegments(buildGeometry(camera.fov), material)
      frustum.name = "fovFrustum"
      // 仅作示意，不参与射线拾取，避免误选。
      frustum.raycast = () => {}
      helper.userData.fovFrustum = frustum
      helper.add(frustum)
    }
    return frustum
  }

  function refreshHelper(camera: any) {
    if (!camera?.isPerspectiveCamera || !camera.userData?.isDirectorShot) return

    const helper = editor.helpers[camera.id]
    if (!helper) return

    // 辅助器挂在 editor.sceneHelpers 下、matrix 直接引用相机 matrixWorld，并不是
    // 机位对象的子节点，故场景面板把机位 visible 置 false 只会隐藏机位子树里的
    // camera.glb 模型，这条示意椎体仍照常渲染——「隐藏机位」看上去只隐藏了图形、
    // 参照线还留在画面里。这里把辅助器的显隐与机位本身对齐。
    // 放在 director 侧而不是 Viewport：引擎层的 showHelpersChanged 是辅助器显隐的
    // 另一个主人（完整编辑器 chrome 的「显示相机辅助器」开关），在引擎层按对象
    // visible 回写会把用户在那里关掉的辅助器重新打开；导演台不挂载该 chrome，
    // 这条通道在本域内没有争用。
    helper.visible = camera.visible

    // 隐藏 CameraHelper 自带视锥线框（含底面矩形），改用下方自定义 FOV 椎体。
    if (helper.material) helper.material.visible = false

    const frustum = ensureFrustum(helper, camera)
    const next = buildGeometry(camera.fov)
    frustum.geometry.dispose()
    frustum.geometry = next
  }

  function refreshAll() {
    for (const camera of Object.values(editor.cameras) as any[]) {
      refreshHelper(camera)
    }
  }

  function onObjectChanged(object: any) {
    refreshHelper(object)
  }

  function onObjectAdded(object: any) {
    refreshHelper(object)
  }

  // 时间轴逐帧写回之后：椎体挂在 CameraHelper 下、matrix 直接引用相机 matrixWorld，故
  // 位姿自动跟随，**唯独按 FOV 建的那份几何**要重建——FOV 关键帧播放时否则横截面纹丝
  // 不动。时间轴的写回不派发 objectChanged，这条 sceneAnimated 才是「本帧已落地」的通道
  // （见 Editor.ts 的信号注释）。
  //
  // 只在 FOV 真的变了时才重建：这是每帧都会跑的一条，而 buildGeometry 是一次几何分配 +
  // 旧几何 dispose，逐帧无条件重建就是给所有机位白付一份（绝大多数场景根本没打 FOV 帧）。
  const lastFov = new WeakMap<object, number>()

  function onSceneAnimated() {
    for (const camera of Object.values(editor.cameras) as any[]) {
      if (!camera?.isPerspectiveCamera || !camera.userData?.isDirectorShot)
        continue
      if (lastFov.get(camera) === camera.fov) continue
      lastFov.set(camera, camera.fov)
      refreshHelper(camera)
    }
  }

  function onHelperRemoved(helper: any) {
    const frustum: THREE.LineSegments | undefined = helper.userData?.fovFrustum
    if (frustum) {
      frustum.geometry.dispose()
      ;(frustum.material as THREE.Material).dispose()
    }
  }

  onMounted(() => {
    signals.objectChanged.add(onObjectChanged)
    signals.objectAdded.add(onObjectAdded)
    signals.sceneAnimated.add(onSceneAnimated)
    signals.helperRemoved.add(onHelperRemoved)
    signals.windowResize.add(refreshAll)
    // 已存在的机位（如加载存档时组件晚于场景挂载）补建一次。
    refreshAll()
  })

  onBeforeUnmount(() => {
    signals.objectChanged.remove(onObjectChanged)
    signals.objectAdded.remove(onObjectAdded)
    signals.sceneAnimated.remove(onSceneAnimated)
    signals.helperRemoved.remove(onHelperRemoved)
    signals.windowResize.remove(refreshAll)
  })
}
