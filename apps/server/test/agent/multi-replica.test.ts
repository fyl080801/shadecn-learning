import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type Context } from '@earendil-works/pi-ai'
import { AgentEventType, type AgentRunEntry, type AgentStreamEvent } from '@shadecn/shared/agent'
import { nodeGroupMap, nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import { createMemoryAuthorityProvider } from '@shadecn/agent/authority'
import { createDocCanvasHandle } from '@shadecn/agent/canvas'
import type { RunRegistry } from '@shadecn/agent/run-registry'
import { createAgentRuntime, type AgentRuntime, type OpenedCanvas } from '@shadecn/agent/session'
import { createMemoryConversationStore, createMemoryRunLog } from '@shadecn/agent/store'
import { createInlineDriver, registerScriptedModel, type ScriptedModel, type ScriptedStep } from '@shadecn/agent/testing'
import { AGENT_GATEWAY_PATH } from '@shadecn/agent/protocol'
import { createSharedLeaseRegistry } from '../../agent/leases.ts'
import { createSharedRunRegistry, type RunRegistryTables } from '../../agent/runs.ts'
import { stringCodec, type ClusterBackend } from '../../cluster/index.ts'
import { createMemoryBackend } from '../../cluster/memory.ts'

/**
 * 多副本（docs/20 §3.10.10，F14，验收 20）：两个 runtime 共用同一个内存共享后端（任务登记、会话槽位、补发日志、停止频道、
 * 节点占用都是宿主的共享层实现 `agent/runs.ts` / `agent/leases.ts`），各自一个网关、一个进程内驱动 —— runner 只连回发起它的那个。
 * 会话库是同一份（多副本共用数据库），画布是同一个 Y.Doc（同一个协同房间）。
 * 共享后端：内存实现永远跑；设了 `TEST_REDIS_URL` 再在真 Redis 上跑一遍同样的用例（stream / pub/sub / 阻塞读都是真的）。
 */

const TTL = 300
const FLOW = 'flow-1'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function profilesOf(userIds: string[]) {
  return new Map(userIds.map((id) => [id, { id, name: `名字-${id}`, avatarUrl: null }]))
}

function canvasOf(doc: Y.Doc) {
  return async (runId: string): Promise<OpenedCanvas> => ({
    ...createDocCanvasHandle(doc, { flowId: FLOW, runId }),
    async close() {},
  })
}

/** 一步停在模型那里，`release()` 之后才回；叫停时（上游请求被掐断）立刻回 */
function gated(final: string | AssistantMessage = '完成') {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const step: ScriptedStep = (_context, options) =>
    new Promise((resolve) => {
      options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
      void gate.then(() => resolve(typeof final === 'string' ? fauxAssistantMessage(final) : final))
    })
  return { step, release }
}

/** 模型这一步看到的上下文里最后一条工具结果（脚本化上游从请求还原） */
function capture(seen: string[], reply: AssistantMessage): ScriptedStep {
  return (context: Context) => {
    const result = [...context.messages].reverse().find((message) => message.role === 'toolResult')
    seen.push(result && result.role === 'toolResult' ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n') : '')
    return reply
  }
}

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function collector() {
  const events: AgentStreamEvent[] = []
  return { events, emit: (event: AgentStreamEvent) => events.push(event) }
}

function threadOf(events: AgentStreamEvent[]): string {
  const started = events.find((event) => event.type === AgentEventType.RUN_STARTED)
  if (!started || started.type !== AgentEventType.RUN_STARTED) throw new Error('没有 RUN_STARTED')
  return started.threadId
}

function seedText(doc: Y.Doc, id: string) {
  nodesMap(doc).set(id, toYNode({ ...buildNodeRecord({ id, type: 'text', label: `节点${id}`, position: { x: 0, y: 0 } }), data: { text: '原文' } }))
}

/** 一个「副本」 */
interface Replica {
  name: string
  runtime: AgentRuntime
  scripted: ScriptedModel
  registry: RunRegistry
  changes: { flowId: string; runs: AgentRunEntry[] }[]
}

/**
 * 两个副本共用一个共享后端 + 一份会话库。`wrapRegistry` 可以换掉某个副本的登记（模拟崩溃：之后的写全都落不了地）。
 */
let backend: ClusterBackend
/** 每个用例一套表（共享后端在一组用例之间复用，Redis 上就是同一条连接）：上一个用例留下的登记不会串过来 */
let tableSeq = 0

function cluster(options: { wrapRegistry?: (name: string, registry: RunRegistry) => RunRegistry } = {}) {
  tableSeq += 1
  const ns = (name: string) => `${name}-${tableSeq}`
  const tables: RunRegistryTables = {
    runs: backend.createMap(ns('agent-run'), stringCodec),
    slots: backend.createMap(ns('agent-conversation'), stringCodec),
    replay: backend.createLog(ns('agent-replay'), stringCodec),
    stops: backend.createChannel(ns('agent-stop'), stringCodec),
  }
  const leaseTable = backend.createMap<string>(ns('agent-node-lease'), stringCodec)
  const store = createMemoryConversationStore()
  const replicas = new Map<string, Replica>()
  const make = (name: string): Replica => {
    const scripted = registerScriptedModel()
    const base = scripted.runtimeOptions(createInlineDriver())
    const origin = `http://gateway-${name.toLowerCase()}.test`
    const shared = createSharedRunRegistry(tables, { ttlMs: TTL, instanceId: name })
    const registry = options.wrapRegistry ? options.wrapRegistry(name, shared) : shared
    const changes: Replica['changes'] = []
    const runtime = createAgentRuntime({
      ...base,
      gateway: { ...base.gateway, url: `${origin}${AGENT_GATEWAY_PATH}` },
      leases: createSharedLeaseRegistry(leaseTable, { ttlMs: TTL, instanceId: name }),
      runRegistry: registry,
      store,
      runLog: createMemoryRunLog(),
      userProfiles: profilesOf,
      authorities: createMemoryAuthorityProvider(),
      onRunsChange: (flowId, runs) => changes.push({ flowId, runs }),
      limits: { runsThrottleMs: 20 },
    })
    const replica = { name, runtime, scripted, registry, changes }
    replicas.set(origin, replica)
    return replica
  }
  const a = make('A')
  const b = make('B')
  // runner 打网关用全局 fetch：按地址交给发起它的那个副本（另一个副本没有它的登记，只会 401）
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const replica = replicas.get(new URL(url).origin)
    if (!replica) throw new Error(`[test] 意外的网络请求：${url}`)
    return replica.runtime.gateway.handle(new Request(input, init))
  })
  return { a, b, store, ns }
}

async function startOn(replica: Replica, doc: Y.Doc, options: { userId?: string; conversationId?: string | null; text?: string } = {}) {
  const out = collector()
  const started = await replica.runtime.start({
    flowId: FLOW,
    userId: options.userId ?? 'u1',
    conversationId: options.conversationId ?? null,
    text: options.text ?? '开始',
    openCanvas: canvasOf(doc),
    emit: out.emit,
  })
  return { started, out }
}

const candidates: { name: string; create: () => Promise<ClusterBackend> }[] = [
  { name: '内存共享后端', create: () => Promise.resolve(createMemoryBackend()) },
]
const redisUrl = process.env.TEST_REDIS_URL?.trim()
if (redisUrl) {
  candidates.push({
    name: 'Redis 共享后端',
    create: async () => {
      const { createRedisBackend } = await import('../../cluster/redis.ts')
      return createRedisBackend({ url: redisUrl, prefix: `test-${randomUUID().slice(0, 8)}` })
    },
  })
}

for (const candidate of candidates) describe(candidate.name, () => {
  beforeAll(async () => {
    backend = await candidate.create()
  })
  afterAll(async () => {
    await backend?.clearAll?.()
    await backend?.close()
  })

  describe('多副本：任务列表、接回、停止', () => {
    it('A 上跑的一轮，B 的任务列表里有它（发起人、会话、expiresAt），view 也带着；结束后两边都没了', async () => {
      const { a, b } = cluster()
      const hold = gated('完成')
      a.scripted.setResponses([hold.step])
      const { started, out } = await startOn(a, new Y.Doc())
      if (!started.ok) throw new Error('应该启动成功')
      await until(() => a.scripted.state.callCount >= 1)

      const onB = await b.runtime.activeRuns(FLOW)
      expect(onB).toEqual([
        expect.objectContaining({
          runId: started.runId,
          conversationId: threadOf(out.events),
          owner: { id: 'u1', name: '名字-u1', avatarUrl: null },
          occupies: [],
          expiresAt: expect.any(Number),
        }),
      ])
      // 线上的那一项不带副本标识
      expect(onB[0]).not.toHaveProperty('instanceId')
      const view = await b.runtime.view(FLOW, 'u2')
      expect(view.activeRuns).toEqual([expect.objectContaining({ runId: started.runId, mine: false })])
      // A 进列表时推的广播就是共享登记的全量
      expect(a.changes.at(-1)!.runs.map((run) => run.runId)).toEqual([started.runId])

      hold.release()
      await started.done
      expect(await b.runtime.activeRuns(FLOW)).toEqual([])
      expect(a.changes.at(-1)!.runs).toEqual([])
    })

    it('两个副本各跑一轮：各自的广播都是两边的全量', async () => {
      const { a, b } = cluster()
      const holdA = gated()
      const holdB = gated()
      a.scripted.setResponses([holdA.step])
      b.scripted.setResponses([holdB.step])
      const doc = new Y.Doc()
      const runA = await startOn(a, doc)
      await until(() => a.scripted.state.callCount >= 1)
      const runB = await startOn(b, doc, { userId: 'u2' })
      await until(() => b.scripted.state.callCount >= 1)
      if (!runA.started.ok || !runB.started.ok) throw new Error('应该启动成功')
      const both = [runA.started.runId, runB.started.runId].sort()
      expect(b.changes.at(-1)!.runs.map((run) => run.runId).sort()).toEqual(both)
      expect((await a.runtime.activeRuns(FLOW)).map((run) => run.runId).sort()).toEqual(both)
      holdA.release()
      holdB.release()
      await Promise.all([runA.started.done, runB.started.done])
    })

    it('B 接回 A 上的一轮：补发自第一帧起的全部，接着收后续的，和发起人那条流逐帧相同', async () => {
      const { a, b } = cluster()
      const hold = gated(fauxAssistantMessage('后面这段话是接回之后才说的，要能在 B 上看到'))
      a.scripted.setResponses([fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', data: { text: '内容' } })], { stopReason: 'toolUse' }), hold.step])
      const { started, out } = await startOn(a, new Y.Doc())
      if (!started.ok) throw new Error('应该启动成功')
      await until(() => a.scripted.state.callCount >= 2)

      const rejoined = collector()
      const sub = await b.runtime.subscribe(FLOW, started.runId, rejoined.emit)
      if (!sub.ok) throw new Error(`应该接得回：${sub.reason}`)
      // 补发：到此刻为止 A 发出的全部
      await until(() => rejoined.events.length >= out.events.length)
      expect(rejoined.events.map((event) => event.type)).toContain(AgentEventType.TOOL_CALL_START)

      hold.release()
      await started.done
      await sub.done
      expect(rejoined.events).toEqual(out.events)
      expect(rejoined.events.at(-1)!.type).toBe(AgentEventType.RUN_FINISHED)
      // 结束了：再来接回的 404（不论哪个副本）
      expect(await b.runtime.subscribe(FLOW, started.runId, () => {})).toEqual({ ok: false, reason: 'not-found' })
      expect(await a.runtime.subscribe(FLOW, started.runId, () => {})).toEqual({ ok: false, reason: 'not-found' })
    })

    it('跨副本接回：runId 不对、画布不对是 404；补发溢出过是 410（和本副本同一个口径）', async () => {
      const { a, b } = cluster()
      expect(await b.runtime.subscribe(FLOW, 'run_nope', () => {})).toEqual({ ok: false, reason: 'not-found' })

      const hold = gated()
      a.scripted.setResponses([hold.step])
      const { started } = await startOn(a, new Y.Doc())
      if (!started.ok) throw new Error('应该启动成功')
      await until(() => a.scripted.state.callCount >= 1)
      expect(await b.runtime.subscribe('flow-2', started.runId, () => {})).toEqual({ ok: false, reason: 'not-found' })
      hold.release()
      await started.done
    })

    it('补发缓冲溢出后：A、B 上接回都是 410；溢出前就挂在 B 上的订阅者照常收到最后', async () => {
      const backendCluster = cluster()
      const { a, b } = backendCluster
      // 换一个补发上限很小的 A：开头几帧就溢出
      const small = createAgentRuntime({
        ...a.scripted.runtimeOptions(createInlineDriver()),
        gateway: { ...a.scripted.runtimeOptions().gateway, url: `http://gateway-a.test${AGENT_GATEWAY_PATH}` },
        leases: createSharedLeaseRegistry(backend.createMap<string>(backendCluster.ns('lease-small'), stringCodec), { ttlMs: TTL, instanceId: 'A' }),
        runRegistry: a.registry,
        store: backendCluster.store,
        runLog: createMemoryRunLog(),
        userProfiles: profilesOf,
        authorities: createMemoryAuthorityProvider(),
        limits: { replayEvents: 6 },
      })
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => small.gateway.handle(new Request(input, init)))
      // 第一步：一大段文字（切成好几帧，一下就溢出）+ 一次读工具，于是还有第二步；第二步停住，这一轮溢出之后还活着
      const first = gated(
        fauxAssistantMessage([fauxText('一段足够长的文字，会被切成好几帧流出去，补发缓冲早就装不下了'), fauxToolCall('read_canvas', {})], {
          stopReason: 'toolUse',
        }),
      )
      const second = gated()
      a.scripted.setResponses([first.step, second.step])
      const out = collector()
      const started = await small.start({ flowId: FLOW, userId: 'u1', conversationId: null, text: '一', openCanvas: canvasOf(new Y.Doc()), emit: out.emit })
      if (!started.ok) throw new Error('应该启动成功')
      await until(() => a.scripted.state.callCount >= 1)
      const early = collector()
      const sub = await b.runtime.subscribe(FLOW, started.runId, early.emit)
      if (!sub.ok) throw new Error('溢出之前应该接得回')

      first.release()
      await until(() => a.scripted.state.callCount >= 2)
      // 溢出了、这一轮还在跑：本副本和别的副本接回都是 410
      expect(await small.subscribe(FLOW, started.runId, () => {})).toEqual({ ok: false, reason: 'overflowed' })
      await until(async () => (await b.runtime.subscribe(FLOW, started.runId, () => {})).ok === false)
      expect(await b.runtime.subscribe(FLOW, started.runId, () => {})).toEqual({ ok: false, reason: 'overflowed' })
      second.release()
      await started.done
      await sub.done
      expect(early.events).toEqual(out.events)
    })

    it('B 上点停止能停下 A 的那一轮（发起人 / 项目管理员）；别人 403，登记没了的按已结束', async () => {
      const { a, b } = cluster()
      const hold = gated()
      a.scripted.setResponses([hold.step])
      const { started, out } = await startOn(a, new Y.Doc())
      if (!started.ok) throw new Error('应该启动成功')
      await until(() => a.scripted.state.callCount >= 1)

      expect(await b.runtime.abort(FLOW, started.runId, { userId: 'u2', admin: false })).toBe('forbidden')
      expect(await b.runtime.abort('flow-2', started.runId, { userId: 'u1', admin: false })).toBe('not-running')
      expect(await b.runtime.abort(FLOW, started.runId, { userId: 'u1', admin: false })).toBe('aborted')
      await started.done
      expect(out.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' } })
      expect(a.runtime.isRunning(FLOW)).toBe(false)
      // 已经结束了：再停一次是 not-running
      expect(await b.runtime.abort(FLOW, started.runId, { userId: 'u1', admin: false })).toBe('not-running')
    })

    it('项目管理员在 B 上停 A 上别人的一轮：原因记为「已被项目管理员中止」', async () => {
      const { a, b } = cluster()
      const hold = gated()
      a.scripted.setResponses([hold.step])
      const { started, out } = await startOn(a, new Y.Doc())
      if (!started.ok) throw new Error('应该启动成功')
      await until(() => a.scripted.state.callCount >= 1)
      expect(await b.runtime.abort(FLOW, started.runId, { userId: 'u9', admin: true })).toBe('aborted')
      await started.done
      const conversation = await b.runtime.getConversation(FLOW, 'u1', threadOf(out.events))
      expect(conversation?.messages[1]).toMatchObject({ role: 'assistant', error: '已被项目管理员中止' })
    })
  })

  describe('多副本：一个会话同时一轮', () => {
    it('同一个会话在 A、B 上同时发起：只有一个成功，另一个 busy；在跑时 B 上删不掉、列表里标着在跑', async () => {
      const { a, b } = cluster()
      a.scripted.setResponses([fauxAssistantMessage('第一轮')])
      const first = await startOn(a, new Y.Doc())
      if (!first.started.ok) throw new Error('应该启动成功')
      await first.started.done
      const conversationId = threadOf(first.out.events)

      const holdA = gated()
      const holdB = gated()
      a.scripted.setResponses([holdA.step])
      b.scripted.setResponses([holdB.step])
      const doc = new Y.Doc()
      const [onA, onB] = await Promise.all([
        startOn(a, doc, { conversationId, text: '从 A 续' }),
        startOn(b, doc, { conversationId, text: '从 B 续' }),
      ])
      const results = [onA.started, onB.started]
      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.filter((result) => !result.ok)).toEqual([expect.objectContaining({ ok: false, reason: 'busy' })])

      const winner = onA.started.ok ? { replica: a, started: onA.started } : { replica: b, started: onB.started as Extract<typeof onB.started, { ok: true }> }
      const other = winner.replica === a ? b : a
      expect(await other.runtime.deleteConversation(FLOW, 'u1', conversationId)).toBe('running')
      expect((await other.runtime.listConversations(FLOW, 'u1')).find((row) => row.id === conversationId)?.running).toBe(true)
      expect((await other.runtime.getConversation(FLOW, 'u1', conversationId))?.running).toBe(true)
      // 在跑的那个副本之外再发一次：仍然 busy
      expect((await startOn(other, doc, { conversationId })).started).toMatchObject({ ok: false, reason: 'busy' })

      holdA.release()
      holdB.release()
      await winner.started.done
      // 结束后槽位释放：另一个副本上能接着发
      other.scripted.setResponses([fauxAssistantMessage('又一轮')])
      const next = await startOn(other, doc, { conversationId })
      if (!next.started.ok) throw new Error('槽位释放后应该能发起')
      await next.started.done
    })
  })

  describe('多副本：持有副本崩溃', () => {
    it('A 崩溃（不再续期、收尾也写不进共享层）：一个 TTL 内 B 上的任务列表、接回、会话槽位都没了，挂着的跨副本订阅者关流', async () => {
      let crashed = false
      const frozen = (registry: RunRegistry): RunRegistry => ({
        ...registry,
        // 崩溃之后这个副本的写全都落不了地（进程没了）；读不受影响（反正它也不读了）
        putRun: (flowId, record) => (crashed ? Promise.resolve() : registry.putRun(flowId, record)),
        releaseRun: (flowId, record) => (crashed ? Promise.resolve(false) : registry.releaseRun(flowId, record)),
        claimSlot: (...args) => (crashed ? Promise.resolve(false) : registry.claimSlot(...args)),
        renewSlot: (...args) => (crashed ? Promise.resolve(false) : registry.renewSlot(...args)),
        releaseSlot: (...args) => (crashed ? Promise.resolve(false) : registry.releaseSlot(...args)),
        appendReplay: (...args) => (crashed ? Promise.resolve() : registry.appendReplay(...args)),
        keepReplay: (runId) => (crashed ? Promise.resolve() : registry.keepReplay(runId)),
        sendStop: (...args) => registry.sendStop(...args),
        onStop: (handler) => registry.onStop((command) => !crashed && handler(command)),
      })
      const { a, b } = cluster({ wrapRegistry: (name, registry) => (name === 'A' ? frozen(registry) : registry) })
      a.scripted.setResponses([fauxAssistantMessage('第一轮')])
      const first = await startOn(a, new Y.Doc())
      if (!first.started.ok) throw new Error('应该启动成功')
      await first.started.done
      const conversationId = threadOf(first.out.events)

      const hold = gated()
      a.scripted.setResponses([hold.step])
      const doc = new Y.Doc()
      const { started } = await startOn(a, doc, { conversationId })
      if (!started.ok) throw new Error('应该启动成功')
      // 第一轮已经请求过一次模型了
      await until(() => a.scripted.state.callCount >= 2)
      expect((await b.runtime.activeRuns(FLOW)).map((run) => run.runId)).toEqual([started.runId])
      const watcher = collector()
      const sub = await b.runtime.subscribe(FLOW, started.runId, watcher.emit)
      if (!sub.ok) throw new Error('崩溃之前应该接得回')

      crashed = true
      const crashedAt = Date.now()
      // 一个 TTL（+ 跟读那边一段阻塞）之内：B 看不到它了
      await until(async () => (await b.runtime.activeRuns(FLOW)).length === 0, TTL * 3)
      expect(Date.now() - crashedAt).toBeLessThan(TTL * 2)
      await sub.done
      expect(watcher.events.some((event) => event.type === AgentEventType.RUN_FINISHED || event.type === AgentEventType.RUN_ERROR)).toBe(false)
      expect(await b.runtime.subscribe(FLOW, started.runId, () => {})).toEqual({ ok: false, reason: 'not-found' })
      expect(await b.runtime.abort(FLOW, started.runId, { userId: 'u1', admin: false })).toBe('not-running')
      // 会话槽位也过期了：B 上能在这个会话里发起
      b.scripted.setResponses([fauxAssistantMessage('B 接手')])
      const takeover = await startOn(b, doc, { conversationId })
      if (!takeover.started.ok) throw new Error('槽位过期后应该能发起')
      await takeover.started.done

      // 收拾：让 A 那一轮自己跑完（它的收尾写不进共享层）
      hold.release()
      await started.done
      await sleep(10)
    })
  })

  describe('多副本：改动归属', () => {
    it('B 上的一轮认得出 A 上那一轮的发起人（「名字-u1 的 agent」），不再报成「另一个 agent」', async () => {
      const { a, b } = cluster()
      const holdB = gated(fauxAssistantMessage([fauxToolCall('update_node', { id: 'n1', data: { text: '乙写的' } })], { stopReason: 'toolUse' }))
      const seen: string[] = []
      b.scripted.setResponses([holdB.step, capture(seen, fauxAssistantMessage('乙停下'))])
      const doc = new Y.Doc()
      seedText(doc, 'n1')
      // 乙在 B 上先开始（打开画布），停在模型那里
      const onB = await startOn(b, doc, { userId: 'u2', text: '乙' })
      if (!onB.started.ok) throw new Error('应该启动成功')
      await until(() => b.scripted.state.callCount >= 1)
      // 甲在 A 上写 n1、结束
      a.scripted.setResponses([fauxAssistantMessage([fauxToolCall('update_node', { id: 'n1', data: { text: '甲写的' } })], { stopReason: 'toolUse' }), fauxAssistantMessage('甲完了')])
      const onA = await startOn(a, doc, { userId: 'u1', text: '甲' })
      if (!onA.started.ok) throw new Error('应该启动成功')
      await onA.started.done
      // 乙接着写 n1：「改过」，说是甲的 agent 改的
      holdB.release()
      await onB.started.done
      expect(seen[0]).toContain('在你读过之后被改过')
      expect(seen[0]).toContain('名字-u1 的 agent')
      expect(nodeGroupMap(nodesMap(doc).get('n1'), 'data')?.toJSON()).toMatchObject({ text: '甲写的' })
    })
  })
})
