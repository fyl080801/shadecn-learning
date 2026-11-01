import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { bus } from '@shadecn/server-kit/bus'
import type { FlowRequestPort } from '@shadecn/server-kit/http'
import { AppError, type AppErrorCode, type AppOutput, type AppResult, type AppsService } from './contract.ts'
import { APPS_CANCEL_TASK, APPS_PUSH_TASKS, APPS_RUN_TASK } from './task-bus.ts'
import { appTasks, taskViews } from './tasks.ts'

/**
 * `/api/apps`（docs/29 §3.6）：
 * - `GET /` —— 应用列表（不含提供方地址和密钥）；`GET /:appId` —— 一个应用；
 * - `POST /:appId/execute` —— 请求体 `{ params: {...} }`，**同步**等到结果（视频 / 3D 可能要几分钟，见 docs/29 §5 的任务化）。
 *   客户端断开 = 中止这次执行（上游已经建好的任务不撤回）。字节产物在回包里是 `dataUrl`。
 */

/** 请求体上限：参数里可能有 base64 的图（方舟单张上限 30MB 量级，这里只放常见尺寸） */
const MAX_BODY_BYTES = 32 * 1024 * 1024

const STATUS: Record<AppErrorCode, ContentfulStatusCode> = {
  not_found: 404,
  invalid_params: 400,
  unavailable: 503,
  upstream: 502,
  timeout: 504,
  aborted: 499 as ContentfulStatusCode,
}

function serializeOutput({ data, ...rest }: AppOutput) {
  return data
    ? { ...rest, dataUrl: `data:${rest.mimeType ?? 'application/octet-stream'};base64,${Buffer.from(data).toString('base64')}` }
    : rest
}

const executeBodyLimit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json({ error: '请求体太大', code: 'invalid_params' }, 413),
})

/** 读 `{ params }`；不是合法 JSON / 不是对象 → null */
async function readParams(c: Context): Promise<Record<string, unknown> | null> {
  const body = await c.req.json<{ params?: unknown }>().catch(() => null)
  if (!body || typeof body !== 'object') return null
  const params = body.params ?? {}
  return typeof params === 'object' && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : null
}

/** 执行并回包：错误码 → HTTP 状态，字节产物 → dataUrl */
async function respond(c: Context, run: () => Promise<AppResult>) {
  try {
    const result = await run()
    return c.json({ ...result, outputs: result.outputs.map(serializeOutput) })
  } catch (err) {
    if (err instanceof AppError) return c.json({ error: err.message, code: err.code }, STATUS[err.code])
    throw err
  }
}

export function createAppRoutes(service: AppsService, userId: (c: Context) => Promise<string | null>) {
  return new Hono()
    .get('/', (c) => c.json(service.list()))
    .get('/:appId', (c) => {
      const app = service.get(c.req.param('appId'))
      return app ? c.json(app) : c.json({ error: '没有这个应用', code: 'not_found' }, 404)
    })
    .post('/:appId/execute', executeBodyLimit, async (c) => {
      const params = await readParams(c)
      if (!params) return c.json({ error: '请求体必须是 { params: {...} }', code: 'invalid_params' }, 400)
      const user = await userId(c)
      return respond(c, () => service.executeApp(c.req.param('appId'), params, { signal: c.req.raw.signal, userId: user }))
    })
}

export interface FlowAppRoutesPorts {
  service: AppsService
  /** 画布守卫已经判过成员，这里只取身份和角色 */
  request: FlowRequestPort
}

/** 等 agent 副本回「接了没有」的上限：接手只是抢租约，执行在那之后异步跑 */
const DISPATCH_TIMEOUT_MS = 10_000
/** 节点 id 的格式上限（同 `createId`） */
const NODE_ID_MAX = 64

/**
 * `/api/flows/:flowId/apps`（docs/29 §3.8、§3.10）：画布节点的生成任务，挂在 `canvas.flowGuard` 之下（非成员 404）。
 *
 * - `POST /:appId/execute` `{ params, nodeId }` —— 当场校验参数（错了 400，不建任务）、同一节点已有进行中的任务 409，
 *   建任务行后经总线**派给一个** agent 副本执行（`task-runner.ts`），回 `202 { task }`。没有 agent 副本 = 任务记失败、503；
 *   派发超时不重发（它可能已经开始了），任务留在 `queued` 等对账接手；
 * - `GET /tasks` —— 这张画布进行中的任务 `{ tasks, now }`（之后的变化走房间的 `apps:tasks` 推送）；
 * - `POST /tasks/:taskId/cancel` —— 发起人或项目管理员；已结束 / 不存在 204（幂等）。
 *
 * web 不执行、不碰画布内容：参考图换字节、产物存资源、写回节点都在执行副本上。
 */
export function createFlowAppRoutes(ports: FlowAppRoutesPorts) {
  return new Hono()
    .get('/tasks', async (c) => {
      const tasks = await taskViews(await appTasks.listActive(c.req.param('flowId')!), ports.service)
      return c.json({ tasks, now: Date.now() })
    })
    .post('/tasks/:taskId/cancel', async (c) => {
      const flowId = c.req.param('flowId')!
      const row = await appTasks.get(c.req.param('taskId'))
      if (!row || row.flowId !== flowId) return c.body(null, 204)
      const userId = await ports.request.userId(c)
      if (row.userId !== userId && ports.request.membership(c)?.role !== 'admin') {
        return c.json({ error: '只有发起人和项目管理员能取消这个任务' }, 403)
      }
      if (await appTasks.cancel(row.id)) {
        // 通知在跑它的副本立刻停（丢了也不要紧：它下一次续租会读到 canceled）
        await bus().request(APPS_CANCEL_TASK, { taskId: row.id }, { timeoutMs: 3_000 })
        // 排队中的没有执行方替它推送：让一个 agent 副本推一次，别的协作者的列表才会去掉它（刚被接手的话会多推一次，无害）
        if (row.status === 'queued') {
          const pushed = await bus().dispatch(APPS_PUSH_TASKS, { flowId }, { timeoutMs: 3_000 })
          if (!pushed.ok) console.warn(`[apps] 任务 ${row.id} 取消后推送任务列表失败（${pushed.reason}）`)
        }
        console.info(`[apps] 任务 ${row.id} 已取消（${userId}）`)
      }
      return c.body(null, 204)
    })
    .post('/:appId/execute', executeBodyLimit, async (c) => {
      const flowId = c.req.param('flowId')!
      const appId = c.req.param('appId')
      const body = await c.req.json<{ params?: unknown; nodeId?: unknown }>().catch(() => null)
      const params = body && typeof body === 'object' ? (body.params ?? {}) : null
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return c.json({ error: '请求体必须是 { params: {...}, nodeId }', code: 'invalid_params' }, 400)
      }
      const nodeId = body?.nodeId
      if (typeof nodeId !== 'string' || !nodeId || nodeId.length > NODE_ID_MAX) {
        return c.json({ error: '缺少 nodeId（结果写回哪个节点）', code: 'invalid_params' }, 400)
      }
      let model: string | undefined
      try {
        model = ports.service.validate(appId, params as Record<string, unknown>).model
      } catch (err) {
        if (err instanceof AppError) return c.json({ error: err.message, code: err.code }, STATUS[err.code])
        throw err
      }
      if (await appTasks.activeOnNode(flowId, nodeId)) {
        return c.json({ error: '这个节点正在生成，等它完成或先取消', code: 'busy' }, 409)
      }
      const userId = (await ports.request.userId(c))!
      const row = await appTasks.create({ flowId, nodeId, userId, appId, model, params: params as Record<string, unknown> })
      const dispatched = await bus().dispatch(APPS_RUN_TASK, { taskId: row.id }, { timeoutMs: DISPATCH_TIMEOUT_MS })
      if (!dispatched.ok && dispatched.reason !== 'timeout') {
        const message =
          dispatched.reason === 'no-responder' ? '生成服务不可用（没有正在运行的 agent 实例）' : `生成任务派发失败：${dispatched.error}`
        console.warn(`[apps] 任务 ${row.id} ${message}`)
        await appTasks.fail(row.id, message)
        return c.json({ error: message, code: 'unavailable' }, 503)
      }
      if (!dispatched.ok) console.warn(`[apps] 任务 ${row.id} 派发超时，等对账接手`)
      const [task] = await taskViews([(await appTasks.get(row.id)) ?? row], ports.service)
      return c.json({ task }, 202)
    })
}
