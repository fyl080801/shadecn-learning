import type { Context, MiddlewareHandler } from 'hono'
import type { FlowRequestPort } from '@shadecn/server-kit/http'
import { platform } from '@shadecn/server-kit/platform'
import { flows } from './flows.ts'
import { projects, type ProjectKind, type ProjectRole } from './projects.ts'

/**
 * 项目维度的鉴权。
 *
 * 两条铁律（docs/13-flow-canvas-management.md 4.8）：
 * - **非成员一律 404**，不是 403 —— 不泄露项目 / 画布是否存在；
 * - 是成员但角色不够（member 干 admin 的事）才是 **403**。
 */

/** 中间件塞进 context 的项目上下文（只有过了 requireProject* 才有值） */
export type ProjectVariables = {
  projectId?: string
  projectRole?: ProjectRole
  /**
   * 这是团队项目还是个人空间。
   *
   * 路由拿它决定两件事：个人空间上不许有分享链接 / 成员管理这类动作，
   * 以及画布内容该走哪条通道（solo 走 REST，collab 走 WebSocket）。
   */
  projectKind?: ProjectKind
}

/** 取当前请求者的 user id；未登录返回 null（没启用登录时平台给本地开发用户） */
export function currentUserId(c: Context): Promise<string | null> {
  return platform().auth.userId(c)
}

function notFound(c: Context) {
  return c.json({ error: 'Not Found', message: '项目不存在' }, 404)
}

/**
 * 要求请求者是 `:projectId` 的成员。
 * 成功后 `c.get('projectRole')` 可用。
 */
export const requireProjectMember: MiddlewareHandler = async (c, next) => {
  const userId = await currentUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

  const projectId = c.req.param('projectId')
  if (!projectId) return notFound(c)

  const membership = await projects.membershipOf(projectId, userId)
  if (!membership) return notFound(c)

  c.set('projectId', projectId)
  c.set('projectRole', membership.role)
  c.set('projectKind', membership.kind)
  await next()
}

/**
 * 叠在 `requireProjectMember` 之后：个人空间上不许干的事（分享链接、成员管理、
 * 删项目、改名）用它挡掉。
 *
 * 是 **403 不是 404** —— 请求者确实是这个「项目」的成员，不存在泄露存在性的问题，
 * 他只是在对自己的私人空间做一件没有意义的事。
 */
export const rejectPersonalSpace: MiddlewareHandler = async (c, next) => {
  if ((c.get('projectKind') as ProjectKind | undefined) === 'personal') {
    return c.json({ error: 'Forbidden', message: '个人空间不支持这个操作' }, 403)
  }
  await next()
}

/** 在 requireProjectMember 之后叠这一层：角色不够就是 403 */
export const requireProjectAdmin: MiddlewareHandler = async (c, next) => {
  if ((c.get('projectRole') as ProjectRole | undefined) !== 'admin') {
    return c.json({ error: 'Forbidden', message: '需要项目管理员权限' }, 403)
  }
  await next()
}

/**
 * 画布路由用：先按 `:flowId` 查出归属项目，再判成员身份。
 * 画布或其项目被软删、以及请求者不是成员，统统 404。
 */
export const requireFlowMember: MiddlewareHandler = async (c, next) => {
  const userId = await currentUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

  const flowId = c.req.param('flowId')
  if (!flowId) return c.json({ error: 'Not Found', message: '画布不存在' }, 404)

  const target = await flows.locate(flowId)
  if (!target) return c.json({ error: 'Not Found', message: '画布不存在' }, 404)

  const membership = await projects.membershipOf(target.projectId, userId)
  if (!membership) return c.json({ error: 'Not Found', message: '画布不存在' }, 404)

  c.set('projectId', target.projectId)
  c.set('projectRole', membership.role)
  c.set('projectKind', membership.kind)
  await next()
}

/** 交给别的模块路由的「这个请求是谁」：membership 读的是 {@link requireFlowMember} 这次请求刚塞进 context 的值 */
export const flowRequest: FlowRequestPort = {
  userId: currentUserId,
  membership(c) {
    const role = c.get('projectRole') as ProjectRole | undefined
    const kind = c.get('projectKind') as ProjectKind | undefined
    return role && kind ? { role, kind } : null
  },
}
