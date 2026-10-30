import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  fauxAssistantMessage,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type Context,
  type JsonObject,
} from '@earendil-works/pi-ai'
import { AgentEventType, type AgentChatMessage, type AgentStreamEvent } from '@shadecn/shared/agent'
import { nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import { createAgentRegistry, DEFAULT_AGENT_MODEL, type AgentConfig, type AgentRegistry } from '../src/agents.ts'
import { createMemoryAuthorityProvider } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { createMemoryLeaseRegistry, type NodeLease } from '../src/occupancy.ts'
import {
  GATEWAY_ROUTES,
  parseAgentTaskStartRequest,
  RUNNER_PROTOCOL_VERSION,
  type AgentTaskStartResponse,
  type RunnerInput,
} from '../src/protocol.ts'
import { createAgentRuntime, type AgentRuntimeOptions, type OpenedCanvas } from '../src/session.ts'
import { BUILTIN_SKILLS, canvasSkill, createSkillRegistry, defineSkill, type SkillRegistry } from '../src/skills/index.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import { createInlineDriver, gatewayFetch, registerScriptedModel, TEST_GATEWAY_URL, testAgentRegistry, type ScriptedStep } from '../src/testing.ts'
import type { CanvasTool } from '../src/tools.ts'

/**
 * 对等的 agent 定义与任务（docs/26 P3）：`run_agent({ agent, task, nodeIds? })` 按**被调用的 agent 自己的定义**跑（系统提示正文、
 * 工具白名单、模型）、可调用的 agent 目录、调用深度上限（含深度 2 的嵌套）、runner 按白名单滤工具（含 runner 自己执行的工具）、
 * 旧数据（技能 id `delegate`、工具名 `delegate_task`）照常读。走完整路径：进程内 runner → 网关 → 编排层 → 脚本化上游。
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const REVIEWER_BODY = '你是审查员：只读，不改节点。'

const canvasConfig = (): AgentConfig => testAgentRegistry().entry

const reviewerConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: 'reviewer',
  description: '只读审查：检查节点内容并列出问题',
  tools: ['read_canvas', 'get_node'],
  systemPrompt: REVIEWER_BODY,
  filePath: 'agents/reviewer.md',
  ...overrides,
})

const registryOf = (configs: AgentConfig[], skills: SkillRegistry = BUILTIN_SKILLS): AgentRegistry =>
  createAgentRegistry(configs, { skills, models: [DEFAULT_AGENT_MODEL] })

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n')
}

/** 一次模型请求：谁（入口 agent 为 null，被调用的 agent 是它任务说明的第一行）、第几步、工具表、系统提示、最后一条工具结果 */
interface Turn {
  task: string | null
  step: number
  tools: string[]
  systemPrompt: string
  context: Context
  lastResult: string
}

function turnOf(context: Context): Turn {
  const firstUser = context.messages.find((message) => message.role === 'user')
  const called = (context.systemPrompt ?? '').includes('## 你是被调用的 agent')
  const lastResult = [...context.messages].reverse().find((message) => message.role === 'toolResult')
  return {
    task: called ? (textOf(firstUser?.content).split('\n')[1] ?? '') : null,
    step: context.messages.filter((message) => message.role === 'assistant').length + 1,
    tools: (context.tools ?? []).map((tool) => tool.name),
    systemPrompt: context.systemPrompt ?? '',
    context,
    lastResult: lastResult ? textOf(lastResult.content) : '',
  }
}

const call = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
const say = (text: string) => fauxAssistantMessage(text)
const runAgent = (agent: string, task: string, nodeIds?: string[]) => call('run_agent', { agent, task, ...(nodeIds ? { nodeIds } : {}) })

function seedText(doc: Y.Doc, id: string) {
  nodesMap(doc).set(id, toYNode({ ...buildNodeRecord({ id, type: 'text', label: `节点${id}`, position: { x: 0, y: 0 } }), data: { text: '原文' } }))
}

interface SetupOptions extends Partial<AgentRuntimeOptions> {
  skills?: SkillRegistry
}

function setup(handler: (turn: Turn) => AssistantMessage | Promise<AssistantMessage>, options: SetupOptions = {}) {
  const faux = registerScriptedModel()
  const turns: Turn[] = []
  const route: ScriptedStep = async (context) => {
    const turn = turnOf(context)
    turns.push(turn)
    return handler(turn)
  }
  faux.setResponses(Array.from({ length: 100 }, () => route))
  const { skills, ...rest } = options
  const store = createMemoryConversationStore()
  const leases = createMemoryLeaseRegistry()
  const runtime = createAgentRuntime({
    ...faux.runtimeOptions(createInlineDriver(skills ? { skills } : {})),
    ...(skills ? { skills } : {}),
    store,
    leases,
    runLog: createMemoryRunLog(),
    userProfiles: async (ids) => new Map(ids.map((id) => [id, { id, name: id, avatarUrl: null }])),
    authorities: createMemoryAuthorityProvider(),
    ...rest,
    limits: { changeWindowMs: 5, runsThrottleMs: 5, ...rest.limits },
  })
  /** runner 发往网关的请求和回复（模型请求只记路由） */
  const sent: { route: string; token: string | null; body: unknown; reply: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    gatewayFetch(async (request) => {
      const route = new URL(request.url).pathname.replace(/^.*agent-gateway/, '')
      if (route.startsWith('/model/')) {
        sent.push({ route, token: request.headers.get('authorization'), body: null, reply: null })
        return runtime.gateway.handle(request)
      }
      const body = await request.clone().json().catch(() => null)
      const response = await runtime.gateway.handle(request)
      sent.push({ route, token: request.headers.get('authorization'), body, reply: await response.clone().json().catch(() => null) })
      return response
    }),
  )
  return Object.assign(runtime, { turns, sent, store, leases })
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
  return { events, last, threadId: first?.type === AgentEventType.RUN_STARTED ? first.threadId : '' }
}

/** `/agent/task/start` 成功的回复（被调用的 agent 的输入） */
const taskInputs = (runtime: ReturnType<typeof setup>) =>
  runtime.sent.flatMap((entry) =>
    entry.route === GATEWAY_ROUTES.taskStart && (entry.reply as AgentTaskStartResponse | null)?.ok
      ? [(entry.reply as Extract<AgentTaskStartResponse, { ok: true }>).agent]
      : [],
  )

describe('run_agent 用被调用的 agent 自己的定义（验收 4）', () => {
  it('canvas 请 reviewer：reviewer 的请求用它自己的系统提示和工具表（只读工具 + load_skill + request_confirmation，没有 run_agent）；条目标着 reviewer；结果交回 canvas', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    let canvasSaw = ''
    const runtime = setup(
      (turn) => {
        if (turn.task === null) {
          if (turn.step === 1) return runAgent('reviewer', '检查 n1', ['n1'])
          canvasSaw = turn.lastResult
          return say('审查完了')
        }
        return turn.step === 1 ? call('get_node', { id: 'n1' }) : say('n1 没问题')
      },
      { agents: registryOf([canvasConfig(), reviewerConfig()]) },
    )
    const { last } = await start(runtime, doc)
    expect(last.outcome).toEqual({ type: 'success' })

    const entry = runtime.turns.find((turn) => turn.task === null)!
    // 入口 agent 的 run_agent：agent 的取值是全部定义，描述里列出可调用的 agent
    const runTool = entry.context.tools!.find((tool) => tool.name === 'run_agent')!
    expect(JSON.stringify(runTool.parameters)).toContain('"enum":["canvas","reviewer"]')
    expect(runTool.description).toContain('- reviewer：只读审查：检查节点内容并列出问题')
    expect(runTool.description).toContain('- canvas：')

    const reviewer = runtime.turns.filter((turn) => turn.task === '检查 n1')
    expect(reviewer).toHaveLength(2)
    expect(reviewer[0]!.systemPrompt.startsWith(`${REVIEWER_BODY}\n\n## 通用规则`)).toBe(true)
    expect(reviewer[0]!.systemPrompt).not.toContain('你是一个画布助手')
    expect(reviewer[0]!.systemPrompt).toContain('## 你是被调用的 agent')
    expect(reviewer[0]!.systemPrompt).toContain('你不能再调用别的 agent')
    expect(reviewer[0]!.tools).toEqual(['load_skill', 'request_confirmation', 'read_canvas', 'get_node'])

    // 交给 runner 的是它自己的那一份：白名单、技能、模型
    const [input] = taskInputs(runtime)
    expect(input).toMatchObject({ name: 'reviewer', tools: ['read_canvas', 'get_node'], skills: { loaded: ['canvas'], offered: ['canvas'] } })
    expect(input!.model).toMatchObject({ id: expect.any(String), api: expect.any(String) })
    expect(input!.model).not.toHaveProperty('baseUrl')
    const runnerInput = runtime.sent.find((item) => item.route === GATEWAY_ROUTES.input)!.reply as RunnerInput
    expect(runnerInput.entry).toMatchObject({ name: 'canvas', tools: null })
    expect(runnerInput.entry.skills.offered).toContain('agents')
    expect(runnerInput.agents.map((agent) => agent.name)).toEqual(['canvas', 'reviewer'])

    expect(canvasSaw).toContain('任务完成（reviewer）：检查 n1')
    expect(canvasSaw).toContain('n1 没问题')
    expect(last.result.subtasks).toMatchObject([{ agent: 'reviewer', brief: '检查 n1', status: 'done', text: 'n1 没问题' }])
    expect(last.result.subtasks![0]).not.toHaveProperty('parentId')
  })

  it('点名一个不存在的 agent：服务端按 schema 预判拒绝（和 runner 里 pi 的校验同一个 schema），没有发起任务', async () => {
    const doc = new Y.Doc()
    let canvasSaw = ''
    const runtime = setup((turn) => {
      if (turn.task === null) {
        if (turn.step === 1) return runAgent('ghost', '做点事')
        canvasSaw = turn.lastResult
        return say('好')
      }
      return say('不该跑到这里')
    })
    const { last } = await start(runtime, doc)
    expect(canvasSaw).toContain('Validation failed for tool "run_agent"')
    expect(runtime.turns.filter((turn) => turn.task !== null)).toEqual([])
    expect(last.result.subtasks).toBeUndefined()
  })
})

describe('调用深度上限', () => {
  it('上限 2：canvas → canvas → canvas 嵌套跑通；深度 1 有 run_agent、深度 2 没有；占用从调用方转给深度 2；嵌套条目带 parentId；等任务的时间不计入单轮时长', async () => {
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    const seen: { depth2Lease?: NodeLease | null; depth2Id?: string; outerSaw?: string; entrySaw?: string; forged?: unknown } = {}
    const runtime: ReturnType<typeof setup> = setup(
      async (turn) => {
        if (turn.task === null) {
          if (turn.step === 1) return runAgent('canvas', '外层')
          seen.entrySaw = turn.lastResult
          return say('都做完了')
        }
        if (turn.task === '外层') {
          if (turn.step === 1) return call('update_node', { id: 'n1', data: { text: '外层改的' } })
          if (turn.step === 2) return runAgent('canvas', '内层', ['n1'])
          seen.outerSaw = turn.lastResult
          return say('外层完成')
        }
        // 内层（深度 2）
        if (turn.step === 1) {
          const inputs = taskInputs(runtime)
          seen.depth2Id = inputs[1]!.agentId
          seen.depth2Lease = await runtime.leases.get('flow-1', 'n1')
          // 拿这一轮的令牌、以深度 2 的 id 伪造它发起的任务：深度到了上限，服务端拒
          const token = runtime.sent.find((entry) => entry.route === GATEWAY_ROUTES.taskStart)!.token!
          seen.forged = await (
            await fetch(`${TEST_GATEWAY_URL}${GATEWAY_ROUTES.taskStart}`, {
              method: 'POST',
              headers: { authorization: token, 'content-type': 'application/json' },
              body: JSON.stringify({ agentId: seen.depth2Id, toolCallId: 'call_forged', agent: 'canvas', task: '第三层', nodeIds: [] }),
            })
          ).json()
          return call('update_node', { id: 'n1', data: { text: '内层改的' } })
        }
        // 跑得比单轮上限久：上层都在等它，计时暂停
        await new Promise((resolve) => setTimeout(resolve, 400))
        return say('内层完成')
      },
      { limits: { maxCallDepth: 2, timeoutMs: 250, totalTimeoutMs: 10_000, idleTimeoutMs: 5000 } },
    )
    const { last } = await start(runtime, doc)
    expect(last.outcome).toEqual({ type: 'success' })

    const outer = runtime.turns.filter((turn) => turn.task === '外层')
    const inner = runtime.turns.filter((turn) => turn.task === '内层')
    expect(outer[0]!.tools).toContain('run_agent')
    expect(outer[0]!.systemPrompt).toContain('你也可以用 run_agent')
    expect(inner[0]!.tools).not.toContain('run_agent')
    expect(inner[0]!.tools).toContain('request_confirmation')
    expect(inner[0]!.systemPrompt).toContain('你不能再调用别的 agent')

    // 占用：深度 1 写过的 n1 交给深度 2，转交原子地改成深度 2 持有，它写的时候不被「调用方正在改」拒
    expect(seen.depth2Lease).toMatchObject({ agentId: seen.depth2Id })
    expect(inner[1]!.lastResult).not.toContain('正在被')
    expect((nodesMap(doc).get('n1')!.get('data') as Y.Map<unknown>).get('text')).toBe('内层改的')
    expect(seen.forged).toMatchObject({ ok: false, message: expect.stringContaining('调用深度已达上限 2') })

    // 结果一层层交回
    expect(seen.outerSaw).toContain('任务完成（canvas）：内层')
    expect(seen.outerSaw).toContain('内层完成')
    expect(seen.entrySaw).toContain('任务完成（canvas）：外层')
    expect(seen.entrySaw).toContain('外层完成')
    expect(seen.entrySaw).not.toContain('内层完成')

    // 条目平铺：嵌套的带 parentId，toolCallId 对得上父条目里那条 run_agent
    const subtasks = last.result.subtasks!
    expect(subtasks).toHaveLength(2)
    const [outerTask, innerTask] = subtasks
    expect(outerTask).toMatchObject({ agent: 'canvas', brief: '外层', status: 'done' })
    expect(outerTask).not.toHaveProperty('parentId')
    expect(innerTask).toMatchObject({ agent: 'canvas', brief: '内层', status: 'done', parentId: outerTask!.id, changedNodeIds: ['n1'] })
    const parentCall = outerTask!.toolCalls.find((item) => item.name === 'run_agent')!
    expect(parentCall).toMatchObject({ status: 'done', summary: '任务完成（canvas）：内层' })
    expect(innerTask!.toolCallId).toBe(parentCall.id)
    // 入口 agent 的 toolCalls 里只有它自己的那条 run_agent
    expect(last.result.toolCalls.map((item) => item.name)).toEqual(['run_agent'])
    expect(await runtime.leases.list('flow-1')).toEqual(new Map())
  })

  it('上限 0：谁都不能发起任务 —— 入口 agent 的工具表里没有 run_agent；会话记着的 agents 不算「本轮不可用」', async () => {
    const runtime = setup(() => say('好'), { limits: { maxCallDepth: 0 } })
    const doc = new Y.Doc()
    const first = await start(runtime, doc)
    // 会话记着以前加载过的 agents（旧 id delegate）
    runtime.store.rows.get(first.threadId)!.skills = ['canvas', 'delegate']
    await start(runtime, doc, '再来', first.threadId)
    for (const turn of runtime.turns) {
      expect(turn.tools).not.toContain('run_agent')
      expect(turn.systemPrompt).not.toContain('本轮不可用')
    }
    expect(runtime.turns).toHaveLength(2)
    const runnerInput = runtime.sent.find((item) => item.route === GATEWAY_ROUTES.input)!.reply as RunnerInput
    expect(runnerInput.entry.skills.offered).not.toContain('agents')
  })
})

describe('runner 按白名单滤工具（docs/26 §3.3，P2 留下的缺口）', () => {
  /** 一个技能里混着网关工具和 runner 自己执行的工具：白名单只留网关工具时，runner 那个不能在沙箱里被执行 */
  let localRuns = 0
  const params = Type.Object({}, { additionalProperties: false })
  const tool = (name: string, execution: 'gateway' | 'runner'): CanvasTool => {
    const made: CanvasTool<typeof params> = {
      name,
      capability: 'flow:read',
      label: name,
      description: `测试工具 ${name}`,
      parameters: params,
      execution,
      describe: () => name,
      async execute() {
        if (execution === 'runner') localRuns += 1
        return { content: [{ type: 'text', text: `${name} ok` }], details: { summary: name, elementIds: [] } }
      },
    }
    return made as unknown as CanvasTool
  }
  const mixed = defineSkill({
    id: 'mixed',
    title: '混合（测试）',
    summary: '网关工具 + runner 工具',
    prompt: '测试用',
    tools: () => [tool('peek', 'gateway'), tool('local_cmd', 'runner')],
    requires: ['flow:read'],
    activation: 'always',
  })
  const skills = createSkillRegistry([canvasSkill, mixed])

  it('白名单只有 peek：模型硬调 local_cmd，服务端预判 Tool not found，runner 里 pi 也找不到它（没执行）；不滤时它会在沙箱里执行', async () => {
    const script = (turn: Turn) => (turn.step === 1 ? call('local_cmd', {}) : say('好'))
    localRuns = 0
    const filtered = setup(script, {
      skills,
      agents: registryOf([{ ...canvasConfig(), tools: ['peek', 'read_canvas'] }], skills),
    })
    const { threadId } = await start(filtered, new Y.Doc())
    expect(filtered.turns[0]!.tools).toEqual(['load_skill', 'read_canvas', 'peek'])
    expect(localRuns).toBe(0)
    const stored = filtered.store.rows.get(threadId)!.llmMessages.filter((message) => message.role === 'toolResult')
    expect(stored).toMatchObject([{ toolName: 'local_cmd', isError: true, content: [{ type: 'text', text: 'Tool local_cmd not found' }] }])
    const input = filtered.sent.find((item) => item.route === GATEWAY_ROUTES.input)!.reply as RunnerInput
    expect(input.entry.tools).toEqual(['peek', 'read_canvas'])

    // 对照：不写 tools（全部），runner 真会执行它 —— 上面的 0 是白名单滤掉的，不是别的原因
    localRuns = 0
    const unfiltered = setup(script, { skills, agents: registryOf([canvasConfig()], skills) })
    await start(unfiltered, new Y.Doc())
    expect(localRuns).toBe(1)
  })
})

describe('旧数据（runner 协议第 8 版之前存的）', () => {
  it('会话里存着技能 delegate、模型上下文里有 delegate_task 的调用与结果、条目没有 agent：下一轮照常跑，delegate 读成 agents（不进「本轮不可用」），旧历史原样带给模型', async () => {
    const doc = new Y.Doc()
    const runtime = setup((turn) => say(turn.step === 1 ? '第一轮' : '第二轮'))
    const first = await start(runtime, doc, '第一轮')
    const row = runtime.store.rows.get(first.threadId)!
    // 改成 P3 之前存下的样子
    row.skills = ['canvas', 'delegate']
    row.llmMessages = [
      { role: 'user', content: '旧的一轮', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_old', name: 'delegate_task', arguments: { brief: '旧任务' } }],
        api: 'openai-completions',
        provider: 'test',
        model: 'test',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: 2,
      },
      { role: 'toolResult', toolCallId: 'call_old', toolName: 'delegate_task', content: [{ type: 'text', text: '子任务完成：旧任务' }], isError: false, timestamp: 3 },
      { role: 'assistant', content: [{ type: 'text', text: '旧的收尾' }], api: 'openai-completions', provider: 'test', model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 4 },
    ] as never
    const legacyAssistant: AgentChatMessage = {
      id: 'msg_old',
      role: 'assistant',
      text: '',
      createdAt: 2,
      toolCalls: [{ id: 'call_old', name: 'delegate_task', summary: '子任务：旧任务', status: 'done' }],
      subtasks: [
        { id: 'sub_old', toolCallId: 'call_old', brief: '旧任务', nodeIds: [], status: 'done', startedAt: 1, finishedAt: 2, toolCalls: [], text: '好了', changedNodeIds: [] } as never,
      ],
    }
    row.messages = [...row.messages, legacyAssistant]

    const second = await start(runtime, doc, '第二轮', first.threadId)
    expect(second.last.outcome).toEqual({ type: 'success' })
    const request = runtime.turns.at(-1)!
    expect(request.systemPrompt).not.toContain('本轮不可用')
    expect(request.tools).toContain('run_agent')
    expect(JSON.stringify(request.context.messages)).toContain('delegate_task')
    // 落库：技能 id 换成了现在的；旧的 assistant 消息原样留着（前端按旧工具名画任务条目，见 shared 的 LEGACY_AGENT_DELEGATE_TOOL_NAME）
    const after = runtime.store.rows.get(first.threadId)!
    expect(after.skills).toContain('agents')
    expect(after.skills).not.toContain('delegate')
    const view = await runtime.getConversation('flow-1', 'u1', first.threadId)
    const kept = view?.messages.find((message) => message.id === 'msg_old')
    expect(kept).toMatchObject({ role: 'assistant', toolCalls: [{ name: 'delegate_task' }] })
  })
})

describe('协议版本', () => {
  it('第 8 版起：路由是 /agent/task/start 与 /agent/task/finish', () => {
    expect(RUNNER_PROTOCOL_VERSION).toBeGreaterThanOrEqual(8)
    expect(GATEWAY_ROUTES).toMatchObject({ taskStart: '/agent/task/start', taskFinish: '/agent/task/finish' })
    expect(GATEWAY_ROUTES).not.toHaveProperty('delegate')
  })

  it('发起请求的解析：agent 名合法、task 非空（去首尾空白）、节点去重；第 7 版的 { brief } 不认', () => {
    const base = { agentId: 'main', toolCallId: 'c1', agent: 'reviewer', task: ' 检查 ', nodeIds: ['n1', 'n1'] }
    expect(parseAgentTaskStartRequest(base)).toEqual({ ...base, task: '检查', nodeIds: ['n1'] })
    expect(parseAgentTaskStartRequest({ ...base, agent: 'Bad Name' })).toBeNull()
    expect(parseAgentTaskStartRequest({ ...base, agent: undefined })).toBeNull()
    expect(parseAgentTaskStartRequest({ ...base, task: '  ' })).toBeNull()
    expect(parseAgentTaskStartRequest({ agentId: 'main', toolCallId: 'c1', brief: '旧的', nodeIds: [] })).toBeNull()
  })
})
