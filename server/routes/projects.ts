import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AuthVariables } from '../auth/middleware.ts'
import {
  currentUserId,
  rejectPersonalSpace,
  requireProjectAdmin,
  requireProjectMember,
  type ProjectVariables,
} from '../auth/project.ts'
import { revokeCollabAccess } from '../collab/index.ts'
import { originOf } from '../auth/origin.ts'
import {
  DEFAULT_INVITE_EXPIRY_DAYS,
  INVITE_EXPIRY_DAYS,
  PROJECT_LIMITS,
  projects as store,
  type InviteExpiryDays,
  type ProjectKind,
} from '../store/projects.ts'
import { FLOW_STATUSES, flows, type FlowSort, type FlowStatus } from '../store/flows.ts'
import {
  INVALID_JSON,
  parseDescription,
  parseName,
  parsePagination,
  readJson,
} from './params.ts'

type Env = { Variables: AuthVariables & ProjectVariables }

interface ProjectPayload {
  name?: unknown
  description?: unknown
}

interface InvitePayload {
  expiresInDays?: unknown
}

interface FlowPayload {
  name?: unknown
  description?: unknown
}

/**
 * 把分享链接拼成前端能直接复制的完整 URL。
 *
 * 域名跟着**当前这次请求**走（白名单收口，见 `auth/origin.ts`）：管理员从哪个
 * 域名打开的分享框，复制出去的链接就是那个域名 —— 否则内网域名下复制出来的是
 * 一条外网地址，对面还不一定打得开。
 */
function withUrl<T extends { token: string }>(c: Context, invite: T) {
  return { ...invite, url: `${originOf(c)}/invite/${invite.token}` }
}

function parseExpiry(
  raw: unknown,
): { ok: true; value: InviteExpiryDays } | { ok: false; error: string } {
  if (!INVITE_EXPIRY_DAYS.includes(raw as InviteExpiryDays)) {
    return { ok: false, error: `expiresInDays 只能是 ${INVITE_EXPIRY_DAYS.join(' / ')}` }
  }
  return { ok: true, value: raw as InviteExpiryDays }
}

function parseSort(raw: string | undefined): { sort: FlowSort; order: 'asc' | 'desc' } | null {
  if (!raw) return { sort: 'updatedAt', order: 'desc' }
  const [field, direction = 'desc'] = raw.split(':')
  if (field !== 'updatedAt' && field !== 'createdAt' && field !== 'name') return null
  if (direction !== 'asc' && direction !== 'desc') return null
  return { sort: field, order: direction }
}

export const projects = new Hono<Env>()
  // —— 项目本身 ——
  .get('/', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const paged = parsePagination(c.req.query())
    if (!paged.ok) return c.json({ error: paged.error }, 400)

    const { items, total } = await store.listForUser(userId, {
      ...paged.value,
      keyword: c.req.query('keyword')?.trim() || undefined,
    })

    return c.json({
      items,
      ...paged.value,
      total,
      totalPages: Math.ceil(total / paged.value.pageSize),
    })
  })

  .post('/', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const body = await readJson<ProjectPayload>(c.req)
    if (!body) return c.json({ error: INVALID_JSON }, 400)

    const name = parseName(body.name)
    if (!name.ok) return c.json({ error: name.error }, 400)

    const description = parseDescription(body.description ?? null)
    if (!description.ok) return c.json({ error: description.error }, 400)

    const project = await store.create({ name: name.value, description: description.value, userId })
    return c.json(project, 201)
  })

  /**
   * 我的个人空间（REQ-SOLO）—— 读接口也会建：第一次点进「个人画布」就有了。
   *
   * **必须注册在 `/:projectId` 的中间件之前**，否则 `personal` 会被当成一个项目 id，
   * 在成员检查那里变成 404。
   *
   * 拿到 id 之后，个人画布的列表 / 新建 / 改名 / 删除全都复用
   * `/:projectId/flows` 那几条 —— 个人空间在接口层面就是个项目，没有第二套 CRUD。
   */
  .get('/personal', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)
    return c.json(await store.ensurePersonalSpace(userId))
  })

  // 下面所有 /:projectId* 都要求是成员；不是成员一律 404
  .use('/:projectId', requireProjectMember)
  .use('/:projectId/*', requireProjectMember)

  .get('/:projectId', async (c) => {
    const userId = await currentUserId(c)
    const project = userId ? await store.get(c.req.param('projectId'), userId) : null
    if (!project) return c.json({ error: 'Not Found', message: '项目不存在' }, 404)
    return c.json(project)
  })

  .patch('/:projectId', rejectPersonalSpace, requireProjectAdmin, async (c) => {
    const body = await readJson<ProjectPayload>(c.req)
    if (!body) return c.json({ error: INVALID_JSON }, 400)

    const patch: { name?: string; description?: string | null } = {}
    if (body.name !== undefined) {
      const name = parseName(body.name)
      if (!name.ok) return c.json({ error: name.error }, 400)
      patch.name = name.value
    }
    if (body.description !== undefined) {
      const description = parseDescription(body.description)
      if (!description.ok) return c.json({ error: description.error }, 400)
      patch.description = description.value
    }

    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const project = await store.update(c.req.param('projectId'), userId, patch)
    if (!project) return c.json({ error: 'Not Found', message: '项目不存在' }, 404)
    return c.json(project)
  })

  .delete('/:projectId', rejectPersonalSpace, requireProjectAdmin, async (c) => {
    await store.softDelete(c.req.param('projectId'))
    // 项目没了，它下面画布的房间也就没人有权待着 —— 当场断掉，别等轮询
    await revokeCollabAccess()
    return c.body(null, 204)
  })

  // —— 成员 ——
  .get('/:projectId/members', async (c) => c.json(await store.listMembers(c.req.param('projectId'))))

  .delete('/:projectId/members/:userId', rejectPersonalSpace, requireProjectAdmin, async (c) => {
    const me = await currentUserId(c)
    const target = c.req.param('userId')
    if (me === target) {
      return c.json({ error: '不能移除自己；如需退出请让其他管理员操作' }, 400)
    }

    const removed = await store.removeMember(c.req.param('projectId'), target)
    if (!removed) return c.json({ error: 'Not Found', message: '成员不存在' }, 404)

    /*
     * **正在协同编辑的那个人要当场断掉**，不能等 `REAUTH_INTERVAL` 的轮询。
     * HTTP 那边是实时的（每个请求都查一次成员身份），但 WebSocket 是长连接，
     * 握手时鉴过的权不会自己失效 —— 而他在那段时间里改的东西会被 CRDT 合并、落库，
     * 并且**其他人撤销不回来**（撤销只跟踪自己的 origin）。
     * 返回 204 之前 await：接口说成功了，人就真的已经不在画布上了。
     */
    await revokeCollabAccess()
    return c.body(null, 204)
  })

  // —— 分享链接（一个项目一条）——
  .get('/:projectId/invite', rejectPersonalSpace, requireProjectAdmin, async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    // 读接口也会写：没有链接就当场建一条，前端打开面板即拿到可复制的 URL
    const invite = await store.ensureInvite({
      projectId: c.req.param('projectId'),
      createdById: userId,
    })
    return c.json(withUrl(c, invite))
  })

  // 改有效期：token 不变，已经发出去的链接继续可用
  .patch('/:projectId/invite', rejectPersonalSpace, requireProjectAdmin, async (c) => {
    const body = await readJson<InvitePayload>(c.req)
    if (!body) return c.json({ error: INVALID_JSON }, 400)

    const days = parseExpiry(body.expiresInDays)
    if (!days.ok) return c.json({ error: days.error }, 400)

    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const invite = await store.setInviteExpiry({
      projectId: c.req.param('projectId'),
      createdById: userId,
      expiresInDays: days.value,
    })
    return c.json(withUrl(c, invite))
  })

  // 重置：换一个 token，旧链接立刻失效
  .post('/:projectId/invite/reset', rejectPersonalSpace, requireProjectAdmin, async (c) => {
    const body = (await readJson<InvitePayload>(c.req)) ?? {}

    const days = parseExpiry(body.expiresInDays ?? DEFAULT_INVITE_EXPIRY_DAYS)
    if (!days.ok) return c.json({ error: days.error }, 400)

    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const invite = await store.resetInvite({
      projectId: c.req.param('projectId'),
      createdById: userId,
      expiresInDays: days.value,
    })
    return c.json(withUrl(c, invite))
  })

  // —— 项目内的画布 ——
  .get('/:projectId/flows', async (c) => {
    const paged = parsePagination(c.req.query())
    if (!paged.ok) return c.json({ error: paged.error }, 400)

    const sort = parseSort(c.req.query('sort'))
    if (!sort) return c.json({ error: 'sort 只支持 updatedAt / createdAt / name 加 :asc|:desc' }, 400)

    const rawStatus = c.req.query('status')
    if (rawStatus && !FLOW_STATUSES.includes(rawStatus as FlowStatus)) {
      return c.json({ error: `status 只能是 ${FLOW_STATUSES.join(' / ')}` }, 400)
    }

    const { items, total } = await flows.listByProject(c.req.param('projectId'), {
      ...paged.value,
      ...sort,
      keyword: c.req.query('keyword')?.trim() || undefined,
      status: rawStatus as FlowStatus | undefined,
    })

    return c.json({
      items,
      ...paged.value,
      total,
      totalPages: Math.ceil(total / paged.value.pageSize),
    })
  })

  .post('/:projectId/flows', async (c) => {
    const projectId = c.req.param('projectId')

    const body = await readJson<FlowPayload>(c.req)
    if (!body) return c.json({ error: INVALID_JSON }, 400)

    const name = parseName(body.name)
    if (!name.ok) return c.json({ error: name.error }, 400)

    const description = parseDescription(body.description ?? null)
    if (!description.ok) return c.json({ error: description.error }, 400)

    /*
     * 画布数上限**只对团队项目**生效。个人空间是自己的草稿箱，给它设一个
     * 早晚会挡住自己的上限没有意义（docs/16 §4.5）；协同那边的成本（房间、在场、
     * 复验）它也一样都不产生。
     */
    if (
      (c.get('projectKind') as ProjectKind | undefined) !== 'personal' &&
      (await flows.countByProject(projectId)) >= PROJECT_LIMITS.flows
    ) {
      return c.json({ error: `项目内画布数已达上限 ${PROJECT_LIMITS.flows}` }, 400)
    }

    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const flow = await flows.create({
      projectId,
      name: name.value,
      description: description.value,
      createdById: userId,
    })
    return c.json(flow, 201)
  })
