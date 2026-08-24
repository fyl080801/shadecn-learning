import { logHttp, logLevel, logFormat, logDir } from '../config.ts'
import { installConsoleBridge } from './console.ts'
import { logger } from './logger.ts'
import { installProcessLogging } from './process.ts'

/**
 * 日志层的总入口。
 *
 * # 设计原则：注入，不插桩
 *
 * 要求是「不要把大量日志加到业务代码里」，所以这一层里**没有一个函数是给业务调用的**。
 * 日志全部从既有的横切位置接出来，业务文件的改动只剩下**四个挂载点**，
 * 每一个都是一行、且都在「装配」而不是「业务逻辑」的位置上：
 *
 * | 挂载点 | 一行改动 | 接住了什么 |
 * |---|---|---|
 * | `server/index.ts` | `installLogging()` | console 接管 + 进程级异常 |
 * | `server/app.ts` | `logger()` → `httpLogger()` | 每个请求的方法/状态/耗时 + requestId 上下文 |
 * | `server/db.ts` | `instrumentAdapter(...)` | 每条 SQL 的耗时、慢查询、失败 |
 * | `server/collab/hocuspocus.ts` | extensions 数组 +1 | 房间生命周期、连接进出、落库健康度 |
 *
 * 其中 **console 接管是支点**：仓库里本来就有 49 处 `console.log/warn/error`，
 * 而且基本都带好了 `[collab]` `[auth]` `[cluster]` 这样的前缀。接管之后它们
 * 一行不改就变成了带 module 字段、带 requestId 的结构化日志 ——
 * 这也意味着**以后写日志继续用 `console.*` 就行**，不必 import 任何东西。
 *
 * # 不要做的事
 *
 * - 不要在业务函数里 `import { logger }` 然后 `logger.info(...)`。想记什么，
 *   照旧 `console.log('[模块] ...')`，前缀会被解析成 module 字段。
 * - 不要在热路径（每帧 awareness、每次 Y.Doc update）上写日志。
 *   那类东西要么在 `collab.ts` 里累加后按分钟汇总，要么就不记。
 */
export { logger, errorFields, type LogMeta } from './logger.ts'
export { httpLogger } from './http.ts'
export { instrumentAdapter } from './db.ts'
export { collabLogging, collabLogStats } from './collab.ts'
export { currentContext, contextFields } from './context.ts'

/**
 * 装上进程级的那两样（console 接管、未捕获异常）。
 *
 * **要尽早调用** —— 在它之前发生的 `console.*` 会原样走 stdout，
 * 不带模块字段也不进文件。`server/index.ts` 里紧跟着 `./env.ts` 调用。
 *
 * 幂等：dev 下 tsx watch 反复重新加载模块也只会生效一次。
 */
export function installLogging(): void {
  installConsoleBridge()
  installProcessLogging()

  logger.debug('日志已就绪', {
    module: 'log',
    level: logLevel,
    format: logFormat,
    http: logHttp,
    file: logDir || undefined,
  })
}
