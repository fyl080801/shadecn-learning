import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../../store/notes.ts'

/** 模块加载时自带的示例数据，用例之间要保住它们 */
const seedIds = new Set(store.list().map((n) => n.id))

/**
 * 时间戳只到毫秒，连续两次写会撞在一起 —— 只假造 Date，别动定时器。
 * 时间取在示例数据之后，这样排序断言才有意义。
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'))
})

afterEach(() => {
  // 模块级 Map 是共享的，用例自己收拾干净
  for (const note of store.list()) {
    if (!seedIds.has(note.id)) store.remove(note.id)
  }
})

describe('notes store', () => {
  it('模块加载时带两条示例数据，按 createdAt 升序', () => {
    const list = store.list()
    expect(list).toHaveLength(2)
    expect(list.map((n) => n.title)).toEqual(['第一条笔记', '第二条笔记'])
  })

  it('create 分配递增 id，并把 createdAt/updatedAt 设成同一时刻', () => {
    const a = store.create({ title: 'A', content: 'a' })
    const b = store.create({ title: 'B', content: 'b' })

    expect(a.id).toMatch(/^note_\d+$/)
    expect(b.id).not.toBe(a.id)
    expect(a.createdAt).toBe('2099-01-01T00:00:00.000Z')
    expect(a.updatedAt).toBe(a.createdAt)
  })

  it('get 拿得到刚建的，拿不到不存在的', () => {
    const created = store.create({ title: 'A', content: 'a' })
    expect(store.get(created.id)).toEqual(created)
    expect(store.get('note_不存在')).toBeUndefined()
  })

  it('update 只改传进来的字段，并刷新 updatedAt', () => {
    const created = store.create({ title: 'A', content: 'a' })
    vi.setSystemTime(new Date('2099-01-02T00:00:00.000Z'))

    const updated = store.update(created.id, { title: 'A2' })

    expect(updated).toMatchObject({ id: created.id, title: 'A2', content: 'a' })
    expect(updated?.createdAt).toBe(created.createdAt)
    expect(updated?.updatedAt).toBe('2099-01-02T00:00:00.000Z')
    // 写回了 Map，不是只返回了个副本
    expect(store.get(created.id)?.title).toBe('A2')
  })

  it('update 不存在的 id 返回 undefined，也不会凭空建一条', () => {
    const before = store.list().length
    expect(store.update('note_不存在', { title: 'x' })).toBeUndefined()
    expect(store.list()).toHaveLength(before)
  })

  it('remove 成功返回 true，重复删返回 false', () => {
    const created = store.create({ title: 'A', content: 'a' })
    expect(store.remove(created.id)).toBe(true)
    expect(store.remove(created.id)).toBe(false)
    expect(store.get(created.id)).toBeUndefined()
  })

  it('list 按 createdAt 排序，跟插入顺序一致', () => {
    vi.setSystemTime(new Date('2099-03-01T00:00:00.000Z'))
    const first = store.create({ title: 'X', content: '' })
    vi.setSystemTime(new Date('2099-04-01T00:00:00.000Z'))
    const second = store.create({ title: 'Y', content: '' })

    const tail = store.list().slice(-2)
    expect(tail.map((n) => n.id)).toEqual([first.id, second.id])
  })
})
