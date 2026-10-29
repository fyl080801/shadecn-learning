import { afterEach, describe, expect, it } from "vitest"
import * as THREE from "three"

import {
  CENTER_PIVOT_NAME,
  applyDefaultCharacterCenter,
  getObjectCenter,
  getObjectCenterWorld,
  matchObjectCenterAnchor,
  resolveObjectCenterAnchor,
  setObjectCenter
} from "@/components/director/directorObjectCenter"
import {
  getRigRootBone,
  measureCharacterRig,
  mergeCharacterRig,
  resolveCharacterRig,
  seedCharacterRig,
  type CharacterRig
} from "@/components/director/characterRig"

/**
 * 一具**按真实素体的形状**搭出来的装配：FBX 根带 0.01 单位缩放、骨骼坐标是厘米、脚底网格
 * 比最低骨骼还低一截。数值照 y-bot 实测取整（胯 99.79cm、最低骨骼 3.11cm、鞋底 −0.01cm）。
 *
 * 这些用例必须拿**带单位缩放**的装配验：缩放为 1 时「量在哪一层」这类错误全部看不出来，
 * 而那正是这套代码踩过的坑（把厘米当米写进中心位置，模型飞出去几十米）。
 */
function fbxLikeCharacter(
  options: { hipsY?: number; hipsZ?: number; tiltXDeg?: number } = {}
) {
  const { hipsY = 99.7919, hipsZ = 0, tiltXDeg = 0 } = options

  const root = new THREE.Group()
  root.userData.unitScaleFactor = 1
  root.scale.setScalar(0.01)

  const hips = new THREE.Bone()
  hips.name = "mixamorigHips"
  hips.position.set(0, hipsY, hipsZ)
  hips.rotation.x = THREE.MathUtils.degToRad(tiltXDeg)
  root.add(hips)

  // 最低骨骼：脚趾末端，落在 3.1084cm。
  const toe = new THREE.Bone()
  toe.name = "mixamorigLeftToe_End"
  // 骨骼是 hips 的子节点，故这里给的是相对 hips 的偏移；带上倾角时用世界量反推太绕，
  // 直接挂在 root 下另起一条链——本用例只关心「最低骨骼在哪儿」。
  toe.position.set(0, 3.1084 - hipsY, 0)
  hips.add(toe)

  // 蒙皮网格：鞋底 −0.0102cm、头顶 180.4632cm（= 身高 1.8047m）。
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  geometry.translate(0, 0, 0)
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(-97.34, -0.0102, -16.05),
    new THREE.Vector3(97.34, 180.4632, 20.38)
  )
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  root.add(mesh)

  return { root, hips, toe, mesh }
}

/** 三层装配 wrapper → pivot → content，content 即上面那具 FBX 根。 */
function assembled(
  presetKey: string,
  options?: Parameters<typeof fbxLikeCharacter>[0]
) {
  const { root, hips } = fbxLikeCharacter(options)
  const wrapper = new THREE.Group()
  wrapper.userData.isCharacter = true
  wrapper.userData.characterPreset = presetKey
  const pivot = new THREE.Group()
  pivot.name = CENTER_PIVOT_NAME
  pivot.userData.isCenterPivot = true
  pivot.add(root)
  wrapper.add(pivot)
  return { wrapper, pivot, content: root, hips }
}

const seeded: string[] = []
function seed(presetKey: string, rig: CharacterRig | null) {
  seeded.push(presetKey)
  seedCharacterRig(presetKey, rig)
}

afterEach(() => {
  for (const key of seeded.splice(0)) seedCharacterRig(key, null)
})

describe("实测装配元数据", () => {
  it("量在父层空间、单位是米——不是骨骼那一层的厘米", () => {
    const { root } = fbxLikeCharacter()
    const rig = measureCharacterRig(root)!

    expect(rig.rootBone).toBe("mixamorigHips")
    expect(rig.unitScale).toBeCloseTo(0.01, 12)
    // 99.7919cm → 0.997919m。量在 content 自己的局部空间会得到 99.79，那正是踩过的坑。
    expect(rig.hips[1]).toBeCloseTo(0.997919, 6)
    expect(rig.boneFloor).toBeCloseTo(0.031084, 6)
    expect(rig.height).toBeCloseTo(1.804734, 6)
  })

  it("接地间隙 = 最低骨骼 − 网格着地面（骨骼末端不在鞋底上）", () => {
    const { root } = fbxLikeCharacter()
    const rig = measureCharacterRig(root)!
    // 3.1084cm − (−0.0102cm) = 3.1186cm。这一段只有量网格才拿得到。
    expect(rig.groundClearance).toBeCloseTo(0.031186, 6)
  })

  it("根骨静置倾角要把单位缩放除掉再解（decompose，不是 setFromRotationMatrix）", () => {
    const { root } = fbxLikeCharacter({ tiltXDeg: 0.7401 })
    const rig = measureCharacterRig(root)!
    // 这条链上带着 0.01 的缩放。按 trace 解四元数会把 0.74° 读成 0.01°——实测踩过。
    expect(rig.rootRestTilt[0]).toBeCloseTo(0.7401, 3)
    expect(rig.rootRestTilt[1]).toBeCloseTo(0, 6)
    expect(rig.rootRestTilt[2]).toBeCloseTo(0, 6)
  })

  it("正面轴是规范给的约定，不从脚趾方向量", () => {
    const { root } = fbxLikeCharacter()
    expect(measureCharacterRig(root)!.forward).toEqual([0, 0, 1])
  })

  it("没有骨骼的模型给 null（刚体走包围盒那条）", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    expect(measureCharacterRig(mesh)).toBeNull()
    expect(getRigRootBone(mesh)).toBeNull()
  })
})

describe("manifest 的声明覆盖实测", () => {
  it("声明了哪几项就盖哪几项，其余保留实测值", () => {
    const { root } = fbxLikeCharacter()
    const measured = measureCharacterRig(root)!
    const merged = mergeCharacterRig(measured, { groundClearance: 0.05 })!

    expect(merged.groundClearance).toBe(0.05)
    expect(merged.hips).toEqual(measured.hips)
    expect(merged.height).toBe(measured.height)
  })

  it("空声明 / undefined 项不把实测值抹掉", () => {
    const { root } = fbxLikeCharacter()
    const measured = measureCharacterRig(root)!

    expect(mergeCharacterRig(measured, {})).toEqual(measured)
    expect(mergeCharacterRig(measured, undefined)).toEqual(measured)
    expect(mergeCharacterRig(measured, { hips: undefined })!.hips).toEqual(
      measured.hips
    )
  })

  it("实测不出来（不是骨骼模型）时，声明也救不回来", () => {
    expect(mergeCharacterRig(null, { boneFloor: 1 })).toBeNull()
  })
})

describe("中心基准按元数据给答案", () => {
  it("「中心」= 胯，「底部」= 骨骼底扣掉接地间隙", () => {
    const { wrapper, content } = assembled("male")
    seed("male", mergeCharacterRig(measureCharacterRig(content), null))

    expect(resolveObjectCenterAnchor(wrapper, "center")!.y).toBeCloseTo(
      0.997919,
      6
    )
    // 0.031084 − 0.031186 ≈ −0.0001：鞋底正好落在对象原点上。不扣接地间隙的话是
    // +0.031084，用户选「底部」时人会陷进地里 3.1cm。
    expect(resolveObjectCenterAnchor(wrapper, "bottom")!.y).toBeCloseTo(
      -0.000102,
      6
    )
  })

  it("元数据量的是没挪过的模型，故已经落过中心之后答案不变（不叠 applied）", () => {
    const { wrapper, content } = assembled("male")
    seed("male", mergeCharacterRig(measureCharacterRig(content), null))

    const before = resolveObjectCenterAnchor(wrapper, "center")!
    setObjectCenter(wrapper, { x: 0, y: 0.9, z: 0 })
    const after = resolveObjectCenterAnchor(wrapper, "center")!

    expect(after.y).toBeCloseTo(before.y, 12)
    // 内容确实被挪过了——上面那条不是因为什么都没发生。
    expect(content.position.y).toBeCloseTo(-0.9, 12)
  })

  it("两具装配的差异全部由各自的元数据吸收", () => {
    const male = assembled("male")
    seed("male", mergeCharacterRig(measureCharacterRig(male.content), null))
    const female = assembled("female", { hipsY: 104.2749, hipsZ: 1.5543 })
    seed(
      "female",
      mergeCharacterRig(measureCharacterRig(female.content), {
        // female 的最低骨骼恰好落在鞋底上（实测差 0.35mm）。
        boneFloor: 0.000001,
        groundClearance: 0.000352
      })
    )

    expect(resolveObjectCenterAnchor(male.wrapper, "center")!.y).toBeCloseTo(
      0.997919,
      6
    )
    expect(resolveObjectCenterAnchor(female.wrapper, "center")!.y).toBeCloseTo(
      1.042749,
      6
    )
    // 胯的 z 也不一样，中心得跟着偏——只盯着 y 会漏掉它。
    expect(resolveObjectCenterAnchor(female.wrapper, "center")!.z).toBeCloseTo(
      0.015543,
      6
    )

    // 归一之后两具素体的「底部」都是「鞋底落在原点上」，差值在毫米级。
    const maleBottom = resolveObjectCenterAnchor(male.wrapper, "bottom")!.y
    const femaleBottom = resolveObjectCenterAnchor(female.wrapper, "bottom")!.y
    expect(Math.abs(maleBottom - femaleBottom)).toBeLessThan(0.001)
  })

  it("没有元数据的骨骼模型退回实测骨架（底部仍是最低骨骼）", () => {
    const { wrapper } = assembled("unknown-preset")
    expect(resolveCharacterRig(wrapper)).toBeNull()
    // 回退路只看骨骼，故拿到的是 boneFloor 本身，不扣接地间隙。
    expect(resolveObjectCenterAnchor(wrapper, "bottom")!.y).toBeCloseTo(
      0.031084,
      6
    )
  })
})

describe("新建角色的默认中心", () => {
  it("落成「底部」，且面板读数就是「底部」而不是「自定义」", () => {
    const { wrapper, content } = assembled("male")
    seed("male", mergeCharacterRig(measureCharacterRig(content), null))

    applyDefaultCharacterCenter(wrapper)

    expect(getObjectCenter(wrapper).y).toBeCloseTo(-0.000102, 6)
    expect(matchObjectCenterAnchor(wrapper)).toBe("bottom")
  })

  it("已经有中心位置就不动它（场景恢复回填过的那一份）", () => {
    const { wrapper, content } = assembled("male")
    seed("male", mergeCharacterRig(measureCharacterRig(content), null))
    setObjectCenter(wrapper, { x: 0, y: 0.9, z: 0 })

    applyDefaultCharacterCenter(wrapper)

    expect(getObjectCenter(wrapper).y).toBeCloseTo(0.9, 12)
  })

  it("解析不出基准时什么也不做——编一个中心比没有中心糟糕", () => {
    const bare = new THREE.Group()
    bare.userData.isCharacter = true
    applyDefaultCharacterCenter(bare)
    expect(getObjectCenter(bare)).toEqual({ x: 0, y: 0, z: 0 })
  })
})

describe("注视参照点", () => {
  it("有骨架的角色取 rig 根骨骼，不是脚底原点", () => {
    const { wrapper, content } = assembled("male")
    seed("male", mergeCharacterRig(measureCharacterRig(content), null))
    applyDefaultCharacterCenter(wrapper)
    wrapper.updateMatrixWorld(true)

    const point = getObjectCenterWorld(wrapper, new THREE.Vector3())
    // 胯高 0.997919，内容又被默认中心（−0.000102）往上挪了那一点点。
    expect(point.y).toBeCloseTo(0.998021, 5)
    // 要紧的是这一条：默认中心落成脚底之后 hasObjectCenter 为真，照旧逻辑会返回**对象
    // 原点**（≈0），机位跟随会当场对准角色的鞋。
    expect(wrapper.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(0, 6)
    expect(point.y).toBeGreaterThan(0.9)
  })

  it("随姿势走：胯一动，注视点跟着动（包围盒中心做不到这件事）", () => {
    const { wrapper, content, hips } = assembled("male")
    seed("male", mergeCharacterRig(measureCharacterRig(content), null))
    wrapper.updateMatrixWorld(true)
    const before = getObjectCenterWorld(wrapper, new THREE.Vector3()).y

    // 下蹲：髋部下沉 20cm（骨骼那一层的单位是厘米）。
    hips.position.y -= 20
    wrapper.updateMatrixWorld(true)
    const after = getObjectCenterWorld(wrapper, new THREE.Vector3()).y

    expect(before - after).toBeCloseTo(0.2, 6)
  })

  it("群众分组不认第一个成员的胯——那会让整队人只跟着排头", () => {
    const group = new THREE.Group()
    group.userData.isCrowdGroup = true
    const first = assembled("male")
    first.wrapper.position.set(-2, 0, 0)
    const second = assembled("male")
    second.wrapper.position.set(2, 0, 0)
    group.add(first.wrapper, second.wrapper)
    group.updateMatrixWorld(true)

    // 分组没有 isCharacter 标记，故走包围盒中心：两个成员的正中间。
    const point = getObjectCenterWorld(group, new THREE.Vector3())
    expect(point.x).toBeCloseTo(0, 6)
  })
})
