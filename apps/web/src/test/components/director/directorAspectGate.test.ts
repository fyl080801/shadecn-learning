import { describe, expect, it } from "vitest"

import { computeAspectGateFrame } from "@/components/director/directorAspectGate"

// 取景框须让开仍悬浮在视口区域上的两组浮层：左侧纵向工具栏（left:16 + 宽 56，再留
// 16px 间距）与右上角罗盘列（right:16 + 宽 72，再留 8px 间距）。面板列与时间轴已在
// 视口区域之外，其占位由传入的 viewW/viewH 自然体现，不再有额外的让位参数。
const TOOLBAR_CLEARANCE = 16 + 56 + 16
const VIEW_HELPER_CLEARANCE = 16 + 72 + 8

describe("computeAspectGateFrame", () => {
  it("取景框让开左侧工具栏与右上角罗盘列", () => {
    const frame = computeAspectGateFrame(1920, 1080, "16:9")

    expect(frame).not.toBeNull()
    expect(frame!.x).toBeGreaterThanOrEqual(TOOLBAR_CLEARANCE)
    expect(frame!.x + frame!.w).toBeLessThanOrEqual(
      1920 - VIEW_HELPER_CLEARANCE
    )
  })

  it("视口区域变矮（例如打开时间轴）时取景框缩小，画幅不变", () => {
    const tall = computeAspectGateFrame(1920, 1080, "9:16")!
    const short = computeAspectGateFrame(1920, 820, "9:16")!

    expect(short.h).toBeLessThan(tall.h)
    // 比例是取景框的硬约束：让位只改变大小与位置，不改变画幅
    expect(short.w / short.h).toBeCloseTo(9 / 16, 5)
    expect(short.y + short.h).toBeLessThanOrEqual(820)
  })

  it("横画幅在可用高度不足时改由高度定尺寸", () => {
    const frame = computeAspectGateFrame(1920, 400, "21:9")!

    expect(frame.w / frame.h).toBeCloseTo(21 / 9, 5)
    expect(frame.h).toBeLessThanOrEqual(400)
  })

  it("auto 与无效尺寸不产出取景框", () => {
    expect(computeAspectGateFrame(1920, 1080, "auto")).toBeNull()
    expect(computeAspectGateFrame(0, 0, "16:9")).toBeNull()
  })

  it("视口区域小到装不下让位余量时返回 null，由调用方退化处理", () => {
    expect(computeAspectGateFrame(160, 300, "16:9")).toBeNull()
  })
})
