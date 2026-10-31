import { describe, expect, it } from 'vitest'
import {
  boundingRect,
  fitGroupFrame,
  GROUP_HEADER,
  groupUnderNode,
  GROUP_PADDING,
  groupFrameAround,
  LAYOUT_NODE_GAP,
  LAYOUT_RANK_GAP,
  layoutHorizontal,
  planAutoLayout,
  planGroupArrangement,
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

describe('分组边界', () => {
  const frame = { x: 100, y: 100, width: 400, height: 300 }

  it('fitGroupFrame：罩得住时原样不动，只长不缩', () => {
    const fit = fitGroupFrame(frame, [{ x: GROUP_PADDING, y: GROUP_PADDING + GROUP_HEADER, width: 50, height: 50 }])
    expect(fit).toEqual({ frame, shift: { x: 0, y: 0 } })
    expect(fitGroupFrame(frame, [])).toEqual({ frame, shift: { x: 0, y: 0 } })
  })

  it('fitGroupFrame：超出右下往右下长（含留白），左上角不动', () => {
    const fit = fitGroupFrame(frame, [{ x: 350, y: 250, width: 100, height: 100 }])
    expect(fit.shift).toEqual({ x: 0, y: 0 })
    expect(fit.frame).toEqual({ x: 100, y: 100, width: 450 + GROUP_PADDING, height: 350 + GROUP_PADDING })
  })

  it('fitGroupFrame：超出左上，框往左上长、给出组员相对坐标的补偿量', () => {
    const fit = fitGroupFrame(frame, [{ x: -40, y: 0, width: 100, height: 100 }])
    const shift = { x: 40 + GROUP_PADDING, y: GROUP_PADDING + GROUP_HEADER }
    expect(fit.shift).toEqual(shift)
    expect(fit.frame).toEqual({ x: 100 - shift.x, y: 100 - shift.y, width: 400 + shift.x, height: 300 + shift.y })
  })

  it('groupUnderNode：看节点中心点；蹭到框边不算；落在叠着的几个框里取最小的', () => {
    const big = { id: 'big', rect: { x: 0, y: 0, width: 1000, height: 1000 } }
    const small = { id: 'small', rect: { x: 100, y: 100, width: 300, height: 300 } }
    expect(groupUnderNode({ x: 150, y: 150, width: 100, height: 100 }, [big, small])).toBe('small')
    expect(groupUnderNode({ x: 500, y: 500, width: 100, height: 100 }, [big, small])).toBe('big')
    // 右半截探进 small，中心在外面
    expect(groupUnderNode({ x: 340, y: 150, width: 200, height: 100 }, [small])).toBeNull()
  })
})

describe('planGroupArrangement（组内排列）', () => {
  const L = GROUP_PADDING
  const T = GROUP_PADDING + GROUP_HEADER
  const G = LAYOUT_NODE_GAP
  const member = (id: string, x: number, y: number, width = 100, height = 50) => ({ id, position: { x, y }, width, height })

  it('横向：按现在的 x 从左到右排成一行、顶边对齐，框正好罩住', () => {
    const plan = planGroupArrangement([member('b', 300, 0), member('a', 10, 200, 100, 80), member('c', 500, 90)], 'horizontal')
    expect(plan.positions.get('a')).toEqual({ x: L, y: T })
    expect(plan.positions.get('b')).toEqual({ x: L + 100 + G, y: T })
    expect(plan.positions.get('c')).toEqual({ x: L + 2 * (100 + G), y: T })
    expect(plan.size).toEqual({ width: 300 + 2 * G + 2 * L, height: 80 + 2 * GROUP_PADDING + GROUP_HEADER })
  })

  it('纵向：按现在的 y 从上到下排成一列、左边对齐', () => {
    const plan = planGroupArrangement([member('b', 0, 300), member('a', 400, 10)], 'vertical')
    expect(plan.positions.get('a')).toEqual({ x: L, y: T })
    expect(plan.positions.get('b')).toEqual({ x: L, y: T + 50 + G })
  })

  it('宫格：列数 ceil(√n)，按阅读顺序逐行填，列宽取该列最宽、行高取该行最高', () => {
    const plan = planGroupArrangement(
      [member('a', 0, 0, 200, 50), member('b', 100, 0), member('c', 0, 100, 100, 120), member('d', 100, 100), member('e', 0, 200)],
      'grid',
    )
    // 5 个 → 3 列 2 行：a b c / d e
    expect(plan.positions.get('a')).toEqual({ x: L, y: T })
    expect(plan.positions.get('b')).toEqual({ x: L + 200 + G, y: T })
    expect(plan.positions.get('c')).toEqual({ x: L + 300 + 2 * G, y: T })
    expect(plan.positions.get('d')).toEqual({ x: L, y: T + 120 + G })
    expect(plan.positions.get('e')).toEqual({ x: L + 200 + G, y: T + 120 + G })
  })

  it('没有组员：不排、没有尺寸', () => {
    expect(planGroupArrangement([], 'grid')).toEqual({ positions: new Map(), size: null })
  })
})
