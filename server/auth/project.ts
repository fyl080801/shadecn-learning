import type { Context, MiddlewareHandler } from 'hono'
import { authEnabled } from '../config.ts'
import { prisma } from '../db.ts'
import { projects, type ProjectKind, type ProjectRole } from '../store/projects.ts'
import { flows } from '../store/flows.ts'
import { completeUserProfile } from './profile.ts'
import type { SessionUser } from './session.ts'

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

const DEV_USER = {
  issuer: 'dev://local',
  subject: 'dev-user',
  username: 'dev',
  name: '本地开发用户',
} as const

/**
 * 没配 Keycloak 时（authEnabled === false）也得有个用户，
 * 否则项目功能在本地裸跑起不来。落一个固定的开发用户，仅限非生产。
 */
async function devUserId(): Promise<string> {
  const user = await prisma.user.upsert({
    where: { issuer_subject: { issuer: DEV_USER.issuer, subject: DEV_USER.subject } },
    update: {},
    create: { ...DEV_USER, email: null, roles: '[]' },
  })
  // 本地模式也走一遍档案补齐，头像这类东西不该只有连了 Keycloak 才有
  return (await completeUserProfile(user)).id
}

/** 取当前请求者的 user id；未登录返回 null */
export async function currentUserId(c: Context): Promise<string | null> {
  const user = c.get('user') as SessionUser | null
  if (user) return user.id
  if (!authEnabled) return devUserId()
  return null
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
