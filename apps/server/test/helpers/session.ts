import { createSession } from '../../auth/session.ts'
import type { ProviderId } from '../../auth/providers/index.ts'
import { createUser, type FakeUserInput } from './db.ts'
import { providerTokens } from './oidc.ts'

export interface SignInOptions extends FakeUserInput {
  /** access_token 还有多少秒过期；给个小于 30 的值会触发自动续期 */
  expiresIn?: number
  /** 从哪个提供方登进来的，默认 Keycloak */
  provider?: ProviderId
}

/** 造一个「已登录」的浏览器：返回可以直接塞进请求头的 cookie */
export async function signIn(options: SignInOptions = {}) {
  const user = await createUser(options)
  const token = await createSession({
    user,
    provider: options.provider ?? 'keycloak',
    tokens: providerTokens({ expiresIn: options.expiresIn ?? 300 }),
  })
  return { user, token, cookie: `sid=${token}` }
}
