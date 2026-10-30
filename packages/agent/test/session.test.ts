import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@mariozechner/pi-ai'
import { AgentEventType, formatNodeMention, type AgentRunEntry, type AgentStreamEvent } from '@shadecn/shared/agent'
import { nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import { createMemoryAuthorityProvider } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import {
  conversationSummary,
  conversationTitle,
  createAgentRuntime,
  trimLlmHistory,
  validatePrompt,
  type AbortActor,
  type AgentRuntimeOptions,
  type OpenedCanvas,
} from '../src/session.ts'
import { createMemoryConversationStore, createMemoryRunLog, type AgentRunLog } from '../src/store.ts'
import { gatewayFetch, registerScriptedModel, type ScriptedModel, type ScriptedStep } from '../src/testing.ts'

/**
 * 编排层走完整的二期路径：进程内驱动跑 runner（pi 在那里）→ 网关（令牌、工具 RPC、事件上报）→ 模型代理 →
 * 脚本化的 OpenAI 兼容上游（`@shadecn/agent/testing`，写法照 pi-ai 的 faux）。不碰网络，模型的每一步回复由测试脚本给定。
 * 守的是：一轮跑通（模型调工具 → 文档里出现节点 → 事件流完整）、按会话并发（一个会话一轮、不同会话同时跑、
 * 每轮的预算各算各的）、运行中任务列表与变更通知、只有发起人 / 管理员能中止、别人的会话只读、
 * 提及展开、失败与中止的收尾，以及会话 / 运行日志经注入的 store 落下去的时机与失败语义（内存实现）。
 */

let faux: ScriptedModel | null = null

afterEach(() => {
  faux = null
  vi.unstubAllGlobals()
})

function runtimeWith(responses: ScriptedStep[], overrides: Partial<AgentRuntimeOptions> = {}) {
  faux = registerScriptedModel()
  faux.setResponses(responses)
  const store = createMemoryConversationStore()
  const runLog = createMemoryRunLog()
  const authorities = createMemoryAuthorityProvider()
  /** 每次 onRunsChange 收到的（画布, 全量列表） */
  const changes: { flowId: string; runs: AgentRunEntry[] }[] = []
  const runtime = createAgentRuntime({
    ...faux.runtimeOptions(),
    store,
    runLog,
    userProfiles: profilesOf,
    onRunsChange: (flowId, runs) => changes.push({ flowId, runs }),
    authorities,
    ...overrides,
  })
  // runner 里 OpenAI SDK 用全局 fetch：发往测试网关的交给这个 runtime 的网关
  vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request)))
  return Object.assign(runtime, { store, runLog, changes, authorities })
}

/** 假的用户表：名字 = `名字-<id>`，没有头像 */
async function profilesOf(userIds: string[]) {
  return new Map(userIds.map((id) => [id, { id, name: `名字-${id}`, avatarUrl: null }]))
}

const owner = (userId: string): AbortActor => ({ userId, admin: false })
const admin = (userId: string): AbortActor => ({ userId, admin: true })

/** 一轮的 threadId（= 会话 id）：从 RUN_STARTED 里拿 */
function threadOf(events: AgentStreamEvent[]): string {
  const started = events.find((event) => event.type === AgentEventType.RUN_STARTED)
  if (!started || started.type !== AgentEventType.RUN_STARTED) throw new Error('没有 RUN_STARTED')
  return started.threadId
}

function canvasOf(doc: Y.Doc, flowId = 'flow-1') {
  let closed = 0
  const open = async (runId: string): Promise<OpenedCanvas> => ({
    ...createDocCanvasHandle(doc, { flowId, runId }),
    async close() {
      closed += 1
    },
  })
  return { open, closed: () => closed }
}

function collector() {
  const events: AgentStreamEvent[] = []
  return { events, emit: (event: AgentStreamEvent) => events.push(event), types: () => events.map((e) => e.type) }
}


/** 不调工具、只回一句话的一轮 */
async function runOnce(
  runtime: ReturnType<typeof runtimeWith>,
  text: string,
  conversationId: string | null = null,
  flowId = 'flow-1',
  userId = 'u1',
) {
  const out = collector()
  const started = runtime.start({ flowId, userId, conversationId, text, openCanvas: canvasOf(new Y.Doc(), flowId).open, emit: out.emit })
  if (!started.ok) throw new Error(`应该启动成功：${started.message}`)
  await started.done
  return out
}

describe('一轮跑通', () => {
  it('模型调 add_node → 文档里出现节点 → 事件流 TOOL_CALL_START/RESULT → RUN_FINISHED', async () => {
    const runtime = runtimeWith([
      fauxAssistantMessage([fauxText('我来加'), fauxToolCall('add_node', { type: 'text', metadata: { label: '新想法' }, data: { text: '内容' } })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('加好了'),
    ])
    const doc = new Y.Doc()
    const canvas = canvasOf(doc)
    const out = collector()

    const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '加一个节点', openCanvas: canvas.open, emit: out.emit })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(runtime.isRunning('flow-1')).toBe(true)
    await started.done

    const nodes = [...nodesMap(doc).values()]
    expect(nodes).toHaveLength(1)
    expect((nodes[0]!.get('metadata') as Y.Map<unknown>).get('label')).toBe('新想法')

    const types = out.types()
    expect(types[0]).toBe(AgentEventType.RUN_STARTED)
    expect(types[1]).toBe(AgentEventType.CUSTOM)
    expect(types).toContain(AgentEventType.TOOL_CALL_START)
    expect(types.indexOf(AgentEventType.TOOL_CALL_RESULT)).toBeGreaterThan(types.indexOf(AgentEventType.TOOL_CALL_START))
    expect(types.at(-1)).toBe(AgentEventType.RUN_FINISHED)

    const result = out.events.find((e) => e.type === AgentEventType.TOOL_CALL_RESULT)
    expect(result).toMatchObject({ metadata: { status: 'done', summary: '新建节点「新想法」' } })

    // 对话记录：用户 + assistant，assistant 的文字是两段拼起来的
    expect(runtime.isRunning('flow-1')).toBe(false)
    expect(canvas.closed()).toBe(1)
    const view = await runtime.view('flow-1', 'u1')
    expect(view).toMatchObject({ enabled: true, running: false })
    // 模型名只进运行日志，不出现在给前端的视图里
    expect(view).not.toHaveProperty('model')
    expect(view.latest?.id).toBe(threadOf(out.events))
    expect(view.latest?.messages).toHaveLength(2)
    expect(view.latest?.messages[1]).toMatchObject({ role: 'assistant', text: '我来加\n\n加好了' })
    expect(view.latest).toMatchObject({ title: '加一个节点', summary: '我来加 加好了', messageCount: 2 })
    // 别人没有会话
    expect((await runtime.view('flow-1', 'u2')).latest).toBeNull()
  })

  it('续聊同一个会话：第二轮带着上一轮的上下文；新会话不带', async () => {
    const seen: number[] = []
    const reply = (text: string): ScriptedStep => (context) => {
      seen.push(context.messages.length)
      return fauxAssistantMessage(text)
    }
    const runtime = runtimeWith([reply('第一轮'), reply('第二轮'), reply('另起')])
    const first = await runOnce(runtime, '一')
    const conversationId = threadOf(first.events)
    const second = await runOnce(runtime, '二', conversationId)
    expect(threadOf(second.events)).toBe(conversationId)
    const third = await runOnce(runtime, '三')
    expect(threadOf(third.events)).not.toBe(conversationId)

    // 用户一；用户一、助手一、用户二；新会话只有用户三
    expect(seen).toEqual([1, 3, 1])
    const conversation = await runtime.getConversation('flow-1', 'u1', conversationId)
    expect(conversation?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(conversation?.title).toBe('一')
    expect(conversation?.summary).toBe('第二轮')
    // 列表：最近更新的在前
    expect((await runtime.listConversations('flow-1', 'u1')).map((c) => c.id)).toEqual([
      threadOf(third.events),
      conversationId,
    ])
  })
})

describe('提及展开', () => {
  it('提及的节点附上名字和内容；不存在的照样告诉模型', async () => {
    let prompt = ''
    const runtime = runtimeWith([
      (context) => {
        const last = context.messages.at(-1)
        prompt = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content)
        return fauxAssistantMessage('好')
      },
    ])
    const doc = new Y.Doc()
    nodesMap(doc).set('n_a', toYNode({ ...buildNodeRecord({ id: 'n_a', type: 'text', label: '需求', position: { x: 0, y: 0 } }), data: { text: '正文内容' } }))
    const canvas = canvasOf(doc)
    const text = `改一下 ${formatNodeMention('n_a')} 和 ${formatNodeMention('n_gone')}`
    const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text, openCanvas: canvas.open, emit: () => {} })
    if (started.ok) await started.done

    expect(prompt).toContain('「需求」')
    expect(prompt).toContain('正文内容')
    expect(prompt).toContain(`${formatNodeMention('n_gone')}：这个节点已经不存在了`)
    // 对话记录里存的是用户原文，不是展开后的那份；标题也是原文
    const latest = (await runtime.view('flow-1', 'u1')).latest
    expect(latest?.messages[0]).toMatchObject({ role: 'user', text })
    expect(latest?.title).toBe(text)
  })
})

function gated() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const step: ScriptedStep = (_context, options) =>
    new Promise((resolve) => {
      options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
      void gate.then(() => resolve(fauxAssistantMessage('完成')))
    })
  return { step, release }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('按会话并发与中止', () => {
  it('同一个会话第二次发起 → busy；同一张画布上别的会话、别人的新会话照常同时跑', async () => {
    const first = gated()
    const runtime = runtimeWith([fauxAssistantMessage('旧的'), first.step, fauxAssistantMessage('乙的'), fauxAssistantMessage('另一张')])
    const conversationId = threadOf((await runOnce(runtime, '旧话题')).events)
    const canvas = canvasOf(new Y.Doc())

    const one = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId, text: '续一句', openCanvas: canvas.open, emit: () => {} })
    expect(one.ok).toBe(true)
    // 同一个会话：同步拒绝（中间没有 await 可插队）
    const again = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId, text: '再续', openCanvas: canvas.open, emit: () => {} })
    expect(again).toMatchObject({ ok: false, reason: 'busy' })
    expect(again.ok === false && again.message).toContain('这个会话')
    await settle()

    // 别人在同一张画布上开新会话：不排队，跑完
    const theirs = await runOnce(runtime, '乙的话题', null, 'flow-1', 'u2')
    expect(theirs.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    // 别的画布同样不受影响
    const other = await runOnce(runtime, '另一张', null, 'flow-2', 'u1')
    expect(other.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED })
    expect(runtime.isRunning('flow-1')).toBe(true)

    first.release()
    if (one.ok) await one.done
    expect(runtime.isRunning('flow-1')).toBe(false)
    // 结束之后同一个会话又能发起了
    const after = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId, text: '又来', openCanvas: canvas.open, emit: () => {} })
    expect(after.ok).toBe(true)
    if (after.ok) await after.done
  })

  it('两个会话真的同时在跑：各自的事件流、各自落库，任务列表两项都在', async () => {
    const a = gated()
    const b = gated()
    const runtime = runtimeWith([a.step, b.step])
    const doc = new Y.Doc()
    const outA = collector()
    const outB = collector()
    const runA = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '甲的事', openCanvas: canvasOf(doc).open, emit: outA.emit })
    await settle()
    const runB = runtime.start({ flowId: 'flow-1', userId: 'u2', conversationId: null, text: '乙的事', openCanvas: canvasOf(doc).open, emit: outB.emit })
    await settle()
    if (!runA.ok || !runB.ok) throw new Error('两轮都应该启动成功')

    expect(runtime.activeRuns('flow-1')).toEqual([
      { runId: runA.runId, conversationId: threadOf(outA.events), conversationTitle: '甲的事', owner: { id: 'u1', name: '名字-u1', avatarUrl: null }, startedAt: expect.any(Number), occupies: [], expiresAt: expect.any(Number) },
      { runId: runB.runId, conversationId: threadOf(outB.events), conversationTitle: '乙的事', owner: { id: 'u2', name: '名字-u2', avatarUrl: null }, startedAt: expect.any(Number), occupies: [], expiresAt: expect.any(Number) },
    ])
    expect(runtime.activeRuns('flow-2')).toEqual([])

    // 先放行后发起的那一轮：先结束的先离开列表，另一轮不受影响
    b.release()
    await runB.done
    expect(runtime.activeRuns('flow-1').map((run) => run.runId)).toEqual([runA.runId])
    a.release()
    await runA.done
    expect(runtime.activeRuns('flow-1')).toEqual([])

    for (const out of [outA, outB]) {
      expect(out.events.filter((event) => event.type === AgentEventType.RUN_STARTED)).toHaveLength(1)
      expect(out.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    }
    expect(threadOf(outA.events)).not.toBe(threadOf(outB.events))
    expect(runtime.store.rows.get(threadOf(outA.events))?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(runtime.store.rows.get(threadOf(outB.events))?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('带入口 nodeId 的会话，那一轮在任务列表里带 nodeId（新建时记下的、续聊时从会话里读的），没有入口的不带', async () => {
    const a = gated()
    const b = gated()
    const runtime = runtimeWith([a.step, fauxAssistantMessage('普通'), b.step])
    const doc = new Y.Doc()
    const bound = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, nodeId: 'n_dir', text: '搭场景', openCanvas: canvasOf(doc).open, emit: () => {} })
    await settle()
    if (!bound.ok) throw new Error('应该启动成功')
    const plain = await runOnce(runtime, '普通的事', null, 'flow-1', 'u2')
    const plainRunId = (plain.events[0] as { runId: string }).runId

    expect(runtime.activeRuns('flow-1')).toEqual([
      expect.objectContaining({ runId: bound.runId, nodeId: 'n_dir' }),
    ])
    // 广播（onRunsChange）里同样带着 —— 前端靠它判断「有人的助手在编辑这个导演台」
    const withPlain = runtime.changes.find(({ runs }) => runs.some((run) => run.runId === plainRunId))
    expect(withPlain?.runs.find((run) => run.runId === plainRunId)).not.toHaveProperty('nodeId')
    expect(withPlain?.runs.find((run) => run.runId === bound.runId)?.nodeId).toBe('n_dir')
    a.release()
    await bound.done

    // 续聊：请求里不带 nodeId，入口从会话里来
    const conversationId = runtime.changes.find(({ runs }) => runs.some((run) => run.runId === bound.runId))!.runs.find(
      (run) => run.runId === bound.runId,
    )!.conversationId
    const again = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId, text: '再调一下', openCanvas: canvasOf(doc).open, emit: () => {} })
    await settle()
    if (!again.ok) throw new Error('续聊应该启动成功')
    expect(runtime.activeRuns('flow-1')).toEqual([expect.objectContaining({ runId: again.runId, nodeId: 'n_dir' })])
    b.release()
    await again.done
  })

  it('onRunsChange：进列表（RUN_STARTED 之后）和离开列表各一次，给的是那张画布的全量列表', async () => {
    const a = gated()
    const runtime = runtimeWith([a.step, fauxAssistantMessage('快的')])
    const runA = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '慢的', openCanvas: canvasOf(new Y.Doc()).open, emit: () => {} })
    await settle()
    if (!runA.ok) throw new Error('应该启动成功')
    const fast = await runOnce(runtime, '快的', null, 'flow-1', 'u2')
    const fastRunId = (fast.events[0] as { runId: string }).runId
    a.release()
    await runA.done

    expect(runtime.changes.map(({ flowId, runs }) => [flowId, runs.map((run) => run.runId)])).toEqual([
      ['flow-1', [runA.runId]],
      ['flow-1', [runA.runId, fastRunId]],
      ['flow-1', [runA.runId]],
      ['flow-1', []],
    ])
    // 广播里没有 mine：那是每个客户端自己算的
    expect(runtime.changes[0]!.runs[0]).not.toHaveProperty('mine')
  })

  it('准备会话就失败的一轮从没进过列表，也不通知；onRunsChange 抛错不影响这一轮', async () => {
    const runtime = runtimeWith([fauxAssistantMessage('好')], {
      onRunsChange: () => {
        throw new Error('广播挂了')
      },
    })
    const gone = collector()
    const failed = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: 'conv_nope', text: '续', openCanvas: canvasOf(new Y.Doc()).open, emit: gone.emit })
    if (failed.ok) await failed.done
    expect(gone.events).toEqual([expect.objectContaining({ code: 'conversation_not_found' })])
    expect(runtime.changes).toEqual([])

    const out = await runOnce(runtime, '照跑')
    expect(out.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
  })

  it('每轮删除上限按各自那一轮计：两轮同时各删满上限，互不挤占', async () => {
    const doc = new Y.Doc()
    const ids = (prefix: string) => Array.from({ length: 20 }, (_, index) => `${prefix}${index}`)
    for (const id of [...ids('a'), ...ids('b')]) {
      nodesMap(doc).set(id, toYNode(buildNodeRecord({ id, type: 'text', label: id, position: { x: 0, y: 0 } })))
    }
    const hold = gated()
    /** 按这一轮的用户消息分派：两轮共用一个 faux 队列，谁先请求模型不确定 */
    const step: ScriptedStep = (context, options, state) => {
      const prompt = JSON.stringify(context.messages.find((message) => message.role === 'user')?.content ?? '')
      const toolDone = context.messages.some((message) => message.role === 'toolResult')
      const prefix = prompt.includes('删甲') ? 'a' : 'b'
      if (!toolDone) return fauxAssistantMessage([fauxToolCall('delete_elements', { ids: ids(prefix) })], { stopReason: 'toolUse' })
      // 甲删完之后卡住，保证乙删的时候甲那一轮还活着
      return prefix === 'a' ? (hold.step as Exclude<ScriptedStep, { role: string }>)(context, options, state) : fauxAssistantMessage('乙删完了')
    }
    const runtime = runtimeWith([step, step, step, step])
    const outA = collector()
    const runA = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '删甲', openCanvas: canvasOf(doc).open, emit: outA.emit })
    if (!runA.ok) throw new Error('应该启动成功')
    for (let i = 0; i < 50 && !outA.events.some((event) => event.type === AgentEventType.TOOL_CALL_RESULT); i += 1) await settle()

    const outB = collector()
    const runB = runtime.start({ flowId: 'flow-1', userId: 'u2', conversationId: null, text: '删乙', openCanvas: canvasOf(doc).open, emit: outB.emit })
    if (!runB.ok) throw new Error('应该启动成功')
    await runB.done
    // 乙删完收尾时甲那一轮还活着：两轮确实同时在跑
    expect(runtime.activeRuns('flow-1').map((run) => run.runId)).toEqual([runA.runId])
    hold.release()
    await runA.done

    for (const out of [outA, outB]) {
      expect(out.events.find((event) => event.type === AgentEventType.TOOL_CALL_RESULT)).toMatchObject({ metadata: { status: 'done' } })
    }
    expect(nodesMap(doc).size).toBe(0)
    expect(runtime.runLog.toolCalls.map((call) => [call.name, call.ok])).toEqual([
      ['delete_elements', true],
      ['delete_elements', true],
    ])
  })

  it('只有发起人（或管理员）能中止；中止后 RUN_FINISHED outcome=cancelled 且照样落库；正在跑的会话删不掉', async () => {
    const { step } = gated()
    const runtime = runtimeWith([step])
    const out = collector()
    const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '一', openCanvas: canvasOf(new Y.Doc()).open, emit: out.emit })
    if (!started.ok) throw new Error('应该启动成功')

    // 等模型请求真的发出去
    await settle()
    const conversationId = threadOf(out.events)
    // 用户消息在调模型之前就已经落库了
    expect(runtime.store.rows.get(conversationId)?.messages.map((m) => m.role)).toEqual(['user'])
    expect((await runtime.listConversations('flow-1', 'u1'))[0]).toMatchObject({ id: conversationId, running: true })
    expect(await runtime.deleteConversation('flow-1', 'u1', conversationId)).toBe('running')
    expect(runtime.abort('flow-1', started.runId, owner('u2'))).toBe('forbidden')
    // runId 对、画布不对：当它不在跑
    expect(runtime.abort('flow-2', started.runId, owner('u1'))).toBe('not-running')
    expect(runtime.abort('flow-1', started.runId, owner('u1'))).toBe('aborted')
    await started.done

    const finished = out.events.at(-1)
    expect(finished).toMatchObject({ type: AgentEventType.RUN_FINISHED, threadId: conversationId, outcome: { type: 'cancelled' } })
    const conversation = await runtime.getConversation('flow-1', 'u1', conversationId)
    expect(conversation?.messages[1]).toMatchObject({ role: 'assistant', error: '已中止' })
    expect(conversation?.running).toBe(false)
    expect(runtime.runLog.runs.get(started.runId)).toMatchObject({ status: 'cancelled', error: '已中止' })
    expect(runtime.abort('flow-1', started.runId, owner('u1'))).toBe('not-running')

    // 结束之后：别人删不得（会话只读可见，所以是 forbidden 而不是当它不存在）、自己删得掉，删完就没了
    expect(await runtime.deleteConversation('flow-1', 'u2', conversationId)).toBe('forbidden')
    expect(await runtime.deleteConversation('flow-1', 'u1', conversationId)).toBe('deleted')
    expect(await runtime.getConversation('flow-1', 'u1', conversationId)).toBeNull()
    expect(await runtime.deleteConversation('flow-1', 'u1', conversationId)).toBe('not-found')
  })

  it('发起者退订（客户端断开）不中止这一轮：照常跑完、照常落库', async () => {
    const { step, release } = gated()
    const runtime = runtimeWith([step])
    const out = collector()
    const started = runtime.start({
      flowId: 'flow-1',
      userId: 'u1',
      conversationId: null,
      text: '一',
      openCanvas: canvasOf(new Y.Doc()).open,
      emit: out.emit,
    })
    if (!started.ok) throw new Error('应该启动成功')
    await settle()
    const conversationId = threadOf(out.events)
    const seenBeforeLeaving = out.events.length

    started.unsubscribe()
    await settle()
    expect(runtime.isRunning('flow-1')).toBe(true)

    release()
    await started.done
    // 退订之后一帧都没再收到，可这一轮是成功跑完的
    expect(out.events).toHaveLength(seenBeforeLeaving)
    expect(runtime.runLog.runs.get(started.runId)).toMatchObject({ status: 'success', error: null })
    const conversation = await runtime.getConversation('flow-1', 'u1', conversationId)
    expect(conversation?.messages[1]).toMatchObject({ role: 'assistant', text: '完成' })
    expect(conversation?.messages[1]).not.toHaveProperty('error')
  })

  it('abortAll 等在跑的轮次收尾：返回时对话已经落库', async () => {
    const { step } = gated()
    const runtime = runtimeWith([step])
    const out = collector()
    const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '一', openCanvas: canvasOf(new Y.Doc()).open, emit: out.emit })
    if (!started.ok) throw new Error('应该启动成功')
    await settle()

    await runtime.abortAll('服务正在重启')
    expect(runtime.isRunning('flow-1')).toBe(false)
    const conversation = await runtime.getConversation('flow-1', 'u1', threadOf(out.events))
    expect(conversation?.messages[1]).toMatchObject({ role: 'assistant', error: '服务正在重启' })
    expect(runtime.runLog.runs.get(started.runId)).toMatchObject({ status: 'cancelled', error: '服务正在重启' })
  })
})

/**
 * 两步的一轮：第一步说一段长话（faux 按 12–20 字切成多帧 TEXT_MESSAGE_CONTENT）再调工具，
 * 第二步卡在门口等测试放行，放行后再说一段长话。`reached` 在第二步开始时兑现 —— 那就是「运行中途」。
 */
function pausedMidRun() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let reach!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const steps: ScriptedStep[] = [
    fauxAssistantMessage([fauxText('先说一段比较长的话，'.repeat(6)), fauxToolCall('add_node', { type: 'text', metadata: { label: '中途' } })], {
      stopReason: 'toolUse',
    }),
    (_context, options) =>
      new Promise((resolve) => {
        reach()
        options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
        void gate.then(() => resolve(fauxAssistantMessage('放行之后又说了一段很长很长的话。'.repeat(6))))
      }),
  ]
  return { steps, release, reached }
}

describe('接回一轮', () => {
  it('运行中途接回：先补发、再实时推，序列与发起者逐帧相同（含 TEXT_MESSAGE_CONTENT），没有重复', async () => {
    const paused = pausedMidRun()
    const runtime = runtimeWith(paused.steps)
    const origin = collector()
    const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '一', openCanvas: canvasOf(new Y.Doc()).open, emit: origin.emit })
    if (!started.ok) throw new Error('应该启动成功')
    await paused.reached

    const rejoined = collector()
    const sub = runtime.subscribe('flow-1', started.runId, rejoined.emit)
    if (!sub.ok) throw new Error('应该接得回')
    // 补发是同步的：返回时已经追平了发起者
    expect(rejoined.events).toEqual(origin.events)

    paused.release()
    await sub.done
    await started.done

    expect(rejoined.events).toEqual(origin.events)
    const types = rejoined.types()
    expect(types.filter((type) => type === AgentEventType.TEXT_MESSAGE_CONTENT).length).toBeGreaterThan(4)
    expect(types.filter((type) => type === AgentEventType.RUN_STARTED)).toHaveLength(1)
    expect(types.at(-1)).toBe(AgentEventType.RUN_FINISHED)
  })

  it('只认这张画布在跑的那一轮：runId 不对 / 别的画布 / 已结束 → not-found（谁能看由宿主判，编排层不再只认发起人）', async () => {
    const { step, release } = gated()
    const runtime = runtimeWith([step])
    const origin = collector()
    const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '一', openCanvas: canvasOf(new Y.Doc()).open, emit: origin.emit })
    if (!started.ok) throw new Error('应该启动成功')
    await settle()

    // 旁观者（宿主已判过他能进这张画布）接得回，收到的和发起者一样
    const watcher = collector()
    expect(runtime.subscribe('flow-1', started.runId, watcher.emit)).toMatchObject({ ok: true })
    expect(watcher.events).toEqual(origin.events)
    expect(runtime.subscribe('flow-1', 'run_nope', () => {})).toEqual({ ok: false, reason: 'not-found' })
    expect(runtime.subscribe('flow-2', started.runId, () => {})).toEqual({ ok: false, reason: 'not-found' })

    release()
    await started.done
    expect(watcher.events).toEqual(origin.events)
    expect(runtime.subscribe('flow-1', started.runId, () => {})).toEqual({ ok: false, reason: 'not-found' })
  })

  it('补发缓冲溢出 → 之后接回得到 overflowed；已经挂着的订阅者照常收完', async () => {
    const paused = pausedMidRun()
    const runtime = runtimeWith(paused.steps, { limits: { replayEvents: 3 } })
    const origin = collector()
    const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '一', openCanvas: canvasOf(new Y.Doc()).open, emit: origin.emit })
    if (!started.ok) throw new Error('应该启动成功')
    await paused.reached

    expect(runtime.subscribe('flow-1', started.runId, () => {})).toEqual({ ok: false, reason: 'overflowed' })

    paused.release()
    await started.done
    expect(origin.types()[0]).toBe(AgentEventType.RUN_STARTED)
    expect(origin.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
  })

  it('中止后接回的流以 RUN_FINISHED cancelled 收尾', async () => {
    const { step } = gated()
    const runtime = runtimeWith([step])
    const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '一', openCanvas: canvasOf(new Y.Doc()).open, emit: () => {} })
    if (!started.ok) throw new Error('应该启动成功')
    await settle()

    const rejoined = collector()
    const sub = runtime.subscribe('flow-1', started.runId, rejoined.emit)
    if (!sub.ok) throw new Error('应该接得回')
    expect(runtime.abort('flow-1', started.runId, owner('u1'))).toBe('aborted')
    await sub.done
    expect(rejoined.types()[0]).toBe(AgentEventType.RUN_STARTED)
    expect(rejoined.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' } })
    await started.done
  })

  it('view：activeRuns 列出所有人的、mine 按请求者算；latest 是我在跑的那个会话', async () => {
    const mineGate = gated()
    const theirGate = gated()
    const runtime = runtimeWith([fauxAssistantMessage('旧的'), mineGate.step, theirGate.step])
    // 旧会话的 updatedAt 被拨到「在跑的那个」之后：latest 要选在跑的，而不是最近更新的
    const old = threadOf((await runOnce(runtime, '旧话题')).events)
    const out = collector()
    const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '新话题', openCanvas: canvasOf(new Y.Doc()).open, emit: out.emit })
    if (!started.ok) throw new Error('应该启动成功')
    await settle()
    const theirOut = collector()
    const theirs = runtime.start({ flowId: 'flow-1', userId: 'u2', conversationId: null, text: '乙的话题', openCanvas: canvasOf(new Y.Doc()).open, emit: theirOut.emit })
    if (!theirs.ok) throw new Error('应该启动成功')
    await settle()
    const running = threadOf(out.events)
    runtime.store.rows.get(old)!.updatedAt = Date.now() + 60_000

    const mine = await runtime.view('flow-1', 'u1')
    expect(mine.running).toBe(true)
    expect(mine.activeRuns).toEqual([
      {
        runId: started.runId,
        conversationId: running,
        conversationTitle: '新话题',
        owner: { id: 'u1', name: '名字-u1', avatarUrl: null },
        mine: true,
        startedAt: expect.any(Number),
        occupies: [],
        expiresAt: expect.any(Number),
      },
      {
        runId: theirs.runId,
        conversationId: threadOf(theirOut.events),
        conversationTitle: '乙的话题',
        owner: { id: 'u2', name: '名字-u2', avatarUrl: null },
        mine: false,
        startedAt: expect.any(Number),
        occupies: [],
        expiresAt: expect.any(Number),
      },
    ])
    expect(mine.latest).toMatchObject({ id: running, running: true, mine: true, owner: { id: 'u1' } })

    // 另一个人看到同一份列表（会话 id 也看得到 —— 项目画布上会话只读可见），mine 反过来；
    // latest 只挑他自己的：他自己那一轮所在的会话
    const theirView = await runtime.view('flow-1', 'u2')
    expect(theirView.activeRuns.map((run) => [run.runId, run.conversationId, run.mine])).toEqual([
      [started.runId, running, false],
      [theirs.runId, threadOf(theirOut.events), true],
    ])
    expect(theirView.latest).toMatchObject({ id: threadOf(theirOut.events), mine: true })
    // 第三个人：没有自己的会话
    expect((await runtime.view('flow-1', 'u3')).latest).toBeNull()

    mineGate.release()
    theirGate.release()
    await started.done
    await theirs.done
    const after = await runtime.view('flow-1', 'u1')
    expect(after).toMatchObject({ running: false, activeRuns: [] })
    expect(after.latest?.id).toBe(old)
  })

  it('别人的会话只读可见：列表里有、读得到（mine=false 带发起人），删不得', async () => {
    const runtime = runtimeWith([fauxAssistantMessage('甲的'), fauxAssistantMessage('乙的'), fauxAssistantMessage('别处')])
    const a = threadOf((await runOnce(runtime, '甲的会话')).events)
    const b = threadOf((await runOnce(runtime, '乙的会话', null, 'flow-1', 'u2')).events)
    // 别的画布上的会话不出现
    await runOnce(runtime, '别处', null, 'flow-2', 'u1')

    const list = await runtime.listConversations('flow-1', 'u2')
    expect(list.map((row) => [row.id, row.mine, row.owner.name])).toEqual([
      [b, true, '名字-u2'],
      [a, false, '名字-u1'],
    ])
    expect(await runtime.getConversation('flow-1', 'u2', a)).toMatchObject({
      id: a,
      mine: false,
      owner: { id: 'u1', name: '名字-u1', avatarUrl: null },
      messages: [expect.objectContaining({ role: 'user', text: '甲的会话' }), expect.objectContaining({ role: 'assistant' })],
    })
    expect(await runtime.getConversation('flow-2', 'u1', a)).toBeNull()
    expect(await runtime.deleteConversation('flow-1', 'u2', a)).toBe('forbidden')
    expect(await runtime.deleteConversation('flow-2', 'u1', a)).toBe('not-found')
    expect(runtime.store.rows.has(a)).toBe(true)
  })

  it('项目管理员能中止别人的一轮；理由写明是管理员中止的', async () => {
    const { step } = gated()
    const runtime = runtimeWith([step])
    const out = collector()
    const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '一', openCanvas: canvasOf(new Y.Doc()).open, emit: out.emit })
    if (!started.ok) throw new Error('应该启动成功')
    await settle()

    expect(runtime.abort('flow-1', started.runId, admin('u9'))).toBe('aborted')
    await started.done
    expect(out.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' } })
    expect(runtime.runLog.runs.get(started.runId)).toMatchObject({ status: 'cancelled', error: '已被项目管理员中止' })
  })

  it('用户信息查不到 / 查询抛错：兜底成「匿名用户」，不影响列表和这一轮', async () => {
    const runtime = runtimeWith([fauxAssistantMessage('好')], {
      userProfiles: async () => {
        throw new Error('用户表挂了')
      },
    })
    const out = await runOnce(runtime, '一')
    expect(out.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED })
    expect(runtime.changes[0]!.runs[0]!.owner).toEqual({ id: 'u1', name: '匿名用户', avatarUrl: null })
    expect((await runtime.listConversations('flow-1', 'u1'))[0]!.owner).toEqual({ id: 'u1', name: '匿名用户', avatarUrl: null })
  })
})

describe('失败的收尾', () => {
  it('打开画布失败（失权）→ RUN_ERROR，槽位释放', async () => {
    const runtime = runtimeWith([fauxAssistantMessage('不该走到这')])
    const out = collector()
    const started = runtime.start({
      flowId: 'flow-1',
      userId: 'u1',
      conversationId: null,
      text: '一',
      openCanvas: async () => {
        throw new Error('你已无权访问这张画布')
      },
      emit: out.emit,
    })
    if (started.ok) await started.done
    expect(out.types()).toEqual([AgentEventType.RUN_STARTED, AgentEventType.CUSTOM, AgentEventType.RUN_ERROR])
    expect(out.events.at(-1)).toMatchObject({ message: '你已无权访问这张画布' })
    expect(runtime.isRunning('flow-1')).toBe(false)
    // 失败的一轮也落进会话
    const latest = (await runtime.view('flow-1', 'u1')).latest
    expect(latest?.messages[1]).toMatchObject({ role: 'assistant', error: '你已无权访问这张画布' })
    expect(latest?.summary).toBe('你已无权访问这张画布')
  })

  it('模型报错 → RUN_ERROR', async () => {
    const runtime = runtimeWith([fauxAssistantMessage([], { stopReason: 'error', errorMessage: '额度用完' })])
    const out = await runOnce(runtime, '一')
    // 上游的报错经 runner 里真实的 OpenAI SDK 传回来：SDK 在原因前面加上 HTTP 状态码
    expect(out.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_ERROR, message: '400 额度用完', code: 'model_error' })
  })

  it('未启用：start 拒绝，view 说 enabled=false', async () => {
    const runtime = createAgentRuntime({
      ...registerScriptedModel().runtimeOptions(),
      model: null,
      disabledReason: '没有 key',
      store: createMemoryConversationStore(),
      runLog: createMemoryRunLog(),
      userProfiles: profilesOf,
      authorities: createMemoryAuthorityProvider(),
    })
    expect(await runtime.view('f', 'u')).toEqual({
      enabled: false,
      running: false,
      activeRuns: [],
      now: expect.any(Number),
      latest: null,
    })
    expect(runtime.start({ flowId: 'f', userId: 'u', conversationId: null, text: 'x', openCanvas: async () => { throw new Error() }, emit: () => {} }))
      .toMatchObject({ ok: false, reason: 'disabled', message: '没有 key' })
  })

  it('模型的线协议网关代理不了 → 未启用，原因写明（而不是每一轮都失败）', async () => {
    const scripted = registerScriptedModel()
    const options = scripted.runtimeOptions()
    const runtime = createAgentRuntime({
      ...options,
      model: { ...scripted.model, model: { ...scripted.model.model, api: 'bedrock-converse-stream' } },
      store: createMemoryConversationStore(),
      runLog: createMemoryRunLog(),
      userProfiles: profilesOf,
      authorities: createMemoryAuthorityProvider(),
    })
    expect(runtime.enabled).toBe(false)
    expect(runtime.disabledReason).toContain('bedrock-converse-stream')
  })

  it('给的会话不存在 / 不是自己的 → 只有一帧 RUN_ERROR，不调模型、不开画布', async () => {
    let called = 0
    const runtime = runtimeWith([
      () => {
        called += 1
        return fauxAssistantMessage('好')
      },
    ])
    const mine = threadOf((await runOnce(runtime, '一')).events)
    called = 0

    const canvas = canvasOf(new Y.Doc())
    for (const [userId, conversationId] of [
      ['u2', mine],
      ['u1', 'conv_nope'],
    ] as const) {
      const out = collector()
      const started = runtime.start({ flowId: 'flow-1', userId, conversationId, text: '续', openCanvas: canvas.open, emit: out.emit })
      if (started.ok) await started.done
      expect(out.events).toEqual([expect.objectContaining({ type: AgentEventType.RUN_ERROR, code: 'conversation_not_found' })])
    }
    expect(called).toBe(0)
    expect(canvas.closed()).toBe(0)
    // 别人的会话没被动过
    expect(runtime.store.rows.get(mine)?.messages).toHaveLength(2)
  })
})

describe('持久化的失败语义', () => {
  it('结尾那次 save 失败 → 这一轮以 RUN_ERROR（persist_failed）收尾，画布上的改动保留', async () => {
    // 新会话开头走的是 create，所以第一次 save 就是结尾那次
    const failing = {
      ...createMemoryConversationStore(),
      save: async (): Promise<boolean> => {
        throw new Error('磁盘满了')
      },
    }
    const runtime = runtimeWith(
      [
        fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: '留下' } })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('好了'),
      ],
      { store: failing },
    )
    const doc = new Y.Doc()
    const out = collector()
    const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '加', openCanvas: canvasOf(doc).open, emit: out.emit })
    if (started.ok) await started.done

    const last = out.events.at(-1)
    expect(last).toMatchObject({ type: AgentEventType.RUN_ERROR, code: 'persist_failed' })
    expect(last?.type === AgentEventType.RUN_ERROR && last.message).toContain('刷新后会丢失')
    expect(out.types()).not.toContain(AgentEventType.RUN_FINISHED)
    expect(nodesMap(doc).size).toBe(1)
    expect(runtime.runLog.runs.get(started.ok ? started.runId : '')).toMatchObject({ status: 'error' })
  })

  it('开头建会话失败 → 只有一帧 RUN_ERROR，模型不调', async () => {
    let called = 0
    const store = createMemoryConversationStore()
    const runtime = runtimeWith(
      [
        () => {
          called += 1
          return fauxAssistantMessage('好')
        },
      ],
      {
        store: {
          ...store,
          create: async () => {
            throw new Error('库连不上')
          },
        },
      },
    )
    const out = await runOnce(runtime, '一')
    expect(out.events).toEqual([expect.objectContaining({ type: AgentEventType.RUN_ERROR, code: 'persist_failed' })])
    expect(called).toBe(0)
    expect(runtime.isRunning('flow-1')).toBe(false)
  })

  it('运行日志写失败不影响这一轮（fail open）', async () => {
    const broken: AgentRunLog = {
      startRun: async () => {
        throw new Error('日志库挂了')
      },
      recordToolCall: async () => {
        throw new Error('日志库挂了')
      },
      finishRun: () => {
        throw new Error('同步抛出也一样')
      },
    }
    const runtime = runtimeWith(
      [
        fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: 'x' } })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('好了'),
      ],
      { runLog: broken },
    )
    const out = await runOnce(runtime, '加')
    expect(out.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    expect((await runtime.view('flow-1', 'u1')).latest?.messageCount).toBe(2)
  })

  it('工具调用日志一次一行：参数只有摘要，不含正文；失败的带原因', async () => {
    const runtime = runtimeWith([
      fauxAssistantMessage(
        [
          fauxToolCall('add_node', { type: 'text', metadata: { label: '机密标题' }, data: { text: '机密正文内容' } }),
          fauxToolCall('update_node', { id: 'n_missing', metadata: { label: '另一个机密' } }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('好了'),
    ])
    const out = await runOnce(runtime, '加')
    const runId = (out.events[0] as { runId: string }).runId

    const calls = runtime.runLog.toolCalls
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ runId, name: 'add_node', ok: true, error: null })
    expect(calls[0]!.args).toBe('type=text metadata{label} data{text}')
    expect(calls[0]!.elementIds).toHaveLength(1)
    expect(calls[1]).toMatchObject({ runId, name: 'update_node', ok: false, elementIds: [] })
    expect(calls[1]!.error).toContain('n_missing')
    expect(JSON.stringify(calls)).not.toMatch(/机密/)

    expect(runtime.runLog.runs.get(runId)).toMatchObject({
      status: 'success',
      toolCallCount: 2,
      model: 'Faux',
      flowId: 'flow-1',
      userId: 'u1',
      conversationId: threadOf(out.events),
    })
  })
})

describe('输入与历史', () => {
  it('validatePrompt：去空白后为空、超长、类型不对都拒；conversationId 缺省 / null = 新会话', () => {
    expect(validatePrompt({ text: '  好  ' })).toEqual({ ok: true, text: '好', conversationId: null, nodeId: null })
    expect(validatePrompt({ text: '好', conversationId: null })).toEqual({ ok: true, text: '好', conversationId: null, nodeId: null })
    expect(validatePrompt({ text: '好', conversationId: 'c1' })).toEqual({ ok: true, text: '好', conversationId: 'c1', nodeId: null })
    expect(validatePrompt({ text: '   ' }).ok).toBe(false)
    expect(validatePrompt({ text: 'x'.repeat(5000) }).ok).toBe(false)
    expect(validatePrompt({}).ok).toBe(false)
    expect(validatePrompt(null).ok).toBe(false)
    expect(validatePrompt({ text: '好', conversationId: 1 }).ok).toBe(false)
    expect(validatePrompt({ text: '好', conversationId: '' }).ok).toBe(false)
    expect(validatePrompt({ text: '好', conversationId: 'c'.repeat(200) }).ok).toBe(false)
  })

  it('validatePrompt：nodeId 只在新建会话时给；格式不对、续聊时给都拒', () => {
    expect(validatePrompt({ text: '好', nodeId: 'n_a' })).toEqual({ ok: true, text: '好', conversationId: null, nodeId: 'n_a' })
    expect(validatePrompt({ text: '好', nodeId: null })).toMatchObject({ ok: true, nodeId: null })
    expect(validatePrompt({ text: '好', nodeId: 'a b' }).ok).toBe(false)
    expect(validatePrompt({ text: '好', nodeId: 3 }).ok).toBe(false)
    expect(validatePrompt({ text: '好', conversationId: 'c1', nodeId: 'n_a' })).toMatchObject({ ok: false })
  })

  it('标题：空白折成一个空格、超长截断带省略号、不切开半个提及', () => {
    expect(conversationTitle('  第一行\n\n第二行  ')).toBe('第一行 第二行')
    const long = conversationTitle('字'.repeat(100))
    expect(Array.from(long)).toHaveLength(60)
    expect(long.endsWith('…')).toBe(true)
    // 第 59 个字落在提及中间：整个提及丢掉，不留半截
    const text = `${'字'.repeat(50)}${formatNodeMention('n_abcdefghijk')}后面`
    expect(conversationTitle(text)).toBe(`${'字'.repeat(50)}…`)
  })

  it('摘要：最近一条 assistant 的纯文本开头；只调了工具时用工具那句话；没有 assistant 时为空', () => {
    const user = { id: 'u', role: 'user' as const, text: 'hi', createdAt: 0 }
    const assistant = (text: string, toolCalls: { summary: string }[] = []) => ({
      id: 'a',
      role: 'assistant' as const,
      text,
      toolCalls: toolCalls.map((call, index) => ({ id: `t${index}`, name: 'add_node', status: 'done' as const, ...call })),
      createdAt: 0,
    })
    expect(conversationSummary([user])).toBe('')
    expect(conversationSummary([user, assistant('## 标题\n\n**加粗** 和 `代码`，见 [链接](http://x)')])).toBe(
      '标题 加粗 和 代码，见 链接',
    )
    expect(conversationSummary([user, assistant('旧的'), user, assistant('', [{ summary: '新建节点「a」' }])])).toBe(
      '新建节点「a」',
    )
    expect(Array.from(conversationSummary([user, assistant('长'.repeat(500))]))).toHaveLength(120)
  })

  it('裁剪模型上下文时切口落在用户消息上', () => {
    const msgs = [
      { role: 'user' },
      { role: 'assistant' },
      { role: 'toolResult' },
      { role: 'user' },
      { role: 'assistant' },
    ] as never[]
    expect(trimLlmHistory(msgs, 3)).toEqual([{ role: 'user' }, { role: 'assistant' }])
    expect(trimLlmHistory(msgs, 10)).toBe(msgs)
  })

  it('对话记录与模型上下文在保存时按上限裁剪', async () => {
    const runtime = runtimeWith(
      [fauxAssistantMessage('1'), fauxAssistantMessage('2'), fauxAssistantMessage('3')],
      { limits: { chatMessages: 3, llmMessages: 2 } },
    )
    const id = threadOf((await runOnce(runtime, '一')).events)
    await runOnce(runtime, '二', id)
    await runOnce(runtime, '三', id)
    const row = runtime.store.rows.get(id)!
    expect(row.messages.map((m) => m.role === 'user' && m.text)).toEqual([false, '三', false])
    expect(row.messageCount).toBe(3)
    expect(row.llmMessages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})
