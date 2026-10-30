import { describe, expect, it } from 'vitest'
import {
  boundingRect,
  GROUP_HEADER,
  GROUP_PADDING,
  groupFrameAround,
  LAYOUT_RANK_GAP,
  layoutHorizontal,
  planAutoLayout,
  type LayoutBox,
} from '../src/flow-layout.ts'

function box(id: string, width = 200, height = 100): LayoutBox {
  return { id, width, height }
}

/** 取一个盒子的位置，没排到就直接让用例失败 */
function at(positions: Map<string, { x: number; y: number }>, id: string) {
  const position = positions.get(id)
  if (!position) throw new Error(`没有排到 ${id}`)
  return position
}

describe('layoutHorizontal', () => {
  it('链式连线从左到右排成一行，相邻两列间距为 LAYOUT_RANK_GAP', () => {
    const positions = layoutHorizontal(
      [box('a'), box('b'), box('c')],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' }
      ]
    )
    const a = at(positions, 'a')
    const b = at(positions, 'b')
    const c = at(positions, 'c')

    expect(b.x - a.x).toBe(200 + LAYOUT_RANK_GAP)
    expect(c.x - b.x).toBe(200 + LAYOUT_RANK_GAP)
    expect(a.y).toBe(b.y)
    expect(b.y).toBe(c.y)
  })

  it('一个上游连多个下游：下游同列、上下排开不重叠', () => {
    const positions = layoutHorizontal(
      [box('root'), box('x'), box('y')],
      [
        { source: 'root', target: 'x' },
        { source: 'root', target: 'y' }
      ]
    )
    const x = at(positions, 'x')
    const y = at(positions, 'y')

    expect(x.x).toBe(y.x)
    expect(x.x).toBeGreaterThan(at(positions, 'root').x)
    expect(Math.abs(x.y - y.y)).toBeGreaterThanOrEqual(100)
  })

  it('返回左上角坐标且为整数', () => {
    const positions = layoutHorizontal([box('a', 201, 99)], [])
    const a = at(positions, 'a')
    expect(Number.isInteger(a.x)).toBe(true)
    expect(Number.isInteger(a.y)).toBe(true)
  })

  it('自环和端点不在盒子里的连线被忽略，不会报错', () => {
    const positions = layoutHorizontal(
      [box('a'), box('b')],
      [
        { source: 'a', target: 'a' },
        { source: 'a', target: 'ghost' },
        { source: 'a', target: 'b' }
      ]
    )
    expect([...positions.keys()].sort()).toEqual(['a', 'b'])
    expect(at(positions, 'b').x).toBeGreaterThan(at(positions, 'a').x)
  })
})

describe('planAutoLayout', () => {
  // 默认放在一个排完不可能落到的位置，好让「变了的」都出现在结果里
  const node = (id: string, x = 777, y = 777, parentNode?: string) => ({
    id,
    position: { x, y },
    width: 200,
    height: 100,
    ...(parentNode !== undefined ? { parentNode } : {}),
  })

  it('只排顶层节点；连到组内节点的线按它所在的分组计', () => {
    const moved = planAutoLayout(
      [node('a'), node('g'), node('child', 10, 10, 'g')],
      [{ source: 'a', target: 'child' }],
    )
    expect(moved.has('child')).toBe(false)
    const a = at(moved, 'a')
    const g = at(moved, 'g')
    // 线 a → child 当成 a → g：g 排在 a 右边一列
    expect(g.x - a.x).toBe(200 + LAYOUT_RANK_GAP)
  })

  it('只返回位置真的变了的节点；没有顶层节点时什么都不排', () => {
    const first = planAutoLayout([node('a'), node('b')], [{ source: 'a', target: 'b' }])
    const settled = [node('a', at(first, 'a').x, at(first, 'a').y), node('b', at(first, 'b').x, at(first, 'b').y)]
    expect(planAutoLayout(settled, [{ source: 'a', target: 'b' }]).size).toBe(0)
    expect(planAutoLayout([node('child', 0, 0, 'ghost')], []).size).toBe(0)
  })

  it('空串的 parentNode 按顶层算；父链成环不死循环', () => {
    const moved = planAutoLayout(
      [node('a', 999, 999, ''), node('x', 0, 0, 'y'), node('y', 0, 0, 'x')],
      [{ source: 'x', target: 'a' }],
    )
    expect([...moved.keys()]).toEqual(['a'])
  })
})

describe('分组框', () => {
  it('boundingRect 取外接矩形；空集合返回 null', () => {
    expect(
      boundingRect([
        { x: 0, y: 0, width: 100, height: 50 },
        { x: 200, y: -20, width: 50, height: 100 },
      ]),
    ).toEqual({ x: 0, y: -20, width: 250, height: 100 })
    expect(boundingRect([])).toBeNull()
  })

  it('groupFrameAround：四周留 GROUP_PADDING，顶上再多留 GROUP_HEADER', () => {
    expect(groupFrameAround({ x: 100, y: 100, width: 300, height: 200 })).toEqual({
      x: 100 - GROUP_PADDING,
      y: 100 - GROUP_PADDING - GROUP_HEADER,
      width: 300 + GROUP_PADDING * 2,
      height: 200 + GROUP_PADDING * 2 + GROUP_HEADER,
    })
  })
})
