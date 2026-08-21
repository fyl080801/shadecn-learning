import { Hono, type Context } from 'hono'
import type { AuthVariables } from '../auth/middleware.ts'
import { currentUserId, requireFlowMember, type ProjectVariables } from '../auth/project.ts'
import { applyFlowUpdate, decodeStateVectorParam, readFlowUpdate } from '../collab/flow-writer.ts'
import { flushRoomToDatabase, revokeCollabAccess } from '../collab/index.ts'
import { COLLAB_LIMITS } from '../collab/quota.ts'
import { parseUserStatePatch } from '../store/flow-types.ts'
import { flowUserState } from '../store/flow-user-state.ts'
import { FLOW_STATUSES, flows as store, type FlowStatus } from '../store/flows.ts'
import type { ProjectKind } from '../store/projects.ts'
import { INVALID_JSON, parseDescription, parseName, readJson } from './params.ts'

type Env = { Variables: AuthVariables & ProjectVariables }

interface FlowPatchPayload {
  name?: unknown
  description?: unknown
  status?: unknown
  tags?: unknown
}

const NOT_FOUND = { error: 'Not Found', message: '画布不存在' } as const
const UNAUTHORIZED = { error: 'Unauthorized', message: '需要登录' } as const

/** 协同画布的内容不走 HTTP —— 走错通道给 409，说清楚该走哪条 */
function rejectCollabFlow(c: Context<Env>) {
  if ((c.get('projectKind') as ProjectKind | undefined) === 'personal') return null
  return c.json(
    { error: 'Conflict', message: '项目画布的内容走协同连接，不走这个接口' },
    409,
  )
}

/** `?sv=` 是 base64url 的状态向量；给了但解不开就是 400，不要当成「没给」 */
function parseStateVector(
  raw: string | undefined,
): { ok: true; value: Uint8Array | undefined } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: undefined }
  const bytes = decodeStateVectorParam(raw)
  return bytes ? { ok: true, value: bytes } : { ok: false, error: 'sv 不是合法的状态向量' }
}

/**
 * Yjs 的更新是二进制，别经 JSON —— base64 一趟平白涨三分之一。
 *
 * 状态向量走响应头：它是**服务端自己的进度**，客户端拿它当下次算差量的基线。
 * 不能让客户端用「合并之后的本地状态」代替 —— 那样离线期间攒下的改动会被算成
 * 「服务端已经知道了」，从此再也推不出去。
 */
function binary(c: Context<Env>, bytes: Uint8Array, stateVector: Uint8Array) {
  return c.body(bytes as unknown as ArrayBuffer, 200, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    'x-flow-state-vector': Buffer.from(stateVector).toString('base64url'),
  })
}

export const flows = new Hono<Env>()
  // 画布的访问权来自项目成员身份；非成员一律 404
  .use('/:flowId', requireFlowMember)
  .use('/:flowId/*', requireFlowMember)

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
    await revokeCollabAccess()
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
   * 个人画布的内容通道（REQ-SOLO）：拉一次基线 / 推一段增量。
   *
   * 协同画布**不许走这条路**（409）。绕过去的话就绕过了单连接互斥、awareness 的
   * 身份改写和内存里那个活房间 —— 写进库的东西会被房间的下一次落库整段盖掉，
   * 而客户端还以为自己存上了。两条通道各自只服务自己的模式，谁都不兼职。
   */
  .get('/:flowId/doc', async (c) => {
    const denied = rejectCollabFlow(c)
    if (denied) return denied

    const since = parseStateVector(c.req.query('sv'))
    if (!since.ok) return c.json({ error: since.error }, 400)

    const state = await readFlowUpdate(c.req.param('flowId'), since.value)
    if (!state) return c.json(NOT_FOUND, 404)

    return binary(c, state.update, state.stateVector)
  })

  .post('/:flowId/doc', async (c) => {
    const denied = rejectCollabFlow(c)
    if (denied) return denied

    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)

    // 先看一眼声明的长度：超限的请求体没必要收完再拒
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > COLLAB_LIMITS.message) {
      return c.json({ error: `请求体超过上限 ${COLLAB_LIMITS.message} 字节` }, 413)
    }

    const body = new Uint8Array(await c.req.arrayBuffer())
    if (body.byteLength === 0) return c.json({ error: '请求体不能为空' }, 400)

    const result = await applyFlowUpdate(c.req.param('flowId'), body)
    if (!result.ok) {
      if (result.reason === 'not-found') return c.json(NOT_FOUND, 404)
      // 超配额是 413：请求本身合法，只是这张画布装不下了
      return c.json({ error: result.message }, 413)
    }

    return c.json({
      // 客户端存下它，下次用 `Y.encodeStateAsUpdate(doc, 这个)` 只发差量
      stateVector: Buffer.from(result.stateVector).toString('base64url'),
      revision: result.revision,
      noop: result.noop,
    })
  })

  /**
   * 复制画布。
   *
   * 复制的是库里那份 ydoc，所以要先把**还开着的房间**落库 ——
   * 内容的事实源是内存里的 Y.Doc，不落一次的话副本会停在上一次防抖写入的样子。
   */
  .post('/:flowId/duplicate', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)

    const flowId = c.req.param('flowId')
    await flushRoomToDatabase(flowId)

    const copy = await store.duplicate(flowId, userId)
    if (!copy) return c.json(NOT_FOUND, 404)
    return c.json(copy, 201)
  })
