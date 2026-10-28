import { describe, expect, it } from 'vitest'
import { createId } from '../src/id.ts'

/**
 * id 的实现挪进了 shared —— 浏览器和服务端（agent 的画布工具）用同一份。
 * 前端那边的 `apps/web/src/test/lib/id.test.ts` 仍从 `@/lib/id` 测形状与时间序；
 * 这里守住「在 Node 下也能跑」（`crypto` 取自 `globalThis`）。
 */
describe('createId()', () => {
  it('Node 下可用，形如 <前缀>_<时间戳 base36>_<8 位随机段>', () => {
    expect(createId('n')).toMatch(/^n_[0-9a-z]+_[0-9a-z]{8}$/)
  })

  it('连续生成不重复', () => {
    expect(new Set(Array.from({ length: 1000 }, () => createId('e'))).size).toBe(1000)
  })
})
