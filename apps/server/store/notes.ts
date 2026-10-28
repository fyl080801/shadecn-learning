export interface Note {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
}

/**
 * 内存存储 —— 进程重启即清空。
 * 后面要持久化时，只需换掉这个模块的实现，路由层不用动。
 */
const notes = new Map<string, Note>()
let seq = 0

function nextId() {
  seq += 1
  return `note_${seq}`
}

export const store = {
  list(): Note[] {
    return [...notes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  },

  get(id: string): Note | undefined {
    return notes.get(id)
  },

  create(input: Pick<Note, 'title' | 'content'>): Note {
    const now = new Date().toISOString()
    const note: Note = { id: nextId(), ...input, createdAt: now, updatedAt: now }
    notes.set(note.id, note)
    return note
  },

  update(id: string, patch: Partial<Pick<Note, 'title' | 'content'>>): Note | undefined {
    const current = notes.get(id)
    if (!current) return undefined
    const next: Note = { ...current, ...patch, updatedAt: new Date().toISOString() }
    notes.set(id, next)
    return next
  },

  remove(id: string): boolean {
    return notes.delete(id)
  },
}

store.create({ title: '第一条笔记', content: '这是后端内存里的示例数据。' })
store.create({ title: '第二条笔记', content: '试试 PATCH / DELETE /api/notes/:id' })
