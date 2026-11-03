import { DataAccess, User } from '@learning/data-access'
import { Inject, Injectable } from '@nestjs/common'
import { describeError } from './errors.js'
import { identiconUrl } from './identicon.js'

/**
 * 登录之后补齐用户档案里空着的字段，目前只有默认头像。登录流程不认识 identicon，只调这一个方法；再加规则也加在这里。
 *
 * **判定和写入都在登录这一步，结果落进 `User.avatarUrl`，读的地方只读这一列**：
 * - 协同副本只有身份模块（没有这个 provider，也没有 `UserIdentity` 这张表），awareness 的头像靠 `CollabAuth` 读 `user.avatarUrl`。这里在建会话之前写好，
 *   所以副本读到的任何一个会话，它的用户都已经补过，平台和副本是同一个值。
 * - 不做读取时兜底（`avatarUrl ?? identiconUrl(...)`）：`issuer` / `subject` 是当前主身份，解绑主身份之后算出来的就是另一张图；
 *   只在 `LoginModule` 这边兜底的话，平台有头像、副本没有。`load` 的只读分支也不能写库。
 *
 * 所以种子只在第一次补的时候算一次：之后换主身份不换图（docs/02 §3.5.1）。还没补上的用户（这个功能上线前登录、会话还活着）下次登录才有，两边都是 null，前端走回退显示。
 */
@Injectable()
export class UserProfileCompleter {
  constructor(@Inject(DataAccess) private readonly dataAccess: DataAccess) {}

  /** **绝不能挡住登录**：写失败只记日志，这个人这次没有头像，下次登录再补 */
  async complete(user: Pick<User, 'id' | 'issuer' | 'subject' | 'avatarUrl'>): Promise<void> {
    if (user.avatarUrl) return
    try {
      // 条件带 avatarUrl: null：同一个人另一个回调刚写进提供方给的头像时，不盖掉它
      await this.dataAccess
        .em()
        .nativeUpdate(User, { id: user.id, avatarUrl: null }, { avatarUrl: identiconUrl(user.issuer, user.subject), updatedAt: new Date() })
    } catch (err) {
      console.error(`[session] 写入默认头像失败，本次登录没有头像：${describeError(err)}`)
    }
  }
}
