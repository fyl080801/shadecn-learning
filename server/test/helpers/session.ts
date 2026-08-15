import { createSession } from '../../auth/session.ts'
import { createUser, type FakeUserInput } from './db.ts'
import { idTokenClaims, tokenResponse } from './oidc.ts'

export interface SignInOptions extends FakeUserInput {
  /** access_token 还有多少秒过期；给个小于 30 的值会触发自动续期 */
  expiresIn?: number
}

/** 造一个「已登录」的浏览器：返回可以直接塞进请求头的 cookie */
export async function signIn(options: SignInOptions = {}) {
  const user = await createUser(options)
  const token = await createSession({
    user,
    tokens: tokenResponse({ expiresIn: options.expiresIn ?? 300 }),
    claims: idTokenClaims(),
  })
  return { user, token, cookie: `sid=${token}` }
}
