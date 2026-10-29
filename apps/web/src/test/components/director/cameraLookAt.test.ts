import { describe, expect, it } from "vitest"
import { defineComponent } from "vue"
import { mount } from "@vue/test-utils"
import * as THREE from "three"

import {
  readAuthored,
  writeAuthored
} from "@/components/three-editor/EvaluatedTransform"

import {
  aimCameraAt,
  applyCameraLookAt,
  authoredRebaseDelta,
  cameraOrbitPosition,
  cameraRollEuler,
  markLegacyCameraRotation,
  readCameraAimAngles,
  ensureCameraLookAt,
  getCameraLookAtMode,
  isCameraAimed,
  migrateLegacyCameraLookAt,
  planCameraLookAtSwitch,
  readCameraOrbit,
  readCameraRoll,
  useCameraLookAt,
  type CameraLookAtMode
} from "@/components/director/cameraLookAt"

// 机位注视的三种模式（手动调整 / 位置 / 跟随）与「对准是叠在 authored 之上的派生量」这条
// 分解——面板的两副表、时间轴上旋转行记的是倾斜、视口装置调节器的绕注视点转，全部建立在
// 它之上，故这里钉的是那一层的数学，而不是某个 UI 的表现。

function createCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.userData.isDirectorShot = true
  return camera
}

function createEditor(children: THREE.Object3D[] = []) {
  const scene = new THREE.Scene()
  if (children.length) scene.add(...children)
  return { scene }
}

function setMode(
  camera: any,
  mode: CameraLookAtMode,
  target = { x: 0, y: 0, z: -5 }
) {
  camera.userData.lookAt = { mode, targetUuid: null, target }
}

function forwardOf(camera: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
}

function upOf(camera: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
}

describe("注视模式", () => {
  it("新机位缺省「手动调整」：注视点只是一份缓存，谁也不驱动朝向", () => {
    const camera = createCamera()
    camera.rotation.set(0.3, 0.4, 0.1)
    camera.updateMatrixWorld(true)
    const before = camera.quaternion.clone()

    const state = ensureCameraLookAt(camera)
    expect(state.mode).toBe("free")
    expect(getCameraLookAtMode(camera)).toBe("free")
    expect(isCameraAimed(camera)).toBe(false)

    applyCameraLookAt(createEditor(), camera)
    expect(camera.quaternion.angleTo(before)).toBeLessThan(1e-9)
  })

  // 数据里的 'manual' 是 ≤v3 的取值，运行期一律当手动（迁移在 codec 那一侧按版本做）。
  it("不认识的模式按手动处理", () => {
    const camera = createCamera()
    setMode(camera, "manual" as CameraLookAtMode)
    expect(getCameraLookAtMode(camera)).toBe("free")
    expect(isCameraAimed(camera)).toBe(false)
  })

  it("位置模式：镜头对准那一点，倾斜（authored）原样留在它之下", () => {
    const camera = createCamera()
    camera.position.set(0, 0, 0)
    setMode(camera, "point", { x: 0, y: 0, z: -5 })
    // authored = 绕视线轴 30°，即面板上的「倾斜」。
    writeAuthored(
      camera,
      "quaternion",
      new THREE.Quaternion().setFromEuler(cameraRollEuler(camera, 30)).toArray()
    )

    applyCameraLookAt(createEditor(), camera)

    const forward = forwardOf(camera)
    expect(forward.z).toBeCloseTo(-1, 6)
    expect(forward.x).toBeCloseTo(0, 6)
    // 视线不变、画面绕它倒过去——这正是「垂直注视方向的倾斜」。
    expect(upOf(camera).x).toBeCloseTo(
      -Math.sin(THREE.MathUtils.degToRad(30)),
      6
    )
    expect(readCameraRoll(camera)).toBeCloseTo(30, 4)
  })

  it("跟随模式：注视点取被跟随图形的中心，图形没了就退回手动且朝向不变", () => {
    const camera = createCamera()
    const target = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    target.position.set(0, 0, -8)
    target.updateMatrixWorld(true)
    camera.userData.lookAt = {
      mode: "object",
      targetUuid: target.uuid,
      target: { x: 0, y: 0, z: 0 }
    }

    const editor = createEditor([target])
    applyCameraLookAt(editor, camera)
    expect(forwardOf(camera).z).toBeCloseTo(-1, 6)
    expect(camera.userData.lookAt.target.z).toBeCloseTo(-8, 6)

    // 目标从场景里消失：退回手动，且此刻的朝向不该跳一下。
    const before = camera.quaternion.clone()
    applyCameraLookAt(createEditor(), camera)
    expect(getCameraLookAtMode(camera)).toBe("free")
    expect(camera.quaternion.angleTo(before)).toBeLessThan(1e-6)
  })
})

/**
 * 「转镜头」的唯一入口。回归的是这样一个真实故障：机位视角左键环视原先直写
 * `camera.lookAt(point)`，那一份被求值层认作 authored，下一次对准再乘一遍——用户看到的是
 * 「镜头没有对准注视目标」，且越操作偏得越远。
 */
describe("aimCameraAt —— 转镜头的唯一入口", () => {
  it("位置模式：改的是注视点，反复调用也不会把对准叠上去", () => {
    const camera = createCamera()
    const editor = createEditor()
    camera.position.set(0, 0, 0)
    setMode(camera, "point", { x: 0, y: 0, z: -5 })
    applyCameraLookAt(editor, camera)

    // 连转三次：每一次都该正对着新的那一点，而不是在上一次的结果上再转一遍。
    for (const point of [
      new THREE.Vector3(5, 0, -5),
      new THREE.Vector3(-3, 2, -4),
      new THREE.Vector3(0, 0, 7)
    ]) {
      aimCameraAt(editor, camera, point)
      const expected = point.clone().sub(camera.position).normalize()
      expect(forwardOf(camera).angleTo(expected)).toBeLessThan(1e-6)
      expect(camera.userData.lookAt.target.x).toBeCloseTo(point.x, 6)
    }
    // authored 全程只是倾斜（这里没设过倾斜，故是单位四元数）。
    expect(readCameraRoll(camera)).toBeCloseTo(0, 6)
  })

  it("手动调整：改的是机位自己的 authored 朝向，模式不被静默改掉", () => {
    const camera = createCamera()
    const editor = createEditor()
    ensureCameraLookAt(camera)

    aimCameraAt(editor, camera, new THREE.Vector3(0, 0, -5))
    expect(getCameraLookAtMode(camera)).toBe("free")
    expect(forwardOf(camera).z).toBeCloseTo(-1, 6)
    expect(
      new THREE.Quaternion()
        .fromArray(readAuthored(camera, "quaternion"))
        .angleTo(camera.quaternion)
    ).toBeLessThan(1e-6)
  })

  it("跟随模式不插手：注视点由被跟随图形给出", () => {
    const camera = createCamera()
    camera.userData.lookAt = {
      mode: "object",
      targetUuid: "x",
      target: { x: 1, y: 2, z: 3 }
    }
    aimCameraAt(createEditor(), camera, new THREE.Vector3(9, 9, 9))
    expect(camera.userData.lookAt.target).toEqual({ x: 1, y: 2, z: 3 })
  })
})

describe("换模式不跳变", () => {
  /** 用 plan 的结果换模式——面板与命令走的正是这一条（见 SetCameraLookAtCommand）。 */
  function applySwitch(
    editor: any,
    camera: any,
    mode: CameraLookAtMode,
    targetUuid?: string
  ) {
    const plan = planCameraLookAtSwitch(camera, mode, targetUuid ?? null)
    camera.userData.lookAt = plan.state
    writeAuthored(camera, "quaternion", plan.rotation)
    applyCameraLookAt(editor, camera)
  }

  it("手动 → 位置：注视点落在当前视线上，画面纹丝不动", () => {
    const camera = createCamera()
    camera.position.set(3, 2, 1)
    camera.rotation.set(0.2, 0.7, 0)
    camera.updateMatrixWorld(true)
    ensureCameraLookAt(camera)
    const before = camera.quaternion.clone()

    applySwitch(createEditor(), camera, "point")

    expect(getCameraLookAtMode(camera)).toBe("point")
    expect(camera.quaternion.angleTo(before)).toBeLessThan(1e-6)
    // 注视点确实在视线前方（而不是沿用一个早已不在视线上的缓存坐标）。
    const toTarget = new THREE.Vector3(
      camera.userData.lookAt.target.x,
      camera.userData.lookAt.target.y,
      camera.userData.lookAt.target.z
    )
      .sub(camera.position)
      .normalize()
    expect(toTarget.angleTo(forwardOf(camera))).toBeLessThan(1e-6)
  })

  it("位置 → 手动：对准撤掉，authored 收下完整朝向，画面同样不动", () => {
    const camera = createCamera()
    camera.position.set(0, 1, 4)
    setMode(camera, "point", { x: 2, y: 0, z: -3 })
    const editor = createEditor()
    applyCameraLookAt(editor, camera)
    const before = camera.quaternion.clone()

    applySwitch(editor, camera, "free")

    expect(getCameraLookAtMode(camera)).toBe("free")
    expect(camera.quaternion.angleTo(before)).toBeLessThan(1e-6)
    // authored 此后就是节点上的那一份——再对准一次也不会叠第二遍。
    expect(
      new THREE.Quaternion()
        .fromArray(readAuthored(camera, "quaternion"))
        .angleTo(before)
    ).toBeLessThan(1e-6)
  })

  it("切到跟随：镜头转向目标，但倾斜留着", () => {
    const camera = createCamera()
    camera.position.set(0, 0, 0)
    setMode(camera, "point", { x: 0, y: 0, z: -5 })
    writeAuthored(
      camera,
      "quaternion",
      new THREE.Quaternion().setFromEuler(cameraRollEuler(camera, 45)).toArray()
    )
    const target = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    target.position.set(6, 0, 0)
    target.updateMatrixWorld(true)

    applySwitch(createEditor([target]), camera, "object", target.uuid)

    expect(getCameraLookAtMode(camera)).toBe("object")
    expect(forwardOf(camera).x).toBeCloseTo(1, 6)
    expect(readCameraRoll(camera)).toBeCloseTo(45, 4)
  })
})

describe("绕注视点的球坐标", () => {
  it("Y角度绕世界 +Y、X角度是仰角、距离是半径", () => {
    const camera = createCamera()
    setMode(camera, "point", { x: 0, y: 0, z: 0 })
    camera.position.set(0, 0, 10)
    expect(readCameraOrbit(camera)).toMatchObject({
      azimuth: expect.closeTo(0, 6),
      elevation: expect.closeTo(0, 6),
      distance: expect.closeTo(10, 6)
    })

    camera.position.set(10, 0, 0)
    expect(readCameraOrbit(camera).azimuth).toBeCloseTo(90, 6)

    camera.position.set(0, 10, 0)
    expect(readCameraOrbit(camera).elevation).toBeCloseTo(90, 6)
  })

  it("读回来的球坐标写回去即原位（面板的步进器靠这条往返）", () => {
    const camera = createCamera()
    setMode(camera, "point", { x: 1, y: 2, z: 3 })
    camera.position.set(4, 6, -2)

    const orbit = readCameraOrbit(camera)
    const position = cameraOrbitPosition(camera, orbit)
    expect(position.distanceTo(camera.position)).toBeLessThan(1e-6)
  })

  it("改Y角度只绕注视点转，距离不变（需求原话：定半径的位置调整）", () => {
    const camera = createCamera()
    setMode(camera, "point", { x: 0, y: 1, z: 0 })
    camera.position.set(0, 1, 8)

    const orbit = readCameraOrbit(camera)
    const moved = cameraOrbitPosition(camera, {
      ...orbit,
      azimuth: orbit.azimuth + 90
    })
    expect(moved.distanceTo(new THREE.Vector3(0, 1, 0))).toBeCloseTo(8, 6)
    expect(moved.x).toBeCloseTo(8, 6)
  })

  it("X角度被夹在天顶之下：正对天顶时上方向退化，转过去会翻面", () => {
    const camera = createCamera()
    setMode(camera, "point", { x: 0, y: 0, z: 0 })
    camera.position.set(0, 0, 5)

    const position = cameraOrbitPosition(camera, {
      azimuth: 0,
      elevation: 120,
      distance: 5
    })
    // 夹到 89.9°：仍在天顶之下，半径不变。
    expect(position.length()).toBeCloseTo(5, 6)
    expect(position.y).toBeLessThan(5)
    camera.position.copy(position)
    expect(readCameraOrbit(camera).elevation).toBeCloseTo(89.9, 4)
  })
})

/**
 * 角度 / 距离的锁。
 *
 * 回归的是这样一个真实故障：站位在时间轴上按 xyz 线性插值，两个关键帧之间插出来的是一条
 * **弦**——中途距离塌进去、方位跟着漂，「间补的时候镜头不按理想的方式移动」。锁住的那一项
 * 此后恒等于按下锁那一刻的读数。
 */
describe("机位进场（useCameraLookAt）", () => {
  /** 极简 signal 替身：本 composable 只用到 add/remove/dispatch。 */
  function createSignal() {
    const fns: ((...args: any[]) => void)[] = []
    return {
      add: (fn: any) => fns.push(fn),
      remove: (fn: any) => fns.splice(fns.indexOf(fn), 1),
      dispatch: (...args: any[]) => [...fns].forEach((fn) => fn(...args))
    }
  }

  function mountLookAt(camera: THREE.Camera) {
    const editor: any = {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      cameras: { [camera.uuid]: camera },
      signals: {
        objectChanged: createSignal(),
        objectRemoved: createSignal(),
        objectAdded: createSignal()
      }
    }
    return {
      editor,
      wrapper: mount(
        defineComponent({
          setup() {
            useCameraLookAt(editor)
            return () => null
          }
        })
      )
    }
  }

  // 对准是派生量、不进持久化，故恢复出来的机位停在只带倾斜的朝向上，要当场补一次。
  it("aim 模式的机位一进场就对准", () => {
    const camera = createCamera()
    setMode(camera, "point", { x: 6, y: 0, z: 0 })
    mountLookAt(camera)
    expect(forwardOf(camera).x).toBeCloseTo(1, 6)
  })

  /**
   * 自愈：aim 模式下 authored 本该只剩倾斜，存档里若躺着一份**完整朝向**（早期版本，或
   * 某条路径直写过 quaternion），不归一的话对准会乘在它之上——每打开一次就再偏一点。
   */
  // ≤v3 的 authored 里躺的是**完整朝向**，而今天 aim 模式下它记的是「注视角度」——相对
  // 对准方向的三轴偏移。照新含义解释那份旧数据就是一份巨大的偏移，故要归一成纯滚转。
  // 判定由 codec 按场景版本给出（markLegacyCameraRotation），执行在机位进场那一刻。
  it("codec 标记过的旧数据，进场归一成纯滚转后照样对准", () => {
    const camera = createCamera()
    setMode(camera, "point", { x: 0, y: 0, z: -5 })
    // 坏数据：authored 已经是一份「看向别处」的完整朝向。
    writeAuthored(
      camera,
      "quaternion",
      new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(0.4, 1.1, 0, camera.rotation.order))
        .toArray()
    )
    markLegacyCameraRotation(camera)

    mountLookAt(camera)

    expect(forwardOf(camera).z).toBeCloseTo(-1, 6)
    expect(forwardOf(camera).x).toBeCloseTo(0, 6)
  })

  // 反过来这一条才是放开三轴之后的要害：没有标记（= 今天存的数据）时**不许**归一，
  // 否则用户调好的取景偏移每次重新打开导演台都会被抹平一次。
  it("没有标记时保留注视角度，不把偏移抹平", () => {
    const camera = createCamera()
    setMode(camera, "point", { x: 0, y: 0, z: -5 })
    // 注视角度：镜头相对对准方向左摆 10°、上抬 5°。
    writeAuthored(
      camera,
      "quaternion",
      new THREE.Quaternion()
        .setFromEuler(
          new THREE.Euler(
            5 * THREE.MathUtils.DEG2RAD,
            10 * THREE.MathUtils.DEG2RAD,
            0,
            camera.rotation.order
          )
        )
        .toArray()
    )

    mountLookAt(camera)

    const angles = readCameraAimAngles(camera)
    expect(angles.x).toBeCloseTo(5, 4)
    expect(angles.y).toBeCloseTo(10, 4)
    // 偏移生效 = 目标不再落在画面正中央。
    expect(forwardOf(camera).x).not.toBeCloseTo(0, 3)
  })
})

describe("旧数据迁移（DIRECTOR_SCENE_VERSION ≤ 3）", () => {
  const target = { x: 1, y: 2, z: 3 }

  /**
   * 旧的 'manual' 是「对准过一次，此后朝向自由」，朝向可能早已不在那一点上，故迁到
   * 「手动调整」——照搬成「位置」会让旧场景一打开就有机位当场转向一个陈旧的坐标。
   */
  it("manual 迁到手动调整", () => {
    expect(
      migrateLegacyCameraLookAt(
        { mode: "manual", targetUuid: null, target },
        false
      )
    ).toEqual({ mode: "free", targetUuid: null, target })
  })

  // 例外：已经为「注视位置」打过关键帧的机位——那条轨道的意义正是让镜头跟着一个点走。
  it("有注视位置轨道的 manual 迁到位置模式", () => {
    expect(
      migrateLegacyCameraLookAt(
        { mode: "manual", targetUuid: null, target },
        true
      ).mode
    ).toBe("point")
  })

  it("跟随原样保留", () => {
    expect(
      migrateLegacyCameraLookAt(
        { mode: "object", targetUuid: "x", target },
        false
      )
    ).toEqual({ mode: "object", targetUuid: "x", target })
  })
})

// 换注视模式时 authored 的**依据**变了（完整朝向 ↔ 相对对准方向的偏移），差量由前后两份
// 读数解出，用来把时间轴上那条旋转轨道整体换过去（见 rebaseRotationTrack）。
describe("authoredRebaseDelta", () => {
  const before = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(20),
      THREE.MathUtils.degToRad(-35),
      0,
      "XYZ"
    )
  )
  const after = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0, 0, THREE.MathUtils.degToRad(12), "XYZ")
  )

  it("把旧值转成新值：ΔR · before = after", () => {
    const delta = authoredRebaseDelta(before.clone(), after.clone())
    const applied = delta.clone().multiply(before.clone())
    expect(applied.angleTo(after)).toBeLessThan(1e-6)
  })

  // 左乘 / 右乘的回归：合成是 `world = R_派生 · authored`，换掉的是左边那一份。纯滚转时
  // 两者恰好同解，故必须拿带俯仰偏/水平偏的那一份来验（同 applyMotionTangent 那一条）。
  it("是左乘而不是右乘", () => {
    const delta = authoredRebaseDelta(before.clone(), after.clone())
    const rightMultiplied = before.clone().multiply(delta.clone())
    expect(rightMultiplied.angleTo(after)).toBeGreaterThan(0.1)
  })

  // 「统一值的依据」的那条不变式：整条轨道刚性地转同一个 ΔR，帧与帧之间的相对关系原样保留。
  it("两份取值之间的相对旋转不受换基影响", () => {
    const delta = authoredRebaseDelta(before.clone(), after.clone())
    const other = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(-8),
        THREE.MathUtils.degToRad(50),
        0,
        "XYZ"
      )
    )
    const relativeBefore = before.clone().invert().multiply(other.clone())
    const relativeAfter = delta
      .clone()
      .multiply(before.clone())
      .invert()
      .multiply(delta.clone().multiply(other.clone()))
    expect(relativeBefore.angleTo(relativeAfter)).toBeLessThan(1e-6)
  })

  it("依据没变时是单位四元数", () => {
    const delta = authoredRebaseDelta(before.clone(), before.clone())
    expect(delta.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6)
  })
})
