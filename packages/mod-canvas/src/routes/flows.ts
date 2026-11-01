import { Hono } from 'hono'
import { revokeAccess } from '@shadecn/server-kit/access'
import { flushFlowContent } from '../contract.ts'
import { parseUserStatePatch } from '../flow-types.ts'
import { flowUserState } from '../flow-user-state.ts'
import { FLOW_STATUSES, flows as store, type FlowStatus } from '../flows.ts'
import { currentUserId, requireFlowMember, type ProjectVariables } from '../guards.ts'
import { INVALID_JSON, parseDescription, parseName, readJson } from './params.ts'

type Env = { Variables: ProjectVariables }

interface FlowPatchPayload {
  name?: unknown
  description?: unknown
  status?: unknown
  tags?: unknown
}

const NOT_FOUND = { error: 'Not Found', message: '画布不存在' } as const
const UNAUTHORIZED = { error: 'Unauthorized', message: '需要登录' } as const

/**
 * 画布元数据接口，挂在 `/api/flows`。
 *
 * 画布的访问权来自项目成员身份；非成员一律 404。守卫**逐条挂在本模块自己的路径上**，不用 `/:flowId/*` 一把罩住 ——
 * 别的模块挂在 `/api/flows/:flowId/<x>` 下的路由（协同的 `/doc`、agent、上传）自己叠 `canvas.flowGuard`，
 * 罩住的写法会让它们的每个请求判两次权。
 */
export const flows = new Hono<Env>()
  .use('/:flowId', requireFlowMember)
  .use('/:flowId/user-state', requireFlowMember)
  .use('/:flowId/duplicate', requireFlowMember)

  .get('/:flowId', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)

    // userState（视口等）是**这个人**的，所以详情要带上请求者身份
    const flow = await store.get(c.req.param('flowId'), userId)
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
    // 画布已删 = 这个房间谁都进不去了（`projectIdOf` 会过滤 deletedAt）。
    // 还开着那张画布的人当场断掉，不然他会继续对着一张已经不存在的画布画
    await revokeAccess()
    return c.body(null, 204)
  })

  /**
   * 按用户存的画布状态（视口…）。PATCH 语义：只带要改的分区，没带的原样留着。
   *
   * 单独一条路由、不搭 commit 的车：这些状态不是画布内容 ——
   * 不进快照、不进操作日志、不涨 revision，也就没有乐观锁和冲突一说，
   * 只平移一下画布同样要能存下来。加新分区不用动这里。
   */
  .patch('/:flowId/user-state', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)

    const body = await readJson<unknown>(c.req)
    if (!body) return c.json({ error: INVALID_JSON }, 400)

    const patch = parseUserStatePatch(body)
    if (!patch.ok) return c.json({ error: patch.error }, 400)

    await flowUserState.patch(c.req.param('flowId'), userId, patch.value)
    return c.body(null, 204)
  })

  /**
   * 复制画布。
   *
   * 复制的是库里那份 ydoc，所以要先把**还开着的房间**落库 ——
   * 内容的事实源是内存里的 Y.Doc，不落一次的话副本会停在上一次防抖写入的样子。
   *
   * 这一步失败就让它抛（→ 500），**不要吞掉继续复制**：吞掉的结果是默默复制出一份
   * 旧内容，而用户拿到的是一张「看着复制成功、内容却少了一截」的画布。
   * 落库失败本来就意味着数据库有问题，紧接着的 `duplicate` 也成不了。
   */
  .post('/:flowId/duplicate', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)

    const flowId = c.req.param('flowId')
    // 房间可能开在任何一个协同实例上：经总线问全部，超时 / 没有协同实例就按库里现有内容复制
    await flushFlowContent(flowId)

    const copy = await store.duplicate(flowId, userId)
    if (!copy) return c.json(NOT_FOUND, 404)
    return c.json(copy, 201)
  })
