import * as THREE from "three"
import type { Editor } from "./Editor"

const mouse = new THREE.Vector2()
const raycaster = new THREE.Raycaster()

class Selector {
  editor: Editor
  signals: Editor["signals"]

  constructor(editor: Editor) {
    const signals = editor.signals

    this.editor = editor
    this.signals = signals

    // 信号

    signals.intersectionsDetected.add((intersects: THREE.Intersection[]) => {
      if (intersects.length > 0) {
        // 将辅助器解析为实际对象

        const objects: THREE.Object3D[] = []

        for (let i = 0; i < intersects.length; i++) {
          let object: any = intersects[i]!.object

          if (object.userData.object !== undefined) {
            object = object.userData.object
          }

          // 点击角色的任何部分（如身体网格）都应选中角色的根组，
          // 而非网格本身——否则拖拽只会移动网格的局部位置，
          // 而组（通过 userData.isCharacter 进行标签/追踪）
          // 始终不会移动。
          let node: any = object
          while (node) {
            if (node.userData?.isCharacter) {
              object = node
              break
            }
            node = node.parent
          }

          if (objects.indexOf(object) === -1) {
            objects.push(object)
          }
        }

        // 如果第一个对象已被选中，则在对象间循环切换

        const index = objects.indexOf(editor.selected as THREE.Object3D)

        if (index !== -1 && index < objects.length - 1) {
          this.select(objects[index + 1] ?? null)
        } else {
          this.select(objects[0] ?? null)
        }
      } else {
        this.select(null)
      }
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
