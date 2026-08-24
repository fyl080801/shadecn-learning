import path from 'node:path'
import winston from 'winston'
import { instanceId, isClustered, isDev, logDir, logFormat, logLevel } from '../config.ts'

/**
 * winston 实例本体 —— 整个进程只有这一个。
 *
 * **这个模块不认识任何业务**：它只定义「一条日志长什么样、去哪儿」。
 * 谁在什么时候写日志，由 `server/logger/` 下另外几个注入器决定，
 * 业务代码里一句 `logger.xxx` 都不该出现（见 `install.ts` 的说明）。
 */

/** 结构化字段里固定会有的那几个，其余随事件走 */
export interface LogMeta {
  /** 事件来源，如 `collab` / `auth` / `http` / `db`。console 接管会从 `[前缀]` 里解析出来 */
  module?: string
  /** 请求上下文（`context.ts` 自动注入），非请求路径上没有 */
  requestId?: string
  userId?: string
  [key: string]: unknown
}

/** 一条日志里不该出现的键 —— winston 自己占用，冲突会被静默丢掉或覆盖 */
const RESERVED = new Set(['level', 'message', 'timestamp', 'stack', 'splat'])

/**
 * 给人看的单行格式：`14:03:22 info  [collab] flow:abc 落库完成  bytes=1024 ms=8`
 *
 * 结构化字段跟在消息后面，不换行、不 JSON 缩进 —— 缩进的对象在终端里滚起来
 * 会把真正要看的那行冲走，而排查时看的是**一串**日志的形状，不是单条的完整性。
 */
const pretty = winston.format.printf((info) => {
  const { level, message, timestamp, module, stack, ...rest } = info as winston.Logform.TransformableInfo &
    LogMeta & { timestamp?: string; stack?: string }

  const head = `${timestamp ?? ''} ${level}`
  const tag = module ? ` [${module}]` : ''

  const fields = Object.entries(rest)
    .filter(([key, value]) => !RESERVED.has(key) && value !== undefined)
    .map(([key, value]) => `${key}=${format(value)}`)
    .join(' ')

  return [
    `${head}${tag} ${String(message)}`,
    fields && `  ${fields}`,
    // 异常的调用栈单独换行放最后：它是唯一值得占多行的东西
    stack && `\n${stack}`,
  ]
    .filter(Boolean)
    .join('')
})

/** 字段值压成一行；对象太长就截断，日志不是数据导出口 */
function format(value: unknown): string {
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 200 ? `${text.slice(0, 197)}...` : text
}

function transports(): winston.transport[] {
  const list: winston.transport[] = [
    new winston.transports.Console({
      // stderr 只留给 error：容器里这两条流常常被分开采集
      stderrLevels: ['error'],
      format:
        logFormat === 'json'
          ? winston.format.combine(winston.format.timestamp(), winston.format.json())
          : winston.format.combine(
              winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
              winston.format.colorize(),
              pretty,
            ),
    }),
  ]

  /*
   * 文件输出是**可选**的（LOG_DIR 不设就没有）。容器里默认不该开：
   * k8s 收的是 stdout，写进容器层的文件会随 Pod 一起消失，还占着可写层。
   * 它是给「裸机 / 本地长跑排查」准备的。
   */
  if (logDir) {
    const shared = {
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }
    list.push(new winston.transports.File({ ...shared, filename: path.join(logDir, 'app.log') }))
    list.push(
      new winston.transports.File({
        ...shared,
        filename: path.join(logDir, 'error.log'),
        level: 'error',
      }),
    )
  }

  return list
}

export const logger: winston.Logger = winston.createLogger({
  level: logLevel === 'silent' ? 'error' : logLevel,
  silent: logLevel === 'silent' || process.env.NODE_ENV === 'test',
  /*
   * `errors({ stack: true })` 让 `logger.error('...', { err })` 里的 Error 被展开成 stack。
   * 多副本下每条都带 instance，不然三个 Pod 的日志汇到一起就分不清谁是谁了。
   */
  format: winston.format.errors({ stack: true }),
  /*
   * 每条日志都带实例名，多副本下三个 Pod 的日志汇到一起才分得清谁是谁。
   *
   * **但 pretty 模式下不带**：那是给人在终端里看的，`instance=xxx env=dev` 挂在每一行
   * 末尾只会把真正要看的字段挤出屏幕，而单进程调试时它俩恒定不变、零信息量。
   * 多副本本地调试（`pnpm dev:cluster`）例外 —— 那时区分实例正是重点。
   */
  defaultMeta:
    logFormat === 'json'
      ? { instance: instanceId, env: isDev ? 'dev' : 'prod' }
      : isClustered
        ? { instance: instanceId }
        : {},
  transports: transports(),
  // 进程级异常由 `process.ts` 统一接管，不交给 winston（它会顺手 exit）
  exitOnError: false,
})

/**
 * 把任意 catch 到的东西整理成可以直接铺进日志字段的形状。
 *
 * `catch (err: unknown)` 拿到的不一定是 Error（Node 里 reject 一个字符串完全合法），
 * 到处写 `err instanceof Error ? … : …` 只会让注入器变脏，所以收在这里一次。
 */
export function errorFields(error: unknown): { error: string; stack?: string } {
  if (error instanceof Error) return { error: error.message, stack: error.stack }
  return { error: String(error) }
}
