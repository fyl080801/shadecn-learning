import type { MikroORM } from '@mikro-orm/core'
import { vi } from 'vitest'

/**
 * 拿一份**全新模块图**里的 app（`vi.resetModules()` + 动态 import），同时给它一个配套的 ORM。
 *
 * 为什么不能只 `resetModules`：`db.ts` 把 ORM 单例挂在 `globalThis` 上，重载模块后它会直接复用
 * 旧的那个 —— 可旧 ORM 里注册的是**旧一份实体定义**（`defineEntity` 随模块重新执行而重新产生），
 * 新模块图里的 store 拿新实体去查就找不到元数据（`Cannot set properties of undefined (setting '__schema')`）。
 * 所以导入前先把全局缓存摘掉，让新模块图自己建一个，导完再把原来的放回去，
 * 免得影响 helpers/db.ts 手里那个（测试自己查库、清库用的）。
 *
 * 新建的 ORM 在 `closeFreshOrms()` 里关掉，调用方放进 afterEach。
 */
const opened: MikroORM[] = []

export async function importFreshApp() {
  const holder = globalThis as unknown as { __mikroOrm?: MikroORM }
  const original = holder.__mikroOrm
  delete holder.__mikroOrm
  vi.resetModules()
  try {
    const { app } = await import('../../app.ts')
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
