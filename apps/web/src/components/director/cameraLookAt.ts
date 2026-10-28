import { onBeforeUnmount, onMounted } from "vue"
import * as THREE from "three"

// 摄像机"注视目标"状态，存放于 camera.userData（与 scaleBase/uniformScale
// 相同的非撤销追踪约定），随场景序列化一同持久化。
// mode = "manual" 时 target 即注视坐标；mode = "object" 时 targetUuid 指向
// 场景中被跟随的图形，target 缓存其最近一次的网格中心（包围盒中心，而非
// 对象原点/控制中心）世界坐标——既供面板显示，也作为目标丢失后回退手动
// 模式时的坐标。
export interface CameraLookAtState {
  mode: "manual" | "object"
  targetUuid: string | null
  target: { x: number; y: number; z: number }
}

const DEFAULT_AIM_DISTANCE = 5

// 由摄像机当前朝向推导视线上固定距离处的一点，
// 用于在尚未设置注视状态时给面板一个不改变朝向的初始坐标。
export function deriveAimPoint(camera: any): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1)
    .applyQuaternion(camera.quaternion)
    .multiplyScalar(DEFAULT_AIM_DISTANCE)
    .add(camera.position)
}

export function getCameraLookAt(camera: any): CameraLookAtState | null {
  return camera?.userData?.lookAt ?? null
}

export function ensureCameraLookAt(camera: any): CameraLookAtState {
  if (!camera.userData.lookAt) {
    const point = deriveAimPoint(camera)
    camera.userData.lookAt = {
      mode: "manual",
      targetUuid: null,
      target: { x: point.x, y: point.y, z: point.z }
    } satisfies CameraLookAtState
  }
  return camera.userData.lookAt
}

// 解析当前应注视的世界坐标；对象模式下若目标已不在场景中，
// 就地降级为手动模式并沿用缓存坐标。
function resolveLookAtPoint(editor: any, camera: any): THREE.Vector3 | null {
  const state = getCameraLookAt(camera)
  if (!state) return null

  if (state.mode === "object" && state.targetUuid) {
    const target = editor.scene.getObjectByProperty("uuid", state.targetUuid)
    if (target) {
      const point = new THREE.Vector3()
      // 对齐目标对象的网格中心（包围盒中心），而非其原点/控制中心；
      // 包围盒为空（如空 Group）时回退到对象原点。
      const box = new THREE.Box3().setFromObject(target)
      if (box.isEmpty()) {
        target.getWorldPosition(point)
      } else {
        box.getCenter(point)
      }
      state.target = { x: point.x, y: point.y, z: point.z }
      return point
    }
    state.mode = "manual"
    state.targetUuid = null
  }

  return new THREE.Vector3(state.target.x, state.target.y, state.target.z)
}

// 将摄像机朝向对准注视点；返回朝向是否实际变化，供调用方决定
// 是否需要派发 objectChanged（也是跟随逻辑不陷入死循环的终止条件）。
export function applyCameraLookAt(editor: any, camera: any): boolean {
  const point = resolveLookAtPoint(editor, camera)
  if (!point) return false
  const before = camera.quaternion.clone()
  camera.lookAt(point)
  return camera.quaternion.angleTo(before) > 1e-6
}

// 全局跟随逻辑：被注视的图形移动时，所有跟随它的机位重新对准；
// 机位自身移动时同样保持对准注视点（类似云台锁定目标）。
// 朝向是由注视状态派生的，直接改写 rotation 而不走命令，不进入撤销历史。
export function useCameraLookAt(editor: any) {
  const signals = editor.signals
  let applying = false

  function trackingCameras(target: any): any[] {
    return Object.values(editor.cameras).filter((camera: any) => {
      if (camera === editor.camera) return false
      const state = getCameraLookAt(camera)
      return state?.mode === "object" && state.targetUuid === target.uuid
    })
  }

  function onObjectChanged(object: any) {
    if (applying || !object) return
    applying = true
    try {
      if (object.isCamera) {
        // 仅对象模式随机位移动重新对准（云台锁定目标）；手动模式下移动
        // 机位保持当前朝向，与新机位一致——手动坐标只在提交时设定一次。
        const state = getCameraLookAt(object)
        if (state?.mode === "object" && applyCameraLookAt(editor, object)) {
          signals.objectChanged.dispatch(object)
        }
        return
      }
      for (const camera of trackingCameras(object)) {
        if (applyCameraLookAt(editor, camera)) {
          signals.objectChanged.dispatch(camera)
        }
      }
    } finally {
      applying = false
    }
  }

  // 被跟随的图形删除后，机位退回手动模式，停在最后缓存的注视坐标上。
  function onObjectRemoved(object: any) {
    if (!object || object.isCamera) return
    for (const camera of trackingCameras(object)) {
      const state = getCameraLookAt(camera)
      if (state) {
        state.mode = "manual"
        state.targetUuid = null
      }
    }
  }

  onMounted(() => {
    signals.objectChanged.add(onObjectChanged)
    signals.objectRemoved.add(onObjectRemoved)
  })

  onBeforeUnmount(() => {
    signals.objectChanged.remove(onObjectChanged)
    signals.objectRemoved.remove(onObjectRemoved)
  })
}
