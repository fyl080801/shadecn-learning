import { describe, expect, it } from "vitest"

import {
  FLOW_HANDLE_BOX,
  FLOW_HANDLE_GAP,
  FLOW_HANDLE_PLUS_RADIUS,
  FLOW_HANDLE_RADIUS,
  flowHandleFollow,
  flowHandleOffset,
  flowHandleShift,
  flowHandleZone
} from "@/components/flow/flow-handle"
import { flowScreenVars, screenToCanvas } from "@/components/flow/flow-screen"

describe("屏幕像素换算", () => {
  it("屏幕长度折回画布坐标：缩小一半，画布上要画两倍长", () => {
    expect(screenToCanvas(10, 1)).toBe(10)
    expect(screenToCanvas(10, 0.5)).toBe(20)
    expect(screenToCanvas(10, 2)).toBe(5)
  })

  it("缩放为 0 / 缺省时按 1 算，不出 Infinity", () => {
    expect(screenToCanvas(10, 0)).toBe(10)
  })

  it("画布根上的变量：缩放倒数 + 一个屏幕像素的画布长度", () => {
    expect(flowScreenVars(2)).toEqual({ "--flow-zoom-inv": "0.5", "--flow-px": "0.5px" })
    expect(flowScreenVars(0.25)).toEqual({ "--flow-zoom-inv": "4", "--flow-px": "4px" })
  })
})

describe("连接点的几何不随缩放变", () => {
  it("圆心离边框的屏幕距离恒定（间距 + 半径）", () => {
    for (const zoom of [0.25, 1, 3]) {
      expect(flowHandleOffset(zoom) * zoom).toBeCloseTo(FLOW_HANDLE_GAP + FLOW_HANDLE_RADIUS)
    }
  })

  it("连线端点从手柄外沿补到圆的外沿：边框 + 半个手柄盒子 + 补偿 = 屏幕上的间距 + 直径", () => {
    for (const zoom of [0.25, 1, 3]) {
      const outer = FLOW_HANDLE_BOX / 2 + flowHandleShift(zoom)
      expect(outer * zoom).toBeCloseTo(FLOW_HANDLE_GAP + FLOW_HANDLE_RADIUS * 2)
    }
  })
})

describe("出口加号的感应区与跟随", () => {
  it("感应区是正方形：屏幕上的大小不随缩放变", () => {
    expect(flowHandleZone(1)).toEqual({ width: 48, height: 48 })
    expect(flowHandleZone(0.5)).toEqual({ width: 96, height: 96 })
    expect(flowHandleZone(2)).toEqual({ width: 24, height: 24 })
  })

  it("鼠标在区域里：加号圆心就在鼠标下", () => {
    expect(flowHandleFollow(30, -10, 1)).toEqual({ x: 30, y: -10 })
    // 缩放 0.5：屏幕距离折回画布坐标
    expect(flowHandleFollow(20, 10, 0.5)).toEqual({ x: 40, y: 20 })
  })

  it("夹在区域里（按屏幕像素夹）：横向不比默认位置更靠近节点，纵向和横向一样的范围", () => {
    const half = 48 / 2 - FLOW_HANDLE_PLUS_RADIUS
    for (const zoom of [0.5, 1, 4]) {
      expect(flowHandleFollow(0, 0, zoom).x).toBeCloseTo(flowHandleOffset(zoom))
      expect(flowHandleFollow(500, 0, zoom).x * zoom).toBeCloseTo(48 - FLOW_HANDLE_PLUS_RADIUS)
      expect(flowHandleFollow(30, 500, zoom).y * zoom).toBeCloseTo(half)
      expect(flowHandleFollow(30, -500, zoom).y * zoom).toBeCloseTo(-half)
    }
  })
})
