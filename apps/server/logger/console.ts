import { inspect } from 'node:util'
import { contextFields } from './context.ts'
import { logger, type LogMeta } from './logger.ts'

/**
 * 接管 `console.*`，把它们原样转成 winston 记录 —— **这是整套日志零入侵的支点**。
 *
 * 仓库里已经有 49 处 `console.log/warn/error`，而且绝大多数早就带好了 `[collab]`
 * `[auth]` `[cluster]` 这样的模块前缀。与其把它们逐个改成 `logger.info(...)`
 * （49 个 diff，还得在每个业务文件里多 import 一个 logger），不如在**出口**上接一次：
 *
 * - 业务代码一行不改，写法照旧就是 `console.warn('[collab] xxx')`；
 * - 前缀被解析成结构化的 `module` 字段，JSON 输出里可以直接按模块过滤；
 * - 请求上下文（requestId / userId）自动补上，调用处什么都不用传；
 * - 第三方库（Hono 的 logger 中间件、Prisma、ioredis）的 console 输出一并收编。
 *
 * 换句话说：**日志的「写」留在原地，日志的「怎么写、去哪儿」全在这里**。
 * 将来真要换掉 winston，业务代码同样一行不动。
 */

/** 原始的 console 方法。接管之后仍然要用它们兜底（见 `restoreConsole`） */
const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
}

let installed = false

/** `[module]` 开头的消息 —— 把标签摘出来 */
const TAG = /^\[([a-z][a-z0-9-]*)\]\s*/i

/**
 * Hono logger 中间件的两种输出：
 *   `  <-- GET /api/health`
 *   `  --> GET /api/health 200 1ms`
 *
 * 认出来是为了**丢掉**它 —— 我们自己的 `http.ts` 中间件记的是同一件事，
 * 但带状态码、耗时、requestId，而且能按 `LOG_HTTP` 过滤噪音。
 * 两份一起打就是每个请求两行重复。识别放在这里而不是删掉 Hono 的中间件，
 * 是因为万一有人把它加回去，日志也不会突然变吵。
 */
const HONO_ACCESS = /^\s*(<--|-->)\s+\w+\s+\//

/**
 * 把 console 的可变参数压成 winston 的 `(message, meta)`。
 *
 * 规则贴着大家实际的写法来：
 * - `console.error('出错了', err)` —— Error 走 `error` 字段，栈由 winston 的 errors() 展开；
 * - `console.log('[x] 完成', { bytes: 1 })` —— 末尾的普通对象直接铺成结构化字段；
 * - 其余一律 `inspect` 成字符串接在消息后面，不丢信息。
 */
export function normalize(args: unknown[]): { message: string; meta: LogMeta } {
  const meta: LogMeta = {}
  const parts: string[] = []

  for (const arg of args) {
    if (arg instanceof Error) {
      meta.error = arg.message
      meta.stack = arg.stack
      continue
    }
    if (typeof arg === 'string') {
      parts.push(arg)
      continue
    }
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      Object.assign(meta, arg as Record<string, unknown>)
      continue
    }
    parts.push(inspect(arg, { depth: 2, colors: false, breakLength: Infinity }))
  }

  let message = parts.join(' ')
  const tag = TAG.exec(message)
  if (tag) {
    meta.module = tag[1]
    message = message.slice(tag[0].length)
  }

  return { message, meta }
}

type Level = 'debug' | 'info' | 'warn' | 'error'

function forward(level: Level, args: unknown[]): void {
  const first = args[0]
  if (typeof first === 'string' && HONO_ACCESS.test(first)) return

  const { message, meta } = normalize(args)
  logger.log(level, message, { ...contextFields(), ...meta })
}

/**
 * 装上接管。**幂等**，重复调用只生效一次（dev 下 tsx watch 会重新执行模块）。
 *
 * 不接管 `console.trace` / `table` / `dir` 这些：它们本来就是临时调试用的，
 * 保持原样反而更好使 —— 结构化日志不是用来看表格的。
 */
export function installConsoleBridge(): void {
  if (installed) return
  installed = true

  console.log = (...args: unknown[]) => forward('info', args)
  console.info = (...args: unknown[]) => forward('info', args)
  console.warn = (...args: unknown[]) => forward('warn', args)
  console.error = (...args: unknown[]) => forward('error', args)
  console.debug = (...args: unknown[]) => forward('debug', args)
}

/**
 * 还原。退出流程的最后一步要用 —— winston 的 transport 一旦开始关闭，
 * 之后的日志就无声无息了，而「正在关闭」恰恰是最需要看到输出的时候。
 */
export function restoreConsole(): void {
  if (!installed) return
  installed = false
  Object.assign(console, original)
}
