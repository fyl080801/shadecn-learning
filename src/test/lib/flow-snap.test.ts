import { describe, expect, it } from "vitest"
import { boundingRect, computeSnap, snapValueToGrid, type SnapRect } from "@/lib/flow-snap"

/** 100×50 的矩形，够区分「左边 / 中线 / 右边」三条候选线 */
function rect(x: number, y: number, width = 100, height = 50): SnapRect {
  return { x, y, width, height }
}

const NO_SNAP = { grid: 0, threshold: 0 }

describe("snapValueToGrid", () => {
  it("就近取整到格子", () => {
    expect(snapValueToGrid(17, 16)).toBe(16)
    expect(snapValueToGrid(25, 16)).toBe(32)
    expect(snapValueToGrid(-17, 16)).toBe(-16)
  })

  it("格子为 0 → 原样返回（等于关掉网格吸附）", () => {
    expect(snapValueToGrid(17, 0)).toBe(17)
  })
})

describe("网格吸附", () => {
  it("左上角对到最近的格点", () => {
    const { delta, guides } = computeSnap(rect(19, 30), [], { grid: 16, threshold: 0 })
    expect(delta).toEqual({ x: -3, y: 2 })
    // 网格吸附不产生辅助线：没有任何参照物
    expect(guides).toEqual([])
  })

  it("关掉就不动", () => {
    expect(computeSnap(rect(19, 30), [], NO_SNAP).delta).toEqual({ x: 0, y: 0 })
  })
})

describe("辅助线吸附", () => {
  const target = rect(200, 200)

  it("左边差一点点 → 吸过去并画出竖线", () => {
    const { delta, guides } = computeSnap(rect(204, 400), [target], { grid: 0, threshold: 6 })

    expect(delta).toEqual({ x: -4, y: 0 })
    expect(guides).toHaveLength(1)
    expect(guides[0]).toMatchObject({ orientation: "vertical", position: 200 })
    // 线要贯穿两个矩形：上到 target 的顶（200），下到自己的底（450）
    expect(guides[0]?.start).toBe(200)
    expect(guides[0]?.end).toBe(450)
  })

  it("超出容差就不吸，也不画线", () => {
    const { delta, guides } = computeSnap(rect(210, 400), [target], { grid: 0, threshold: 6 })
    expect(delta).toEqual({ x: 0, y: 0 })
    expect(guides).toEqual([])
  })

  it("中线对中线也算对齐", () => {
    // 宽 60 的矩形放在 223：左边 223、中线 253、右边 283 —— 只有中线够得着 target 的 250
    const { delta, guides } = computeSnap(rect(223, 400, 60), [target], { grid: 0, threshold: 6 })
    expect(delta.x).toBe(-3)
    expect(guides[0]).toMatchObject({ orientation: "vertical", position: 250 })
  })

  it("两个轴各自独立吸附，各出一条线", () => {
    const { delta, guides } = computeSnap(rect(203, 197), [target], { grid: 0, threshold: 6 })
    expect(delta).toEqual({ x: -3, y: 3 })
    expect(guides.map((guide) => guide.orientation)).toEqual(["vertical", "horizontal"])
  })

  it("多个矩形压在同一条线上 → 线贯穿全部，而不只是吸中的那一个", () => {
    const targets = [rect(200, 0), rect(200, 600)]
    const { guides } = computeSnap(rect(203, 300), targets, { grid: 0, threshold: 6 })

    expect(guides).toHaveLength(1)
    expect(guides[0]?.start).toBe(0)
    expect(guides[0]?.end).toBe(650)
  })

  it("有多个候选时取偏移最小的那一条", () => {
    // 左边差 5 → 100；中线差 1 → 254
    const targets = [rect(100, 400), rect(204, 400)]
    const { delta } = computeSnap(rect(105, 400), targets, { grid: 0, threshold: 6 })
    expect(delta.x).toBe(-1)
  })

  it("没有参照物就什么都不做", () => {
    expect(computeSnap(rect(203, 400), [], { grid: 0, threshold: 6 }).guides).toEqual([])
  })
})

describe("两种吸附同时开", () => {
  it("辅助线赢：先按网格量化，再被对齐拉到线上", () => {
    // 网格把 x=203 拉到 208，208 离 target 左边（200）还在容差内，最终落到 200
    const { delta, guides } = computeSnap(rect(203, 400), [rect(200, 200)], {
      grid: 16,
      threshold: 8
    })

    expect(203 + delta.x).toBe(200)
    expect(guides[0]).toMatchObject({ orientation: "vertical", position: 200 })
  })

  it("对不上任何东西时退回纯网格", () => {
    const { delta, guides } = computeSnap(rect(203, 400), [rect(900, 900)], {
      grid: 16,
      threshold: 6
    })

    expect(203 + delta.x).toBe(208)
    expect(guides).toEqual([])
  })
})

describe("boundingRect", () => {
  it("多选拖动取外接矩形", () => {
    expect(boundingRect([rect(0, 0), rect(200, 100)])).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 150
    })
  })

  it("空数组 → null", () => {
    expect(boundingRect([])).toBeNull()
  })
})
