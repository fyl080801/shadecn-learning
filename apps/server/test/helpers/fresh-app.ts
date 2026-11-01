import { createServer } from 'node:http'
import type { MikroORM } from '@mikro-orm/core'
import { vi } from 'vitest'

/**
 * 拿一份**全新模块图**里装配好的 app（`vi.resetModules()` + 动态 import + `prepare` + `assemble`）——
 * 换了环境变量（`vi.stubEnv`）之后要看整套行为变化的用例用它（换登录方式、换角色）。
 *
 * 新模块图里 `prepare` 会建一个配套的 ORM（实体随模块重新执行而重新产生，旧 ORM 的元数据里没有它们）。
 * `db.ts` 把 ORM 挂在 `globalThis` 上复用，所以导入前先把全局缓存摘掉、导完放回去，
 * 免得影响 helpers/db.ts 手里那个（测试自己查库、清库用的）。新建的 ORM 在 `closeFreshOrms()` 里关掉，调用方放进 afterEach。
 */
const opened: MikroORM[] = []

export async function importFreshApp() {
  const holder = globalThis as unknown as { __mikroOrm?: MikroORM }
  const original = holder.__mikroOrm
  delete holder.__mikroOrm
  vi.resetModules()
  try {
    const { app } = await import('@shadecn/server-core/app')
    const { assemble, prepare } = await import('@shadecn/server-core/server')
    const { modules } = await import('../../modules.ts')
    await prepare(modules)
    await assemble({ app, server: createServer() })
    const created = holder.__mikroOrm
    if (created && created !== original) opened.push(created)
    return app
  } finally {
    if (original) holder.__mikroOrm = original
  }
}

export async function closeFreshOrms() {
  for (const orm of opened.splice(0)) await orm.close()
}
