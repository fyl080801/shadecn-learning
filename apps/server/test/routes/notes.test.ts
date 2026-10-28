import { afterEach, describe, expect, it } from 'vitest'
import { notes } from '../../routes/notes.ts'
import { store, type Note } from '../../store/notes.ts'

const seedIds = new Set(store.list().map((n) => n.id))

afterEach(() => {
  for (const note of store.list()) {
    if (!seedIds.has(note.id)) store.remove(note.id)
  }
})

const json = (path: string, method: string, body: unknown) =>
  notes.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('GET /api/notes', () => {
  it('返回全部笔记', async () => {
    const res = await notes.request('/')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toHaveLength(2)
  })
})

describe('GET /api/notes/:id', () => {
  it('命中返回 200', async () => {
    const created = store.create({ title: 'A', content: 'a' })
    const res = await notes.request(`/${created.id}`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(created)
  })

  it('不存在返回 404', async () => {
    const res = await notes.request('/note_不存在')
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Note not found' })
  })
})

describe('POST /api/notes', () => {
  it('创建成功返回 201 和新对象', async () => {
    const res = await json('/', 'POST', { title: '新笔记', content: '正文' })

    expect(res.status).toBe(201)
    const body = (await res.json()) as Note
    expect(body).toMatchObject({ title: '新笔记', content: '正文' })
    expect(store.get(body.id)).toBeDefined()
  })

  it('title 前后空格会被 trim 掉', async () => {
    const res = await json('/', 'POST', { title: '  带空格  ', content: '' })
    await expect(res.json()).resolves.toMatchObject({ title: '带空格' })
  })

  it('不传 content 时默认空字符串', async () => {
    const res = await json('/', 'POST', { title: 'only-title' })
    await expect(res.json()).resolves.toMatchObject({ content: '' })
  })

  it.each([
    ['缺 title', {}, 'title 是必填项'],
    ['title 是空串', { title: '' }, 'title 必须是非空字符串'],
    ['title 全是空格', { title: '   ' }, 'title 必须是非空字符串'],
    ['title 不是字符串', { title: 123 }, 'title 必须是非空字符串'],
    ['content 不是字符串', { title: 'ok', content: 42 }, 'content 必须是字符串'],
  ])('%s → 400', async (_label, body, error) => {
    const res = await json('/', 'POST', body)
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error })
  })

  it('请求体不是合法 JSON → 400', async () => {
    const res = await json('/', 'POST', '{ 不是 json')
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: '请求体不是合法 JSON' })
  })

  it('校验失败时不会往 store 里塞脏数据', async () => {
    const before = store.list().length
    await json('/', 'POST', { title: '' })
    expect(store.list()).toHaveLength(before)
  })
})

describe('PATCH /api/notes/:id', () => {
  it('只改传进来的字段', async () => {
    const created = store.create({ title: 'A', content: 'a' })
    const res = await json(`/${created.id}`, 'PATCH', { content: 'a2' })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ title: 'A', content: 'a2' })
  })

  it('空 body 也合法（PATCH 字段全部可缺省）', async () => {
    const created = store.create({ title: 'A', content: 'a' })
    const res = await json(`/${created.id}`, 'PATCH', {})
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ title: 'A', content: 'a' })
  })

  it('title 传了但非法 → 400', async () => {
    const created = store.create({ title: 'A', content: 'a' })
    const res = await json(`/${created.id}`, 'PATCH', { title: '  ' })
    expect(res.status).toBe(400)
    expect(store.get(created.id)?.title).toBe('A')
  })

  it('不存在的 id → 404', async () => {
    const res = await json('/note_不存在', 'PATCH', { title: 'x' })
    expect(res.status).toBe(404)
  })

  it('先校验 body 再查 id：body 非法时返回 400 而不是 404', async () => {
    const res = await json('/note_不存在', 'PATCH', { title: '' })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/notes/:id', () => {
  it('删除成功返回 204 且没有 body', async () => {
    const created = store.create({ title: 'A', content: 'a' })
    const res = await notes.request(`/${created.id}`, { method: 'DELETE' })

    expect(res.status).toBe(204)
    await expect(res.text()).resolves.toBe('')
    expect(store.get(created.id)).toBeUndefined()
  })

  it('重复删除返回 404', async () => {
    const created = store.create({ title: 'A', content: 'a' })
    await notes.request(`/${created.id}`, { method: 'DELETE' })
    const res = await notes.request(`/${created.id}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
