import type { Context } from 'hono'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AgentStreamEvent } from '@shadecn/shared/agent'
import { validatePrompt } from '@shadecn/agent/session'
import { flowHasNode, openAgentCanvas } from '../agent/canvas-access.ts'
import { agentRuntime } from '../agent/index.ts'
import type { AuthVariables } from '../auth/middleware.ts'
import { currentUserId, type ProjectVariables } from '../auth/project.ts'
import { INVALID_JSON, readJson } from './params.ts'

/**
 * 画布 Agent 的接口（REQ-AGENT，契约在 `@shadecn/shared/agent`）。
 *
 * 挂在 `routes/flows.ts` 的 `/:flowId/agent` 下，所以 `requireFlowMember` 已经在前面跑过（**每次请求都重查**）：
 * 非成员 / 画布不存在一律 404，和画布的其余接口同一个口径。个人画布（所有者就是唯一成员）也走这里。
 *
 * ## 权限矩阵（项目画布；个人画布只有所有者进得来，等于全是「发起人」那一列）
 *
 * | 接口 | 发起人 | 其他成员 | 项目管理员 | 非成员 |
 * |---|---|---|---|---|
 * | `GET /`、`GET /conversations`、`GET /conversations/:id` | ✓ | ✓（只读） | ✓（只读） | 404 |
 * | `GET /runs/:runId/events`（接回 / 旁观） | ✓ | ✓（只读） | ✓（只读） | 404 |
 * | `POST /messages` 续聊某个会话 | ✓ | 403 | 403 | 404 |
 * | `DELETE /conversations/:id` | ✓ | 403 | 403 | 404 |
 * | `POST /runs/:runId/abort` | ✓ | 403 | ✓ | 404 |
 *
 * 不存在的会话 / 不在这张画布上的会话一律 404（先于 403 判）；新会话（不给 conversationId）谁都能发起。
 *
 * 这一层只管 HTTP：参数、状态码、把事件逐帧写成 SSE。会话、按会话并发、事件映射都在
 * `@shadecn/agent`，会话与运行日志的落库在 `store/agent.ts`（经 `agent/index.ts` 注入，路由不碰 ORM）；
 * 怎么打开画布（direct connection、每次读写判权、配额）在 `agent/canvas-access.ts`；
 * 一轮的执行身份（Grant 签发、判权、对账）在 `agent/authority.ts`。
 *
 * **会话只管发起**：这里取 `currentUserId` 决定「谁发起、能不能发起」，之后这一轮凭的是 Grant ——
 * 发起人退出登录、会话过期都不会让它停下（docs/22 §6）。
 */

type Env = { Variables: AuthVariables & ProjectVariables }

const UNAUTHORIZED = { error: 'Unauthorized', message: '需要登录' } as const

/**
 * SSE 心跳间隔。一次 ffmpeg 可能跑一分钟，这期间没有任何事件 —— 反代（nginx / Ingress）
 * 的空闲超时默认 60s，会把流掐掉。掐掉不会中止这一轮，但前端就得重新接回、白白补发一遍。
 * 发一行注释（`: ping`）撑住，SSE 解析器（包括 AG-UI 的）都忽略注释行。
 */
const HEARTBEAT_MS = 15_000

const CONVERSATION_NOT_FOUND = { error: 'Not Found', message: '会话不存在' } as const
const RUN_NOT_FOUND = { error: 'Not Found', message: '这一轮已经结束或不存在' } as const
const NOT_CONVERSATION_OWNER = { error: 'Forbidden', message: '这是别人的会话，只能查看，不能继续对话' } as const
const NODE_NOT_FOUND = { error: 'Not Found', message: '这张画布上没有这个节点' } as const

/** 请求者在这张画布所属项目里是不是管理员 —— `requireFlowMember` 这次请求刚查的，不缓存 */
function isProjectAdmin(c: Context<Env>): boolean {
  return c.get('projectRole') === 'admin'
}

/**
 * 把一轮的事件接到一条 SSE 上 —— 发起（`POST /messages`）和接回（`GET /runs/:runId/events`）共用。
 *
 * 订阅必须在开流**之前**做（状态码只能在响应头之前定：忙 409、接不回 404 / 410），
 * 而订阅那一刻就会收到帧（接回时是同步补发的整段缓冲），所以先攒在 `backlog` 里，流就绪后按顺序补发。
 */
function sseRelay() {
  const backlog: AgentStreamEvent[] = []
  let sink: ((event: AgentStreamEvent) => void) | null = null
  return {
    emit: (event: AgentStreamEvent) => (sink ? sink(event) : backlog.push(event)),
    /**
     * 开流：补发攒下的、接着推后续的，`until` 兑现后关流。
     * **客户端断开只调 `onDisconnect`（退订）** —— 这一轮不随连接中止，照常跑完、照常落库。
     */
    stream(c: Context, until: Promise<void>, onDisconnect: () => void) {
      return streamSSE(c, async (stream) => {
        let disconnected!: () => void
        const gone = new Promise<void>((resolve) => (disconnected = resolve))
        stream.onAbort(() => {
          onDisconnect()
          disconnected()
        })
        const open = () => !stream.closed && !stream.aborted

        // 写是异步的，串成一条链保证顺序；写失败（连接没了）由 onAbort 那条路收尾
        let chain: Promise<void> = Promise.resolve()
        const write = (event: AgentStreamEvent) => {
          chain = chain
            .then(() => (open() ? stream.writeSSE({ data: JSON.stringify(event) }) : undefined))
            .catch(() => undefined)
        }
        for (const event of backlog.splice(0)) write(event)
        sink = write

        const heartbeat = setInterval(() => {
          chain = chain
            .then(() => (open() ? stream.write(': ping\n\n').then(() => undefined) : undefined))
            .catch(() => undefined)
        }, HEARTBEAT_MS)

        try {
          await Promise.race([until, gone])
        } finally {
          clearInterval(heartbeat)
          await chain
        }
      })
    },
  }
}

export const agent = new Hono<Env>()
  /**
   * 面板打开（以及协同连接连上 / 重连）时的那一次：是否启用、这张画布此刻在跑的全部任务（`mine` 按请求者算）、
   * 默认打开的会话（我有任务在跑时是最近那一轮的会话，否则是我最近更新的那个）
   */
  .get('/', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)
    return c.json(await agentRuntime().view(c.req.param('flowId')!, userId))
  })

  /** 这张画布上所有人的会话列表（带发起人、mine），按 updatedAt 倒序（不含消息） */
  .get('/conversations', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)
    return c.json(await agentRuntime().listConversations(c.req.param('flowId')!, userId))
  })

  /** 一个会话的全部内容。能进这张画布的人都能读（别人的只读）；不在这张画布上 → 404 */
  .get('/conversations/:conversationId', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)
    const view = await agentRuntime().getConversation(
      c.req.param('flowId')!,
      userId,
      c.req.param('conversationId'),
    )
    return view ? c.json(view) : c.json(CONVERSATION_NOT_FOUND, 404)
  })

  /** 删除会话：只有发起人能删（别人 403）；它正在跑一轮时 409（先中止或等它结束）；不存在的 404 */
  .delete('/conversations/:conversationId', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)
    const result = await agentRuntime().deleteConversation(
      c.req.param('flowId')!,
      userId,
      c.req.param('conversationId'),
    )
    if (result === 'running') {
      return c.json({ error: 'Conflict', message: '这个会话还有一轮在运行，先中止或等它结束再删除' }, 409)
    }
    if (result === 'not-found') return c.json(CONVERSATION_NOT_FOUND, 404)
    if (result === 'forbidden') {
      return c.json({ error: 'Forbidden', message: '这是别人的会话，只有发起人可以删除它' }, 403)
    }
    return c.body(null, 204)
  })

  /**
   * 发一条消息、跑一轮，以 `text/event-stream` 回复（AG-UI 的 HTTP 编码：每帧只有
   * `data: <事件 JSON>\n\n`，没有 `event:` 行）。
   *
   * **先占槽位再开流**：`runtime.start()` 是同步的，这个会话已有一轮在跑就当场 409 —— 状态码只能在响应头之前定，
   * 流一开就是 200 了。这一轮从 `start()` 起就在跑，开流之前吐出来的事件先攒着（见 {@link sseRelay}）。
   *
   * `conversationId` 为空 = 新会话：编排层在这一轮开始时建好它，id 经 RUN_STARTED 的 `threadId` 带回。
   * 新会话可以带 `nodeId` = 会话的入口节点（docs/20 §3.10.9，只记录、不限制工具）：节点不在这张画布上 → 404；续聊时给 → 400。
   *
   * **客户端断开不中止这一轮**：只是发起者不再收事件，这一轮照常跑完、照常落库；
   * 重新打开画布后经 `GET /runs/:runId/events` 接回。中止只有 `POST /runs/:runId/abort`、时长上限、失权、服务端退出。
   * 流仍然开到这一轮彻底结束（运行日志写完）才关 —— 收到最后一帧时，`GET` 读到的已经是落定的状态。
   */
  .post('/messages', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)

    const runtime = agentRuntime()
    if (!runtime.enabled) {
      return c.json(
        { error: 'Service Unavailable', message: `画布 Agent 未启用：${runtime.disabledReason}` },
        503,
      )
    }

    const body = await readJson<unknown>(c.req)
    if (!body) return c.json({ error: INVALID_JSON }, 400)
    const prompt = validatePrompt(body)
    if (!prompt.ok) return c.json({ error: prompt.error }, 400)

    const flowId = c.req.param('flowId')!
    // 续聊的会话要在开流之前确认存在（404）且是自己的（403）：状态码只能在响应头之前定。
    // 查过之后、这一轮开始之前它才被删掉的（极窄的窗口），由编排层以 RUN_ERROR 收尾；
    // 编排层读会话时 where 里同样带着 user，这里漏判也续不了别人的会话
    if (prompt.conversationId !== null) {
      const existing = await runtime.getConversation(flowId, userId, prompt.conversationId)
      if (!existing) return c.json(CONVERSATION_NOT_FOUND, 404)
      if (!existing.mine) return c.json(NOT_CONVERSATION_OWNER, 403)
    }
    if (prompt.nodeId !== null && !(await flowHasNode(flowId, prompt.nodeId))) return c.json(NODE_NOT_FOUND, 404)

    const relay = sseRelay()
    const started = runtime.start({
      flowId,
      userId,
      text: prompt.text,
      conversationId: prompt.conversationId,
      nodeId: prompt.nodeId,
      openCanvas: (runId, authority) => openAgentCanvas({ flowId, userId, runId, authority }),
      emit: relay.emit,
    })
    if (!started.ok) {
      return started.reason === 'busy'
        ? c.json({ error: 'Conflict', message: started.message }, 409)
        : c.json({ error: 'Service Unavailable', message: started.message }, 503)
    }

    return relay.stream(c, started.done, started.unsubscribe)
  })

  /**
   * 接回 / 旁观正在跑的一轮（契约见 `agentRunEventsPath`）：先从头补发它已经发出的全部事件，
   * 再接着推后续的，最后一帧之后关流 —— 序列和发起时那条流逐帧相同。
   *
   * 能进这张画布的人都能订阅（只读，项目画布上会话本就只读可见）。不是这张画布此刻在跑的一轮 → 404；
   * 补发缓冲已经溢出 → 410。客户端断开只是退订。
   */
  .get('/runs/:runId/events', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)

    const relay = sseRelay()
    const subscribed = agentRuntime().subscribe(c.req.param('flowId')!, c.req.param('runId'), relay.emit)
    if (!subscribed.ok) {
      return subscribed.reason === 'overflowed'
        ? c.json({ error: 'Gone', message: '这一轮的事件太多，接不回完整的进度；等它结束后重新打开会话' }, 410)
        : c.json(RUN_NOT_FOUND, 404)
    }
    return relay.stream(c, subscribed.done, subscribed.unsubscribe)
  })

  /**
   * 中止某一轮（契约见 `agentRunAbortPath`）—— 发起人或项目管理员（docs/20 §3.8.4）；
   * 已经结束 / runId 不对就当已经停了（幂等，204）。角色取自这次请求的 `requireFlowMember`，不缓存。
   */
  .post('/runs/:runId/abort', async (c) => {
    const userId = await currentUserId(c)
    if (!userId) return c.json(UNAUTHORIZED, 401)

    const result = agentRuntime().abort(c.req.param('flowId')!, c.req.param('runId'), {
      userId,
      admin: isProjectAdmin(c),
    })
    if (result === 'forbidden') {
      return c.json({ error: 'Forbidden', message: '只有发起这一轮的人或项目管理员可以中止它' }, 403)
    }
    return c.body(null, 204)
  })
