import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware.ts'
import {
  currentUserId,
  requireProjectAdmin,
  requireProjectMember,
  type ProjectVariables,
} from '../auth/project.ts'
import { appOrigin } from '../config.ts'
import {
  DEFAULT_INVITE_EXPIRY_DAYS,
  INVITE_EXPIRY_DAYS,
  PROJECT_LIMITS,
  projects as store,
  type InviteExpiryDays,
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

/** 把分享链接拼成前端能直接复制的完整 URL */
function withUrl<T extends { token: string }>(invite: T) {
  return { ...invite, url: `${appOrigin}/invite/${invite.token}` }
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

  // 下面所有 /:projectId* 都要求是成员；不是成员一律 404
  .use('/:projectId', requireProjectMember)
  .use('/:projectId/*', requireProjectMember)

  .get('/:projectId', async (c) => {
    const userId = await currentUserId(c)
    const project = userId ? await store.get(c.req.param('projectId'), userId) : null
    if (!project) return c.json({ error: 'Not Found', message: '项目不存在' }, 404)
    return c.json(project)
  })

  .patch('/:projectId', requireProjectAdmin, async (c) => {
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

  .delete('/:projectId', requireProjectAdmin, async (c) => {
    await store.softDelete(c.req.param('projectId'))
    return c.body(null, 204)
  })

  // —— 成员 ——
  .get('/:projectId/members', async (c) => c.json(await store.listMembers(c.req.param('projectId'))))

  .delete('/:projectId/members/:userId', requireProjectAdmin, async (c) => {
    const me = await currentUserId(c)
    const target = c.req.param('userId')
    if (me === target) {
      return c.json({ error: '不能移除自己；如需退出请让其他管理员操作' }, 400)
    }

    const removed = await store.removeMember(c.req.param('projectId'), target)
    if (!removed) return c.json({ error: 'Not Found', message: '成员不存在' }, 404)
    return c.body(null, 204)
  })

  // —— 分享链接（一个项目一条）——
  .get('/:projectId/invite', requireProjectAdmin, async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    // 读接口也会写：没有链接就当场建一条，前端打开面板即拿到可复制的 URL
    const invite = await store.ensureInvite({
      projectId: c.req.param('projectId'),
      createdById: userId,
    })
    return c.json(withUrl(invite))
  })

  // 改有效期：token 不变，已经发出去的链接继续可用
  .patch('/:projectId/invite', requireProjectAdmin, async (c) => {
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
    return c.json(withUrl(invite))
  })

  // 重置：换一个 token，旧链接立刻失效
  .post('/:projectId/invite/reset', requireProjectAdmin, async (c) => {
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
    return c.json(withUrl(invite))
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

    if ((await flows.countByProject(projectId)) >= PROJECT_LIMITS.flows) {
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
