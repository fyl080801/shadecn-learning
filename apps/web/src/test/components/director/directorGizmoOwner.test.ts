import { beforeEach, describe, expect, it } from "vitest"

import {
  allowedDirectorTransformModes,
  directorGizmoOwner,
  isDirectorTransformModeAllowed,
  ownsDirectorGizmo,
  resetDirectorGizmoOwner,
  resolveCameraRigMode,
  setDirectorPoseEditing
} from "@/components/director/directorGizmoOwner"
import {
  clearDirectorSelection,
  resetDirectorSelection,
  selectDirectorItem
} from "@/components/director/directorSelection"

// 「调节器归谁」是**选区的派生量**（见 directorGizmoOwner 的文件头）：这一层不再有 setter，
// 故这里一律经选区驱动。裁决的那一半（对象 gizmo 挂不挂）见 useDirectorObjectGizmo.spec.ts。

const UUID = "obj-1"

describe("调节器所有权", () => {
  beforeEach(() => {
    resetDirectorSelection()
    resetDirectorGizmoOwner()
  })

  it("缺省归对象自己", () => {
    expect(directorGizmoOwner.value).toBe("object")
    expect(ownsDirectorGizmo("object")).toBe(true)
    expect(ownsDirectorGizmo("motionPath")).toBe(false)
  })

  // 后来者居上：用户最后一次选中的是什么，调节器就在哪儿。固定优先级答不了这个问题
  // ——选中轨迹片段后再点一下模型，要的就是模型自己的调节器。
  it("选中什么调节器就跟到哪儿", () => {
    selectDirectorItem({
      kind: "clip",
      uuid: UUID,
      track: "motion",
      clipId: "c1"
    })
    expect(ownsDirectorGizmo("motionPath")).toBe(true)

    selectDirectorItem({
      kind: "pathNode",
      track: "motion",
      uuid: UUID,
      clipId: "c1",
      index: 2
    })
    expect(ownsDirectorGizmo("motionNode")).toBe(true)
    expect(ownsDirectorGizmo("motionPath")).toBe(false)

    selectDirectorItem({ kind: "object", uuid: UUID })
    expect(ownsDirectorGizmo("object")).toBe(true)
  })

  // 判据是「这条轨道带不带路径」（注册表的 hasPath），不是写死某个 key：机位注视点那条轴
  // （aimMotion）与站位那条轴一样有路径可调，写死 'motion' 的话它选中之后视口里一个手柄都
  // 没有。动作片段仍与视口调节器无关，归对象。
  it("两条轨迹轴都归整体手柄，动作片段归对象", () => {
    selectDirectorItem({
      kind: "clip",
      uuid: UUID,
      track: "aimMotion",
      clipId: "c1"
    })
    expect(ownsDirectorGizmo("motionPath")).toBe(true)

    selectDirectorItem({
      kind: "clip",
      uuid: UUID,
      track: "action",
      clipId: "c1"
    })
    expect(ownsDirectorGizmo("object")).toBe(true)
  })

  // 选中整条路径（index 为 null）与选中路径上的某一个点是两种调节器。
  it("整条路径与单个路径点分属两个调节器", () => {
    selectDirectorItem({
      kind: "pathNode",
      track: "motion",
      uuid: UUID,
      clipId: "c1",
      index: null
    })
    expect(ownsDirectorGizmo("motionPath")).toBe(true)

    selectDirectorItem({
      kind: "pathNode",
      track: "motion",
      uuid: UUID,
      clipId: "c1",
      index: 0
    })
    expect(ownsDirectorGizmo("motionNode")).toBe(true)
  })

  // 姿势页一打开就是「正在调关节、还没点具体哪一个」，角色级 gizmo 那时就该让位了。
  it("关节：还没点具体哪一个时也已经归它", () => {
    selectDirectorItem({ kind: "joint", uuid: UUID, groupKey: null })
    expect(ownsDirectorGizmo("joint")).toBe(true)
  })

  // 姿势页开着的时候，「没有更具体的东西被选中」退到的是关节而不是对象——摆姿只操作关节，
  // 角色级的位置/旋转/缩放手柄那时一概不该出场。这一条不能靠选区回答：点一颗姿势关键帧
  // （那正是跳到姿势页的路）会把选区换成 keyframe，可姿势模式并没有结束。
  it("姿势页开着时，缺省那一份归关节而不是对象", () => {
    setDirectorPoseEditing(true)

    // 姿势页刚打开、还没点具体哪个关节。
    expect(ownsDirectorGizmo("joint")).toBe(true)

    // 点一颗姿势关键帧：选区换成了 keyframe，但姿势模式还开着，角色级 gizmo 仍不出场。
    selectDirectorItem({
      kind: "keyframe",
      uuid: UUID,
      property: "pose",
      time: 1
    })
    expect(ownsDirectorGizmo("joint")).toBe(true)

    selectDirectorItem({ kind: "span", uuid: UUID, property: "pose", from: 1 })
    expect(ownsDirectorGizmo("joint")).toBe(true)

    clearDirectorSelection()
    expect(ownsDirectorGizmo("joint")).toBe(true)

    // 姿势页一卸载即交还，缺省立刻回到对象。
    setDirectorPoseEditing(false)
    expect(ownsDirectorGizmo("object")).toBe(true)
  })

  // 变的只是缺省那一份：「后来者居上」照旧——姿势页开着时去点一格轨迹片段/一个路径点，
  // 调节器还是归它们。
  it("姿势页开着也不妨碍别人接管", () => {
    setDirectorPoseEditing(true)

    selectDirectorItem({
      kind: "clip",
      uuid: UUID,
      track: "motion",
      clipId: "c1"
    })
    expect(ownsDirectorGizmo("motionPath")).toBe(true)

    selectDirectorItem({
      kind: "pathNode",
      track: "motion",
      uuid: UUID,
      clipId: "c1",
      index: 2
    })
    expect(ownsDirectorGizmo("motionNode")).toBe(true)

    // 但**动作**片段与视口调节器无关，故它退的是缺省那一份 = 关节。
    selectDirectorItem({
      kind: "clip",
      uuid: UUID,
      track: "action",
      clipId: "a1"
    })
    expect(ownsDirectorGizmo("joint")).toBe(true)
  })

  // 上下文不是选区的派生量，故它自己要复位——否则上一次会话停在姿势页上时，新场景一打开
  // 角色级 gizmo 会因为一个早已不成立的上下文而始终不出场。
  it("复位一并交还姿势编辑上下文", () => {
    setDirectorPoseEditing(true)
    resetDirectorGizmoOwner()
    expect(directorGizmoOwner.value).toBe("object")
  })

  // 时间轴上的选中与视口调节器无关：点一帧不该把模型的变换 gizmo 收走。
  it("关键帧 / 连线段 / 动作片段一律归对象", () => {
    selectDirectorItem({
      kind: "keyframe",
      uuid: UUID,
      property: "position",
      time: 1
    })
    expect(ownsDirectorGizmo("object")).toBe(true)

    selectDirectorItem({
      kind: "span",
      uuid: UUID,
      property: "position",
      from: 1
    })
    expect(ownsDirectorGizmo("object")).toBe(true)

    selectDirectorItem({
      kind: "clip",
      uuid: UUID,
      track: "action",
      clipId: "a1"
    })
    expect(ownsDirectorGizmo("object")).toBe(true)
  })

  // 机位注视点跟着 'object' 走是刻意的：注视装置本就是 aim 模式机位的那个对象 gizmo，
  // 镜头/注视点两个手柄由它自己按选区分（见 useDirectorCameraRig）。
  it("机位注视点仍归对象那一份", () => {
    selectDirectorItem({ kind: "cameraTarget", uuid: UUID })
    expect(ownsDirectorGizmo("object")).toBe(true)
  })

  // 跨 Editor 实例存活，故导演台挂载时要复位——否则上一次会话停在「轨迹整体」上时，
  // 新场景一打开对象 gizmo 会因为选区指着一条不存在的轨迹而不出现。
  it("复位回到缺省", () => {
    selectDirectorItem({
      kind: "pathNode",
      track: "motion",
      uuid: UUID,
      clipId: "c1",
      index: 1
    })
    resetDirectorSelection()
    expect(directorGizmoOwner.value).toBe("object")
  })
})

// 公共 helper 工具栏（移动/旋转/缩放）是全导演台共用的那一个，故「现在这个调节器认不认
// 这个模式」必须只有一处答案——按下一个什么也不会发生的按钮，用户读到的是「工具栏坏了」。
describe("工具栏对各调节器开放的模式", () => {
  beforeEach(() => {
    resetDirectorSelection()
    resetDirectorGizmoOwner()
  })

  it("缺省（对象自己的 gizmo）三种模式全开", () => {
    expect(allowedDirectorTransformModes.value).toEqual([
      "translate",
      "rotate",
      "scale"
    ])
    expect(isDirectorTransformModeAllowed("rotate")).toBe(true)
  })

  it("别的调节器接管期间同样按它那一份取模式", () => {
    selectDirectorItem({
      kind: "pathNode",
      track: "motion",
      uuid: UUID,
      clipId: "c1",
      index: 1
    })
    expect(allowedDirectorTransformModes.value).toEqual([
      "translate",
      "rotate",
      "scale"
    ])
  })

  it("选区回到对象后回到缺省", () => {
    selectDirectorItem({
      kind: "pathNode",
      track: "motion",
      uuid: UUID,
      clipId: "c1",
      index: 1
    })
    selectDirectorItem({ kind: "object", uuid: UUID })
    expect(directorGizmoOwner.value).toBe("object")
    expect(isDirectorTransformModeAllowed("rotate")).toBe(true)
  })
})

// 被注视驱动的机位：视口里那一下不再是机位自己的 xyz，而是整套装置的平移 / 绕注视点转，
// 故归装置调节器。判据只有这一处（装置调节器与对象 gizmo 的裁决点共用），两处各判各的
// 必然会出现「两个调节器并存」或「一个都没有」。
describe("机位装置调节器接管哪几下", () => {
  function camera(mode: string) {
    return {
      isCamera: true,
      userData: { lookAt: { mode, targetUuid: null, target } }
    }
  }
  const target = { x: 0, y: 0, z: 0 }

  it("手动调整的机位一概不接管——它与普通图形一样", () => {
    expect(resolveCameraRigMode(camera("free"), "translate")).toBe(null)
    expect(resolveCameraRigMode(camera("free"), "rotate")).toBe(null)
  })

  // 移动那一下不只是挪机位（位置模式还多一个摆在注视点上的整体平移手柄），旋转那一下更
  // 不是普通旋转（只给绕视线那一个环 = 倾斜），故两下都归装置调节器。
  it("位置模式：移动与旋转都归它", () => {
    expect(resolveCameraRigMode(camera("point"), "translate")).toBe("translate")
    expect(resolveCameraRigMode(camera("point"), "rotate")).toBe("rotate")
  })

  it("跟随模式同样两下都归它（只是没有注视点那个手柄）", () => {
    expect(resolveCameraRigMode(camera("object"), "translate")).toBe(
      "translate"
    )
    expect(resolveCameraRigMode(camera("object"), "rotate")).toBe("rotate")
  })

  // 机位本就没有缩放（见 resolveObjectTransformModes），装置这一侧也不接。
  it("缩放不接", () => {
    expect(resolveCameraRigMode(camera("point"), "scale")).toBe(null)
  })

  it("不是机位的对象一概不接管", () => {
    expect(resolveCameraRigMode({ isMesh: true }, "rotate")).toBe(null)
    expect(resolveCameraRigMode(null, "rotate")).toBe(null)
  })
})
