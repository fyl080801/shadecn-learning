import * as THREE from "three"
import type { Editor } from "./Editor"

const mouse = new THREE.Vector2()
const raycaster = new THREE.Raycaster()

// 将一次射线命中解析为实际应选中的对象：点击角色的任何部分（如身体网格）都
// 应选中角色的根组，而非网格本身——否则拖拽只会移动网格的局部位置，而组
// （通过 userData.isCharacter 进行标签/追踪）始终不会移动。同理，机位原点以
// camera.glb 子网格呈现（见 DirectorToolbar.vue 的 addCameraPosition），点击
// 模型的任意部分都应选中机位（相机）本身，而非模型网格。
//
// 导出供 Viewport.ts 的 onDoubleClick 复用：双击群众分组内的成员时需要解析到
// 这一级（成员本身），而非下面 resolveGroupClickTarget 继续冒泡到的分组级别。
export function resolveClickTarget(raw: THREE.Object3D): THREE.Object3D {
  let object: any = raw

  if (object.userData.object !== undefined) {
    object = object.userData.object
  }

  // 冒泡到「图形本体的根」——角色包裹容器与三层装配的图形根都打 `isShapeContainer`
  // （见 director/directorObjectCenter 的 SHAPE_CONTAINER_FLAG），故这里只认一个标记：
  // 点中里面那个网格，选中的必须是这个根，否则拖拽只挪动内部节点，而根（时间轴轨道、
  // 序列化、名字标签认的那一个）纹丝不动。
  let node: any = object
  while (node) {
    if (node.userData?.isShapeContainer) {
      object = node
      break
    }
    node = node.parent
  }

  node = object
  while (node) {
    if ((node as any).isCamera) {
      object = node
      break
    }
    node = node.parent
  }

  return object
}

// 单击命中群众分组内的成员时，默认选中整个分组（可整体移动/旋转），而非
// 分组内的单个成员——双击才下钻到成员（见 Viewport.ts 的 onDoubleClick），
// 也可在场景面板展开分组后直接点击成员行单独选中（DirectorScenePanel 直接
// 调用 editor.select，不经过这里）。对没有 isCrowdGroup 祖先的对象（三维
// 编辑器完整 chrome 下的所有对象、导演台内除群众分组外的其余对象），这里
// 与 resolveClickTarget 的结果完全一致，行为不受影响。
function resolveGroupClickTarget(raw: THREE.Object3D): THREE.Object3D {
  const object: any = resolveClickTarget(raw)

  let node: any = object
  while (node) {
    if (node.userData?.isCrowdGroup) return node
    node = node.parent
  }

  return object
}

// 一次点击该选中谁：**永远是离相机最近的那一次命中**（`intersectObjects` 的结果按
// distance 升序，故取解析后的第一个）。
//
// 这里刻意**不做** three.js editor 原版的「第一个对象已选中就切到下一个」循环：那套
// 循环让「前面的图形挡住后面的图形」时的点击变成前后交替——点前面的图形选中它，再点
// 一次却跳到被它挡住的那个，第三次又回到前面。用户看到的是「点不准、每点一下选中的
// 东西都在换」，而遮挡关系本来已经把「点这儿指的是谁」说得很清楚了。
//
// 要选被挡住的对象走另外两条已有的路：场景面板（`DirectorScenePanel` 直接
// `editor.select`）、或先把相机转到看得见它的角度。**不要**把循环加回来。
export function resolveSelectionTarget(
  intersects: THREE.Intersection[]
): THREE.Object3D | null {
  const nearest = intersects[0]

  return nearest ? resolveGroupClickTarget(nearest.object) : null
}

class Selector {
  editor: Editor
  signals: Editor["signals"]

  constructor(editor: Editor) {
    const signals = editor.signals

    this.editor = editor
    this.signals = signals

    // 信号

    signals.intersectionsDetected.add((intersects: THREE.Intersection[]) => {
      // 最近的一次命中即选中目标（辅助器在 resolveSelectionTarget 里解析回实际
      // 对象）；没有命中就是点在空白处，取消选中。
      this.select(resolveSelectionTarget(intersects))
    })
  }

  getIntersects(raycaster: THREE.Raycaster) {
    const objects: THREE.Object3D[] = []

    this.editor.scene.traverseVisible(function (child) {
      objects.push(child)
    })

    this.editor.sceneHelpers.traverseVisible(function (child) {
      if (child.name === "picker") objects.push(child)
    })

    return raycaster.intersectObjects(objects, false)
  }

  getPointerIntersects(point: { x: number; y: number }, camera: THREE.Camera) {
    mouse.set(point.x * 2 - 1, -(point.y * 2) + 1)

    raycaster.setFromCamera(mouse, camera)

    return this.getIntersects(raycaster)
  }

  select(object: THREE.Object3D | null) {
    if (this.editor.selected === object) return

    let uuid = null

    if (object !== null) {
      uuid = object.uuid
    }

    this.editor.selected = object
    this.editor.config.setKey("selected", uuid)

    this.signals.objectSelected.dispatch(object)
  }

  deselect() {
    this.select(null)
  }
}

export { Selector }
