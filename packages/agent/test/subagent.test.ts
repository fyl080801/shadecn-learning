import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type Context, type JsonObject } from '@earendil-works/pi-ai'
import {
  AGENT_SUBTASK_EVENT,
  AGENT_SUBTASK_UPDATE_EVENT,
  AgentEventType,
  applyAgentSubtaskUpdate,
  parseAgentSubtask,
  parseAgentSubtaskUpdate,
  type AgentChatMessage,
  type AgentRunEntry,
  type AgentStreamEvent,
  type AgentSubtaskView,
} from '@shadecn/shared/agent'
import { nodeGroupMap, nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import { createMemoryAuthorityProvider } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { createMemoryLeaseRegistry, type NodeLease } from '../src/occupancy.ts'
import { DELEGATE_BRIEF_MAX, GATEWAY_ROUTES } from '../src/protocol.ts'
import type { SandboxDriver, SandboxSpec } from '../src/sandbox/driver.ts'
import { createAgentRuntime, type AgentRuntimeOptions, type OpenedCanvas } from '../src/session.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import { gatewayFetch, registerScriptedModel, TEST_GATEWAY_URL, type ScriptedStep } from '../src/testing.ts'

/**
 * 子 agent（docs/20 §3.10.11，F19，验收 16 / 21 / 22）：走完整的二期路径（进程内 runner → 网关 → 编排层 → 脚本化上游）。
 *
 * 子 agent 和父 agent 的模型请求都打到同一个脚本化上游，而且几个子 agent 是**并行**的 —— 请求的先后不固定，
 * 所以这里不按顺序排回复，而是一个「路由」：每次请求看系统提示（子 agent 的带「你是子 agent」）和第一条用户消息（它的任务说明）
 * 决定是谁、回什么。守的是：同批派出的并行执行并拿回结果摘要；只有一层（工具里没有、服务端也拒）；上限服务端判；
 * 随父 run 一起停；失败 / 需要确认交回父 agent；占用转交、子 agent 结束释放、同一轮的两个子 agent 互相算别人；
 * 步数按 agent 各算、工具调用次数全轮共用；等子 agent 的时间不算单轮时长、总时长上限封顶；子任务条目的映射、落库与补发。
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const profiles = async (ids: string[]) => new Map(ids.map((id) => [id, { id, name: `名字-${id}`, avatarUrl: null }]))

/** 一次模型请求是谁发的：父 agent，或某个子 agent（按它任务说明的第一行认） */
interface Turn {
  context: Context
  /** null = 父 agent */
  brief: string | null
  /** 这个 agent 第几次请求模型（从 1 起） */
  step: number
  /** 这次请求里最后一条工具结果的文字 */
  lastResult: string
  tools: string[]
}

type Handler = (turn: Turn, signal?: AbortSignal) => AssistantMessage | Promise<AssistantMessage>

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n')
}

function turnOf(context: Context): Turn {
  const firstUser = context.messages.find((message) => message.role === 'user')
  const first = firstUser ? textOf(firstUser.content) : ''
  const sub = (context.systemPrompt ?? '').includes('## 你是子 agent')
  const brief = sub ? (first.split('\n')[1] ?? '') : null
  const lastResult = [...context.messages].reverse().find((message) => message.role === 'toolResult')
  return {
    context,
    brief,
    step: context.messages.filter((message) => message.role === 'assistant').length + 1,
    lastResult: lastResult ? textOf(lastResult.content) : '',
    tools: (context.tools ?? []).map((tool) => tool.name),
  }
}

const call = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
/** 指定调用 id（模拟复用 id / 不给 id 的上游） */
const callWithId = (id: string, ...items: [string, JsonObject][]) =>
  fauxAssistantMessage(items.map(([name, args]) => fauxToolCall(name, args, { id })), { stopReason: 'toolUse' })
const calls = (...items: [string, JsonObject][]) =>
  fauxAssistantMessage(items.map(([name, args]) => fauxToolCall(name, args)), { stopReason: 'toolUse' })
const say = (text: string) => fauxAssistantMessage(text)
const delegate = (brief: string, nodeIds?: string[]) => ['delegate_task', { brief, ...(nodeIds ? { nodeIds } : {}) }] as [string, JsonObject]

/** 被叫停之前一直挂着（脚本化上游在 abort 时让它失败） */
const hang = (signal?: AbortSignal) =>
  new Promise<AssistantMessage>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))

function seedText(doc: Y.Doc, id: string, text = '原文') {
  nodesMap(doc).set(id, toYNode({ ...buildNodeRecord({ id, type: 'text', label: `节点${id}`, position: { x: 0, y: 0 } }), data: { text } }))
}

const dataText = (doc: Y.Doc, id: string) => nodeGroupMap(nodesMap(doc).get(id)!, 'data')?.get('text')

interface SetupExtras {
  wrapDriver?: (driver: SandboxDriver) => SandboxDriver
  /** 改写 runner 发往网关的请求体（模拟不守规矩 / 老镜像的 runner）；返回 undefined = 不改 */
  rewrite?: (route: string, body: unknown) => unknown
}

function setup(handler: Handler, overrides: Partial<AgentRuntimeOptions> & SetupExtras = {}) {
  const faux = registerScriptedModel()
  const turns: Turn[] = []
  const route: ScriptedStep = async (context, options) => {
    const turn = turnOf(context)
    turns.push(turn)
    return handler(turn, options.signal)
  }
  faux.setResponses(Array.from({ length: 200 }, () => route))
  const leases = createMemoryLeaseRegistry()
  const store = createMemoryConversationStore()
  const authorities = createMemoryAuthorityProvider()
  const changes: AgentRunEntry[][] = []
  const base = faux.runtimeOptions()
  const { wrapDriver, rewrite, ...rest } = overrides
  const runtime = createAgentRuntime({
    ...base,
    driver: wrapDriver ? wrapDriver(base.driver) : base.driver,
    leases,
    store,
    runLog: createMemoryRunLog(),
    userProfiles: profiles,
    authorities,
    onRunsChange: (_flowId, runs) => changes.push(runs),
    ...rest,
    limits: { changeWindowMs: 5, runsThrottleMs: 5, ...rest.limits },
  })
  /** runner 发往网关的请求（带着令牌）和回复，测试拿它伪造请求 */
  const sent: { route: string; token: string | null; body: unknown; reply: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    gatewayFetch(async (original) => {
      const url = new URL(original.url)
      // 模型请求（SSE）不记、不改写，直接交给网关
      if (url.pathname.includes('/model/')) return runtime.gateway.handle(original)
      const route = url.pathname.replace(/^.*agent-gateway/, '')
      let request = original
      if (rewrite) {
        const changed = rewrite(route, await original.clone().json().catch(() => null))
        if (changed !== undefined) request = new Request(original, { body: JSON.stringify(changed) })
      }
      const body = await request.clone().json().catch(() => null)
      const response = await runtime.gateway.handle(request)
      const reply = await response.clone().json().catch(() => null)
      sent.push({ route, token: request.headers.get('authorization'), body, reply })
      return response
    }),
  )
  return Object.assign(runtime, { leases, store, authorities, changes, turns, sent })
}

async function start(runtime: ReturnType<typeof setup>, doc: Y.Doc, text = '开始', wrapCanvas?: (canvas: OpenedCanvas) => OpenedCanvas) {
  const events: AgentStreamEvent[] = []
  const started = await runtime.start({
    flowId: 'flow-1',
    userId: 'u1',
    conversationId: null,
    text,
    openCanvas: async (runId: string): Promise<OpenedCanvas> => {
      const canvas: OpenedCanvas = { ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }), async close() {} }
      return wrapCanvas ? wrapCanvas(canvas) : canvas
    },
    emit: (event) => events.push(event),
  })
  if (!started.ok) throw new Error(`应该启动成功：${started.message}`)
  return Object.assign(started, { events })
}

/** 派发时那一帧（完整条目） */
const subtaskFrames = (events: AgentStreamEvent[]) =>
  events.flatMap((event) => (event.type === AgentEventType.CUSTOM && event.name === AGENT_SUBTASK_EVENT ? [event.value] : []))

/** 两种子任务帧（完整条目 + 之后的变化） */
const allSubtaskFrames = (events: AgentStreamEvent[]) =>
  events.filter(
    (event) => event.type === AgentEventType.CUSTOM && (event.name === AGENT_SUBTASK_EVENT || event.name === AGENT_SUBTASK_UPDATE_EVENT),
  )

/** 实时流里的子任务帧依次折起来（首帧完整、之后合并变化，和前端一样）：补发 / 只读旁观看到的条目 */
function foldSubtasks(events: AgentStreamEvent[]): AgentSubtaskView[] {
  const views: AgentSubtaskView[] = []
  for (const event of allSubtaskFrames(events)) {
    if (event.type !== AgentEventType.CUSTOM) continue
    if (event.name === AGENT_SUBTASK_EVENT) {
      views.push(parseAgentSubtask(event.value)!)
      continue
    }
    const update = parseAgentSubtaskUpdate(event.value)!
    const index = views.findIndex((view) => view.id === update.id)
    views[index] = applyAgentSubtaskUpdate(views[index]!, update)
  }
  return views
}

function finished(events: AgentStreamEvent[]) {
  const last = events.at(-1)
  if (last?.type !== AgentEventType.RUN_FINISHED) throw new Error(`最后一帧不是 RUN_FINISHED：${JSON.stringify(last)}`)
  return last
}

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('等不到条件成立')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 一个计数闩：`arrive()` 到 n 次才放行全部；超时则失败（顺序执行时永远到不了 n —— 用它证明并行） */
function latch(n: number, timeoutMs = 2000) {
  let count = 0
  let release!: () => void
  const open = new Promise<void>((resolve) => (release = resolve))
  return {
    async arrive() {
      count += 1
      if (count >= n) release()
      await Promise.race([
        open,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`只到了 ${count} 个，没有并行`)), timeoutMs)),
      ])
    },
  }
}

describe('同批派出、并行执行、拿回结果摘要（验收 21）', () => {
  it('父 agent 同一批调三个 delegate_task：三个子 agent 同时在跑，各改各的节点，父 agent 收到三份结果；子 agent 的过程不进父 agent 的上下文', async () => {
    const doc = new Y.Doc()
    for (const id of ['n1', 'n2', 'n3']) seedText(doc, id)
    const together = latch(3)
    const parentResults: string[] = []
    const runtime = setup(async (turn) => {
      if (turn.brief === null) {
        if (turn.step === 1) return calls(delegate('改 n1', ['n1']), delegate('改 n2', ['n2']), delegate('改 n3', ['n3']))
        for (const message of turn.context.messages) if (message.role === 'toolResult') parentResults.push(textOf(message.content))
        return say('三个都做完了')
      }
      const id = turn.brief.slice(2)
      // 三个子 agent 都发出了第一次请求才放行：顺序执行永远等不齐
      if (turn.step === 1) {
        await together.arrive()
        return call('update_node', { id, data: { text: `新-${id}` } })
      }
      return say(`${id} 改好了`)
    })
    const run = await start(runtime, doc, '分别改这三个节点')
    await run.done

    expect(['n1', 'n2', 'n3'].map((id) => dataText(doc, id))).toEqual(['新-n1', '新-n2', '新-n3'])
    // 父 agent 拿回的是三份结果摘要：状态、改过的节点、最终回复（不是它们的过程）
    expect(parentResults).toHaveLength(3)
    for (const id of ['n1', 'n2', 'n3']) {
      const result = parentResults.find((text) => text.includes(`改 ${id}`))!
      expect(result).toContain('子任务完成')
      expect(result).toContain(`它改过的节点：${id}`)
      expect(result).toContain(`${id} 改好了`)
      expect(result).not.toContain('update_node')
    }
    // 子 agent 的工具里没有 delegate_task，有 request_confirmation；父 agent 有 delegate_task、没有 request_confirmation
    const subTurn = runtime.turns.find((turn) => turn.brief !== null)!
    expect(subTurn.tools).not.toContain('delegate_task')
    expect(subTurn.tools).toContain('request_confirmation')
    const parentTurn = runtime.turns.find((turn) => turn.brief === null)!
    expect(parentTurn.tools).toContain('delegate_task')
    expect(parentTurn.tools).not.toContain('request_confirmation')

    const last = finished(run.events)
    expect(last.outcome).toEqual({ type: 'success' })
    // 子任务条目：三条，完成，挂在各自的 delegate_task 上；父 agent 的 toolCalls 里只有三个 delegate_task
    const subtasks = last.result.subtasks!
    expect(subtasks.map((task) => [task.brief, task.status, task.changedNodeIds])).toEqual(
      expect.arrayContaining([
        ['改 n1', 'done', ['n1']],
        ['改 n2', 'done', ['n2']],
        ['改 n3', 'done', ['n3']],
      ]),
    )
    expect(last.result.toolCalls.map((item) => item.name)).toEqual(['delegate_task', 'delegate_task', 'delegate_task'])
    for (const task of subtasks) {
      expect(last.result.toolCalls.map((item) => item.id)).toContain(task.toolCallId)
      expect(task.toolCalls).toMatchObject([{ name: 'update_node', status: 'done' }])
      expect(task.text).toMatch(/改好了/)
      expect(task.finishedAt).toBeGreaterThanOrEqual(task.startedAt)
    }
    // 实时流里子 agent 的工具调用不是 TOOL_CALL_START（那只给父 agent 的）
    const toolStarts = run.events.filter((event) => event.type === AgentEventType.TOOL_CALL_START)
    expect(toolStarts.map((event) => (event as { toolCallName: string }).toolCallName)).toEqual(['delegate_task', 'delegate_task', 'delegate_task'])

    // 落库：assistant 消息带着子任务条目（刷新后一样）；模型上下文里没有子 agent 的消息
    const conversationId = (run.events[0] as { threadId: string }).threadId
    const stored = runtime.store.rows.get(conversationId)!
    const assistant = stored.messages.find((message): message is Extract<AgentChatMessage, { role: 'assistant' }> => message.role === 'assistant')!
    expect(assistant.subtasks).toEqual(subtasks)
    const llmText = JSON.stringify(stored.llmMessages)
    expect(llmText).not.toContain('父 agent 交给你的任务')
    expect(llmText).not.toContain('update_node')
    expect(llmText).toContain('delegate_task')
    // 占用：子 agent 结束时都释放了
    expect(await runtime.leases.list('flow-1')).toEqual(new Map())
  })

  it('任务列表那一项带着在跑的子任务数；补发（中途接回）和发起者看到的逐帧相同', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    const both = latch(2)
    let gate!: () => void
    const held = new Promise<void>((resolve) => (gate = resolve))
    const runtime = setup(async (turn) => {
      if (turn.brief === null) return turn.step === 1 ? calls(delegate('甲'), delegate('乙')) : say('好')
      if (turn.step === 1) {
        await both.arrive()
        await held
        return call('read_canvas', {})
      }
      return say(`${turn.brief} 完成`)
    })
    const run = await start(runtime, doc)
    await until(() => runtime.changes.some((list) => list.some((entry) => entry.subtasks === 2)))
    // 中途接回：补发从 RUN_STARTED 起，之后接着推
    const replayed: AgentStreamEvent[] = []
    const subscribed = await runtime.subscribe('flow-1', run.runId, (event) => replayed.push(event))
    expect(subscribed.ok).toBe(true)
    expect(subtaskFrames(replayed)).toHaveLength(2)
    gate()
    await run.done
    expect(replayed).toEqual(run.events)
    // 结束后列表里没有它（子任务数随之归零）
    expect(runtime.changes.at(-1)).toEqual([])
  })
})

describe('只有一层：子 agent 不能再派（验收 21）', () => {
  it('子 agent 的工具里没有 delegate_task；拿着这一轮的令牌伪造子 agent 发起的派发、经 /canvas/tool 点名 delegate_task，都被拒', async () => {
    const doc = new Y.Doc()
    const forged: { delegate?: unknown; tool?: unknown; load?: unknown } = {}
    const runtime: ReturnType<typeof setup> = setup(async (turn) => {
      if (turn.brief === null) return turn.step === 1 ? calls(delegate('试试再派')) : say('好')
      // 子 agent 第一次请求模型时：拿父 run 的令牌、以它自己的 agent id 伪造请求
      const assigned = runtime.sent.find((item) => item.route === GATEWAY_ROUTES.delegate)!
      const token = assigned.token!
      const agentId = (assigned.reply as { agent: { agentId: string } }).agent.agentId
      const post = async (route: string, body: unknown) =>
        (
          await fetch(`${TEST_GATEWAY_URL}${route}`, {
            method: 'POST',
            headers: { authorization: token, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json()
      forged.delegate = await post(GATEWAY_ROUTES.delegate, { agentId, toolCallId: 'call_forged', brief: '孙子任务', nodeIds: [] })
      forged.tool = await post(GATEWAY_ROUTES.tool, { agentId, toolCallId: 'call_forged2', name: 'delegate_task', args: { brief: 'x' } })
      forged.load = await post(GATEWAY_ROUTES.tool, { agentId, toolCallId: 'call_forged3', name: 'load_skill', args: { id: 'delegate' } })
      return say('做完了')
    })
    const run = await start(runtime, doc)
    await run.done
    const subTurn = runtime.turns.find((turn) => turn.brief !== null)!
    expect(subTurn.tools).not.toContain('delegate_task')
    expect(forged.delegate).toMatchObject({ ok: false, message: expect.stringContaining('只有一层') })
    expect(forged.tool).toMatchObject({ isError: true, message: 'Tool delegate_task not found' })
    expect(forged.load).toMatchObject({ isError: true, message: expect.stringContaining('只有一层') })
    // 只派出了父 agent 的那一个
    expect(finished(run.events).result.subtasks).toHaveLength(1)
  })
})

describe('子 agent 按需加载技能（docs/23 §3.3）', () => {
  it('子 agent load_skill 之后，它的下一次请求就带上新工具；只有父 agent 去取别人的改动', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    const runtime = setup(async (turn) => {
      if (turn.brief === null) return turn.step === 1 ? calls(delegate('先加载导演台再读')) : say('好')
      if (turn.step === 1) return call('load_skill', { id: 'director' })
      if (turn.step === 2) return call('read_canvas', {})
      return say('读完了')
    })
    const run = await start(runtime, doc)
    await run.done
    expect(finished(run.events).outcome).toEqual({ type: 'success' })
    const sub = runtime.turns.filter((turn) => turn.brief !== null)
    expect(sub).toHaveLength(3)
    expect(sub[0]!.tools).not.toContain('get_director_scene')
    expect(sub[1]!.tools).toContain('get_director_scene')
    // 子 agent 两批调过工具也不取；父 agent 只在它那一批 delegate_task 之后取一次
    expect(runtime.sent.filter((entry) => entry.route === GATEWAY_ROUTES.changes)).toHaveLength(1)
  })
})

describe('上限服务端判（验收 21）', () => {
  it('同时上限 2、累计上限 3：第一批三个里一个因「同时」被拒；第二批两个里一个因「累计」被拒 —— 拒绝是给父 agent 的工具错误，不停整轮', async () => {
    const doc = new Y.Doc()
    const batches: string[][] = []
    const runtime = setup(
      async (turn) => {
        if (turn.brief === null) {
          if (turn.step === 1) return calls(delegate('a1'), delegate('a2'), delegate('a3'))
          const results = turn.context.messages.filter((message) => message.role === 'toolResult').map((message) => textOf(message.content))
          if (turn.step === 2) {
            batches.push(results)
            return calls(delegate('b1'), delegate('b2'))
          }
          batches.push(results.slice(3))
          return say('好')
        }
        return say(`${turn.brief} 完成`)
      },
      { limits: { maxSubagents: 2, maxSubagentsPerRun: 3 } },
    )
    const run = await start(runtime, doc)
    await run.done
    expect(finished(run.events).outcome).toEqual({ type: 'success' })
    expect(batches[0]!.filter((text) => text.includes('同时最多 2 个子任务'))).toHaveLength(1)
    expect(batches[0]!.filter((text) => text.includes('子任务完成'))).toHaveLength(2)
    expect(batches[1]!.filter((text) => text.includes('达到上限 3'))).toHaveLength(1)
    expect(batches[1]!.filter((text) => text.includes('子任务完成'))).toHaveLength(1)
    // 被拒的那几个没有子任务条目
    expect(finished(run.events).result.subtasks).toHaveLength(3)
  })
})

describe('随父 run 一起停（验收 21）', () => {
  it('子 agent 正在请求模型时点停止：这一轮 cancelled，子任务条目标成失败（已中止），占用释放', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    let waiting = false
    const runtime = setup(async (turn, signal) => {
      if (turn.brief === null) return calls(delegate('慢慢改', ['n1']))
      if (turn.step === 1) return call('update_node', { id: 'n1', data: { text: '改了一半' } })
      waiting = true
      return hang(signal)
    })
    const run = await start(runtime, doc)
    await until(() => waiting)
    expect(await runtime.leases.get('flow-1', 'n1')).toMatchObject({ runId: run.runId, agentId: expect.stringMatching(/^sub_/) })
    expect(await runtime.abort('flow-1', run.runId, { userId: 'u1', admin: false })).toBe('aborted')
    await run.done
    const last = finished(run.events)
    expect(last.outcome).toEqual({ type: 'cancelled' })
    expect(last.result.subtasks).toMatchObject([{ status: 'failed', error: '已中止' }])
    expect(await runtime.leases.list('flow-1')).toEqual(new Map())
  })
})

describe('失败与需要确认交回父 agent', () => {
  it('子 agent 的模型出错：delegate_task 回「失败 + 原因」，父 agent 接着做完这一轮', async () => {
    const doc = new Y.Doc()
    let parentSaw = ''
    const runtime = setup(async (turn) => {
      if (turn.brief === null) {
        if (turn.step === 1) return calls(delegate('会失败的事'))
        parentSaw = turn.lastResult
        return say('子任务失败了，我换个做法')
      }
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: '上游炸了' })
    })
    const run = await start(runtime, doc)
    await run.done
    expect(parentSaw).toContain('子任务失败')
    expect(parentSaw).toContain('上游炸了')
    const last = finished(run.events)
    expect(last.outcome).toEqual({ type: 'success' })
    expect(last.result.text).toContain('换个做法')
    expect(last.result.subtasks).toMatchObject([{ status: 'failed', error: expect.stringContaining('上游炸了') }])
    // 父 agent 那条 delegate_task 是出错状态
    expect(last.result.toolCalls).toMatchObject([{ name: 'delegate_task', status: 'error' }])
  })

  it('子 agent 调 request_confirmation：以「需要确认 + 问题」结束，父 agent 收到问题自己决定', async () => {
    const doc = new Y.Doc()
    let parentSaw = ''
    const runtime = setup(async (turn) => {
      if (turn.brief === null) {
        if (turn.step === 1) return calls(delegate('改个有争议的节点'))
        parentSaw = turn.lastResult
        return say('需要问一下你')
      }
      return call('request_confirmation', { question: '这个节点要不要等对方改完？' })
    })
    const run = await start(runtime, doc)
    await run.done
    expect(parentSaw).toContain('子任务需要确认')
    expect(parentSaw).toContain('这个节点要不要等对方改完？')
    const last = finished(run.events)
    expect(last.result.subtasks).toMatchObject([{ status: 'needs_confirmation', question: '这个节点要不要等对方改完？' }])
    // request_confirmation 不列进它的工具调用；父 agent 的 delegate_task 不是错误
    expect(last.result.subtasks![0]!.toolCalls).toEqual([])
    expect(last.result.toolCalls).toMatchObject([{ name: 'delegate_task', status: 'done' }])
  })
})

describe('占用按 agent（验收 16）', () => {
  it('父 agent 占着的节点派给子 agent：占用转给它，它写不被拒；它结束时释放、不还给父 agent；父 agent 之后再写要重读（子 agent 改过）', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    const seen: { subLease?: NodeLease | null; afterSub?: NodeLease | null; subResult?: string; parentWrite?: string } = {}
    const runtime: ReturnType<typeof setup> = setup(async (turn) => {
      if (turn.brief === null) {
        if (turn.step === 1) return call('get_node', { id: 'n1' })
        if (turn.step === 2) return call('update_node', { id: 'n1', data: { text: '父改的' } })
        if (turn.step === 3) return calls(delegate('接着改 n1', ['n1']))
        if (turn.step === 4) {
          seen.afterSub = await runtime.leases.get('flow-1', 'n1')
          return call('update_node', { id: 'n1', data: { text: '父又改' } })
        }
        seen.parentWrite = turn.lastResult
        return say('好')
      }
      if (turn.step === 1) {
        seen.subLease = await runtime.leases.get('flow-1', 'n1')
        return call('update_node', { id: 'n1', data: { text: '子改的' } })
      }
      seen.subResult = turn.lastResult
      return say('改好了')
    })
    const run = await start(runtime, doc)
    await run.done
    expect(seen.subLease).toMatchObject({ runId: run.runId, agentId: expect.stringMatching(/^sub_/) })
    expect(seen.subResult).not.toContain('正在被')
    expect(dataText(doc, 'n1')).toBe('子改的')
    // 子 agent 结束时释放了，没有还给父 agent
    expect(seen.afterSub).toBeNull()
    // 子 agent 改过它的 data：父 agent 读过之后它被「别人」（同一轮的子任务）改了，先重读
    expect(seen.parentWrite).toContain('在你读过之后被改过')
    expect(seen.parentWrite).toContain('这一轮的子任务')
  })

  it('两个子 agent 写同一个节点：先写的占着；后写的先因「改过」被拒（同一轮的别的 agent 也算别人），重读后因「正在改」被拒，按规矩以「需要确认」交回', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n2')
    let aWrote!: () => void
    const wrote = new Promise<void>((resolve) => (aWrote = resolve))
    let bDone!: () => void
    const tried = new Promise<void>((resolve) => (bDone = resolve))
    const b: string[] = []
    const runtime = setup(async (turn) => {
      if (turn.brief === null) return turn.step === 1 ? calls(delegate('A 改', ['n2']), delegate('B 改', ['n2'])) : say('好')
      if (turn.brief === 'A 改') {
        if (turn.step === 1) return call('update_node', { id: 'n2', data: { text: 'A' } })
        aWrote()
        // A 等 B 试完才交回：B 试的时候 A 还占着 n2
        await tried
        return say('A 好了')
      }
      if (turn.step === 1) {
        await wrote
        return call('update_node', { id: 'n2', data: { text: 'B' } })
      }
      b.push(turn.lastResult)
      if (turn.step === 2) return call('get_node', { id: 'n2' })
      if (turn.step === 3) return call('update_node', { id: 'n2', data: { text: 'B' } })
      bDone()
      return call('request_confirmation', { question: 'n2 正被另一个子任务改，要等吗？' })
    })
    const run = await start(runtime, doc)
    await run.done
    expect(b[0]).toContain('在你读过之后被改过（这一轮的子任务')
    expect(b[0]).toContain('request_confirmation')
    // 读的结果里标出占用者是同一轮的另一个子任务
    expect(b[1]).toContain('【节点占用】')
    expect(b[1]).toContain('这一轮的另一个子任务')
    expect(b[2]).toContain('正在被这一轮的另一个子任务')
    expect(b[2]).toContain('request_confirmation')
    expect(dataText(doc, 'n2')).toBe('A')
    const subtasks = finished(run.events).result.subtasks!
    expect(subtasks.map((task) => task.status).sort()).toEqual(['done', 'needs_confirmation'])
  })
})

describe('预算：步数按 agent 各算，工具调用次数全轮共用', () => {
  it('单轮步数上限 3：子 agent 自己用满 3 步被结束（子任务失败），父 agent 的步数不受它影响、照常收尾', async () => {
    const doc = new Y.Doc()
    let parentSaw = ''
    const runtime = setup(
      async (turn) => {
        if (turn.brief === null) {
          if (turn.step === 1) return calls(delegate('读个没完'))
          parentSaw = turn.lastResult
          return say('它步数用完了')
        }
        // 每一步都带一句话再调工具：结束时子任务的文字是最后这一步的真回复
        return fauxAssistantMessage([fauxText(`读第 ${turn.step} 遍`), fauxToolCall('read_canvas', {})], { stopReason: 'toolUse' })
      },
      { limits: { maxTurns: 3 } },
    )
    const run = await start(runtime, doc)
    await run.done
    // 父 2 步 + 子 3 步 > 3：按轮合计早就超了，但各算各的
    expect(finished(run.events).outcome).toEqual({ type: 'success' })
    expect(parentSaw).toContain('子任务失败')
    expect(parentSaw).toContain('步数上限 3')
    // runner 用 pi 的 finishTurn 结束它的循环：第 3 步之后不再请求模型（没有一次被掐断的第 4 次请求），上报的 turn_end 正好 3 个
    expect(runtime.turns.filter((turn) => turn.brief !== null)).toHaveLength(3)
    const reported = runtime.sent
      .filter((entry) => entry.route === GATEWAY_ROUTES.events)
      .flatMap((entry) => (entry.body as { events: { type: string; agentId?: string }[] }).events)
    expect(reported.filter((event) => event.type === 'turn_end' && event.agentId !== undefined)).toHaveLength(3)
    // 子任务的文字是第 3 步的回复（不是一条被中止的空消息）
    expect(parentSaw).toContain('读第 3 遍')
    const last = foldSubtasks(run.events).at(-1)
    expect(last).toMatchObject({ status: 'failed', text: '读第 3 遍', error: '超过子任务的步数上限 3' })
  })

  it('子 agent 第 maxTurns + 1 次模型请求（不守规矩的 runner）：网关只回一帧 error、不调上游，它之后的工具调用被拒', async () => {
    const doc = new Y.Doc()
    const runtime = setup(
      async (turn) => {
        if (turn.brief === null) return turn.step === 1 ? calls(delegate('读个没完')) : say('收到')
        return fauxAssistantMessage([fauxText(`读第 ${turn.step} 遍`), fauxToolCall('read_canvas', {})], { stopReason: 'toolUse' })
      },
      { limits: { maxTurns: 3 } },
    )
    const inner = globalThis.fetch
    let subToolCalls = 0
    let forged: { status: number; text: string } | null = null
    let refused: unknown = null
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url.endsWith(GATEWAY_ROUTES.tool)) {
        const body = (await request.clone().json()) as { agentId?: string }
        if (body.agentId) {
          subToolCalls += 1
          // 子 agent 第 3 步的模型请求已经结束、工具还没执行：替它多请求一次（第 4 次）
          if (subToolCalls === 3) {
            const res = await runtime.gateway.handle(
              new Request(`${TEST_GATEWAY_URL}/model/${encodeURIComponent(body.agentId)}/api/stream`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: request.headers.get('authorization')! },
                body: JSON.stringify({ context: { messages: [] } }),
              }),
            )
            forged = { status: res.status, text: await res.text() }
            const reply = await inner(request)
            refused = await reply.clone().json()
            return reply
          }
        }
      }
      return inner(request)
    })
    const run = await start(runtime, doc)
    await run.done
    const got = forged as { status: number; text: string } | null
    expect(got?.status).toBe(200)
    expect(got?.text.trim().split('\n\n')).toHaveLength(1)
    expect(JSON.parse(got!.text.trim().slice('data: '.length))).toMatchObject({
      type: 'error',
      reason: 'error',
      errorMessage: '子任务的步数已达上限 3，这次请求没有发给模型',
    })
    // 上游只收到父 2 次 + 子 3 次
    expect(runtime.turns).toHaveLength(5)
    expect(refused).toMatchObject({ isError: true })
    expect(String((refused as { message?: string }).message)).toContain('子任务的步数已达上限 3')
    expect(finished(run.events).outcome).toEqual({ type: 'success' })
  })

  it('工具调用上限 3（父子共用）：delegate_task 算一次，子 agent 再用两次就到顶；之后子 agent、父 agent 的调用都被拦下', async () => {
    const doc = new Y.Doc()
    const results: { sub: string[]; parent: string } = { sub: [], parent: '' }
    const runtime = setup(
      async (turn) => {
        if (turn.brief === null) {
          if (turn.step === 1) return calls(delegate('读三次'))
          if (turn.step === 2) return call('read_canvas', {})
          results.parent = turn.lastResult
          return say('好')
        }
        if (turn.step > 1) results.sub.push(turn.lastResult)
        return turn.step <= 3 ? call('read_canvas', {}) : say('读完了')
      },
      { limits: { maxToolCalls: 3 } },
    )
    const run = await start(runtime, doc)
    await run.done
    expect(results.sub[0]).not.toContain('已达上限')
    expect(results.sub[1]).not.toContain('已达上限')
    expect(results.sub[2]).toContain('本轮工具调用已达上限 3 次')
    expect(results.parent).toContain('本轮工具调用已达上限 3 次')
  })
})

describe('时长（验收 22）', () => {
  /** 记下驱动收到的沙箱规格（硬期限） */
  const recording = (specs: SandboxSpec[]) => (driver: SandboxDriver): SandboxDriver => ({
    ...driver,
    start: (spec) => {
      specs.push(spec)
      return driver.start(spec)
    },
  })

  it('子 agent 跑得比单轮上限久：等它的时间不计入单轮时长，这一轮照常收尾；沙箱硬期限与 Grant 按总时长上限算', async () => {
    const doc = new Y.Doc()
    const specs: SandboxSpec[] = []
    const runtime = setup(
      async (turn) => {
        if (turn.brief === null) return turn.step === 1 ? calls(delegate('要跑很久')) : say('等到了')
        await new Promise((resolve) => setTimeout(resolve, 600))
        return say('终于做完')
      },
      { limits: { timeoutMs: 250, totalTimeoutMs: 10_000, idleTimeoutMs: 5000 }, wrapDriver: recording(specs) },
    )
    const run = await start(runtime, doc)
    await run.done
    const last = finished(run.events)
    expect(last.outcome).toEqual({ type: 'success' })
    expect(last.result.subtasks).toMatchObject([{ status: 'done', text: '终于做完' }])
    expect(specs[0]!.resources.deadlineMs).toBe(10_000 + 30_000)
    expect(runtime.authorities.grants[0]!.request.timeoutMs).toBe(10_000)
  })

  it('总时长上限到了：这一轮连同子 agent 停下，原因「超过总时长上限」', async () => {
    const doc = new Y.Doc()
    const runtime = setup(
      async (turn, signal) => {
        if (turn.brief === null) return calls(delegate('永远做不完'))
        return hang(signal)
      },
      { limits: { timeoutMs: 100, totalTimeoutMs: 400, idleTimeoutMs: 5000 } },
    )
    const run = await start(runtime, doc)
    await run.done
    const last = finished(run.events)
    expect(last.outcome).toEqual({ type: 'cancelled' })
    expect(last.result.error).toContain('超过总时长上限')
    expect(last.result.subtasks).toMatchObject([{ status: 'failed', error: expect.stringContaining('超过总时长上限') }])
  })

  it('没有子 agent 在跑时单轮上限照常生效', async () => {
    const doc = new Y.Doc()
    const runtime = setup(
      async (turn, signal) => {
        void turn
        return hang(signal)
      },
      { limits: { timeoutMs: 150, totalTimeoutMs: 10_000, idleTimeoutMs: 5000 } },
    )
    const run = await start(runtime, doc)
    await run.done
    expect(finished(run.events).result.error).toContain('超过 0.15 秒')
  })
})

describe('子任务条目的契约', () => {
  it('派发一帧完整条目，之后每帧只带变化；依次合并 = 落定消息里的那一项', async () => {
    const doc = new Y.Doc()
    const runtime = setup(async (turn) => {
      if (turn.brief === null) return turn.step === 1 ? calls(delegate('建一个节点')) : say('好')
      if (turn.step === 1) return call('add_node', { type: 'text', metadata: { label: '子建的' }, data: { text: 'x' } })
      return say('建好了')
    })
    const run = await start(runtime, doc)
    await run.done
    const frames = allSubtaskFrames(run.events)
    // 开始（完整）、工具开始、工具结束、回复、结束（变化）
    expect(frames.map((frame) => (frame as { name: string }).name)).toEqual([
      AGENT_SUBTASK_EVENT,
      AGENT_SUBTASK_UPDATE_EVENT,
      AGENT_SUBTASK_UPDATE_EVENT,
      AGENT_SUBTASK_UPDATE_EVENT,
      AGENT_SUBTASK_UPDATE_EVENT,
    ])
    // 变化帧里没有任务说明
    for (const frame of frames.slice(1)) expect((frame as { value: object }).value).not.toHaveProperty('brief')
    const final = foldSubtasks(run.events)
    expect(final).toMatchObject([{ status: 'done', text: '建好了' }])
    expect(finished(run.events).result.subtasks).toEqual(final)
    // 新建的节点算它改过的
    const created = [...nodesMap(doc).keys()]
    expect(final[0]!.changedNodeIds).toEqual(created)
    // 子 agent 新建的节点它占着，结束时释放
    expect(await runtime.leases.list('flow-1')).toEqual(new Map())
  })

  it('长任务说明 × 多次工具调用：补发量不再按「调用数 × 条目大小」放大 —— 说明只出现在派发那一帧，补发缓冲小也能中途接回', async () => {
    const doc = new Y.Doc()
    const brief = `长说明${'很'.repeat(DELEGATE_BRIEF_MAX - 20)}`
    const steps = 12
    let gate!: () => void
    const held = new Promise<void>((resolve) => (gate = resolve))
    let waiting = false
    const runtime = setup(
      async (turn) => {
        if (turn.brief === null) return turn.step === 1 ? calls(delegate(brief)) : say('好')
        if (turn.step <= steps) return call('read_canvas', {})
        waiting = true
        await held
        return say('读完了')
      },
      // 旧做法每帧带完整条目：(1 + 2 × 12) 帧 × 8000 字 ≈ 20 万字，远超这里的 6 万字
      { limits: { replayChars: 60_000 } },
    )
    const run = await start(runtime, doc)
    await until(() => waiting)
    const replayed: AgentStreamEvent[] = []
    const subscribed = await runtime.subscribe('flow-1', run.runId, (event) => replayed.push(event))
    expect(subscribed).toMatchObject({ ok: true })
    gate()
    await run.done
    expect(replayed).toEqual(run.events)

    const frames = allSubtaskFrames(run.events)
    expect(frames.length).toBeGreaterThanOrEqual(1 + 2 * steps)
    expect(frames.filter((frame) => JSON.stringify(frame).includes(brief))).toHaveLength(1)
    const subtaskChars = frames.reduce((sum, frame) => sum + JSON.stringify(frame).length, 0)
    // 说明一份 + 每次调用一条小变化
    expect(subtaskChars).toBeLessThan(brief.length + 400 * frames.length)
    // 接回的、发起人看到的、落库的是同一个完整条目
    const stored = finished(run.events).result.subtasks!
    expect(foldSubtasks(replayed)).toEqual(stored)
    expect(stored[0]!.toolCalls).toHaveLength(steps)
    expect(stored[0]!.brief).toBe(brief)
  })
})

describe('交回的结果文字（最后一条有文字的回复）', () => {
  it('子 agent 先说了结论再调工具、下一步模型出错：交回父 agent 和条目上的都是那句结论，不是空的；不信 runner 报的文字', async () => {
    const doc = new Y.Doc()
    let parentSaw = ''
    const runtime = setup(
      async (turn) => {
        if (turn.brief === null) {
          if (turn.step === 1) return calls(delegate('查一下'))
          parentSaw = turn.lastResult
          return say('好')
        }
        if (turn.step === 1) return fauxAssistantMessage([fauxText('结论：画布是空的'), fauxToolCall('read_canvas', {})], { stopReason: 'toolUse' })
        return fauxAssistantMessage('', { stopReason: 'error', errorMessage: '上游炸了' })
      },
      // 老镜像 / 不守规矩的 runner 报来的文字：服务端不用它
      { rewrite: (route, body) => (route === GATEWAY_ROUTES.agentFinish ? { ...(body as object), text: 'runner 编的' } : undefined) },
    )
    const run = await start(runtime, doc)
    await run.done
    expect(parentSaw).toContain('子任务失败')
    expect(parentSaw).toContain('结论：画布是空的')
    expect(parentSaw).not.toContain('runner 编的')
    expect(foldSubtasks(run.events)).toMatchObject([{ status: 'failed', text: '结论：画布是空的' }])
    expect(finished(run.events).result.subtasks).toMatchObject([{ text: '结论：画布是空的' }])
  })
})

describe('调用 id：上游复用 / 不给', () => {
  it('父 agent 两步都用 call_0 调 delegate_task、子 agent 也每步用 call_0：两次都派出，条目各挂各的那次调用', async () => {
    const doc = new Y.Doc()
    const results: string[] = []
    const runtime = setup(async (turn) => {
      if (turn.brief === null) {
        if (turn.step > 1) results.push(turn.lastResult)
        if (turn.step === 1) return callWithId('call_0', delegate('第一件'))
        if (turn.step === 2) return callWithId('call_0', delegate('第二件'))
        return say('都好了')
      }
      if (turn.step <= 2) return callWithId('call_0', ['read_canvas', {}])
      return say(`${turn.brief} 好了`)
    })
    const run = await start(runtime, doc)
    await run.done
    expect(results).toHaveLength(2)
    for (const text of results) expect(text).toContain('子任务完成')
    const last = finished(run.events)
    expect(last.outcome).toEqual({ type: 'success' })
    expect(last.result.toolCalls.map((item) => [item.id, item.name, item.status])).toEqual([
      ['call_0', 'delegate_task', 'done'],
      ['call_0#2', 'delegate_task', 'done'],
    ])
    const subtasks = last.result.subtasks!
    expect(subtasks.map((task) => [task.brief, task.toolCallId, task.status])).toEqual([
      ['第一件', 'call_0', 'done'],
      ['第二件', 'call_0#2', 'done'],
    ])
    for (const task of subtasks) {
      expect(task.toolCalls.map((item) => [item.id, item.status])).toEqual([
        ['call_0', 'done'],
        ['call_0#2', 'done'],
      ])
    }
    expect(foldSubtasks(run.events)).toEqual(subtasks)
  })

  it('上游不给调用 id（pi-ai 填空串）：runner 补一个，事件不被整批拒，这一轮照常做完', async () => {
    const doc = new Y.Doc()
    const runtime = setup(async (turn) => {
      if (turn.brief === null) return turn.step === 1 ? callWithId('', delegate('甲'), delegate('乙')) : say('好')
      return turn.step === 1 ? callWithId('', ['read_canvas', {}]) : say(`${turn.brief} 好了`)
    })
    const run = await start(runtime, doc)
    await run.done
    const last = finished(run.events)
    expect(last.outcome).toEqual({ type: 'success' })
    const ids = last.result.toolCalls.map((item) => item.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^call_/)
    expect(last.result.subtasks!.map((task) => task.status)).toEqual(['done', 'done'])
    expect(last.result.subtasks!.map((task) => task.toolCallId).sort()).toEqual([...ids].sort())
    // 没有一批事件被网关拒掉
    expect(runtime.sent.filter((entry) => entry.route === GATEWAY_ROUTES.events && entry.reply === null)).toEqual([])
  })
})

describe('派发没成功：名额、计时、登记、占用全部退回', () => {
  it('展开提及时读画布失败：拒绝是给父 agent 的工具错误；累计名额退回（上限 1 也能再派一次），计时恢复（之后单轮上限照常生效）', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    // 只让派发那一次的读失败（开始时的读照常）
    let failRead = false
    const results: string[] = []
    const runtime = setup(
      async (turn, signal) => {
        if (turn.brief === null) {
          if (turn.step > 1) results.push(turn.lastResult)
          if (turn.step === 1) {
            failRead = true
            return callWithId('call_0', delegate('读 n1', ['n1']))
          }
          if (turn.step === 2) {
            failRead = false
            return callWithId('call_0', delegate('再读 n1', ['n1']))
          }
          // 子任务都结束了：单轮计时恢复，挂住到超时
          return hang(signal)
        }
        return say('读到了')
      },
      { limits: { maxSubagentsPerRun: 1, maxSubagents: 1, timeoutMs: 400, totalTimeoutMs: 10_000, idleTimeoutMs: 5000 } },
    )
    const run = await start(runtime, doc, '开始', (canvas) => ({
      ...canvas,
      read: (fn) => {
        if (failRead) return Promise.reject(new Error('画布读不到'))
        return canvas.read(fn)
      },
    }))
    await run.done
    expect(results[0]).toContain('没有派出子任务')
    expect(results[0]).toContain('画布读不到')
    expect(results[1]).toContain('子任务完成')
    const last = finished(run.events)
    expect(last.result.error).toContain('超过 0.4 秒')
    expect(last.result.subtasks).toMatchObject([{ brief: '再读 n1', status: 'done' }])
    // 派发失败的那次没有条目、没有开始帧
    expect(subtaskFrames(run.events)).toHaveLength(1)
  })

  it('转交占用时登记表出错：这次派发被拒，已转交的占用释放，子 agent 不留登记；工具调用次数照计', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    seedText(doc, 'n2')
    const seen: { delegate?: string; n1?: NodeLease | null; n2?: NodeLease | null; after?: string } = {}
    let transfers = 0
    const runtime: ReturnType<typeof setup> = setup(
      async (turn) => {
        if (turn.brief === null) {
          if (turn.step === 1) return calls(['get_node', { id: 'n1' }], ['get_node', { id: 'n2' }])
          if (turn.step === 2) return calls(['update_node', { id: 'n1', data: { text: '父1' } }], ['update_node', { id: 'n2', data: { text: '父2' } }])
          if (turn.step === 3) return calls(delegate('改两个', ['n1', 'n2']))
          if (turn.step === 4) {
            seen.delegate = turn.lastResult
            seen.n1 = await runtime.leases.get('flow-1', 'n1')
            seen.n2 = await runtime.leases.get('flow-1', 'n2')
            return call('read_canvas', {})
          }
          seen.after = turn.lastResult
          return say('好')
        }
        return say('不该跑到这里')
      },
      { limits: { maxToolCalls: 6 } },
    )
    // 第一个转交成功，第二个时登记表炸了
    const transfer = runtime.leases.transfer.bind(runtime.leases)
    runtime.leases.transfer = async (...args) => {
      transfers += 1
      if (transfers === 2) throw new Error('redis 不可用')
      return transfer(...args)
    }
    const run = await start(runtime, doc)
    await run.done
    expect(seen.delegate).toContain('没有派出子任务')
    expect(seen.delegate).toContain('redis 不可用')
    // 已转交给子 agent 的 n1 释放了（不还给父 agent）；转交失败的 n2 仍是父 agent 的
    expect(seen.n1).toBeNull()
    expect(seen.n2).toMatchObject({ runId: run.runId })
    expect(seen.n2?.agentId ?? 'main').toBe('main')
    // 没有子 agent 跑过、没有条目
    expect(runtime.turns.filter((turn) => turn.brief !== null)).toEqual([])
    expect(finished(run.events).result.subtasks).toBeUndefined()
    // get_node ×2 + update_node ×2 + delegate_task（被拒也算）+ read_canvas = 6：正好到顶，read_canvas 还能执行
    expect(seen.after).not.toContain('已达上限')
    expect(finished(run.events).outcome).toEqual({ type: 'success' })
    expect(await runtime.leases.list('flow-1')).toEqual(new Map())
  })
})
