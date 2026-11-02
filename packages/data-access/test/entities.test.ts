import { EntitySchema } from '@mikro-orm/core'
import { describe, expect, it } from 'vitest'
import { dataAccessEntities } from '../src/index.js'

function entitiesIn(module: Record<string, unknown>): unknown[] {
  return Object.values(module).filter((value) => value instanceof EntitySchema)
}

describe('dataAccessEntities', () => {
  it('覆盖 User 和五个模块导出的全部实体：模块新增实体没跟着加 → 这里失败', async () => {
    const modules = await Promise.all([
      import('@shadecn/server-kit/identity'),
      import('@shadecn/mod-auth/entities'),
      import('@shadecn/mod-canvas/entities'),
      import('@shadecn/mod-storage/entities'),
      import('@shadecn/mod-agent/entities'),
      import('@shadecn/mod-apps/entities'),
    ])
    const expected = new Set(modules.flatMap(entitiesIn))
    expect(new Set(dataAccessEntities as unknown[])).toEqual(expected)
    expect((dataAccessEntities as unknown[]).length).toBe(expected.size)
  })
})
