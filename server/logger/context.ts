import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 请求上下文 —— 「这条日志是哪次请求、哪个人产生的」。
 *
 * **为什么要有它**：零入侵的代价是注入器拿不到调用现场。`server/store/` 里一句
 * `console.warn('[flows] ...')` 被 console 接管收上来时，接管函数只看得见那行字符串，
 * 看不见它属于哪次请求。`AsyncLocalStorage` 把这层信息挂在异步调用链上 ——
 * 中间件在链的最外层 `run()` 一次，链上任何深度的日志都能读到，
 * 而中间那些函数一个参数都不用加。
 *
 * 这正是「注入」和「插桩」的区别：插桩要求每层函数都把 `ctx` 传下去。
 */

export interface RequestContext {
  requestId: string
  /** 认证之后才有；`withSession` 跑完之前是 undefined */
  userId?: string
  method: string
  path: string
  startedAt: number
}

const storage = new AsyncLocalStorage<RequestContext>()

/** 在这次请求的上下文里跑一段代码；里面所有异步分支都能 `currentContext()` 到它 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore()
}

/**
 * 当前请求的日志字段；不在请求里就是空对象。
 *
 * 所有注入器都用它给日志补上下文，所以「日志里带不带 requestId」这件事
 * 只在这一个函数里决定。
 */
export function contextFields(): { requestId?: string; userId?: string } {
  const context = storage.getStore()
  if (!context) return {}
  return { requestId: context.requestId, userId: context.userId }
}

/**
 * 认证完成后回填用户。
 *
 * 会话是在请求处理**中途**才解析出来的（`withSession`），而 requestId 在入口就得有 ——
 * 所以上下文对象是可变的，中途补一个字段，之前已经写出去的日志不受影响。
 */
export function setContextUser(userId: string | undefined): void {
  const context = storage.getStore()
  if (context) context.userId = userId
}
