import { describe, expect, it } from "vitest"
import * as THREE from "three"

import { resolveSelectionTarget } from "@/components/three-editor/Selector"

/** `intersectObjects` 的结果按 distance 升序，故命中列表的第一项就是「前面那个」。 */
function hit(object: THREE.Object3D, distance: number): THREE.Intersection {
  return {
    object,
    distance,
    point: new THREE.Vector3(),
    face: null
  } as THREE.Intersection
}

describe("resolveSelectionTarget —— 遮挡时只选中最前面那个", () => {
  it("前后两个图形都被射线穿过时，取距离最近的那个", () => {
    const front = new THREE.Mesh()
    front.name = "front"
    const back = new THREE.Mesh()
    back.name = "back"

    expect(resolveSelectionTarget([hit(front, 1), hit(back, 5)])).toBe(front)
  })

  it("最前面那个已经是选中态时，重复点击仍解析到它（不轮换到被挡住的那个）", () => {
    const front = new THREE.Mesh()
    const back = new THREE.Mesh()
    const intersects = [hit(front, 1), hit(back, 5)]

    // 交替选择现象的判据：连续几次同样的命中必须给出同一个答案。
    expect(resolveSelectionTarget(intersects)).toBe(front)
    expect(resolveSelectionTarget(intersects)).toBe(front)
    expect(resolveSelectionTarget(intersects)).toBe(front)
  })

  it("点在空白处（无命中）解析为 null，即取消选中", () => {
    expect(resolveSelectionTarget([])).toBeNull()
  })

  // 冒泡认的是「图形本体的根」这一个标记（SHAPE_CONTAINER_FLAG）：createCharacterContainer
  // 与 createShapeContainer 都会打上它，故角色与普通图形在这里是同一条路。
  it("命中角色的身体网格解析到角色根组，而不是网格本身", () => {
    const character = new THREE.Group()
    character.userData.isCharacter = true
    character.userData.isShapeContainer = true
    const body = new THREE.Mesh()
    character.add(body)

    expect(resolveSelectionTarget([hit(body, 1)])).toBe(character)
  })

  it("命中群众分组内的成员解析到分组", () => {
    const group = new THREE.Group()
    group.userData.isCrowdGroup = true
    const member = new THREE.Group()
    member.userData.isCharacter = true
    member.userData.isShapeContainer = true
    const body = new THREE.Mesh()
    member.add(body)
    group.add(member)

    expect(resolveSelectionTarget([hit(body, 1)])).toBe(group)
  })

  it("命中带 userData.object 的辅助器（picker）解析回它代表的对象", () => {
    const target = new THREE.Mesh()
    const picker = new THREE.Mesh()
    picker.name = "picker"
    picker.userData.object = target

    expect(resolveSelectionTarget([hit(picker, 1)])).toBe(target)
  })

  it("机位模型的子网格解析到相机本身", () => {
    const camera = new THREE.PerspectiveCamera()
    const model = new THREE.Group()
    const part = new THREE.Mesh()
    model.add(part)
    camera.add(model)

    expect(resolveSelectionTarget([hit(part, 1)])).toBe(camera)
  })
})

describe("resolveSelectionTarget —— 三层装配的图形", () => {
  // 工具栏加的几何体自 createShapeContainer 起是 root → pivot → 网格：射线命中的是里面
  // 那个网格，而选中必须落在 root 上——它才是时间轴轨道、序列化、gizmo 认的那一个。
  it("命中三层装配里的网格解析到装配根，而不是网格本身", () => {
    const root = new THREE.Group()
    root.userData.isShapeContainer = true
    const pivot = new THREE.Group()
    pivot.userData.isCenterPivot = true
    const mesh = new THREE.Mesh()
    pivot.add(mesh)
    root.add(pivot)

    expect(resolveSelectionTarget([hit(mesh, 1)])).toBe(root)
  })

  // 存量场景在迁移前仍是裸网格（根就是它自己），这条路必须原样成立。
  it("没有装配根的裸网格仍解析为它自己", () => {
    const mesh = new THREE.Mesh()
    expect(resolveSelectionTarget([hit(mesh, 1)])).toBe(mesh)
  })
})
