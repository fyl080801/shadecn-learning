import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxToolCall, Type, type Context } from '@earendil-works/pi-ai'
import {
  AGENT_CANVAS_CHANGE_EVENT,
  AGENT_SKILL_LOADED_EVENT,
  AgentEventType,
  formatNodeMention,
  type AgentStreamEvent,
  type AgentSkillLoadedMessage,
} from '@shadecn/shared/agent'
import { nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import { createMemoryAuthorityProvider, type MemoryAuthorityOptions } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import type { MediaReader } from '../src/media.ts'
import { createGatewayClient } from '../src/runner/client.ts'
import type { SandboxDriver, SandboxExit } from '../src/sandbox/driver.ts'
import { createAgentRuntime, type AgentRuntimeOptions, type OpenedCanvas } from '../src/session.ts'
import {
  BUILTIN_SKILLS,
  canvasSkill,
  createSkillRegistry,
  defineSkill,
  LOAD_SKILL_ALONE_REASON,
  mediaExecSkill,
  mediaViewSkill,
  type AgentSkill,
  type SkillAvailability,
} from '../src/skills/index.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import {
  createInlineDriver,
  gatewayFetch,
  loadSkillStep,
  registerScriptedModel,
  type ScriptedModel,
  type ScriptedStep,
} from '../src/testing.ts'
import type { CanvasTool } from '../src/tools.ts'
import { TOOL_CALL_UNBOUND } from '../src/transcript.ts'

/**
 * 内置技能（docs/23）走完整的二期路径：scripted model + 进程内驱动（runner 就在本进程，照样只经网关协议说话）。
 * 逐条对着 docs/23 §6 的验收写；这里用**测试专用**的技能注册进去验证注册表的各种形态（真的导演台技能见 director-skill.test.ts）
 * （auto 按节点类型自动加载、按需加载、runner 执行的工具、可用条件会变的技能）。
 */

const CANVAS_TOOLS = [
  'read_canvas',
  'get_node',
  'check_connection',
  'add_node',
  'update_node',
  'duplicate_node',
  'connect',
  'delete_elements',
  'move_nodes',
  'resize_node',
  'group_nodes',
  'ungroup',
  'auto_layout',
]

// —— 测试专用的技能 ——

const emptyParams = Type.Object({}, { additionalProperties: false })
const nodeParams = Type.Object({ nodeId: Type.String() }, { additionalProperties: false })

function readTool(name: string): CanvasTool {
  const tool: CanvasTool<typeof emptyParams> = {
    name,
    capability: 'flow:read',
    label: name,
    description: `测试工具 ${name}：数一数画布上有几个节点`,
    parameters: emptyParams,
    describe: () => name,
    async execute() {
      return { content: [{ type: 'text', text: `${name} ok` }], details: { summary: name, elementIds: [] } }
    },
  }
  return tool as unknown as CanvasTool
}

/** 「导演台」的替身：auto，命中 director 类型；工具点名哪个节点都照常执行（没有会话范围） */
const directorFixture = defineSkill({
  id: 'director',
  title: '导演台（测试）',
  summary: '测试用的导演台技能',
  prompt: '测试用的导演台说明',
  tools: () => {
    const tool: CanvasTool<typeof nodeParams> = {
      name: 'get_director_scene',
      capability: 'flow:read',
      label: '读场景',
      description: '读导演台场景（测试）',
      parameters: nodeParams,
      describe: (args) => `读场景 ${args.nodeId}`,
      async execute(_id, args) {
        return { content: [{ type: 'text', text: `场景 ${args.nodeId}` }], details: { summary: '读场景', elementIds: [] } }
      },
    }
    return [tool as unknown as CanvasTool]
  },
  requires: ['flow:read', 'flow:write'],
  activation: 'auto',
  activatesFor: { nodeTypes: ['director'] },
})

/** 「导演台脚本」的替身：要 sandbox:exec，工具在 runner 里执行 */
const scriptFixture = defineSkill({
  id: 'director-script',
  title: '脚本（测试）',
  summary: '测试用的 runner 技能',
  prompt: '测试用的脚本说明',
  tools: () => [{ ...readTool('run_scene_script'), capability: 'sandbox:exec', execution: 'runner' }],
  requires: ['flow:read', 'flow:write', 'sandbox:exec'],
  available: (env) => env.deployment.sandboxExec,
  activation: 'on-demand',
})

/** 写画布的按需技能（只给伪造 runner 的那个用例：没加载时网关不能代它写） */
const stampFixture = defineSkill({
  id: 'stamp',
  title: '盖章（测试）',
  summary: '在画布文档里记一笔',
  prompt: '测试用',
  tools: (ctx) => {
    const tool: CanvasTool<typeof emptyParams> = {
      name: 'stamp',
      capability: 'flow:write',
      label: '盖章',
      description: '在文档里记一笔（测试）',
      parameters: emptyParams,
      describe: () => '盖章',
      async execute() {
        // 测试夹具：直接写一个独立的根类型，只为看「画布变没变」
        await ctx.canvas.write((doc) => doc.getMap('stamps').set('x', true))
        return { content: [{ type: 'text', text: '盖好了' }], details: { summary: '盖章', elementIds: [] } }
      },
    }
    return [tool as unknown as CanvasTool]
  },
  requires: ['flow:read', 'flow:write'],
  activation: 'on-demand',
})

const onDemand = (id: string, extra: Partial<AgentSkill> = {}) =>
  defineSkill({
    id,
    title: `技能 ${id}`,
    summary: `测试技能 ${id}`,
    prompt: `技能 ${id} 的说明`,
    tools: () => [readTool(`${id.replace(/-/g, '_')}_tool`)],
    requires: ['flow:read'],
    activation: 'on-demand',
    ...extra,
  })

/** 可用条件可以在两轮之间翻转的技能（跨轮「本轮不可用」用） */
const flaky = { on: true }
const flakyFixture = onDemand('flaky', { available: () => flaky.on })

const TEST_SKILLS = createSkillRegistry([
  canvasSkill,
  mediaViewSkill,
  mediaExecSkill,
  directorFixture,
  scriptFixture,
  stampFixture,
  flakyFixture,
  onDemand('notes'),
  onDemand('s-a'),
  onDemand('s-b'),
  onDemand('s-c'),
  onDemand('s-d'),
])

// —— 搭一个 runtime ——

let faux: ScriptedModel | null = null

afterEach(() => {
  faux = null
  flaky.on = true
  vi.unstubAllGlobals()
})

interface Setup {
  /** 不给 = 测试注册表；`null` = 用内置注册表（默认路径） */
  registry?: typeof TEST_SKILLS | null
  overrides?: Partial<AgentRuntimeOptions>
  authority?: MemoryAuthorityOptions
  driver?: SandboxDriver
}

function runtimeWith(steps: ScriptedStep[], setup: Setup = {}) {
  faux = registerScriptedModel({ imageInput: true })
  faux.setResponses(steps)
  const registry = setup.registry === undefined ? TEST_SKILLS : setup.registry
  const store = createMemoryConversationStore()
  const runLog = createMemoryRunLog()
  const authorities = createMemoryAuthorityProvider(setup.authority)
  const driver = setup.driver ?? createInlineDriver(registry ? { skills: registry } : {})
  const runtime = createAgentRuntime({
    ...faux.runtimeOptions(driver),
    ...(registry ? { skills: registry } : {}),
    store,
    runLog,
    userProfiles: async (ids) => new Map(ids.map((id) => [id, { id, name: id, avatarUrl: null }])),
    authorities,
    ...setup.overrides,
  })
  vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request)))
  return Object.assign(runtime, { store, runLog, authorities, scripted: faux })
}

function seed(doc: Y.Doc, id: string, type: string, label = `名字-${id}`) {
  nodesMap(doc).set(id, toYNode({ ...buildNodeRecord({ id, type, label, position: { x: 0, y: 0 } }), data: {} }))
}

async function run(
  runtime: ReturnType<typeof runtimeWith>,
  doc: Y.Doc,
  options: { text?: string; conversationId?: string | null; nodeId?: string | null } = {},
) {
  const events: AgentStreamEvent[] = []
  const open = async (runId: string): Promise<OpenedCanvas> => ({
    ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }),
    async close() {},
  })
  const started = await runtime.start({
    flowId: 'flow-1',
    userId: 'u1',
    conversationId: options.conversationId ?? null,
    nodeId: options.nodeId ?? null,
    text: options.text ?? '做点事',
    openCanvas: open,
    emit: (event) => events.push(event),
  })
  if (!started.ok) throw new Error(started.message)
  await started.done
  const first = events[0]
  const threadId = first?.type === AgentEventType.RUN_STARTED ? first.threadId : ''
  return { events, threadId }
}

/** 记下每次模型请求看到的工具名与系统提示 */
function probe() {
  const requests: { tools: string[]; systemPrompt: string; context: Context }[] = []
  const step =
    (reply: () => ReturnType<typeof fauxAssistantMessage>): ScriptedStep =>
    (context) => {
      requests.push({ tools: (context.tools ?? []).map((tool) => tool.name), systemPrompt: context.systemPrompt ?? '', context })
      return reply()
    }
  return { requests, step }
}

/** 模型下一次请求里看到的工具结果文字（线上不带工具名和 isError，名字按 toolCallId 对回去） */
function toolResults(context: Context) {
  const names = new Map(
    context.messages.flatMap((message) =>
      message.role === 'assistant' ? message.content.flatMap((part) => (part.type === 'toolCall' ? [[part.id, part.name] as const] : [])) : [],
    ),
  )
  return context.messages.flatMap((message) =>
    message.role === 'toolResult'
      ? [{ name: names.get(message.toolCallId) ?? '', text: message.content.map((p) => (p.type === 'text' ? p.text : '')).join('') }]
      : [],
  )
}

/** 这个会话落库的模型上下文里的工具结果（带 isError）：runner 报上来的 pi 消息，按发生顺序 */
function storedResults(runtime: ReturnType<typeof runtimeWith>, threadId: string) {
  const row = runtime.store.rows.get(threadId)
  return (row?.llmMessages ?? []).flatMap((message) =>
    message.role === 'toolResult'
      ? [{ name: message.toolName, isError: message.isError, text: message.content.map((p) => (p.type === 'text' ? p.text : '')).join('') }]
      : [],
  )
}

const skillLoadedEvents = (events: AgentStreamEvent[]) =>
  events.flatMap((event) =>
    event.type === AgentEventType.CUSTOM && event.name === AGENT_SKILL_LOADED_EVENT ? [event.value as AgentSkillLoadedMessage] : [],
  )

const toolCallNames = (events: AgentStreamEvent[]) =>
  events.flatMap((event) => (event.type === AgentEventType.TOOL_CALL_START ? [event.toolCallName] : []))

const fakeReader: MediaReader = { read: async () => ({ data: new Uint8Array(), contentType: 'image/png' }) }

// —— 注册表 ——

describe('注册表与 §3.2 的集合计算', () => {
  const env = (overrides: Partial<SkillAvailability> = {}): SkillAvailability => ({
    scopes: new Set(['flow:read', 'flow:write', 'flow:delete', 'llm:invoke', 'sandbox:exec'] as const),
    deployment: { imageInput: true, mediaReader: true, sandboxExec: true },
    ...overrides,
  })

  it('建表时校验：工具名重复、requires 没覆盖工具的能力、offeredWith 超出 requires、起子进程的工具不要 sandbox:exec / 不在 runner、工具叫平台工具的名字都抛', () => {
    expect(() => createSkillRegistry([onDemand('x1'), { ...onDemand('x2'), tools: () => [readTool('x1_tool')] }])).toThrow(/同时属于/)
    expect(() => createSkillRegistry([{ ...onDemand('x3'), requires: [] }])).toThrow(/没有覆盖/)
    expect(() => createSkillRegistry([{ ...onDemand('x8'), offeredWith: ['flow:write'] }])).toThrow(/offeredWith/)
    expect(() =>
      createSkillRegistry([{ ...onDemand('x4'), tools: () => [{ ...readTool('t'), execution: 'runner', spawnsProcess: true }] }]),
    ).toThrow(/sandbox:exec/)
    expect(() =>
      createSkillRegistry([
        { ...onDemand('x9'), requires: ['flow:read', 'sandbox:exec'], tools: () => [{ ...readTool('t9'), spawnsProcess: true }] },
      ]),
    ).toThrow(/只能在 runner 里执行/)
    // 在 runner 里执行、但不起子进程（delegate_task 那种：每一步仍经网关）：不要求 sandbox:exec
    expect(() => createSkillRegistry([{ ...onDemand('x10'), tools: () => [{ ...readTool('t10'), execution: 'runner' }] }])).not.toThrow()
    expect(() => createSkillRegistry([{ ...onDemand('x5'), tools: () => [readTool('load_skill')] }])).toThrow(/load_skill/)
    expect(() => createSkillRegistry([{ ...onDemand('x11'), tools: () => [readTool('request_confirmation')] }])).toThrow(/request_confirmation/)
    expect(() => createSkillRegistry([onDemand('x6'), onDemand('x6')])).toThrow(/重复/)
    expect(() => defineSkill({ ...onDemand('x7'), activation: 'auto' })).toThrow(/activatesFor/)
    // 内置的那份本身是合法的
    expect(BUILTIN_SKILLS.skills.map((skill) => skill.id)).toEqual(['canvas', 'media-view', 'media-exec', 'director', 'delegate'])
  })

  it('画布技能合成一个 canvas：13 个工具，requires 是三项能力的并集，只要 flow:read 就提供', () => {
    const canvas = BUILTIN_SKILLS.get('canvas')!
    expect(canvas.activation).toBe('always')
    expect(canvas.requires).toEqual(['flow:read', 'flow:write', 'flow:delete'])
    expect(BUILTIN_SKILLS.get('canvas-edit')).toBeUndefined()
    expect(CANVAS_TOOLS.map((name) => BUILTIN_SKILLS.skillOfTool(name)?.id)).toEqual(CANVAS_TOOLS.map(() => 'canvas'))
    // 缺写 / 删权限：canvas 照样提供并一开始就加载（写工具到网关逐个判权时被拒）；要 flow:write 的别的技能不提供
    const readOnly = TEST_SKILLS.plan({ env: env({ scopes: new Set(['flow:read', 'llm:invoke'] as const) }), previous: [], mentionedNodeTypes: [] })
    expect(readOnly.loaded.map((skill) => skill.id)).toEqual(['canvas'])
    expect(readOnly.offered.map((skill) => skill.id)).not.toContain('stamp')
    // 连 flow:read 都没有：不提供
    const none = TEST_SKILLS.plan({ env: env({ scopes: new Set(['llm:invoke'] as const) }), previous: [], mentionedNodeTypes: [] })
    expect(none.offered.map((skill) => skill.id)).not.toContain('canvas')
  })

  it('auto：用户提及了这种类型的节点 → 一开始就加载；否则进目录', () => {
    const plain = TEST_SKILLS.plan({ env: env(), previous: [], mentionedNodeTypes: [] })
    expect(plain.loaded.map((skill) => skill.id)).toEqual(['canvas'])
    expect(plain.catalog.map((skill) => skill.id)).toContain('director')

    const mentioned = TEST_SKILLS.plan({ env: env(), previous: [], mentionedNodeTypes: ['text', 'director'] })
    expect(mentioned.loaded.map((skill) => skill.id)).toEqual(['canvas', 'director'])
  })

  it('之前加载过的：仍提供就预加载，不提供（含注册表里已没有的）进 unavailable', () => {
    const plan = TEST_SKILLS.plan({
      env: env({ deployment: { imageInput: false, mediaReader: true, sandboxExec: true } }),
      previous: ['notes', 'media-view', 'gone'],
      mentionedNodeTypes: [],
    })
    expect(plan.loaded.map((skill) => skill.id)).toContain('notes')
    expect(plan.unavailable).toEqual(['media-view', 'gone'])
    expect(TEST_SKILLS.titleOf('gone')).toBe('gone')
  })
})

// —— docs/23 §6 验收 ——

describe('验收 1：普通画布会话', () => {
  it('第一次模型请求里只有 canvas 的 13 个工具、delegate_task 和 load_skill；技能目录里有其它提供了的技能', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith([step(() => fauxAssistantMessage('好'))], {
      registry: null,
      overrides: { mediaReader: fakeReader, mediaTool: true },
    })
    await run(runtime, new Y.Doc())

    expect([...requests[0]!.tools].sort()).toEqual([...CANVAS_TOOLS, 'delegate_task', 'load_skill'].sort())
    const prompt = requests[0]!.systemPrompt
    expect(prompt).toContain('### 画布（canvas）')
    expect(prompt).not.toContain('canvas-edit')
    expect(prompt).toContain('## 技能目录')
    expect(prompt).toContain('- media-view：')
    expect(prompt).toContain('- media-exec：')
    // 已加载的不进目录
    expect(prompt).not.toContain('- canvas：')
  })
})

describe('验收 2：提及导演台节点（全局 agent，docs/20 §3.10.9）', () => {
  it('消息提及导演台节点：第一次请求就有 director 的工具和 canvas 的全部工具；导演台工具对画布上任意导演台都能调用', async () => {
    const doc = new Y.Doc()
    seed(doc, 'n_dir', 'director', '片头')
    seed(doc, 'n_other', 'director', '别的')
    const { requests, step } = probe()
    const runtime = runtimeWith([
      step(() =>
        fauxAssistantMessage(
          [fauxToolCall('get_director_scene', { nodeId: 'n_other' }), fauxToolCall('get_director_scene', { nodeId: 'n_dir' })],
          { stopReason: 'toolUse' },
        ),
      ),
      step(() => fauxAssistantMessage('好')),
    ])
    // 从导演台里发起：带入口 nodeId，消息开头是这个节点的提及（前端自动放上的）
    const { events, threadId } = await run(runtime, doc, { nodeId: 'n_dir', text: `${formatNodeMention('n_dir')} 搭个场景` })
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })

    const first = requests[0]!
    expect(first.tools).toEqual(expect.arrayContaining([...CANVAS_TOOLS, 'get_director_scene', 'load_skill']))
    expect(first.systemPrompt).not.toContain('会话范围')
    expect(storedResults(runtime, threadId)).toMatchObject([
      { name: 'get_director_scene', isError: false, text: '场景 n_other' },
      { name: 'get_director_scene', isError: false, text: '场景 n_dir' },
    ])
    expect(skillLoadedEvents(events)).toEqual([])

    // 会话记着入口节点；一开始加载的技能进了会话
    const view = await runtime.getConversation('flow-1', 'u1', threadId)
    expect(view).toMatchObject({ nodeId: 'n_dir' })
    expect(view!.skills.map((skill) => skill.id)).toEqual(['canvas', 'director'])
  })

  it('入口 nodeId 只记录：消息里没提及时不自动加载 director，画布写工具照常全在', async () => {
    const doc = new Y.Doc()
    seed(doc, 'n_dir', 'director')
    const { requests, step } = probe()
    const runtime = runtimeWith([step(() => fauxAssistantMessage('好'))])
    const { threadId } = await run(runtime, doc, { nodeId: 'n_dir', text: '随便聊聊' })
    expect([...requests[0]!.tools].sort()).toEqual([...CANVAS_TOOLS, 'load_skill'].sort())
    expect(requests[0]!.systemPrompt).toContain('- director：')
    expect(await runtime.getConversation('flow-1', 'u1', threadId)).toMatchObject({ nodeId: 'n_dir' })
  })

  it('普通会话里用户 @ 提及了导演台节点 → director 一开始就加载（auto）', async () => {
    const doc = new Y.Doc()
    seed(doc, 'n_dir', 'director')
    const { requests, step } = probe()
    const runtime = runtimeWith([step(() => fauxAssistantMessage('好'))])
    await run(runtime, doc, { text: `改一下 ${formatNodeMention('n_dir')}` })
    expect(requests[0]!.tools).toContain('get_director_scene')
    expect(requests[0]!.tools).toContain('add_node')
  })
})

describe('验收 3：按需加载', () => {
  it('load_skill 之后同一轮的下一次请求带上新工具，模型能调用；对话里出现「已加载：…」，load_skill 不是工具调用条目', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith([
      step(() => loadSkillStep('notes')),
      step(() => fauxAssistantMessage([fauxToolCall('notes_tool', {})], { stopReason: 'toolUse' })),
      step(() => fauxAssistantMessage('好了')),
    ])
    const { events, threadId } = await run(runtime, new Y.Doc())
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })

    // 加载不结束循环、不多请求：三步正好三次请求
    expect(requests).toHaveLength(3)
    expect(requests[0]!.tools).not.toContain('notes_tool')
    expect(requests[0]!.systemPrompt).toContain('- notes：测试技能 notes')
    expect(requests[1]!.tools).toContain('notes_tool')
    // 系统提示一轮之内不变；技能的说明在 load_skill 的结果里
    expect(requests[1]!.systemPrompt).toBe(requests[0]!.systemPrompt)
    const loadResult = toolResults(requests[1]!.context).at(-1)!
    expect(loadResult.name).toBe('load_skill')
    expect(loadResult.text).toContain('notes_tool')
    expect(loadResult.text).toContain('技能 notes 的说明')
    expect(storedResults(runtime, threadId)).toMatchObject([
      { name: 'load_skill', isError: false },
      { name: 'notes_tool', isError: false, text: 'notes_tool ok' },
    ])

    // 事件：一条 agent.skill-loaded；load_skill 不发 TOOL_CALL_*，也不进 assistant 消息的 toolCalls
    const loaded = skillLoadedEvents(events)
    expect(loaded).toMatchObject([{ role: 'skill-loaded', skill: { id: 'notes', title: '技能 notes' } }])
    expect(toolCallNames(events)).toEqual(['notes_tool'])
    const finished = events.at(-1)
    expect(finished?.type === AgentEventType.RUN_FINISHED && finished.result.toolCalls.map((call) => call.name)).toEqual(['notes_tool'])

    // 落库：对话里那一行和事件里的是同一条（刷新 / 补发 / 旁观一致），排在 assistant 之后；会话记着这个技能
    const view = await runtime.getConversation('flow-1', 'u1', threadId)
    expect(view!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'skill-loaded'])
    expect(view!.messages[2]).toEqual(loaded[0])
    expect(view!.skills).toEqual([
      { id: 'canvas', title: '画布' },
      { id: 'notes', title: '技能 notes' },
    ])
    // 审计里有 load_skill 这一笔（网关执行过）
    expect(runtime.runLog.toolCalls.map((call) => call.name)).toEqual(['load_skill', 'notes_tool'])
  })

  it('加载技能的那一批也照常交付别人的改动：下一次请求同时带上新工具和那条通知（同一个 prepareNextTurn），不多请求一次模型', async () => {
    const doc = new Y.Doc()
    seed(doc, 'n1', 'text', '大纲')
    const { requests, step } = probe()
    const runtime = runtimeWith([
      step(() => {
        // 模型决定加载技能的同时，别人改了画布
        doc.transact(() => nodesMap(doc).delete('n1'), 'someone-else')
        return loadSkillStep('notes')
      }),
      step(() => fauxAssistantMessage([fauxToolCall('notes_tool', {})], { stopReason: 'toolUse' })),
      step(() => fauxAssistantMessage('好')),
    ])
    const { events, threadId } = await run(runtime, doc)
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    expect(requests).toHaveLength(3)
    // 第二次请求：新工具在，通知是最后一条消息，排在 load_skill 的结果之后
    expect(requests[1]!.tools).toContain('notes_tool')
    const messages = requests[1]!.context.messages
    const notice = messages.at(-1)!
    expect(notice.role).toBe('user')
    expect(JSON.stringify(notice.content)).toContain('画布改动通知')
    expect(messages.findIndex((message) => message.role === 'toolResult')).toBeLessThan(messages.length - 1)
    // 交付了：发了 canvas-change，对话里排在「已加载」之后；第三次请求不再重复这条通知
    const changes = events.filter((event) => event.type === AgentEventType.CUSTOM && event.name === AGENT_CANVAS_CHANGE_EVENT)
    expect(changes).toHaveLength(1)
    const view = await runtime.getConversation('flow-1', 'u1', threadId)
    expect(view!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'skill-loaded', 'canvas-change'])
    const notices = requests[2]!.context.messages.filter((message) => message.role === 'user' && JSON.stringify(message.content).includes('画布改动通知'))
    expect(notices).toHaveLength(1)
  })

  it('runner 执行的工具（execution: runner）加载后在 runner 本地跑，不经网关', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith(
      [
        step(() => loadSkillStep('director-script')),
        step(() => fauxAssistantMessage([fauxToolCall('run_scene_script', {})], { stopReason: 'toolUse' })),
        step(() => fauxAssistantMessage('好')),
      ],
      { overrides: { mediaTool: true } },
    )
    const { threadId } = await run(runtime, new Y.Doc())
    expect(requests[1]!.tools).toContain('run_scene_script')
    expect(storedResults(runtime, threadId)).toMatchObject([
      { name: 'load_skill', isError: false },
      { name: 'run_scene_script', isError: false, text: 'run_scene_script ok' },
    ])
    // 网关只执行过 load_skill；runner 工具按 runner 报的记
    expect(runtime.runLog.toolCalls.map((call) => [call.name, call.ok])).toEqual([
      ['load_skill', true],
      ['run_scene_script', true],
    ])
  })
})

describe('验收 4：load_skill 必须单独成批', () => {
  it('同一批里还有别的工具：load_skill 被拦下并返回原因，别的工具照常执行，技能没加载', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith([
      step(() =>
        fauxAssistantMessage([fauxToolCall('load_skill', { id: 'notes' }), fauxToolCall('read_canvas', {})], { stopReason: 'toolUse' }),
      ),
      step(() => fauxAssistantMessage('好')),
    ])
    const { events, threadId } = await run(runtime, new Y.Doc())
    expect(storedResults(runtime, threadId)).toMatchObject([
      { name: 'load_skill', isError: true, text: LOAD_SKILL_ALONE_REASON },
      { name: 'read_canvas', isError: false },
    ])
    expect(requests[1]!.tools).not.toContain('notes_tool')
    expect(skillLoadedEvents(events)).toEqual([])
    // 被拦下的 load_skill 没到网关：审计里只有 read_canvas 是网关执行的
    expect(runtime.runLog.toolCalls.filter((call) => call.ok).map((call) => call.name)).toEqual(['read_canvas'])
  })
})

describe('验收 5：伪造的 runner', () => {
  it('直接请求网关执行没加载的技能里的工具 → 拒绝，画布不变；不提供的工具不存在；已加载（提及触发）的也不执行 —— 模型没要过这次调用', async () => {
    const replies: { name: string; reply: unknown }[] = []
    /** 一个「被攻破」的 runner：不跑 pi，拿到令牌就直接点名工具 */
    const forged: SandboxDriver = {
      name: 'forged',
      async start(spec) {
        const done: Promise<SandboxExit> = (async () => {
          const client = createGatewayClient({ baseUrl: spec.gatewayUrl })
          await client.redeem(spec.credential.token)
          await client.input()
          for (const [name, args] of [
            ['stamp', {}],
            ['run_scene_script', {}],
            ['get_director_scene', { nodeId: 'n_dir' }],
          ] as const) {
            replies.push({ name, reply: await client.tool({ toolCallId: `c_${name}`, name, args }) })
          }
          await client.finish({ error: null })
          return { exitCode: 0 }
        })()
        return { id: `forged:${spec.runId}`, wait: () => done, kill: async () => {} }
      },
      async reap() {},
    }
    const runtime = runtimeWith([], { driver: forged })
    const doc = new Y.Doc()
    seed(doc, 'n_dir', 'director')
    const before = Y.encodeStateAsUpdate(doc)
    await run(runtime, doc, { text: `看看 ${formatNodeMention('n_dir')}` })

    expect(replies[0]!.reply).toMatchObject({ isError: true })
    expect((replies[0]!.reply as { message: string }).message).toContain('未加载')
    // 脚本技能这一轮不提供（没开沙箱执行）：对网关来说就是不存在的工具
    expect(replies[1]!.reply).toMatchObject({ isError: true, message: 'Tool run_scene_script not found' })
    // 已加载（auto）的技能里的工具：以前照常执行；第 2 步起它必须对得上服务端回复里的一次调用（docs/22 §4.3「工具调用」），
    // 这个 runner 没请求过模型，所以同样被拒、画布不变
    expect(replies[2]!.reply).toMatchObject({ isError: true, message: TOOL_CALL_UNBOUND })
    expect(doc.getMap('stamps').size).toBe(0)
    expect([...nodesMap(doc).keys()]).toEqual(['n_dir'])
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})

describe('验收 6：Grant 里没有 sandbox:exec', () => {
  it('技能目录里没有要 sandbox:exec 的技能（media-exec、脚本），导演台照常可用', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith([step(() => loadSkillStep('media-exec')), step(() => fauxAssistantMessage('好'))], {
      overrides: { mediaTool: true },
      authority: { withhold: ['sandbox:exec'] },
    })
    const { threadId } = await run(runtime, new Y.Doc())
    const prompt = requests[0]!.systemPrompt
    expect(prompt).not.toContain('media-exec')
    expect(prompt).not.toContain('director-script')
    expect(prompt).toContain('- director：')
    // 照样不能硬加载
    expect(storedResults(runtime, threadId)).toMatchObject([{ name: 'load_skill', isError: true }])
  })
})

describe('验收 7：跨轮', () => {
  it('下一轮继续同一个会话：上一轮加载过的技能在第一次请求里就在；不再提供的在系统提示里说明，记录照留', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith([
      step(() => loadSkillStep('notes')),
      step(() => loadSkillStep('flaky')),
      step(() => fauxAssistantMessage('一')),
      step(() => fauxAssistantMessage('二')),
    ])
    const doc = new Y.Doc()
    const { threadId } = await run(runtime, doc)
    flaky.on = false
    await run(runtime, doc, { conversationId: threadId })

    const second = requests[3]!
    expect(second.tools).toContain('notes_tool')
    expect(second.tools).not.toContain('flaky_tool')
    expect(second.systemPrompt).toContain('## 本轮不可用的技能')
    expect(second.systemPrompt).toContain('技能 flaky（flaky）')
    // 预加载的不再发「已加载」那一行；记录只增不减
    const view = await runtime.getConversation('flow-1', 'u1', threadId)
    expect(view!.skills.map((skill) => skill.id)).toEqual(['canvas', 'notes', 'flaky'])
    expect(view!.messages.filter((message) => message.role === 'skill-loaded')).toHaveLength(2)
  })

  it('会话里存着旧的 canvas-edit：读出时按 canvas 处理 —— 不算「本轮不可用」，视图里不出现，下一轮落库后只剩 canvas', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith([step(() => fauxAssistantMessage('一')), step(() => fauxAssistantMessage('二'))])
    const doc = new Y.Doc()
    const { threadId } = await run(runtime, doc)
    // 模拟合并之前存下的记录
    runtime.store.rows.get(threadId)!.skills = ['canvas', 'canvas-edit', 'notes']
    const before = await runtime.getConversation('flow-1', 'u1', threadId)
    expect(before!.skills).toEqual([
      { id: 'canvas', title: '画布' },
      { id: 'notes', title: '技能 notes' },
    ])

    await run(runtime, doc, { conversationId: threadId })
    const second = requests[1]!
    expect(second.tools).toEqual(expect.arrayContaining([...CANVAS_TOOLS, 'notes_tool']))
    expect(second.systemPrompt).not.toContain('本轮不可用')
    expect(second.systemPrompt).not.toContain('canvas-edit')
    expect(runtime.store.rows.get(threadId)!.skills).toEqual(['canvas', 'notes'])
  })
})

describe('验收 8：每轮加载上限', () => {
  it('一轮加载超过 3 次：第 4 次 load_skill 返回错误，前 3 个照常可用', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith([
      step(() => loadSkillStep('s-a')),
      step(() => loadSkillStep('s-b')),
      step(() => loadSkillStep('s-c')),
      step(() => loadSkillStep('s-d')),
      step(() => fauxAssistantMessage('好')),
    ])
    const { events, threadId } = await run(runtime, new Y.Doc())
    const fourth = storedResults(runtime, threadId).at(-1)!
    expect(fourth).toMatchObject({ name: 'load_skill', isError: true })
    expect(fourth.text).toContain('达到上限 3')
    expect(requests[4]!.tools).toEqual(expect.arrayContaining(['s_a_tool', 's_b_tool', 's_c_tool']))
    expect(requests[4]!.tools).not.toContain('s_d_tool')
    expect(skillLoadedEvents(events).map((message) => message.skill.id)).toEqual(['s-a', 's-b', 's-c'])
  })

  it('已经加载的再 load_skill 一次：不算次数、不结束这一批，告诉模型工具已经可用', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith([step(() => loadSkillStep('canvas')), step(() => fauxAssistantMessage('好'))])
    const { events, threadId } = await run(runtime, new Y.Doc())
    expect(storedResults(runtime, threadId)).toMatchObject([{ name: 'load_skill', isError: false }])
    expect(toolResults(requests[1]!.context).at(-1)!.text).toContain('已经加载了')
    expect(skillLoadedEvents(events)).toEqual([])
  })
})
