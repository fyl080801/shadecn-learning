import { describe, expect, it } from "vitest"
import { LAYOUT_RANK_GAP, layoutHorizontal, type LayoutBox } from "@/lib/flow-layout"

function box(id: string, width = 200, height = 100): LayoutBox {
  return { id, width, height }
}

/** 取一个盒子的位置，没排到就直接让用例失败 */
function at(positions: Map<string, { x: number; y: number }>, id: string) {
  const position = positions.get(id)
  if (!position) throw new Error(`没有排到 ${id}`)
  return position
}

describe("layoutHorizontal", () => {
  it("链式连线从左到右排成一行，相邻两列间距为 LAYOUT_RANK_GAP", () => {
    const positions = layoutHorizontal(
      [box("a"), box("b"), box("c")],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" }
      ]
    )
    const a = at(positions, "a")
    const b = at(positions, "b")
    const c = at(positions, "c")

    expect(b.x - a.x).toBe(200 + LAYOUT_RANK_GAP)
    expect(c.x - b.x).toBe(200 + LAYOUT_RANK_GAP)
    expect(a.y).toBe(b.y)
    expect(b.y).toBe(c.y)
  })

  it("一个上游连多个下游：下游同列、上下排开不重叠", () => {
    const positions = layoutHorizontal(
      [box("root"), box("x"), box("y")],
      [
        { source: "root", target: "x" },
        { source: "root", target: "y" }
      ]
    )
    const x = at(positions, "x")
    const y = at(positions, "y")

    expect(x.x).toBe(y.x)
    expect(x.x).toBeGreaterThan(at(positions, "root").x)
    expect(Math.abs(x.y - y.y)).toBeGreaterThanOrEqual(100)
  })

  it("返回左上角坐标且为整数", () => {
    const positions = layoutHorizontal([box("a", 201, 99)], [])
    const a = at(positions, "a")
    expect(Number.isInteger(a.x)).toBe(true)
    expect(Number.isInteger(a.y)).toBe(true)
  })

  it("自环和端点不在盒子里的连线被忽略，不会报错", () => {
    const positions = layoutHorizontal(
      [box("a"), box("b")],
      [
        { source: "a", target: "a" },
        { source: "a", target: "ghost" },
        { source: "a", target: "b" }
      ]
    )
    expect([...positions.keys()].sort()).toEqual(["a", "b"])
    expect(at(positions, "b").x).toBeGreaterThan(at(positions, "a").x)
  })
})
