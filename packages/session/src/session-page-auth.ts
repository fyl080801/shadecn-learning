import { Inject, Injectable } from '@nestjs/common'
import { readCookie } from './session.guard.js'
import { SessionService } from './session.service.js'

/**
 * 页面闸门用的登录态判断，结构上满足 `@learning/web` 的 `WebPageAuth`。本包不依赖 web：绑定到 `WEB_PAGE_AUTH` 是应用的事（`apps/platform` 的 PageAuthModule）。
 * 查库失败照常抛，web 那边回 500。
 */
@Injectable()
export class SessionPageAuth {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  async isAuthenticated(request: { headers: Record<string, unknown> }): Promise<boolean> {
    const token = readCookie(request.headers.cookie, this.sessions.cookieName)
    return (await this.sessions.load(token)) !== null
  }
}
