import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware.ts'
import { currentUserId, requireFlowMember, type ProjectVariables } from '../auth/project.ts'
import { GRAPH_LIMITS, parseGraph, parseTransactions } from '../store/flow-types.ts'
import { FLOW_STATUSES, flows as store, type FlowStatus } from '../store/flows.ts'
import { INVALID_JSON, parseDescription, parseName, parsePagination, readJson } from './params.ts'

type Env = { Variables: AuthVariables & ProjectVariables }

interface FlowPatchPayload {
  name?: unknown
  description?: unknown
  status?: unknown
  tags?: unknown
}

interface CommitPayload {
  baseRevision?: unknown
  transactions?: unknown
  graph?: unknown
}

const NOT_FOUND = { error: 'Not Found', message: '画布不存在' } as const

export const flows = new Hono<Env>()
  // 画布的访问权来自项目成员身份；非成员一律 404
  .use('/:flowId', requireFlowMember)
  .use('/:flowId/*', requireFlowMember)

  .get('/:flowId', async (c) => {
    const flow = await store.get(c.req.param('flowId'))
    if (!flow) return c.json(NOT_FOUND, 404)
    return c.json(flow)
  })

  .patch('/:flowId', async (c) => {
    const body = await readJson<FlowPatchPayload>(c.req)
    if (!body) return c.json({ error: INVALID_JSON }, 400)

    const patch: {
      name?: string
      description?: string | null
      status?: FlowStatus
      tags?: string[]
    } = {}

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
    if (body.status !== undefined) {
      if (!FLOW_STATUSES.includes(body.status as FlowStatus)) {
        return c.json({ error: `status 只能是 ${FLOW_STATUSES.join(' / ')}` }, 400)
      }
      patch.status = body.status as FlowStatus
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
        return c.json({ error: 'tags 必须是字符串数组' }, 400)
      }
      patch.tags = body.tags as string[]
    }

    return c.json(await store.update(c.req.param('flowId'), patch))
  })

  .delete('/:flowId', async (c) => {
    await store.softDelete(c.req.param('flowId'))
    return c.body(null, 204)
  })

  .post('/:flowId/duplicate', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const copy = await store.duplicate(c.req.param('flowId'), userId)
    if (!copy) return c.json(NOT_FOUND, 404)
    return c.json(copy, 201)
  })

  /**
   * 提交事务。乐观锁靠 baseRevision：对不上就 409，让前端重新加载 ——
   * 本期不做协同，没有合并逻辑。
   */
  .post('/:flowId/commit', async (c) => {
    const body = await readJson<CommitPayload>(c.req)
    if (!body) return c.json({ error: INVALID_JSON }, 400)

    if (!Number.isInteger(body.baseRevision) || (body.baseRevision as number) < 0) {
      return c.json({ error: 'baseRevision 必须是非负整数' }, 400)
    }

    const transactions = parseTransactions(body.transactions)
    if (!transactions.ok) return c.json({ error: transactions.error }, 400)

    const graph = parseGraph(body.graph)
    if (!graph.ok) {
      // 体积超限是 413，其余结构问题都是 400
      const tooLarge = graph.error.includes('超过上限')
      return c.json({ error: graph.error }, tooLarge ? 413 : 400)
    }

    const userId = await currentUserId(c)
    const result = await store.commit({
      flowId: c.req.param('flowId'),
      baseRevision: body.baseRevision as number,
      transactions: transactions.value,
      graph: graph.value,
      actorId: userId,
    })

    if (!result.ok) {
      return c.json(
        {
          error: '该画布已在别处修改，请重新加载',
          reason: 'conflict',
          revision: result.revision,
        },
        409,
      )
    }

    return c.json({ revision: result.revision })
  })

  .get('/:flowId/operations', async (c) => {
    const paged = parsePagination(c.req.query(), 50)
    if (!paged.ok) return c.json({ error: paged.error }, 400)

    const rawSince = c.req.query('sinceSeq')
    let sinceSeq: number | undefined
    if (rawSince !== undefined && rawSince !== '') {
      const value = Number(rawSince)
      if (!Number.isInteger(value) || value < 0) {
        return c.json({ error: 'sinceSeq 必须是非负整数' }, 400)
      }
      sinceSeq = value
    }

    const { items, total } = await store.listOperations(c.req.param('flowId'), {
      ...paged.value,
      sinceSeq,
    })

    return c.json({
      items,
      ...paged.value,
      total,
      totalPages: Math.ceil(total / paged.value.pageSize),
    })
  })

/** 给前端做上限提示用 */
export const flowLimits = GRAPH_LIMITS
