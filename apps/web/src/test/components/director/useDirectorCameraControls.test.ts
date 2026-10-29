import { describe, expect, it } from "vitest"

import {
  CAMERA_FOV_MAX,
  CAMERA_FOV_MIN
} from "@/components/director/cameraFrustum"
import {
  nextCameraFov,
  resolveCameraViewNavigation
} from "@/components/director/useDirectorCameraControls"

// 机位视角（正透过某个机位取景）下鼠标能做什么，取决于这个机位有没有注视锚点。
//
// 需求原话：「机位朝向注视位置时，和注视对象一样，在机位视角也不能通过鼠标调整位置，
// 机位视角唯一能调整的是鼠标滚轮调整 fov，注意和自由调整的区别」。
//
// 回归背景：此前只有「注视对象」被挡住，「注视位置」是放行的——旋转手势改的是注视点、
// 平移与滚轮漫游还会把注视点沿相同位移一起搬。那让「注视位置」这份用户数据（它自己
// 还能打关键帧、还能放轨迹）在用户没碰过它的手势里被静默改写。

describe("机位视角：这个机位允许什么鼠标操作", () => {
  it("自由调整 → 完整的第一人称漫游", () => {
    expect(resolveCameraViewNavigation("free")).toBe("roam")
  })

  // 这两条就是本次需求的回归点：两种注视模式在这里一个字不差。
  it("注视位置 → 指针不接，只剩滚轮变焦", () => {
    expect(resolveCameraViewNavigation("point")).toBe("fov")
  })

  it("注视对象 → 与注视位置同一档", () => {
    expect(resolveCameraViewNavigation("object")).toBe("fov")
  })
})

describe("滚轮变焦", () => {
  it("向上滚推近（视野变窄），向下滚拉远（视野变宽）", () => {
    expect(nextCameraFov(50, -100)).toBeLessThan(50)
    expect(nextCameraFov(50, 100)).toBeGreaterThan(50)
  })

  // 取指数倍率而不是「每格 ±5°」的理由：滚出去再滚回来必须正好回到原处。
  it("进出互逆", () => {
    expect(nextCameraFov(nextCameraFov(50, 100), -100)).toBeCloseTo(50, 10)
  })

  // 同一个理由的另一面：窄视野时每格走得更细，与画面上看到的变化幅度相称。
  it("长焦端一格走得比广角端细", () => {
    const nearMin = Math.abs(nextCameraFov(20, -100) - 20)
    const nearMax = Math.abs(nextCameraFov(80, -100) - 80)
    expect(nearMin).toBeLessThan(nearMax)
  })

  // 量程与属性面板滑杆同一对数字（单点源在 cameraFrustum.ts），两处滚/拖到头的位置一致。
  it("夹在面板滑杆的同一对量程内", () => {
    expect(nextCameraFov(CAMERA_FOV_MIN, -100)).toBe(CAMERA_FOV_MIN)
    expect(nextCameraFov(CAMERA_FOV_MAX, 100)).toBe(CAMERA_FOV_MAX)
  })
})
