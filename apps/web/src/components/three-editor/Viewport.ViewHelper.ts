
import * as THREE from "three"
import { ViewHelper as ViewHelperBase } from "three/addons/helpers/ViewHelper.js"

interface ViewHelperOffset {
  top: number
  right: number
}

const DEFAULT_OFFSET: ViewHelperOffset = { top: 30, right: 0 }

// gizmo 球体/线条每帧直接绘制到共享的 WebGL 画布中
// （见 ViewHelperBase.render），而非作为 DOM 元素——DOM 叠加层
// 始终绘制在该画布之上（position:absolute 内容无论 DOM 顺序如何，
// 都在静态流内内容之后绘制），因此它只能冲淡 gizmo，永远无法位于其后。
// 背景板必须作为同一场景图的一部分：一个以局部原点为中心的 Sprite，
// 因为精灵始终面向相机，且其在 (0,0,0) 处的位置不受此对象逐帧旋转的影响
// （见下文 render()）。
function createBackdrop(): THREE.Sprite {
  const size = 128
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size

  const context = canvas.getContext("2d")!
  const color =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim() || "#808080"

  context.beginPath()
  context.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2)
  context.closePath()
  context.fillStyle = color
  context.fill()

  const material = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
    transparent: true,
    opacity: 0.55,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  })

  const sprite = new THREE.Sprite(material)
  // 此处的世界单位映射到正交相机固定的 ±2 视锥体（在 128px 视口中
  // 宽/高各 4 个单位）——缩放至该值以下，使背景板呈现为环绕坐标轴的环，
  // 而非填满整个瓦片。
  sprite.scale.setScalar(3.1)
  sprite.renderOrder = -1

  return sprite
}

class ViewHelper extends ViewHelperBase {
  // 由 ViewHelperBase 的真实（未类型化）构造函数在内部设置。
  declare camera: THREE.Camera

  constructor(
    editorCamera: THREE.Camera,
    container: HTMLElement,
    offset: ViewHelperOffset = DEFAULT_OFFSET
  ) {
    super(editorCamera, container)

    this.location.top = offset.top
    this.location.right = offset.right

    this.add(createBackdrop())

    const panel = document.createElement("div")
    panel.id = "viewHelper"
    panel.style.position = "absolute"
    panel.style.right = `${offset.right}px`
    panel.style.top = `${offset.top}px`
    panel.style.height = "128px"
    panel.style.width = "128px"

    panel.addEventListener("pointerup", (event) => {
      event.stopPropagation()

      this.handleClick(event)
    })

    panel.addEventListener("pointerdown", function (event) {
      event.stopPropagation()
    })

    container.appendChild(panel)
  }
}

export { ViewHelper, type ViewHelperOffset }
