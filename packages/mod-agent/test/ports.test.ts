import { describe, expect, it, vi } from 'vitest'
import { lazySingleton } from '../src/ports.ts'

/**
 * 惰性单例：包里那些「原来 import 时就按环境变量建好」的对象，现在等宿主装配完端口才建。
 * 调用方照旧当普通对象用 —— 属性、方法（含依赖 this 的）、展开、Object.keys、in 都要和真对象一样。
 */
describe('lazySingleton', () => {
  it('第一次访问才建，之后一直是同一个', () => {
    const build = vi.fn(() => ({ n: 1 }))
    const value = lazySingleton(build)
    expect(build).not.toHaveBeenCalled()
    expect(value.n).toBe(1)
    expect(value.n).toBe(1)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('方法里的 this 指向真对象', () => {
    class Counter {
      count = 0
      bump() {
        this.count += 1
        return this.count
      }
    }
    const counter = lazySingleton(() => new Counter())
    const { bump } = counter
    expect(counter.bump()).toBe(1)
    expect(bump()).toBe(2)
  })

  it('展开、Object.keys、in 都看得到真对象的键（agentHostOptions 被展开进 createAgentRuntime）', () => {
    const value = lazySingleton(() => ({ a: 1, b: 'x' }))
    expect({ ...value }).toEqual({ a: 1, b: 'x' })
    expect(Object.keys(value)).toEqual(['a', 'b'])
    expect('a' in value).toBe(true)
  })

  it('数组也能用（模型键表）', () => {
    const keys = lazySingleton(() => ['default', 'cheap'])
    expect([...keys]).toEqual(['default', 'cheap'])
    expect(keys.includes('cheap')).toBe(true)
    expect(keys.length).toBe(2)
  })

  it('建的时候抛错 = 访问时抛（装配函数主动访问一次，就是启动时校验）', () => {
    const value = lazySingleton<{ x: number }>(() => {
      throw new Error('agent 定义不合法')
    })
    expect(() => value.x).toThrow('agent 定义不合法')
  })
})
