import { Hono } from 'hono'
import { store, type Note } from '../store/notes.ts'

interface NotePayload {
  title?: unknown
  content?: unknown
}

type NoteFields = Partial<Pick<Note, 'title' | 'content'>>
type ParseResult = { ok: true; value: NoteFields } | { ok: false; error: string }

/** partial=true 用于 PATCH：字段可缺省；partial=false 用于 POST：title 必填 */
function parseBody(body: NotePayload, partial: boolean): ParseResult {
  const value: NoteFields = {}

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      return { ok: false, error: 'title 必须是非空字符串' }
    }
    value.title = body.title.trim()
  } else if (!partial) {
    return { ok: false, error: 'title 是必填项' }
  }

  if (body.content !== undefined) {
    if (typeof body.content !== 'string') {
      return { ok: false, error: 'content 必须是字符串' }
    }
    value.content = body.content
  } else if (!partial) {
    value.content = ''
  }

  return { ok: true, value }
}

export const notes = new Hono()
  .get('/', (c) => c.json(store.list()))

  .get('/:id', (c) => {
    const note = store.get(c.req.param('id'))
    if (!note) return c.json({ error: 'Note not found' }, 404)
    return c.json(note)
  })

  .post('/', async (c) => {
    const body = await c.req.json<NotePayload>().catch(() => null)
    if (!body) return c.json({ error: '请求体不是合法 JSON' }, 400)

    const parsed = parseBody(body, false)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)

    return c.json(store.create(parsed.value as Pick<Note, 'title' | 'content'>), 201)
  })

  .patch('/:id', async (c) => {
    const body = await c.req.json<NotePayload>().catch(() => null)
    if (!body) return c.json({ error: '请求体不是合法 JSON' }, 400)

    const parsed = parseBody(body, true)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)

    const updated = store.update(c.req.param('id'), parsed.value)
    if (!updated) return c.json({ error: 'Note not found' }, 404)
    return c.json(updated)
  })

  .delete('/:id', (c) => {
    if (!store.remove(c.req.param('id'))) {
      return c.json({ error: 'Note not found' }, 404)
    }
    return c.body(null, 204)
  })
