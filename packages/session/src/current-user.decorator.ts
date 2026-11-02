import type { SessionUser } from '@learning/data-access'
import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { SessionRequest } from './session.guard.js'

/**
 * 路由参数装饰器：拿 `SessionGuard` 挂上去的 `SessionUser`。
 * 没挂守卫是写错了代码，不是用户没登录：抛普通错误（500），不要用 undefined 冒充已登录用户，也不要报成 401 把问题藏起来。
 */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): SessionUser => {
  const { user } = context.switchToHttp().getRequest<SessionRequest>()
  if (!user) throw new Error('[session] 用了 @CurrentUser() 的路由没有挂 @UseGuards(SessionGuard)')
  return user
})
