import { describe, expect, it } from "vitest"

import {
  resolveRigClick,
  resolveRigHandle,
  resolveRigTranslateTarget,
  rigClickConsumesEvent
} from "@/components/director/useDirectorCameraRig"

// 机位是「一个对象含两个可调元素」的那一类：镜头本体与注视点。视口里**同时只出现一个**
// 调节器，由选区（directorSelection）里停在哪一项决定——这一组守的就是那条不变式。
//
// 回归背景：此前两个手柄各有一个独立的布尔判据，位置模式 + 移动时双双为真，于是视口里凭空
// 多出一个调节器，用户读不出自己正在调哪一个。

const BASE = {
  mode: "translate" as const,
  isViewportCamera: false,
  targetAdjustable: true,
  targetSelected: false
}

describe("机位装置：出场的是哪一个手柄", () => {
  // 这一条就是那个 bug 的回归用例：位置模式 + 移动，两个手柄都「可用」，但只出一个。
  it("注视点可调、但选区停在镜头上时，只出镜头那一个", () => {
    expect(resolveRigHandle(BASE)).toBe("camera")
  })

  it("选区停在注视点上时，只出注视点那一个", () => {
    expect(resolveRigHandle({ ...BASE, targetSelected: true })).toBe("target")
  })

  // 选区停在注视点上时，手柄**只可能是它自己**：不可调（切到了旋转模式——注视点是一个点、
  // 转不了；或注视对象模式下那一点由图形给出）就一个都不给。
  //
  // **不退回镜头那一个**：用户明明选着注视点，切一下旋转手柄却跳到机位上、转出来的是机位
  // 的注视角度——那正是用户报的「选中注视位置那个点，旋转却到了机位上」。要转机位就先点
  // 一下机位（点别处会退回镜头本体，见 resolveRigClick）。
  it("注视点不可调时，选中它就一个手柄都不给（不退回镜头）", () => {
    expect(
      resolveRigHandle({
        ...BASE,
        targetSelected: true,
        targetAdjustable: false
      })
    ).toBe(null)
  })

  // 机位视角下这条镜头的取景一律不由鼠标改（唯一能调的是滚轮变焦，见
  // useDirectorCameraControls 的 resolveCameraViewNavigation），故两个手柄都不给。
  // 早先只挡住镜头那一个（理由是纯人机：手柄摆在眼睛上，糊在画面正中既看不清也点不准），
  // 注视点那一个照给——可它同样是在这块画面上用鼠标改这一条镜头的取景。
  it("正透过这个机位取景时不给镜头手柄", () => {
    expect(resolveRigHandle({ ...BASE, isViewportCamera: true })).toBe(null)
  })

  it("正透过它取景时，注视点被选中也不给", () => {
    expect(
      resolveRigHandle({
        ...BASE,
        isViewportCamera: true,
        targetSelected: true
      })
    ).toBe(null)
  })

  it("装置整体不出场时一个也不给", () => {
    expect(resolveRigHandle({ ...BASE, mode: null })).toBe(null)
    expect(
      resolveRigHandle({ ...BASE, mode: null, targetSelected: true })
    ).toBe(null)
  })

  // 结构性保证：返回的是**一个值**，故「两个手柄同时在场」在类型层面就不成立。
  it("任何取值组合下都至多给出一个手柄", () => {
    const flags = [false, true]
    for (const mode of ["translate", "rotate", null] as const) {
      for (const isViewportCamera of flags) {
        for (const targetAdjustable of flags) {
          for (const targetSelected of flags) {
            const handle = resolveRigHandle({
              mode,
              isViewportCamera,
              targetAdjustable,
              targetSelected
            })
            expect(
              handle === null || handle === "camera" || handle === "target"
            ).toBe(true)
          }
        }
      }
    }
  })
})

// 注视点选中期间，点在视口别处的那一下**必须一次生效**：退回镜头本体与「选中你点的那个
// 东西 / 取消选中」在同一次点击里一起发生。
//
// 回归背景：这一下原先被无条件 halt 掉（照搬了轨迹路径点那套「一次点击只剥一层」），于是
// 点别的图形要按两下——第一下只把选中退回机位本体，第二下才选中它；点空白取消选中同理。
describe("机位装置：点击的处置", () => {
  const CLICK = {
    targetAdjustable: true,
    targetSelected: false,
    hitPicker: false
  }

  it("点中注视点小球即切过去，并消费掉这一下（小球是我们自己的东西）", () => {
    const outcome = resolveRigClick({ ...CLICK, hitPicker: true })
    expect(outcome).toBe("select-target")
    expect(rigClickConsumesEvent(outcome)).toBe(true)
  })

  it("注视点本就选着时再点小球：不改动，仍消费", () => {
    const outcome = resolveRigClick({
      ...CLICK,
      hitPicker: true,
      targetSelected: true
    })
    expect(outcome).toBe("keep-target")
    expect(rigClickConsumesEvent(outcome)).toBe(true)
  })

  // 这两条就是「要按两下」的回归用例。
  it("选着注视点却点在别处：退回镜头本体，且**不**消费这一下", () => {
    const outcome = resolveRigClick({ ...CLICK, targetSelected: true })
    expect(outcome).toBe("release-target")
    expect(rigClickConsumesEvent(outcome)).toBe(false)
  })

  it("没选中注视点时一概不插手", () => {
    const outcome = resolveRigClick(CLICK)
    expect(outcome).toBe("ignore")
    expect(rigClickConsumesEvent(outcome)).toBe(false)
  })

  // 跟随模式的注视点挪不动，小球也不出场；万一点到也不该切过去。
  it("注视点不可调时，点中小球也不切过去", () => {
    expect(
      resolveRigClick({ ...CLICK, hitPicker: true, targetAdjustable: false })
    ).toBe("ignore")
  })

  // 唯一会被消费掉的是「点中了小球」那两种：其余一律放行给 Selector。
  it("只有点中小球的那两种消费事件", () => {
    const flags = [false, true]
    for (const targetAdjustable of flags) {
      for (const targetSelected of flags) {
        for (const hitPicker of flags) {
          const outcome = resolveRigClick({
            targetAdjustable,
            targetSelected,
            hitPicker
          })
          expect(rigClickConsumesEvent(outcome)).toBe(
            hitPicker && targetAdjustable
          )
        }
      }
    }
  })
})

// 拖镜头手柄拖出来的落点该写到哪儿——站位这条通道此刻归谁，落点就折回谁的数据里。
//
// 只有两条取值：跟拍开着时折回装置本身，其余一律写 authored。曾经还有第三条 `motion-path`
// （播放头压在一格站位轨迹里时直写节点、交给吸收折进路径），已随吸收整体撤掉——那几秒的
// 站位由路径说了算，改路径一律去线上加点或拖点位（见 useDirectorMotionPath）。
describe("机位装置：拖出来的落点写到哪儿", () => {
  it("跟拍开着时折回装置本身", () => {
    expect(resolveRigTranslateTarget({ following: true })).toBe("follow-rig")
  })

  it("没有人驱动站位时写 authored", () => {
    expect(resolveRigTranslateTarget({ following: false })).toBe("authored")
  })
})
