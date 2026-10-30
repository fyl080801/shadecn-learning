import { describe, expect, it, vi } from "vitest"
import * as THREE from "three"
import {
  readDirectorScene,
  directorObjectKey,
  directorTrackKey,
  directorKeyframeKey
} from "@shadecn/shared/director-doc"
import { compileDirectorTimeline } from "@shadecn/shared/director-eval"
import { createDirectorProjection, directorIdOf } from "@/components/director/directorProjection"
import { getObjectCenterNode } from "@/components/director/directorObjectCenter"

/**
 * 「Y.Doc → three 场景」的对账器（docs/07 §7.6）：按 id 增量建 / 改 / 删，只动变了的；
 * 几何约定照 three（平面水平、圆柱上下同径、机位 fov 以度）；求值用 shared 的 objectStateAt。
 */

const box = (name: string, extra: Record<string, unknown> = {}) => ({
  kind: "box",
  name,
  position: [0, 0.5, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  geometry: { width: 1, height: 1, depth: 1 },
  ...extra
})

function sceneOf(objects: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...extra }
  for (const [id, value] of Object.entries(objects)) data[directorObjectKey(id)] = value
  return readDirectorScene(data)
}

function fakeHost() {
  return { add: vi.fn<(o: THREE.Object3D) => void>(), remove: vi.fn<(o: THREE.Object3D) => void>(), changed: vi.fn<(o: THREE.Object3D) => void>() }
}

describe("导演台投影的对账", () => {
  it("新增 / 改 / 删只动变了的对象；没变的保持同一个 Object3D", () => {
    const host = fakeHost()
    const projection = createDirectorProjection(host)
    expect(projection.reconcile(sceneOf({ a: box("甲"), b: box("乙"), c: box("丙") }))).toEqual({
      added: ["a", "b", "c"],
      updated: [],
      removed: []
    })
    const a = projection.objectOf("a")!
    const b = projection.objectOf("b")!
    expect(directorIdOf(a)).toBe("a")
    expect(host.add).toHaveBeenCalledTimes(3)

    // 只改乙的颜色、删丙、加丁；甲只是挪了位置（变换不算对账，由求值写）
    const result = projection.reconcile(
      sceneOf({
        a: box("甲", { position: [5, 0.5, 0] }),
        b: box("乙", { material: { color: "#ff0000" } }),
        d: box("丁")
      })
    )
    expect(result).toEqual({ added: ["d"], updated: ["b"], removed: ["c"] })
    expect(projection.objectOf("a")).toBe(a)
    expect(projection.objectOf("b")).toBe(b)
    expect(host.changed).toHaveBeenCalledTimes(1)
    expect(host.changed).toHaveBeenCalledWith(b)
    expect(host.remove).toHaveBeenCalledTimes(1)
    const mesh = getObjectCenterNode(b) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
    expect(mesh.material.color.getHexString()).toBe("ff0000")

    // 原样再对一次：什么都不动
    host.changed.mockClear()
    expect(projection.reconcile(sceneOf({ a: box("甲"), b: box("乙", { material: { color: "#ff0000" } }), d: box("丁") }))).toEqual({
      added: [],
      updated: [],
      removed: []
    })
    expect(host.changed).not.toHaveBeenCalled()
  })

  it("种类变了就删了重建", () => {
    const host = fakeHost()
    const projection = createDirectorProjection(host)
    projection.reconcile(sceneOf({ a: box("甲") }))
    const before = projection.objectOf("a")
    const result = projection.reconcile(
      sceneOf({ a: { kind: "sphere", name: "甲", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], geometry: { radius: 1 } } })
    )
    expect(result).toEqual({ added: ["a"], updated: [], removed: ["a"] })
    expect(projection.objectOf("a")).not.toBe(before)
  })

  it("几何约定：平面水平铺在 XZ 面，圆柱上下同径，机位 fov 以度、带 isDirectorShot", () => {
    const projection = createDirectorProjection(fakeHost())
    projection.reconcile(
      sceneOf({
        p: { kind: "plane", name: "地", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], geometry: { width: 4, depth: 2 } },
        c: { kind: "cylinder", name: "柱", position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], geometry: { radius: 0.3, height: 2 } },
        cam: { kind: "camera", name: "机位1", position: [0, 1.6, 6], rotation: [0, 0, 0], scale: [1, 1, 1], camera: { fov: 35, near: 0.1, far: 500 } },
        l: { kind: "light", name: "灯", position: [3, 5, 3], rotation: [0, 0, 0], scale: [1, 1, 1], light: { type: "point", intensity: 2, color: "#ffeeaa" } }
      })
    )
    const plane = getObjectCenterNode(projection.objectOf("p")) as THREE.Mesh
    plane.geometry.computeBoundingBox()
    const size = plane.geometry.boundingBox!.getSize(new THREE.Vector3())
    expect([size.x, size.y, size.z].map((v) => +v.toFixed(6))).toEqual([4, 0, 2])

    const cylinder = getObjectCenterNode(projection.objectOf("c")) as THREE.Mesh<THREE.CylinderGeometry>
    expect(cylinder.geometry.parameters.radiusTop).toBe(0.3)
    expect(cylinder.geometry.parameters.radiusBottom).toBe(0.3)

    const camera = projection.objectOf("cam") as THREE.PerspectiveCamera
    expect(camera.isPerspectiveCamera).toBe(true)
    expect(camera.fov).toBe(35)
    expect(camera.userData.isDirectorShot).toBe(true)

    const light = projection.objectOf("l") as THREE.PointLight
    expect(light.isPointLight).toBe(true)
    expect(light.intensity).toBe(2)
  })

  it("求值：变换来自 objectStateAt（有关键帧按插值，没有按静态值），机位 fov 跟着关键帧", () => {
    const projection = createDirectorProjection(fakeHost())
    const data: Record<string, unknown> = {
      [directorObjectKey("a")]: box("甲", { position: [1, 0.5, 0] }),
      [directorObjectKey("cam")]: { kind: "camera", name: "机位", position: [0, 1, 5], rotation: [0, 0, 0], scale: [1, 1, 1], camera: { fov: 50, near: 0.1, far: 100 } },
      [directorTrackKey("t1")]: { objectId: "cam", property: "fov", interp: "linear" },
      [directorKeyframeKey("k1")]: { trackId: "t1", t: 0, value: 20 },
      [directorKeyframeKey("k2")]: { trackId: "t1", t: 1000, value: 60 }
    }
    const scene = readDirectorScene(data)
    projection.reconcile(scene)
    projection.applyStateAt(compileDirectorTimeline(scene), 500)
    expect(projection.objectOf("a")!.position.toArray()).toEqual([1, 0.5, 0])
    expect((projection.objectOf("cam") as THREE.PerspectiveCamera).fov).toBeCloseTo(40, 9)
  })

  it("正被拖着的对象求值时跳过（本地草稿占着屏幕）", () => {
    const projection = createDirectorProjection(fakeHost())
    const scene = sceneOf({ a: box("甲") })
    projection.reconcile(scene)
    const object = projection.objectOf("a")!
    object.position.set(9, 9, 9)
    projection.applyStateAt(compileDirectorTimeline(scene), 0, new Set([object]))
    expect(object.position.toArray()).toEqual([9, 9, 9])
    projection.applyStateAt(compileDirectorTimeline(scene), 0)
    expect(object.position.toArray()).toEqual([0, 0.5, 0])
  })
})
