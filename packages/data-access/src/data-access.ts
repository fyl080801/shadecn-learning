import type { EntityManager, MikroORM } from '@mikro-orm/core'
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'

/** ORM 实例的注入 token。只在模块内部用，对外的入口是 {@link DataAccess} */
export const DATA_ACCESS_ORM = Symbol('DATA_ACCESS_ORM')

/** 要管理的实体，默认 `dataAccessEntities`。yaml 表达不了实体对象，所以是模块内部的 token，不对外导出 */
export const DATA_ACCESS_ENTITIES = Symbol('DATA_ACCESS_ENTITIES')

/**
 * 其他模块经依赖注入拿到的数据访问能力。能注入到它，就说明 ORM 已建好、表结构已对齐（见 module.ts）。
 *
 * 全局 EntityManager 默认禁用（`allowGlobalContext: false`），一律经 {@link em} 或 {@link transactional} 拿 fork 出来的，
 * 身份映射不跨操作共享，语义和 `@shadecn/server-kit/db` 的 `db()` 一致。
 */
@Injectable()
export class DataAccess implements OnApplicationShutdown {
  private closing: Promise<void> | undefined

  // esbuild 不输出 emitDecoratorMetadata，构造函数参数必须显式 @Inject
  constructor(@Inject(DATA_ACCESS_ORM) readonly orm: MikroORM) {}

  /** 每次都 fork 一个干净的 EntityManager：一次操作（或一组要放进同一事务的操作）一个 */
  em(): EntityManager {
    return this.orm.em.fork()
  }

  /** 在事务里跑 `fn`：正常返回则提交（含 flush），抛错则回滚并原样抛出 */
  transactional<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.em().transactional(fn)
  }

  /**
   * 放在关闭流程的最后一个阶段（而不是 onModuleDestroy）：Nest 按 onModuleDestroy → beforeApplicationShutdown →
   * 关 HTTP → onApplicationShutdown 走，业务模块的 onModuleDestroy 和收尾中的请求还要用库。
   * 只关一次：`app.close()` 被调两次时第二次拿到同一个 Promise。
   */
  onApplicationShutdown(): Promise<void> {
    this.closing ??= this.orm.close()
    return this.closing
  }
}
