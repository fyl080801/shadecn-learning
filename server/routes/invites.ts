import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware.ts'
import { currentUserId, type ProjectVariables } from '../auth/project.ts'
import { projects as store, type InviteInvalidReason } from '../store/projects.ts'

type Env = { Variables: AuthVariables & ProjectVariables }

/**
 * 邀请链接是加入项目的唯一入口。
 * 这两个端点按 token 鉴权而非成员身份 —— 被邀请者此刻当然还不是成员，
 * 但必须已登录（未登录会先被页面网关挡去登录页）。
 */

/** 失效原因给各自的文案，不要一律「链接无效」 */
const REASON_TEXT: Record<InviteInvalidReason, string> = {
  not_found: '邀请链接无效',
  expired: '邀请链接已过期',
  revoked: '邀请链接已被撤销',
  exhausted: '邀请链接的使用次数已用完',
  project_deleted: '项目已被删除',
  project_full: '项目成员数已达上限',
}

export const invites = new Hono<Env>()
  .get('/:token', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const preview = await store.previewInvite(c.req.param('token'), userId)
    return c.json({
      ...preview,
      message: preview.reason ? REASON_TEXT[preview.reason] : undefined,
    })
  })

  .post('/:token/accept', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const result = await store.acceptInvite(c.req.param('token'), userId)
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 400
      return c.json({ error: REASON_TEXT[result.reason], reason: result.reason }, status)
    }
    return c.json({ projectId: result.projectId })
  })
