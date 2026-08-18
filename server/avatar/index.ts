import { registerProfileHook } from '../auth/profile.ts'
import { identiconUrl } from './identicon.ts'

/**
 * 默认头像这块的装配处：把「没头像就补一张 identicon」挂到登录后的档案钩子上。
 *
 * 这是本模块唯一碰到登录流程的地方 —— 登录代码里没有一行认识 identicon，
 * 想撤掉这个特性，删掉这个目录 + `routes/avatars.ts` 的挂载即可。
 */

export * from './identicon.ts'

registerProfileHook({
  name: 'identicon-avatar',
  /**
   * Keycloak 给了 picture 就用人家的，这里只管空着的那些。
   * 每次登录都会问一遍，所以**存量用户**下次进来自动补上，不用迁移脚本。
   */
  fill: (user) =>
    user.avatarUrl ? null : { avatarUrl: identiconUrl(user.issuer, user.subject) },
})
