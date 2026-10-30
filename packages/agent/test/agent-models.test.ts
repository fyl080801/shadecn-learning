import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type Context, type JsonObject, type Model, type Api } from '@earendil-works/pi-ai'
import { AgentEventType, type AgentStreamEvent } from '@shadecn/shared/agent'
import { nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import { createAgentRegistry, DEFAULT_AGENT_MODEL, type AgentConfig } from '../src/agents.ts'
import { createMemoryAuthorityProvider } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import type { MediaReader } from '../src/media.ts'
import type { ModelResolution } from '../src/model.ts'
import { GATEWAY_ROUTES, type AgentTaskStartResponse, type RunnerInput } from '../src/protocol.ts'
import { createAgentRuntime, type AgentRuntimeOptions, type OpenedCanvas } from '../src/session.ts'
import { BUILTIN_SKILLS } from '../src/skills/index.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import {
  combineUpstreams,
  createInlineDriver,
  gatewayFetch,
  registerScriptedModel,
  testAgentRegistry,
  type ScriptedModel,
  type ScriptedStep,
} from '../src/testing.ts'

/**
 * 按 agent 选模型（docs/26 §3.4，P4）：模型表 = `default` + 其余项；每个 agent 用**它自己定义**的那一项 ——
 * 网关打的上游（地址 + key）、交给 runner 的模型元数据、看图与否（`media-view`）、费用（混用时有一项没定价就记 null）、
 * 跨轮历史的 token 预算（入口 agent 的模型）。不可用的项：入口 agent 用它 = 这一轮不开始；被调用的 agent 用它 = 那次 run_agent 返回错误。
 * 走完整路径：进程内 runner → 网关 → 编排层 → 两个脚本化上游（各自的地址和 key）。
 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const FAST_URL = 'http://fast.upstream.test/v1'
const FAST_KEY = 'fast-secret-key'

const canvasConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({ ...testAgentRegistry().entry, ...overrides })
const reviewerConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: 'reviewer',
  description: '只读审查',
  tools: ['read_canvas', 'get_node'],
  model: 'fast',
  systemPrompt: '你是审查员。',
  filePath: 'agents/reviewer.md',
  ...overrides,
})

const call = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
const say = (text: string) => fauxAssistantMessage(text)
const usageOf = (input: number, output: number): AssistantMessage['usage'] => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})
const priced = (input: number, output: number): Model<Api>['cost'] => ({ input, output, cacheRead: 0, cacheWrite: 0 })

/** 一次模型请求：哪个上游收到的、是不是被调用的 agent、第几步、工具结果 */
interface Turn {
  upstream: 'default' | 'fast'
  called: boolean
  step: number
  tools: string[]
  lastResult: string
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n')
}

function turnOf(upstream: Turn['upstream'], context: Context): Turn {
  const lastResult = [...context.messages].reverse().find((message) => message.role === 'toolResult')
  return {
    upstream,
    called: (context.systemPrompt ?? '').includes('## 你是被调用的 agent'),
    step: context.messages.filter((message) => message.role === 'assistant').length + 1,
    tools: (context.tools ?? []).map((tool) => tool.name),
    lastResult: lastResult ? textOf(lastResult.content) : '',
  }
}

interface SetupOptions extends Partial<AgentRuntimeOptions> {
  defaultModel?: Parameters<typeof registerScriptedModel>[0]
  fastModel?: Parameters<typeof registerScriptedModel>[0]
  /** 覆盖模型表里 fast 那一项（不给 = 可用的脚本化模型） */
  fast?: ModelResolution
}

function setup(handler: (turn: Turn) => AssistantMessage | Promise<AssistantMessage>, options: SetupOptions = {}) {
  const { defaultModel, fastModel, fast, ...rest } = options
  const main = registerScriptedModel(defaultModel)
  const second = registerScriptedModel({ label: 'Fast', id: 'fast-model', baseUrl: FAST_URL, apiKey: FAST_KEY, ...fastModel })
  const turns: Turn[] = []
  const routeOf =
    (upstream: Turn['upstream']): ScriptedStep =>
    async (context) => {
      const turn = turnOf(upstream, context)
      turns.push(turn)
      return handler(turn)
    }
  main.setResponses(Array.from({ length: 50 }, () => routeOf('default')))
  second.setResponses(Array.from({ length: 50 }, () => routeOf('fast')))
  const store = createMemoryConversationStore()
  const runLog = createMemoryRunLog()
  const base = main.runtimeOptions(createInlineDriver())
  const runtime = createAgentRuntime({
    ...base,
    gateway: { ...base.gateway, upstreamFetch: combineUpstreams(main, second) },
    models: { fast: fast ?? { ok: true, value: second.model } },
    agents: createAgentRegistry([canvasConfig(), reviewerConfig()], { skills: BUILTIN_SKILLS, models: [DEFAULT_AGENT_MODEL, 'fast'] }),
    store,
    runLog,
    userProfiles: async (ids) => new Map(ids.map((id) => [id, { id, name: id, avatarUrl: null }])),
    authorities: createMemoryAuthorityProvider(),
    ...rest,
    limits: { changeWindowMs: 5, runsThrottleMs: 5, ...rest.limits },
  })
  const sent: { route: string; reply: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    gatewayFetch(async (request) => {
      const route = new URL(request.url).pathname.replace(/^.*agent-gateway/, '')
      const response = await runtime.gateway.handle(request)
      if (!route.startsWith('/model/')) sent.push({ route, reply: await response.clone().json().catch(() => null) })
      return response
    }),
  )
  return Object.assign(runtime, { turns, sent, store, runLog, main, second: second as ScriptedModel })
}

async function start(runtime: ReturnType<typeof setup>, doc: Y.Doc, text = '开始', conversationId: string | null = null) {
  const events: AgentStreamEvent[] = []
  const started = await runtime.start({
    flowId: 'flow-1',
    userId: 'u1',
    conversationId,
    text,
    openCanvas: async (runId: string): Promise<OpenedCanvas> => ({ ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }), async close() {} }),
    emit: (event) => events.push(event),
  })
  if (!started.ok) throw new Error(`应该启动成功：${started.message}`)
  await started.done
  const last = events.at(-1)
  if (last?.type !== AgentEventType.RUN_FINISHED) throw new Error(`最后一帧不是 RUN_FINISHED：${JSON.stringify(last)}`)
  const first = events[0]
  return { last, runId: started.runId, threadId: first?.type === AgentEventType.RUN_STARTED ? first.threadId : '' }
}

const taskInputs = (runtime: ReturnType<typeof setup>) =>
  runtime.sent.flatMap((entry) =>
    entry.route === GATEWAY_ROUTES.taskStart && (entry.reply as AgentTaskStartResponse | null)?.ok
      ? [(entry.reply as Extract<AgentTaskStartResponse, { ok: true }>).agent]
      : [],
  )
const runnerInputOf = (runtime: ReturnType<typeof setup>) => runtime.sent.find((item) => item.route === GATEWAY_ROUTES.input)!.reply as RunnerInput

function seedText(doc: Y.Doc, id: string) {
  nodesMap(doc).set(id, toYNode({ ...buildNodeRecord({ id, type: 'text', label: `节点${id}`, position: { x: 0, y: 0 } }), data: { text: '原文' } }))
}

/** canvas 第 1 步请 reviewer、reviewer 读一次再交回、canvas 收尾 */
const delegateScript = (turn: Turn): AssistantMessage => {
  if (!turn.called) {
    return turn.step === 1
      ? { ...call('run_agent', { agent: 'reviewer', task: '检查 n1', nodeIds: ['n1'] }), usage: usageOf(1000, 100) }
      : { ...say('审查完了'), usage: usageOf(500, 50) }
  }
  return turn.step === 1 ? { ...call('get_node', { id: 'n1' }), usage: usageOf(2000, 10) } : { ...say('n1 没问题'), usage: usageOf(1000, 20) }
}

describe('每个 agent 用它自己定义的模型（验收 6）', () => {
  it('reviewer 配了 fast：它的请求打到 fast 的上游（地址、key、模型 id 都是那一项的），canvas 的打到 default；runner 拿到的是各自的模型元数据', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    const runtime = setup(delegateScript)
    const { last, runId } = await start(runtime, doc)
    expect(last.outcome).toEqual({ type: 'success' })

    // 入口 agent 的两步在 default，reviewer 的两步在 fast
    expect(runtime.turns.map((turn) => [turn.called, turn.upstream])).toEqual([
      [false, 'default'],
      [true, 'fast'],
      [true, 'fast'],
      [false, 'default'],
    ])
    expect(runtime.second.requests).toHaveLength(2)
    for (const request of runtime.second.requests) {
      expect(request.url).toBe(`${FAST_URL}/chat/completions`)
      expect(request.headers.get('authorization')).toBe(`Bearer ${FAST_KEY}`)
      expect((request.body as { model?: string }).model).toBe('fast-model')
    }
    expect(runtime.main.requests).toHaveLength(2)
    for (const request of runtime.main.requests) expect((request.body as { model?: string }).model).toBe('scripted-model')

    // runner 拿到的模型元数据：入口 agent 的是 default 的，reviewer 的是 fast 的（都去掉了地址）
    expect(runnerInputOf(runtime).entry.model).toMatchObject({ id: 'scripted-model' })
    const [input] = taskInputs(runtime)
    expect(input!.model).toMatchObject({ id: 'fast-model', name: 'Fast' })
    expect(input!.model).not.toHaveProperty('baseUrl')

    // 运行日志：model 记入口 agent 的；token 全轮合计；两个模型都没定价 → 费用 null
    expect(runtime.runLog.runs.get(runId)).toMatchObject({
      model: 'Faux',
      usage: { inputTokens: 4500, outputTokens: 180, costUsd: null },
    })
    expect(runtime.modelLabel).toBe('Faux')
  })

  it('费用按每次请求它自己的模型算再相加：两个都有价格 → 合计；有一个没价格 → null（不报一个偏低的数）', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    // default：1 / 2 美元每百万 token；fast：10 / 20
    const both = setup(delegateScript, { defaultModel: { cost: priced(1, 2) }, fastModel: { cost: priced(10, 20) } })
    const ran = await start(both, doc)
    const cost = both.runLog.runs.get(ran.runId)!
    // canvas：1500 输入 × 1 + 150 输出 × 2；reviewer：3000 × 10 + 30 × 20（单位：美元每百万 token）
    const expected = (1500 * 1 + 150 * 2 + 3000 * 10 + 30 * 20) / 1_000_000
    expect('usage' in cost && cost.usage.costUsd).toBeCloseTo(expected, 10)

    const doc2 = new Y.Doc()
    seedText(doc2, 'n1')
    // 入口 agent 的模型有价格、被调用的 agent 的没有：只要有一次请求的模型没定价，这一轮的费用就是 null
    const mixed = setup(delegateScript, { defaultModel: { cost: priced(1, 2) } })
    const mixedRun = await start(mixed, doc2)
    expect(mixed.runLog.runs.get(mixedRun.runId)).toMatchObject({ usage: { inputTokens: 4500, outputTokens: 180, costUsd: null } })

    // 对照：入口 agent 有价格、这一轮没调别的 agent → 照常有数
    const solo = setup(() => ({ ...say('好'), usage: usageOf(1000, 0) }), { defaultModel: { cost: priced(1, 2) } })
    const soloRun = await start(solo, new Y.Doc())
    const soloLog = solo.runLog.runs.get(soloRun.runId)!
    expect('usage' in soloLog && soloLog.usage.costUsd).toBeCloseTo(0.001, 10)
  })
})

describe('模型不可用：不是启动错误，到用时才报', () => {
  it('被调用的 agent 的模型不可用（环境变量没设）：那次 run_agent 返回错误给调用方，没有发起任务，fast 的上游没被打过', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    let canvasSaw = ''
    const runtime = setup(
      (turn) => {
        if (turn.step === 1) return call('run_agent', { agent: 'reviewer', task: '检查 n1' })
        canvasSaw = turn.lastResult
        return say('它用不了，我自己看')
      },
      { fast: { ok: false, reason: 'apiKey 引用的环境变量 AGENT_FAST_KEY 没有设置' } },
    )
    expect(runtime.enabled).toBe(true)
    const { last } = await start(runtime, doc)
    expect(last.outcome).toEqual({ type: 'success' })
    expect(canvasSaw).toContain('agent reviewer 的模型「fast」不可用，没有发起任务：apiKey 引用的环境变量 AGENT_FAST_KEY 没有设置')
    expect(taskInputs(runtime)).toEqual([])
    expect(last.result.subtasks).toBeUndefined()
    expect(runtime.second.requests).toHaveLength(0)
    expect(runtime.turns.every((turn) => turn.upstream === 'default' && !turn.called)).toBe(true)
  })

  it('被调用的 agent 的模型线协议服务端调不了：同样按不可用处理（启动时打一行警告）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let canvasSaw = ''
    const template = registerScriptedModel({ id: 'fast-model', baseUrl: FAST_URL, apiKey: FAST_KEY })
    const runtime = setup(
      (turn) => {
        if (turn.step === 1) return call('run_agent', { agent: 'reviewer', task: '检查' })
        canvasSaw = turn.lastResult
        return say('好')
      },
      { fast: { ok: true, value: { ...template.model, model: { ...template.model.model, api: 'bedrock-converse-stream' } } } },
    )
    expect(warn.mock.calls.some((args) => String(args[0]).includes('模型表的「fast」不可用'))).toBe(true)
    await start(runtime, new Y.Doc())
    expect(canvasSaw).toContain('agent reviewer 的模型「fast」不可用')
    expect(canvasSaw).toContain('bedrock-converse-stream')
  })

  it('入口 agent 的模型不可用：agent 未启用，这一轮不开始（同没配模型），原因说出是哪一项', async () => {
    const runtime = setup(() => say('不该跑'), {
      fast: { ok: false, reason: '没有 anthropic 的 API key' },
      agents: createAgentRegistry([canvasConfig({ model: 'fast' }), reviewerConfig({ model: DEFAULT_AGENT_MODEL })], {
        skills: BUILTIN_SKILLS,
        models: [DEFAULT_AGENT_MODEL, 'fast'],
      }),
    })
    expect(runtime.enabled).toBe(false)
    expect(runtime.modelLabel).toBeNull()
    expect(runtime.disabledReason).toBe('入口 agent canvas 的模型「fast」不可用：没有 anthropic 的 API key')
    const started = await runtime.start({
      flowId: 'flow-1',
      userId: 'u1',
      conversationId: null,
      text: '你好',
      openCanvas: () => Promise.reject(new Error('不该打开画布')),
      emit: () => {},
    })
    expect(started).toEqual({ ok: false, reason: 'disabled', message: runtime.disabledReason })
    expect(runtime.turns).toEqual([])
  })

  it('入口 agent 用非 default 的模型、default 没配：照样启用，请求打到它自己的上游；宿主的 disabled 优先于模型表', async () => {
    const options = {
      model: null,
      disabledReason: '没有 anthropic 的 API key',
      agents: createAgentRegistry([canvasConfig({ model: 'fast' })], { skills: BUILTIN_SKILLS, models: [DEFAULT_AGENT_MODEL, 'fast'] }),
    }
    const runtime = setup(() => say('好'), options)
    expect(runtime.enabled).toBe(true)
    expect(runtime.modelLabel).toBe('Fast')
    await start(runtime, new Y.Doc())
    expect(runtime.turns.map((turn) => turn.upstream)).toEqual(['fast'])

    const off = setup(() => say('好'), { ...options, disabled: 'k8s 沙箱不可用' })
    expect(off.enabled).toBe(false)
    expect(off.disabledReason).toBe('k8s 沙箱不可用')
  })

  it('模型表和定义对不上是装配错误：models 里写 default、定义引用了表里没有的 key —— createAgentRuntime 抛错', () => {
    expect(() => setup(() => say('x'), { models: { default: { ok: false, reason: 'x' } } })).toThrow(/default 由 model/)
    expect(() =>
      setup(() => say('x'), {
        models: {},
      }),
    ).toThrow(/agents\/reviewer\.md：model「fast」不在模型表里/)
  })
})

describe('跟着模型走的东西按 agent 自己的模型算', () => {
  const reader: MediaReader = { read: () => Promise.reject(new Error('测试里不读')) }

  it('看图：只有吃图片的模型拿得到 media-view —— default 只吃文字、fast 吃图片，入口 agent 没有，reviewer 有；这一轮提供的是并', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    const runtime = setup(delegateScript, {
      mediaReader: reader,
      fastModel: { imageInput: true },
      agents: createAgentRegistry([canvasConfig(), reviewerConfig({ tools: undefined })], {
        skills: BUILTIN_SKILLS,
        models: [DEFAULT_AGENT_MODEL, 'fast'],
      }),
    })
    await start(runtime, doc)
    const input = runnerInputOf(runtime)
    expect(input.entry.skills.offered).not.toContain('media-view')
    expect(input.offered).toContain('media-view')
    const [task] = taskInputs(runtime)
    expect(task!.skills.offered).toContain('media-view')
    expect(task!.model.input).toEqual(['text', 'image'])
    // 入口 agent 硬加载也不行（这一轮对它不提供）
    expect(runtime.turns.find((turn) => !turn.called)!.tools).not.toContain('view_node_media')
  })

  it('历史的 token 预算按入口 agent 的模型：入口 agent 用窗口小的 fast 时长回复被裁掉，default 的窗口再大也不算数', async () => {
    const long = '长'.repeat(100_000) // ≈ 2.9 万 token
    const agents = createAgentRegistry([canvasConfig({ model: 'fast' })], { skills: BUILTIN_SKILLS, models: [DEFAULT_AGENT_MODEL, 'fast'] })
    const template = registerScriptedModel({ label: 'Fast', id: 'fast-model', baseUrl: FAST_URL, apiKey: FAST_KEY })
    const narrow = setup(() => say(long), {
      agents,
      fast: { ok: true, value: { ...template.model, model: { ...template.model.model, contextWindow: 40_000 } } },
    })
    // combineUpstreams 按地址分给 setup 自己建的 fast 上游（同地址同 key），回复同样是这一条长文
    const { threadId } = await start(narrow, new Y.Doc())
    expect(narrow.turns.map((turn) => turn.upstream)).toEqual(['fast'])
    expect(narrow.store.rows.get(threadId)!.llmMessages).toEqual([])

    // 对照：fast 窗口大（默认 128k）时同一条留着
    const wide = setup(() => say(long), { agents })
    const kept = await start(wide, new Y.Doc())
    expect(wide.store.rows.get(kept.threadId)!.llmMessages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })
})
