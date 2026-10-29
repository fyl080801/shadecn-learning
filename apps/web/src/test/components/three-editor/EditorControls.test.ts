import { describe, expect, it } from "vitest"
import * as THREE from "three"

import { EditorControls } from "@/components/three-editor/EditorControls"

// 轨道导航的手感基准是「指针下方那个东西的深度」（见 EditorControls 的类注释）。
// 这里守的就是由它派生的三条：朝光标缩放、缩放可逆、缩放后平移仍是像素 1:1。
//
// 视口尺寸取整数便于换算：宽 800 高 600。

const WIDTH = 800
const HEIGHT = 600

function createHarness(pick: THREE.Vector3 | null) {
  const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 1000)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)

  const element = document.createElement("div")
  Object.defineProperty(element, "clientHeight", { value: HEIGHT })
  Object.defineProperty(element, "clientWidth", { value: WIDTH })
  ;(element as any).setPointerCapture = () => {}
  ;(element as any).releasePointerCapture = () => {}

  const controls = new EditorControls(camera)
  controls.pickPoint = () => (pick ? pick.clone() : null)
  controls.connect(element)

  // 相机矩阵由渲染循环维护，测试里手动补上（pan 读 object.matrix）。
  const sync = () => camera.updateMatrixWorld(true)

  function wheel(deltaY: number, clientX = WIDTH / 2, clientY = HEIGHT / 2) {
    sync()
    element.dispatchEvent(
      new WheelEvent("wheel", { deltaY, clientX, clientY, cancelable: true })
    )
    sync()
  }

  function drag(button: number, from: [number, number], to: [number, number]) {
    const buttons = button === 2 ? 2 : 1
    sync()
    element.dispatchEvent(
      new MouseEvent("pointerdown", {
        button,
        buttons,
        clientX: from[0],
        clientY: from[1]
      })
    )
    sync()
    document.dispatchEvent(
      new MouseEvent("pointermove", { buttons, clientX: to[0], clientY: to[1] })
    )
    sync()
    document.dispatchEvent(
      new MouseEvent("pointerup", {
        button,
        buttons: 0,
        clientX: to[0],
        clientY: to[1]
      })
    )
    sync()
  }

  /** 世界点在画布上的像素坐标（左上角为原点）。 */
  function toScreen(point: THREE.Vector3): { x: number; y: number } {
    const ndc = point.clone().project(camera)
    return { x: ((ndc.x + 1) / 2) * WIDTH, y: ((1 - ndc.y) / 2) * HEIGHT }
  }

  /** 一次触摸指针事件（jsdom 没有 PointerEvent，按 EditorControls 真正读的那几个字段搭）。 */
  function touchEvent(
    type: string,
    pointerId: number,
    pageX: number,
    pageY: number
  ) {
    const event: any = new MouseEvent(type, { buttons: 1, cancelable: true })
    for (const [key, value] of Object.entries({
      pointerId,
      pointerType: "touch",
      pageX,
      pageY,
      clientX: pageX,
      clientY: pageY
    })) {
      Object.defineProperty(event, key, { value, configurable: true })
    }
    return event
  }

  /** 两指按下（各自 pointerdown），随后把第二根手指移到新位置。 */
  function pinch(start: [number, number], move: [number, number]) {
    sync()
    element.dispatchEvent(touchEvent("pointerdown", 1, start[0], 0))
    element.dispatchEvent(touchEvent("pointerdown", 2, start[1], 0))
    sync()
    element.ownerDocument.dispatchEvent(
      touchEvent("pointermove", 2, move[1], 0)
    )
    sync()
    element.ownerDocument.dispatchEvent(touchEvent("pointerup", 1, move[0], 0))
    element.ownerDocument.dispatchEvent(touchEvent("pointerup", 2, move[1], 0))
    sync()
  }

  return { camera, controls, element, wheel, drag, toScreen, pinch }
}

describe("EditorControls —— 缩放", () => {
  it("朝光标缩放：焦点在屏幕上的像素位置保持不动", () => {
    // 光标压在一个偏离画面中心的点上。
    const focus = new THREE.Vector3(2, 1, 0)
    const h = createHarness(focus)
    const before = h.toScreen(focus)

    h.wheel(-100, 600, 200)

    const after = h.toScreen(focus)
    expect(after.x).toBeCloseTo(before.x, 3)
    expect(after.y).toBeCloseTo(before.y, 3)
    // 确实推近了
    expect(h.camera.position.distanceTo(focus)).toBeLessThan(
      new THREE.Vector3(0, 0, 10).distanceTo(focus)
    )
  })

  it("推近再拉远同样格数回到原处（倍率互逆）", () => {
    const h = createHarness(new THREE.Vector3(2, 1, 0))
    const start = h.camera.position.clone()

    for (let i = 0; i < 5; i++) h.wheel(-100, 600, 200)
    for (let i = 0; i < 5; i++) h.wheel(100, 600, 200)

    expect(h.camera.position.distanceTo(start)).toBeLessThan(1e-6)
  })

  it("轨道中心留在视线轴上（相机始终正对着它）", () => {
    const h = createHarness(new THREE.Vector3(2, 1, 0))

    h.wheel(-100, 600, 200)

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      h.camera.quaternion
    )
    const toCenter = h.controls.center
      .clone()
      .sub(h.camera.position)
      .normalize()
    expect(toCenter.dot(forward)).toBeCloseTo(1, 6)
  })

  it("上下限是墙而不是吸附：焦点已在限外时，往回的那个方向仍然放行", () => {
    const h = createHarness(new THREE.Vector3(0, 0, -190)) // 距相机 200
    h.controls.maxDistance = 100
    const start = h.camera.position.clone()

    h.wheel(100) // 拉远：已超出上限，不该被吸到 100 处
    expect(h.camera.position.distanceTo(start)).toBeLessThan(1e-6)

    h.wheel(-100) // 推近：放行
    expect(h.camera.position.z).toBeLessThan(start.z)
  })
})

// 捏合缩放的量纲：touchstart 播种与 touchmove 每帧必须用同一个换算（见 pinchDistance）。
// 两处各写各的时，每次捏合的**第一帧**算出来的是 0.9 × 指间像素距，而缩放是 e^(Δ·zoomSpeed)
// ——两指相距 200px 即 e^18 ≈ 6.6e7，相机当场被甩到无穷远、整个场景消失。
// 指数化之前有一道 `delta.length() > distance 就返回` 的守卫一直在吞掉这个首帧，故这个错是
// 那次改写「露」出来的，不是它引入的。
describe("EditorControls —— 双指缩放", () => {
  // 量的是**到轨道中心的距离**：双指手势同时还在平移，而平移把相机与中心一起搬，故这个
  // 距离只被缩放改变（拿 camera.position.length() 量会把平移一起量进去）。
  const orbitDistance = (harness: ReturnType<typeof createHarness>) =>
    harness.camera.position.distanceTo(harness.controls.center)

  it("第一帧没有捏合动作时相机不动（播种与每帧同量纲）", () => {
    const harness = createHarness(new THREE.Vector3(0, 0, 0))
    const before = orbitDistance(harness)

    // 两指相距 200px 按下，第一帧手指没动——指间距不变即「这一帧没有缩放」。
    // 播种漏掉那个 /10 时，这一帧算出来的是 200 − 20 = 180，倍率 e^18 ≈ 6.6e7。
    harness.pinch([300, 500], [300, 500])

    expect(orbitDistance(harness)).toBeCloseTo(before, 6)
  })

  it("真的捏合才缩放，且量级与指间距的变化相称", () => {
    const harness = createHarness(new THREE.Vector3(0, 0, 0))
    const before = orbitDistance(harness)

    // 指间距 200 → 100（收拢 100px）：按同一个量纲，delta.z = (200 − 100) / 10 = 10，
    // 倍率 e^(10 × 0.1) = e ≈ 2.718，即拉远到原来的 e 倍。
    harness.pinch([300, 500], [300, 400])

    expect(orbitDistance(harness) / before).toBeCloseTo(Math.E, 6)
  })
})

describe("EditorControls —— 平移与旋转的中心", () => {
  // 指针下方那一点刻意**不在**轨道中心的深度上（它在 z=6，深度 4；轨道中心在原点，
  // 深度 10）——按中心深度标定的旧实现在这里会把画面拖出 2.5 倍的距离。
  const NEAR_FOCUS = new THREE.Vector3(0, 0, 6)

  it("右键平移按指针下方那个东西的深度做像素 1:1", () => {
    const h = createHarness(NEAR_FOCUS)

    h.drag(2, [400, 300], [500, 300])

    // 焦点在画面上应恰好右移 100 像素（相机反向平移）。
    const after = h.toScreen(NEAR_FOCUS)
    expect(after.x).toBeCloseTo(500, 2)
    expect(after.y).toBeCloseTo(300, 2)
  })

  it("缩放之后平移仍是像素 1:1（速度跟着画面尺度走）", () => {
    const h = createHarness(NEAR_FOCUS)

    for (let i = 0; i < 8; i++) h.wheel(-100)
    h.drag(2, [400, 300], [500, 300])

    const after = h.toScreen(NEAR_FOCUS)
    expect(after.x).toBeCloseTo(500, 2)
  })

  it("左键旋转绕指针下方那个东西转，而不是绕原点", () => {
    // 相机在 +Z 看向原点，光标下方是 z = 6 处的一个点（深度 4）。
    const focus = new THREE.Vector3(0, 0, 6)
    const h = createHarness(focus)

    h.drag(0, [400, 300], [460, 300])

    // 轨道中心被对到焦点深度上，故相机绕它转、与它的距离不变。
    expect(h.controls.center.z).toBeCloseTo(6, 6)
    expect(
      h.camera.position.distanceTo(new THREE.Vector3(0, 0, 6))
    ).toBeCloseTo(4, 6)
  })

  it("指针下方什么也没有时退回原有行为（轨道中心不动）", () => {
    const h = createHarness(null)
    const center = h.controls.center.clone()

    h.drag(0, [400, 300], [460, 300])

    expect(h.controls.center.distanceTo(center)).toBeLessThan(1e-9)
  })
})
