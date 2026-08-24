import { describe, expect, it } from 'vitest'
import { normalize } from '../../logger/console.ts'

/**
 * console 接管的解析规则 —— 整套日志「零入侵」就靠它：
 * 仓库里既有的 49 处 `console.log('[模块] …')` 一行不改，
 * 却要变成带 module 字段的结构化日志。
 */
describe('console 参数解析', () => {
  it('`[模块]` 前缀 → module 字段，消息里不再留下它', () => {
    const { message, meta } = normalize(['[collab] flow:abc 落库完成'])
    expect(meta.module).toBe('collab')
    expect(message).toBe('flow:abc 落库完成')
  })

  it('没有前缀就不猜 module', () => {
    const { message, meta } = normalize(['服务已启动'])
    expect(meta.module).toBeUndefined()
    expect(message).toBe('服务已启动')
  })

  it('只认开头的方括号，消息中间的不算前缀', () => {
    const { message, meta } = normalize(['房间 [flow:abc] 已卸载'])
    expect(meta.module).toBeUndefined()
    expect(message).toBe('房间 [flow:abc] 已卸载')
  })

  it('Error 走 error / stack 字段，而不是被 toString 进消息里', () => {
    const boom = new Error('写库失败')
    const { message, meta } = normalize(['[collab] 落库出错', boom])
    expect(message).toBe('落库出错')
    expect(meta.error).toBe('写库失败')
    expect(meta.stack).toContain('Error: 写库失败')
  })

  it('末尾的普通对象铺成结构化字段', () => {
    const { message, meta } = normalize(['[db] 慢查询', { ms: 320, rows: 12 }])
    expect(message).toBe('慢查询')
    expect(meta).toMatchObject({ module: 'db', ms: 320, rows: 12 })
  })

  it('非字符串非对象的参数不丢，接在消息后面', () => {
    const { message } = normalize(['[auth] 会话数', 42])
    expect(message).toBe('会话数 42')
  })
})
