import { describe, expect, it } from "vitest"
import * as THREE from "three"

import {
  captureAuthored,
  getEvaluated,
  writeAuthored,
  readAuthored,
  setEvaluated,
  suspendEvaluated
} from "@/components/three-editor/EvaluatedTransform"

// authored（用户/关键帧写的那一份）与 evaluated（约束求值算出来的那一份）分开：派生变换
// 只声明自己的分量，节点上的值由求值层合成。此前每个派生功能各自在 userData 里存一份基准，
// 三份拷贝各自处理「怎么还原」「序列化怎么摘」，漏一处就是数据里存进了派生量。

function node(): THREE.Group {
  const object = new THREE.Group()
  object.position.set(1, 2, 3) // 模型自带的内部偏移：authored 必须原样保留
  return object
}

describe("求值层：位移通道", () => {
  it("各方分量叠加在 authored 之上，互不覆盖（含落在同一根轴上时）", () => {
    const object = node()

    setEvaluated(object, "footSnap", "position", [0, 0.5, 0])
    // 刻意让它也带竖向分量：两方落在同一根轴上，正是各写各的时会互相覆盖的情形。
    setEvaluated(object, "rootMotion", "position", [0.9, 0.2, -0.2])

    expect(object.position.toArray()).toEqual([1.9, 2.7, 2.8])
    expect(readAuthored(object, "position")).toEqual([1, 2, 3])
  })

  it("撤掉某一方只撤掉它自己那一份", () => {
    const object = node()
    setEvaluated(object, "footSnap", "position", [0, 0.5, 0])
    setEvaluated(object, "rootMotion", "position", [0.1, 0.2, 0.3])

    setEvaluated(object, "rootMotion", "position", null)

    expect(object.position.toArray()).toEqual([1, 2.5, 3])
    expect(getEvaluated(object, "footSnap", "position")).toEqual([0, 0.5, 0])
    expect(getEvaluated(object, "rootMotion", "position")).toBeNull()
  })

  // authored 是「首次贡献之前那一刻的值」。每次都重抄的话，第二轮求值就把上一轮的结果并进
  // 了 authored，位移会一路累加出去。
  it("反复声明同一份分量不累加，全部撤掉即回到 authored", () => {
    const object = node()
    for (let i = 0; i < 5; i++) {
      setEvaluated(object, "rootMotion", "position", [0.4, 0, 0.4])
      setEvaluated(object, "footSnap", "position", [0, 0.1, 0])
    }
    expect(object.position.toArray()).toEqual([1.4, 2.1, 3.4])

    setEvaluated(object, "rootMotion", "position", null)
    setEvaluated(object, "footSnap", "position", null)
    expect(object.position.toArray()).toEqual([1, 2, 3])
  })
})

describe("求值层：旋转通道", () => {
  it("分量左乘在 authored 之上——在父层空间里再转一次", () => {
    const object = new THREE.Group()
    object.rotation.z = Math.PI / 2 // authored：用户摆的角度
    const authored = object.quaternion.clone()
    const contribution = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, Math.PI / 2, 0)
    )

    setEvaluated(object, "motionTangent", "quaternion", contribution.toArray())

    const expected = contribution.clone().multiply(authored)
    expect(object.quaternion.angleTo(expected)).toBeCloseTo(0, 6)
    // 撤掉即还原用户摆的那一份。
    setEvaluated(object, "motionTangent", "quaternion", null)
    expect(object.quaternion.angleTo(authored)).toBeCloseTo(0, 10)
  })

  // 按通道分别记账：骨骼的 quaternion 归姿势管、position 归贴地管，两者互不打扰。
  it("只有被写过的通道会被重算", () => {
    const object = node()
    setEvaluated(object, "footSnap", "position", [0, 0.5, 0])

    // 姿势直接改 quaternion（求值层没碰过这个通道）。
    object.quaternion.setFromEuler(new THREE.Euler(0.3, 0, 0))
    const posed = object.quaternion.clone()
    setEvaluated(object, "footSnap", "position", [0, 0.8, 0])

    // angleTo 走 acos，零附近会把 1e-16 的浮点误差放大到 1e-8，故取 6 位。
    expect(object.quaternion.angleTo(posed)).toBeCloseTo(0, 6)
    expect(object.position.y).toBe(2.8)
  })
})

describe("外部改动的认领", () => {
  // 求值层写下去之后，节点上的值若又变了，那一定是别人动的手（gizmo 拖拽、属性面板命令、
  // 撤销回退）——那些改动表达的都是 authored，故收作新的 authored 继续在其上合成。没有这
  // 一步的话，轨迹段里拖一下旋转 gizmo 会被下一帧打回去（表现为「转不动」）。
  it("别人改过节点之后，对象停在被改到的地方（旋转收的是增量，不是绝对值）", () => {
    const object = new THREE.Group()
    const contribution = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0, Math.PI / 2, 0))
      .toArray()

    setEvaluated(object, "motionTangent", "quaternion", contribution)
    // 用户拖了 gizmo（直接改节点）——写下去的是他在视口里看到的那份世界朝向。
    object.rotation.set(0, Math.PI / 4, 0)
    const dragged = object.quaternion.clone()
    setEvaluated(object, "motionTangent", "quaternion", contribution)

    // 重新合成之后仍是那一份：分量已经在节点上了，按绝对值收会把它再左乘一遍
    // （45° → 135°），表现是「松手之后又多转了一整个分量」。
    expect(object.quaternion.angleTo(dragged)).toBeCloseTo(0, 6)
    // authored 收的是那份世界差量的共轭，故撤掉分量剩下的是 分量⁻¹ · 拖到的朝向。
    setEvaluated(object, "motionTangent", "quaternion", null)
    const expectedAuthored = new THREE.Quaternion()
      .fromArray(contribution)
      .invert()
      .multiply(dragged)
    expect(object.quaternion.angleTo(expectedAuthored)).toBeCloseTo(0, 6)
  })

  // 没有任何分量时本式退化成「收绝对值」，故这条路一个字都没变。
  it("没有分量时，认领到的就是节点上那一份", () => {
    const object = new THREE.Group()
    setEvaluated(object, "aim", "quaternion", new THREE.Quaternion().toArray())
    object.rotation.set(0, Math.PI / 3, 0)
    const written = object.quaternion.clone()

    expect(
      new THREE.Quaternion()
        .fromArray(readAuthored(object, "quaternion"))
        .angleTo(written)
    ).toBeCloseTo(0, 10)
  })

  // 启发式的盲区：写进去的值恰好等于当前 evaluated 时看不出「有人写过」。关键帧每帧都写、
  // 写的就是 authored，故那条路径走 writeAuthored，不赌这个概率。
  it("writeAuthored 显式改写 authored，即使新值恰好等于当前 evaluated", () => {
    const object = new THREE.Group()
    const yaw90 = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0, Math.PI / 2, 0))
      .toArray()

    setEvaluated(object, "motionTangent", "quaternion", yaw90)
    // 此刻 evaluated 正好是 90°；关键帧把 authored 也写成 90°。
    writeAuthored(object, "quaternion", yaw90)

    // 合成 = 90° · 90° = 180°，而不是被当成「没人写过」停在 90°。
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(object.quaternion)
    expect(front.z).toBeCloseTo(-1, 6)
    expect(readAuthored(object, "quaternion")).toEqual(yaw90)
  })

  it("没有派生分量时 writeAuthored 就是一次普通写入", () => {
    const object = new THREE.Group()
    writeAuthored(object, "position", [1, 2, 3])
    expect(object.position.toArray()).toEqual([1, 2, 3])
  })

  // 认领只发生在合成时，而一个通道**可以长时间没有任何分量**——轨迹演完之后位置就是这样：
  // 撤掉分量之后再没有人调用合成。这段时间里用户拖 gizmo，读 authored 的人（打关键帧、
  // 自动补帧、SetPositionCommand 的 old 值、属性面板）若拿到撤销那一刻的旧值，就会出现
  // 「轨迹后面打的位置关键帧不起作用，一移动时间轴对象又回到轨迹末端」——帧里存的本来就是
  // 轨迹末端。故读这一端也要先认领一次。
  it("分量全撤掉之后被外部改动，读 authored 拿到的是新值", () => {
    const object = new THREE.Group()

    setEvaluated(object, "motionPath", "position", [0, 0, 4], "override")
    setEvaluated(object, "motionPath", "position", null) // 片段演完，分量撤掉
    expect(readAuthored(object, "position")).toEqual([0, 0, 0])

    // 此后没有任何一方再合成；用户拖了 gizmo。
    object.position.set(6, 0, 6)
    expect(readAuthored(object, "position")).toEqual([6, 0, 6])

    // 认领之后再有分量进来，叠的是拖出来的那一份。
    setEvaluated(object, "footSnap", "position", [0, 0.5, 0])
    expect(object.position.toArray()).toEqual([6, 0.5, 6])
  })

  // 分量还在时两条路径必须同解：认领的口径一律是「节点上此刻这一份就是作者的意思」
  // （不做「减掉分量再收」的推断，那正是合成路径既有的做法）。读这一端若换个口径，
  // 同一次拖动会因为「先读了还是先合成」得出两个 authored。
  it("分量还在时，读 authored 与合成路径给出同一个答案", () => {
    const byRead = new THREE.Group()
    setEvaluated(byRead, "rootMotion", "position", [1, 0, 0])
    byRead.position.set(5, 0, 0) // 用户拖 gizmo
    const adoptedByRead = readAuthored(byRead, "position")

    const byRecompose = new THREE.Group()
    setEvaluated(byRecompose, "rootMotion", "position", [1, 0, 0])
    byRecompose.position.set(5, 0, 0)
    setEvaluated(byRecompose, "rootMotion", "position", [1, 0, 0]) // 下一轮求值触发合成

    expect(adoptedByRead).toEqual(readAuthored(byRecompose, "position"))
  })
})

describe("序列化期间还原 authored", () => {
  /** 三层装配的一角：整棵子树上散落着多个派生写入方。 */
  function tree() {
    const root = new THREE.Group()
    const carrier = new THREE.Group()
    const bone = new THREE.Bone()
    bone.position.set(0, 0.9, 0)
    carrier.add(bone)
    root.add(carrier)
    return { root, carrier, bone }
  }

  // 派生量存进持久化数据的话，重新落地时会在它之上再叠一遍，每存一次歪一点。此前只有切线
  // 朝向单独做了 suspend，动作位移与贴地补偿漏在外面——现在按子树一次覆盖全部。
  it("整棵子树的派生量一次摘干净，收尾函数原样装回", () => {
    const { root, carrier, bone } = tree()
    setEvaluated(carrier, "rootMotion", "position", [0.6, 0, -0.2])
    setEvaluated(
      carrier,
      "motionTangent",
      "quaternion",
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1, 0)).toArray()
    )
    setEvaluated(bone, "footSnap", "position", [0, -0.15, 0])
    const evaluated = {
      carrier: carrier.position.clone(),
      quaternion: carrier.quaternion.clone(),
      bone: bone.position.clone()
    }

    const restore = suspendEvaluated(root)

    expect(carrier.position.toArray()).toEqual([0, 0, 0])
    expect(carrier.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(
      0,
      10
    )
    expect(bone.position.toArray()).toEqual([0, 0.9, 0])

    restore()

    expect(carrier.position.distanceTo(evaluated.carrier)).toBeCloseTo(0, 10)
    expect(carrier.quaternion.angleTo(evaluated.quaternion)).toBeCloseTo(0, 10)
    expect(bone.position.distanceTo(evaluated.bone)).toBeCloseTo(0, 10)
  })

  // 还原 position/quaternion 是不够的：`Object3D.toJSON()` 直接读 `this.matrix` 且不会自己
  // 重算，而两个调用方都是「还原 → 立刻 toJSON → 装回去」的同步流程，中间插不进一帧渲染。
  // 不刷局部矩阵的话，存下去的仍是含派生量的那一份，整套 suspend 等于白做。
  it("存下去的矩阵带的是 authored，不是渲染用的那一份", () => {
    const root = new THREE.Group()
    const object = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial()
    )
    object.position.set(1, 0, 0)
    root.add(object)
    object.updateMatrix() // 渲染过一帧

    setEvaluated(object, "motionPath", "position", [9, 9, 9], "override")
    object.updateMatrix() // 渲染循环按 matrixAutoUpdate 又刷了一次

    const restore = suspendEvaluated(root)
    const json = object.toJSON() as any
    restore()

    const matrix = json.object.matrix as number[]
    expect([matrix[12], matrix[13], matrix[14]]).toEqual([1, 0, 0])
    // 装回去之后矩阵也要跟上（序列化跑在自动保存里，后面未必紧跟一帧渲染）。
    expect(object.position.toArray()).toEqual([9, 9, 9])
    expect(object.matrix.elements.slice(12, 15)).toEqual([9, 9, 9])
  })

  // 调用方在动手之前要先改节点（如换 rotation.order）时，authored 必须抄在那次改动之前。
  it("captureAuthored 先抄快照，此后节点被改也不影响 authored", () => {
    const object = new THREE.Group()
    captureAuthored(object, "quaternion")
    object.rotation.set(0.3, 0.2, 0.1) // 抄完之后才发生的改动

    setEvaluated(object, "motionTangent", "quaternion", [0, 0, 0, 1])

    // authored 是抄快照那一刻的恒等旋转，不是后来那一份。
    expect(object.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6)
  })

  it("没有派生量时是空操作", () => {
    const { root, carrier } = tree()
    carrier.position.set(0.4, 0, 0)
    suspendEvaluated(root)()
    expect(carrier.position.toArray()).toEqual([0.4, 0, 0])
    expect(suspendEvaluated(null)).toBeTypeOf("function")
  })

  // 记在模块级 WeakMap 上而不是 userData 上：userData 会被 object.toJSON() 一并存下来，
  // 基准存进数据里就成了「模型自带的偏移」（同 SkeletonBindPose 不进 userData 的理由）。
  it("不往 userData 里塞任何东西", () => {
    const object = node()
    setEvaluated(object, "rootMotion", "position", [1, 0, 0])
    expect(object.userData).toEqual({})
  })
})

describe("override 期间不认领外部改动", () => {
  // 认领那条启发式是给 **offset** 用的（轨迹段里拖旋转 gizmo 能转得动，靠的正是它）。
  // override 的合成式里 authored 一个字都不参与，节点上的值是别人算出来的那一份，认领它
  // 等于把派生量记成用户的意图。
  it("拖动给得出反馈，但不污染 authored，下一次合成还原", () => {
    const node = new THREE.Object3D()
    node.position.set(0, 0, 0)
    setEvaluated(node, "motionPath", "position", [0, 0, 2], "override")
    expect(node.position.z).toBe(2)
    expect(readAuthored(node, "position")[2]).toBe(0)

    // 模拟视口 gizmo：直接改节点。
    node.position.z += 5
    expect(readAuthored(node, "position")[2]).toBe(0)

    // 再合成一次即还原到 override 说的那一点。
    setEvaluated(node, "motionPath", "position", [0, 0, 2], "override")
    expect(node.position.z).toBe(2)
    expect(readAuthored(node, "position")[2]).toBe(0)
  })

  it("offset 照旧认领，且收的是**位移**不是绝对值", () => {
    const node = new THREE.Object3D()
    node.position.set(0, 0, 1)
    setEvaluated(node, "rootMotion", "position", [0, 0, 2])
    expect(node.position.z).toBe(3)

    // 用户把它从 3 拖到 8（挪了 5）。authored 该变成 6——再合成一次正好回到 8，
    // 也就是用户放手的地方。收绝对值的话 authored 会记成 8、下一次合成给出 10。
    node.position.z += 5
    expect(readAuthored(node, "position")[2]).toBe(6)
    setEvaluated(node, "rootMotion", "position", [0, 0, 2])
    expect(node.position.z).toBe(8)
  })

  it("认领是幂等的：readAuthored 与 recompose 各调一次，位移不会被加两遍", () => {
    const node = new THREE.Object3D()
    node.position.set(0, 0, 1)
    setEvaluated(node, "rootMotion", "position", [0, 0, 2])
    node.position.z += 5
    expect(readAuthored(node, "position")[2]).toBe(6)
    expect(readAuthored(node, "position")[2]).toBe(6)
  })

  it("override 撤掉之后认领恢复：那时 authored 又开始参与合成了", () => {
    const node = new THREE.Object3D()
    node.position.set(0, 0, 0)
    setEvaluated(node, "motionPath", "position", [0, 0, 2], "override")
    setEvaluated(node, "motionPath", "position", null)
    node.position.z = 4
    expect(readAuthored(node, "position")[2]).toBe(4)
  })
})
