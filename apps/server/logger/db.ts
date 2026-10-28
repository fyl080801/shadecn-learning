import { stripVTControlCharacters } from 'node:util'
import type { LogContext, Logger, LoggerNamespace, LoggerOptions } from '@mikro-orm/core'
import { logSlowQueryMs } from '../config.ts'
import { contextFields } from './context.ts'
import { logger } from './logger.ts'

/**
 * 数据库日志 —— 走 MikroORM 自己的 `loggerFactory` 扩展点，不动任何一句查询。
 *
 * MikroORM 每执行一条 SQL 都会调一次 `Logger.logQuery()`，带着这条 SQL、耗时、行数和成败。
 * 把这个工厂交给 ORM 配置（`apps/server/db/orm.ts` 里就一处）就是整个数据库日志的唯一注入点 ——
 * 和其余三个挂载点一样，在「装配」的位置上，不在业务里。
 *
 * 不用 MikroORM 自带的 `debug` / `slowQueryThreshold`：前者是往 stdout 打彩色文本，
 * 后者会和这里的慢查询判定重复记一次。阈值仍然是 `LOG_SLOW_QUERY_MS`，一个变量管到底。
 *
 * 记什么、不记什么：
 * - 记 SQL 文本（压成一行、截断）、耗时、行数；
 * - **不记参数值**。参数里有会话 token 的 HMAC、邮箱、画布内容 —— 日志会被采集、
 *   会被更多人看到，把它们抄一份进去是白送的风险。
 *
 * 「不记参数」靠两层保证，缺一不可：
 * 1. `isEnabled('query-params')` 永远是 false —— MikroORM 只在这个命名空间开着时才把参数值
 *    拼进交给 logger 的 SQL 里，关着就给带 `?` 占位符的原句；
 * 2. `logQuery()` 只挑 `query` / `took` / `results` / `affected` 这几个字段用 ——
 *    上下文里其实还带着 `params` 和拼好参数的 `formatted`，一个都不碰。
 */

/** SQL 记进日志前压成一行并截断 —— 一条带 join 的 SELECT 能有几千字符 */
const MAX_SQL = 300

function briefSql(value: unknown): string {
  const flat = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > MAX_SQL ? `${flat.slice(0, MAX_SQL - 3)}...` : flat
}

/**
 * ORM 自己的消息里哪些值得留：版本号、弃用提示、告警。
 * 实体发现（`discovery`）每个实体一行，纯噪音，不记。
 */
const QUIET_NAMESPACES = new Set<string>(['discovery', 'query-params'])

class OrmLogger implements Logger {
  log(namespace: LoggerNamespace | (string & {}), message: string, context?: LogContext) {
    if (QUIET_NAMESPACES.has(namespace)) return
    // MikroORM 自己会给版本号之类的上色，日志里不要终端转义序列
    const text = stripVTControlCharacters(message)
    const meta = { module: 'db', namespace, ...contextFields() }

    if (context?.level === 'error') logger.error(text, meta)
    else if (context?.level === 'warning' || namespace === 'deprecated') logger.warn(text, meta)
    else logger.debug(text, meta)
  }

  error(namespace: LoggerNamespace | (string & {}), message: string, context?: LogContext) {
    this.log(namespace, message, { ...context, level: 'error' })
  }

  warn(namespace: LoggerNamespace | (string & {}), message: string, context?: LogContext) {
    this.log(namespace, message, { ...context, level: 'warning' })
  }

  /** 慢查询是 warn，正常查询是 debug（默认级别下不输出），失败是 error */
  logQuery(context: LogContext) {
    const ms = context.took
    const sql = briefSql(context.query)

    if (context.level === 'error') {
      logger.error('查询失败', { module: 'db', ...contextFields(), ms, sql })
      return
    }

    if (ms !== undefined && logSlowQueryMs > 0 && ms >= logSlowQueryMs) {
      logger.warn('慢查询', { module: 'db', ...contextFields(), ms, sql })
    } else if (logger.isDebugEnabled()) {
      logger.debug('query', {
        module: 'db',
        ...contextFields(),
        ms,
        sql,
        rows: context.results ?? context.affected,
      })
    }
  }

  /** 开关不归 MikroORM 管：输出与否由 LOG_LEVEL 决定 */
  setDebugMode() {}

  /**
   * `query` 必须是开着的：MikroORM 据此决定交给 `logQuery` 的是不是原句。
   * `query-params` 必须是关着的：见文件头「不记参数」的第 1 层。
   */
  isEnabled(namespace: LoggerNamespace) {
    return !QUIET_NAMESPACES.has(namespace)
  }
}

/** 交给 MikroORM 配置的 `loggerFactory`。参数里的 debug / writer 一概不用，见 {@link OrmLogger} */
export function ormLoggerFactory(_options: LoggerOptions): Logger {
  return new OrmLogger()
}
