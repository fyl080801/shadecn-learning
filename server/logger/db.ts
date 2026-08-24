import { logSlowQueryMs } from '../config.ts'
import { contextFields } from './context.ts'
import { errorFields, logger } from './logger.ts'

/**
 * 数据库日志 —— 包在 **driver adapter** 外面，不动 Prisma 客户端，也不动任何一句查询。
 *
 * 三条路可以拿到查询日志，这里挑了第三条：
 *
 * 1. `new PrismaClient({ log: [...] })` + `$on('query')` —— 要改客户端构造，
 *    而且 `$on` 的类型跟着 log 配置的泛型走，改一处牵一串类型。
 * 2. `prisma.$extends({ query: ... })` —— 返回的不再是 `PrismaClient` 类型，
 *    `export const prisma: PrismaClient` 这个标注就得破例断言。
 * 3. **包 adapter**（本文件）—— adapter 本来就是构造参数，包一层 Proxy 之后类型不变，
 *    而且拦到的是**真正发出去的 SQL 和真实耗时**，连 Prisma 自己的内部查询也在内。
 *
 * 记什么、不记什么：
 * - 记 SQL 文本（截断）、耗时、行数；
 * - **不记参数值**。参数里有会话 token 的 HMAC、邮箱、画布内容 —— 日志会被采集、
 *   会被更多人看到，把它们抄一份进去是白送的风险。要看参数，用 `pnpm db:studio`。
 */

/** SQL 记进日志前压成一行并截断 —— 一条 Prisma 生成的 SELECT 能有几千字符 */
const MAX_SQL = 300

function briefSql(value: unknown): string {
  const sql = typeof value === 'string' ? value : String((value as { sql?: unknown })?.sql ?? '')
  const flat = sql.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_SQL ? `${flat.slice(0, MAX_SQL - 3)}...` : flat
}

/** 慢查询是 warn，正常查询是 debug（默认级别下不输出），失败是 error */
async function timed<T>(op: string, query: unknown, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await run()
    const ms = Date.now() - startedAt

    if (logSlowQueryMs > 0 && ms >= logSlowQueryMs) {
      logger.warn('慢查询', {
        module: 'db',
        ...contextFields(),
        op,
        ms,
        sql: briefSql(query),
      })
    } else if (logger.isDebugEnabled()) {
      logger.debug(op, {
        module: 'db',
        ...contextFields(),
        ms,
        sql: briefSql(query),
        rows: rowCount(result),
      })
    }
    return result
  } catch (error) {
    logger.error('查询失败', {
      module: 'db',
      ...contextFields(),
      op,
      ms: Date.now() - startedAt,
      sql: briefSql(query),
      ...errorFields(error),
    })
    throw error
  }
}

function rowCount(result: unknown): number | undefined {
  if (typeof result === 'number') return result
  const rows = (result as { rows?: unknown[] })?.rows
  return Array.isArray(rows) ? rows.length : undefined
}

/** 这些方法要计时，其余属性原样透传 */
const QUERY_METHODS = new Set(['queryRaw', 'executeRaw', 'executeScript'])

/**
 * 给一个「能执行 SQL 的东西」（adapter 本身、或它开出来的事务）套上计时。
 *
 * 用 Proxy 而不是手写一个转发类：adapter 的接口会随 Prisma 版本长出新方法
 * （`getConnectionInfo`、`connectToShadowDb`…），转发类漏一个就是运行时 `undefined is not a function`，
 * 而 Proxy 的默认行为就是透传，**新方法自动可用**。这也是「零入侵」在这一层的含义。
 */
function instrument<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver)
      if (typeof value !== 'function' || typeof property !== 'string') return value

      if (QUERY_METHODS.has(property)) {
        return (...args: unknown[]) =>
          timed(property, args[0], () =>
            (value as (...a: unknown[]) => Promise<unknown>).apply(object, args),
          )
      }

      // 事务里执行的语句同样要看得见，所以开出来的事务也包一层
      if (property === 'startTransaction') {
        return async (...args: unknown[]) => {
          const transaction = await (value as (...a: unknown[]) => Promise<object>).apply(
            object,
            args,
          )
          return instrument(transaction)
        }
      }

      return (value as (...a: unknown[]) => unknown).bind(object)
    },
  })
}

/**
 * 包住 adapter 工厂。`db.ts` 里就一处调用，是整个数据库日志的唯一注入点。
 *
 * 类型上是恒等函数（进什么类型出什么类型），所以 `PrismaClient` 的构造参数、
 * `prisma` 的导出类型都不受影响。
 */
export function instrumentAdapter<T extends { connect: () => Promise<object> }>(factory: T): T {
  return new Proxy(factory, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver)
      if (typeof value !== 'function') return value

      if (property === 'connect' || property === 'connectToShadowDb') {
        return async (...args: unknown[]) => {
          const adapter = await (value as (...a: unknown[]) => Promise<object>).apply(object, args)
          logger.debug('数据库连接已建立', { module: 'db', adapter: factory.constructor?.name })
          return instrument(adapter)
        }
      }

      return (value as (...a: unknown[]) => unknown).bind(object)
    },
  }) as T
}
