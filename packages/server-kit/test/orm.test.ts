import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineEntity, p } from '@mikro-orm/core'
import { afterAll, describe, expect, it } from 'vitest'
import { openOrm, providerFromUrl } from '../src/orm.ts'

describe('providerFromUrl', () => {
  it('按协议判 provider，认不出来 → undefined', () => {
    expect(providerFromUrl('file:/tmp/a.db')).toBe('sqlite')
    expect(providerFromUrl('postgres://u@h/db')).toBe('postgresql')
    expect(providerFromUrl('POSTGRESQL://u@h/db')).toBe('postgresql')
    expect(providerFromUrl('mysql://u@h/db')).toBeUndefined()
    expect(providerFromUrl('/tmp/a.db')).toBeUndefined()
    expect(providerFromUrl(undefined)).toBeUndefined()
  })
})

describe('openOrm', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-kit-orm-'))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('SQLite：file: 路径的父目录不存在时先建好，dbName 去掉 file: 前缀', async () => {
    const file = path.join(dir, 'a/b/test.db')
    const Probe = defineEntity({ name: 'Probe', properties: { id: p.text().primary() } })
    const orm = await openOrm({ provider: 'sqlite', url: `file:${file}`, entities: [Probe] })
    expect(orm.config.get('dbName')).toBe(file)
    expect(fs.existsSync(path.dirname(file))).toBe(true)
    await orm.close()
  })
})
