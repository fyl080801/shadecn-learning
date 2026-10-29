import { afterEach, describe, expect, it } from "vitest"
import * as THREE from "three"
import { TransformControls } from "three/addons/controls/TransformControls.js"

import {
  enableTransformShiftEven,
  evenScaleRatio,
  evenTranslateDelta,
  readPlaneAxis
} from "@/components/three-editor/transformShiftEven"

// 「拖平面手柄时按住 Shift 让两个轴等量变化」——移动即两轴位移量相等（沿平面对角线走），
// 缩放即两轴同一个倍率（不再把图形拉变形）。
//
// 这一组守两件事：约束本身的算法，以及「它是靠改写平面命中点落地的」——即整条上游链路
// （空间换算、写 position/scale、派发事件）一个字都没改。

describe("两轴等量的算法", () => {
  // 取的是正交投影到 45° 对角线（= 两者绝对值的平均），不是「取较大的那一个」：后者在
  // 横向拖 100、纵向拖 0 时会让两轴各走 100，按下 Shift 那一瞬图形直接窜出去一截。
  it("移动：量取两者绝对值的平均，象限各按自己的符号", () => {
    expect(evenTranslateDelta(10, 2)).toEqual([6, 6])
    expect(evenTranslateDelta(2, 10)).toEqual([6, 6])
    expect(evenTranslateDelta(-10, 2)).toEqual([-6, 6])
    expect(evenTranslateDelta(10, -2)).toEqual([6, -6])
    expect(evenTranslateDelta(-10, -2)).toEqual([-6, -6])
    expect(evenTranslateDelta(0, 0)).toEqual([0, 0])
    // 本来就相等时是恒等变换（Shift 不该把「已经很齐」的拖动再挪一下）。
    expect(evenTranslateDelta(7, 7)).toEqual([7, 7])
  })

  it("缩放：取平面内两分量的径向比值，反向即镜像", () => {
    expect(evenScaleRatio(2, 2, 4, 4)).toBeCloseTo(2, 10)
    expect(evenScaleRatio(2, 2, 1, 1)).toBeCloseTo(0.5, 10)
    expect(evenScaleRatio(2, 2, -4, -4)).toBeCloseTo(-2, 10)
    // 起点贴着原点时给不出比值——那时任何倍率都成立。
    expect(evenScaleRatio(0, 0, 4, 4)).toBe(null)
  })

  it("只认平面手柄：单轴只有一个轴，XYZ 本来就是等比", () => {
    expect(readPlaneAxis("XY")).toBe("XY")
    expect(readPlaneAxis("YZ")).toBe("YZ")
    expect(readPlaneAxis("XZ")).toBe("XZ")
    expect(readPlaneAxis("X")).toBe(null)
    expect(readPlaneAxis("XYZ")).toBe(null)
    expect(readPlaneAxis("E")).toBe(null)
    expect(readPlaneAxis(null)).toBe(null)
  })
})

// ————————————————————————————————————————————————————————
// 与真的 TransformControls 一起跑
// ————————————————————————————————————————————————————————

const RECT = { left: 0, top: 0, width: 400, height: 300 }

function ndc(clientX: number, clientY: number, button: number) {
  return {
    x: (clientX / RECT.width) * 2 - 1,
    y: -(clientY / RECT.height) * 2 + 1,
    button
  }
}

function setupControls(mode: "translate" | "scale") {
  const dom = document.createElement("div")
  dom.getBoundingClientRect = () => RECT as DOMRect
  // jsdom 没有指针捕获，TransformControls 的 pointerdown 会调它们。
  dom.setPointerCapture = () => {}
  dom.releasePointerCapture = () => {}

  const camera = new THREE.PerspectiveCamera(
    50,
    RECT.width / RECT.height,
    0.1,
    1000
  )
  camera.position.set(6, 7, 8)
  camera.lookAt(0, 0, 0)

  const scene = new THREE.Scene()
  const object = new THREE.Object3D()
  scene.add(object)

  const controls: any = new TransformControls(camera, dom)
  controls.setMode(mode)
  controls.attach(object)
  scene.add(controls.getHelper())
  const off = enableTransformShiftEven(controls)

  /** 记一次指针位置（模块级跟踪靠指针事件，按键事件本身不带坐标）。 */
  function trackPointer(clientX: number, clientY: number, shiftKey: boolean) {
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX, clientY, shiftKey })
    )
  }

  function press(
    clientX: number,
    clientY: number,
    axis: string,
    shiftKey = false
  ) {
    trackPointer(clientX, clientY, shiftKey)
    controls.axis = axis
    scene.updateMatrixWorld(true)
    controls.pointerDown(ndc(clientX, clientY, 0))
  }

  function drag(clientX: number, clientY: number, shiftKey: boolean) {
    trackPointer(clientX, clientY, shiftKey)
    controls.pointerMove(ndc(clientX, clientY, -1))
  }

  function shift(held: boolean, clientX: number, clientY: number) {
    trackPointer(clientX, clientY, held)
    window.dispatchEvent(
      new KeyboardEvent(held ? "keydown" : "keyup", {
        key: "Shift",
        shiftKey: held
      })
    )
  }

  return { controls, object, off, press, drag, shift }
}

describe("拖平面手柄时按/松 Shift", () => {
  afterEach(() => {
    // 模块级的 Shift 状态跨用例存活，收干净。
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Shift", shiftKey: false })
    )
  })

  it("移动：按下 Shift 即两轴同量，量取自由拖动那两个量的平均，松开回到指针处", () => {
    const rig = setupControls("translate")
    rig.press(200, 150, "XZ")
    rig.drag(275, 130, false)

    const free = rig.object.position.clone()
    // 自由拖平面手柄：两轴各走各的（这正是「变化不均」）。
    expect(Math.abs(free.x)).toBeGreaterThan(0.01)
    expect(Math.abs(free.z)).toBeGreaterThan(0.01)
    expect(Math.abs(Math.abs(free.x) - Math.abs(free.z))).toBeGreaterThan(0.01)
    expect(free.y).toBeCloseTo(0, 10) // 平面之外那一轴照旧不动

    // 按下 Shift 当场生效（不必等下一次指针移动）。
    rig.shift(true, 275, 130)
    const even = rig.object.position.clone()
    expect(Math.abs(even.x)).toBeCloseTo(Math.abs(even.z), 10)
    // 落点正是自由拖动那两个量的平均——即把位移正交投影到平面对角线上。
    const size = (Math.abs(free.x) + Math.abs(free.z)) / 2
    expect(Math.abs(even.x)).toBeCloseTo(size, 10)
    // 象限不变：往哪个角上拖就往哪个角上走。
    expect(Math.sign(even.x)).toBe(Math.sign(free.x))
    expect(Math.sign(even.z)).toBe(Math.sign(free.z))
    expect(even.y).toBeCloseTo(0, 10)

    // 按住期间继续拖，仍然同量。
    rig.drag(300, 100, true)
    expect(Math.abs(rig.object.position.x)).toBeCloseTo(
      Math.abs(rig.object.position.z),
      10
    )

    // 松开即回到指针真正的落点（与同一位置自由拖动的结果一致）。
    rig.shift(false, 300, 100)
    const released = rig.object.position.clone()
    rig.drag(300, 100, false)
    expect(rig.object.position.distanceTo(released)).toBeCloseTo(0, 10)
    expect(
      Math.abs(Math.abs(released.x) - Math.abs(released.z))
    ).toBeGreaterThan(0.01)

    rig.off()
  })

  it("缩放：按下 Shift 即两轴同倍率，平面之外那一轴不动", () => {
    const rig = setupControls("scale")
    rig.press(240, 110, "XY")
    rig.drag(280, 100, false)

    const free = rig.object.scale.clone()
    expect(Math.abs(free.x - free.y)).toBeGreaterThan(0.01) // 自由拖：被拉变形
    expect(free.z).toBeCloseTo(1, 10)

    rig.shift(true, 280, 100)
    const even = rig.object.scale.clone()
    expect(even.x).toBeCloseTo(even.y, 10) // 起始倍率同为 1，故等比 = 两分量相等
    expect(even.z).toBeCloseTo(1, 10)
    expect(Math.abs(even.x - free.x)).toBeGreaterThan(1e-6)

    rig.drag(300, 90, true)
    expect(rig.object.scale.x).toBeCloseTo(rig.object.scale.y, 10)
    expect(rig.object.scale.z).toBeCloseTo(1, 10)

    rig.off()
  })

  it("单轴手柄上按 Shift 不插手（那儿只有一个轴）", () => {
    const rig = setupControls("translate")
    rig.press(200, 150, "X")
    rig.drag(260, 130, false)
    const free = rig.object.position.clone()

    rig.shift(true, 260, 130)
    expect(rig.controls.axis).toBe("X") // 也不去换轴
    expect(rig.object.position.distanceTo(free)).toBeCloseTo(0, 10)
    rig.drag(280, 120, true)
    expect(rig.object.position.y).toBeCloseTo(0, 10)
    expect(rig.object.position.z).toBeCloseTo(0, 10)

    rig.off()
  })

  it("按下手柄那一刻的起点不受约束（约束是相对起点定义的）", () => {
    const rig = setupControls("translate")
    rig.shift(true, 200, 150)
    rig.press(200, 150, "XZ", true)
    // 起点没被挪过：此刻还没有任何位移。
    expect(rig.object.position.length()).toBeCloseTo(0, 10)
    // 而且约束立刻可用。
    rig.drag(275, 130, true)
    expect(Math.abs(rig.object.position.x)).toBeCloseTo(
      Math.abs(rig.object.position.z),
      10
    )
    rig.off()
  })

  it("卸载之后不再接管", () => {
    const rig = setupControls("translate")
    rig.press(200, 150, "XZ")
    rig.drag(275, 130, false)
    const free = rig.object.position.clone()
    rig.off()

    rig.press(200, 150, "XZ")
    rig.drag(275, 130, true)
    expect(rig.object.position.distanceTo(free)).toBeCloseTo(0, 10)
  })
})
