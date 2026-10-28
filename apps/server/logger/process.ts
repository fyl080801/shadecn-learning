import { restoreConsole } from './console.ts'
import { errorFields, logger } from './logger.ts'

/**
 * 进程级的兜底日志：没人接住的异常、没人接住的 Promise、以及进程怎么结束的。
 *
 * 这是零入侵最彻底的一层 —— 它观察的是**整个进程**，业务代码里不存在对应的位置。
 * 没有它，一个 `unhandledRejection` 在 node 里只会打一行默认栈然后（未来版本）
 * 直接结束进程，日志系统里什么都留不下。
 */

let installed = false

export function installProcessLogging(): void {
  if (installed) return
  installed = true

  /**
   * **不 exit**。node 的默认行为是打印后继续跑（`uncaughtException` 有监听器时），
   * 而这个进程持有着还没落库的 Y.Doc —— 直接退等于把它们扔了。
   * 记下来，让正常的 shutdown 流程（SIGTERM / 运维介入）去收尾。
   */
  process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常', { module: 'process', ...errorFields(error) })
  })

  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { module: 'process', ...errorFields(reason) })
  })

  /**
   * 警告（`MaxListenersExceededWarning`、废弃 API…）走 warn。
   * 它们平时没人看，但「监听器泄漏」这类问题只在这里露头。
   */
  process.on('warning', (warning) => {
    logger.warn(warning.message, { module: 'process', kind: warning.name })
  })

  /**
   * 退出前把 console 还原。
   *
   * winston 的 transport 一进入关闭流程，之后写的日志就无声无息了 ——
   * 而「正在关闭」恰恰是最需要看到输出的时候（落库刷盘、连接断开）。
   * 还原成原生 console，剩下那几行至少会落到 stdout 上。
   */
  process.on('exit', (code) => {
    restoreConsole()
    if (code !== 0) process.stdout.write(`[process] 进程退出，code=${code}\n`)
  })
}
