import { OidcError } from './oauth/index.js'

/**
 * 写日志用。只有协议错误带 message：它们是这里的代码自己拼的，不含 token / code / client secret。
 * 别的错误只留类型名：MikroORM 的异常 message 带着完整 SQL 和参数值，写 Session 行失败时就是 access_token。
 */
export function describeError(err: unknown): string {
  if (err instanceof OidcError) return err.code ? `${err.message}（${err.code}）` : err.message
  return err instanceof Error ? err.name : typeof err
}

/** 经 `?error=` 显示在登录页上的话。连不上提供方时不把内网地址告诉用户，其他的错误也不把内部信息送进 URL */
export function loginFailureMessage(err: unknown): string {
  if (err instanceof OidcError && !err.retryable) return err.message
  return err instanceof OidcError ? '连不上登录服务，请稍后重试' : '登录失败，请重试'
}
