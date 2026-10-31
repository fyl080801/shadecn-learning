import { randomUUID } from 'node:crypto'
import type { AgentAttachment, AgentStreamEvent } from '@shadecn/shared/agent'
import type { StartRunResult } from '@shadecn/agent/session'
import { bus, defineRequest } from '@shadecn/server-kit/bus'
import { sharedLog, stringCodec, type SharedLog } from '@shadecn/server-kit/cluster'
import { openAgentCanvas } from './canvas-access.ts'
import { agentRuntime } from './index.ts'

/**
 * 发起一轮 agent：**web 派发、agent 副本执行**（REQ-MODULES，docs/28 §3.6）。
 *
 * web 角色不跑 agent。`POST …/agent/messages` 在 web 上判完权限、校验完输入，把发起请求经总线
 * **派给一个** agent 副本（`bus.dispatch`，本进程有 agent 就交给本进程）；那个副本调编排层的 `start()`
 * —— 会话槽位、模型、沙箱、Grant 全在执行的这一侧 —— 回一句「开始了 / 忙 / 未启用」，web 据此在开流之前定状态码。
 *
 * ## 事件怎么回到 web：一条按派发 id 的共享日志
 *
 * 编排层发给发起者的每一帧，执行侧按顺序攒成批、追加进共享日志 `agent-dispatch:<派发 id>`，结束时补一条结束标记；
 * web 从头读这条日志转给浏览器。**不复用编排层的补发日志**（`GET /runs/:runId/events` 那条）：
 * 那条要等这一轮进了任务列表才有登记，发起后马上订阅会 404，很短的一轮结束得比订阅还早也会 404。
 * 这条日志从第一帧起就在，和编排层内部的时机无关。
 *
 * - 批次带连续的 `seq`：读到断号（日志被截断 / 过期）就停止转发 —— 浏览器那头照常走「流断了 → 经 GET 接回」。
 * - 浏览器断开 = web 不读了；这一轮照常跑完（和以前「发起者退订」一样），日志靠 TTL 自己消失。
 * - **单进程（全部角色）也走这一条**：派发交给本进程的处理函数，事件照样经共享日志（内存实现）回来 ——
 *   没有「本地就直接 start」的快路径，免得那条只在开发环境跑的路把这条的毛病盖住。
 */

export interface StartRunRequest {
  dispatchId: string
  flowId: string
  userId: string
  text: string
  conversationId: string | null
  nodeId: string | null
  attachments: AgentAttachment[]
}

export type StartRunReply =
  | { ok: true; runId: string }
  | { ok: false; reason: 'disabled' | 'busy' | 'unavailable'; message: string }

export const AGENT_START_RUN = defineRequest<StartRunRequest, StartRunReply>('agent.start-run')

/** 等执行侧回「开始了没有」的上限：start() 只是占槽位 + 判模型，沙箱在那之后异步起 */
export const START_RUN_TIMEOUT_MS = 15_000

/** 事件日志的存活时间（每次追加都续）；比一轮的总时长上限宽就不会在跑着的时候过期 */
export const RELAY_TTL_MS = 60 * 60_000

/** 攒批的窗口：文字是逐 token 来的，一帧一条会把共享层写爆 */
export const RELAY_BATCH_MS = 30

/** web 每次阻塞读的时长 */
const RELAY_WAIT_MS = 5_000

type RelayRecord = { seq: number; events: AgentStreamEvent[] } | { seq: number; end: true }

let log: SharedLog<string> | undefined
const relayLog = () => (log ??= sharedLog<string>('agent-dispatch', stringCodec))
const keyOf = (dispatchId: string) => dispatchId

// ---------------------------------------------------------------- 执行侧（agent 角色）

/** 一条派发的写端：按顺序攒批、追加，结束时补结束标记 */
function relayWriter(dispatchId: string) {
  let seq = 0
  let pending: AgentStreamEvent[] = []
  let timer: NodeJS.Timeout | undefined
  let chain: Promise<void> = Promise.resolve()

  const append = (record: RelayRecord) => {
    chain = chain
      .then(() => relayLog().append(keyOf(dispatchId), JSON.stringify(record), { ttlMs: RELAY_TTL_MS }))
      .then(() => undefined)
      .catch((err: unknown) => console.warn(`[agent] 派发 ${dispatchId} 的事件写入共享日志失败`, err))
  }
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (pending.length === 0) return
    seq += 1
    append({ seq, events: pending })
    pending = []
  }

  return {
    emit(event: AgentStreamEvent) {
      pending.push(event)
      timer ??= setTimeout(flush, RELAY_BATCH_MS)
    },
    async end() {
      flush()
      seq += 1
      append({ seq, end: true })
      await chain
    },
  }
}

/**
 * agent 角色在总线上登记「发起一轮」的处理函数（`module.ts` 的 setup 调）。返回撤销函数。
 * 只有装了 agent 模块的进程才登记 —— web 派发时据此知道有没有能干活的副本。
 */
export function handleRunDispatch(): Promise<() => Promise<void>> {
  return bus().handle(AGENT_START_RUN, async (request): Promise<StartRunReply> => {
    const writer = relayWriter(request.dispatchId)
    const started: StartRunResult = await agentRuntime().start({
      flowId: request.flowId,
      userId: request.userId,
      text: request.text,
      conversationId: request.conversationId,
      nodeId: request.nodeId,
      attachments: request.attachments,
      openCanvas: (runId, authority) =>
        openAgentCanvas({ flowId: request.flowId, userId: request.userId, runId, authority }),
      emit: writer.emit,
    })
    if (!started.ok) return { ok: false, reason: started.reason, message: started.message }
    void started.done
      .catch((err: unknown) => console.error(`[agent] run=${started.runId} 收尾失败`, err))
      .then(() => writer.end())
    return { ok: true, runId: started.runId }
  })
}

// ---------------------------------------------------------------- 发起侧（web 角色）

export type RemoteStartResult =
  | { ok: true; runId: string; done: Promise<void>; unsubscribe: () => void }
  | { ok: false; reason: 'disabled' | 'busy' | 'unavailable'; message: string }

/**
 * web 发起一轮：派给一个 agent 副本，开始了就从派发日志读事件、逐帧交给 `emit`，读到结束标记 `done` 兑现。
 * `unsubscribe` = 浏览器断开，不再读（这一轮照常跑）。
 */
export async function startRunRemotely(
  input: Omit<StartRunRequest, 'dispatchId'>,
  emit: (event: AgentStreamEvent) => void,
): Promise<RemoteStartResult> {
  const dispatchId = randomUUID()
  const dispatched = await bus().dispatch(AGENT_START_RUN, { ...input, dispatchId }, { timeoutMs: START_RUN_TIMEOUT_MS })
  if (!dispatched.ok) {
    const message =
      dispatched.reason === 'no-responder'
        ? '画布 Agent 服务不可用（没有正在运行的 agent 实例）'
        : dispatched.reason === 'timeout'
          ? '画布 Agent 服务没有响应，请稍后再试'
          : `画布 Agent 发起失败：${dispatched.error}`
    if (dispatched.reason !== 'no-responder') {
      console.warn(`[agent] 派发发起请求失败（${dispatched.reason}，实例 ${dispatched.instance}）`)
    }
    return { ok: false, reason: 'unavailable', message }
  }
  const reply = dispatched.value
  if (!reply.ok) return reply

  let stopped = false
  const done = readRelay(dispatchId, emit, () => stopped)
  return {
    ok: true,
    runId: reply.runId,
    done,
    unsubscribe: () => {
      stopped = true
    },
  }
}

async function readRelay(dispatchId: string, emit: (event: AgentStreamEvent) => void, stopped: () => boolean) {
  let cursor: string | null = null
  let expected = 1
  while (!stopped()) {
    let entries
    try {
      entries = await relayLog().wait(keyOf(dispatchId), cursor, RELAY_WAIT_MS)
    } catch (err) {
      console.warn(`[agent] 读派发 ${dispatchId} 的事件失败，不再转发（浏览器可经 GET 接回）`, err)
      return
    }
    for (const entry of entries) {
      cursor = entry.id
      let record: RelayRecord
      try {
        record = JSON.parse(entry.value) as RelayRecord
      } catch {
        console.warn(`[agent] 派发 ${dispatchId} 的事件记录损坏，不再转发`)
        return
      }
      if (record.seq !== expected) {
        console.warn(`[agent] 派发 ${dispatchId} 的事件断号（期望 ${expected}，读到 ${record.seq}），不再转发`)
        return
      }
      expected += 1
      if ('end' in record) return
      if (stopped()) return
      for (const event of record.events) emit(event)
    }
  }
}
