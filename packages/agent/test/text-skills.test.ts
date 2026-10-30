import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxToolCall, Type, type AssistantMessage, type Context, type JsonObject } from '@earendil-works/pi-ai'
import {
  AGENT_SKILL_LOADED_EVENT,
  AgentEventType,
  type AgentSkillLoadedMessage,
  type AgentStreamEvent,
} from '@shadecn/shared/agent'
import { createAgentRegistry, DEFAULT_AGENT_MODEL, type AgentConfig } from '../src/agents.ts'
import { createMemoryAuthorityProvider, type MemoryAuthorityOptions } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { GATEWAY_ROUTES, RUNNER_PROTOCOL_VERSION, type ToolCallResponse } from '../src/protocol.ts'
import { createAgentRuntime, type AgentRuntimeOptions, type OpenedCanvas } from '../src/session.ts'
import { agentsSkill, BUILTIN_SKILLS, canvasSkill, createSkillRegistry, defineSkill, type AgentSkill } from '../src/skills/index.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import { createInlineDriver, gatewayFetch, registerScriptedModel, testAgentRegistry, type ScriptedStep } from '../src/testing.ts'
import {
  createTextSkillRegistry,
  loadTextSkills,
  parseTextSkill,
  TEXT_SKILL_DESCRIPTION_LIMIT,
  type TextSkill,
  type TextSkillRegistry,
} from '../src/text-skills.ts'
import type { CanvasTool } from '../src/tools.ts'

/**
 * 文字技能（docs/26 §3.8、docs/23 §7）：pi `SKILL.md` 的解析与启动校验、目录的发现规则，以及走完整二期路径
 * （scripted model + 进程内驱动）的加载：目录里的位置和标记、`load_skill` 一个文字技能 = 正文进结果 + 依赖的内置技能一起加载
 * （runner 经 `loadedSkills` 拿到它们、下一步就能用）、依赖用不了时照样加载并说明原因、算一次加载、会话记住、移除后「本轮不可用」。
 */

// —— 测试专用的内置技能 ——

const emptyParams = Type.Object({}, { additionalProperties: false })

function tool(name: string, capability: CanvasTool['capability'] = 'flow:read'): CanvasTool {
  const definition: CanvasTool<typeof emptyParams> = {
    name,
    capability,
    label: name,
    description: `测试工具 ${name}`,
    parameters: emptyParams,
    describe: () => name,
    async execute() {
      return { content: [{ type: 'text', text: `${name} ok` }], details: { summary: name, elementIds: [] } }
    },
  }
  return definition as unknown as CanvasTool
}

const onDemand = (id: string, extra: Partial<AgentSkill> = {}): AgentSkill =>
  defineSkill({
    id,
    title: `技能 ${id}`,
    summary: `测试技能 ${id}`,
    prompt: `技能 ${id} 的说明`,
    tools: () => [tool(`${id.replace(/-/g, '_')}_tool`)],
    requires: ['flow:read'],
    activation: 'on-demand',
    ...extra,
  })

/** 可用条件可以在两轮之间翻转（跨轮时依赖用不了） */
const flaky = { on: true }

const TEST_SKILLS = createSkillRegistry([
  canvasSkill,
  agentsSkill,
  onDemand('notes'),
  onDemand('s-b'),
  onDemand('s-c'),
  onDemand('s-d'),
  onDemand('s-e'),
  // Grant 里没有 flow:write 时不提供
  onDemand('writer', { tools: () => [tool('writer_tool', 'flow:write')], requires: ['flow:read', 'flow:write'] }),
  onDemand('flaky', { available: () => flaky.on }),
])

const textSkill = (name: string, requires: string[] = [], extra: Partial<TextSkill> = {}): TextSkill => ({
  name,
  description: `文字技能 ${name} 的一句话`,
  requires,
  body: `文字技能 ${name} 的做法：先读再改。`,
  filePath: `skills/${name}/SKILL.md`,
  ...extra,
})

const textRegistry = (skills: TextSkill[]) => createTextSkillRegistry(skills, { skills: TEST_SKILLS })

// —— 搭一个 runtime（按「谁在请求」路由的脚本模型，同 agent-peers.test.ts） ——

interface Turn {
  called: boolean
  step: number
  tools: string[]
  systemPrompt: string
  context: Context
}

function turnOf(context: Context): Turn {
  return {
    called: (context.systemPrompt ?? '').includes('## 你是被调用的 agent'),
    step: context.messages.filter((message) => message.role === 'assistant').length + 1,
    tools: (context.tools ?? []).map((item) => item.name),
    systemPrompt: context.systemPrompt ?? '',
    context,
  }
}

const call = (name: string, args: JsonObject = {}) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
const say = (text: string) => fauxAssistantMessage(text)

afterEach(() => {
  flaky.on = true
  vi.unstubAllGlobals()
})

interface SetupOptions {
  textSkills?: TextSkillRegistry
  authority?: MemoryAuthorityOptions
  overrides?: Partial<AgentRuntimeOptions>
}

function setup(handler: (turn: Turn) => AssistantMessage, options: SetupOptions = {}) {
  const faux = registerScriptedModel()
  const turns: Turn[] = []
  const route: ScriptedStep = (context) => {
    const turn = turnOf(context)
    turns.push(turn)
    return handler(turn)
  }
  faux.setResponses(Array.from({ length: 60 }, () => route))
  const store = createMemoryConversationStore()
  const runLog = createMemoryRunLog()
  const runtime = createAgentRuntime({
    ...faux.runtimeOptions(createInlineDriver({ skills: TEST_SKILLS })),
    agents: testAgentRegistry(TEST_SKILLS),
    skills: TEST_SKILLS,
    ...(options.textSkills ? { textSkills: options.textSkills } : {}),
    store,
    runLog,
    userProfiles: async (ids) => new Map(ids.map((id) => [id, { id, name: id, avatarUrl: null }])),
    authorities: createMemoryAuthorityProvider(options.authority),
    ...options.overrides,
  })
  /** 网关回给 runner 的 `/canvas/tool` 回复（看 runner 拿到的 `loadedSkills`） */
  const toolReplies: { name: string; reply: ToolCallResponse }[] = []
  vi.stubGlobal(
    'fetch',
    gatewayFetch(async (request) => {
      const route = new URL(request.url).pathname.replace(/^.*agent-gateway/, '')
      if (route !== GATEWAY_ROUTES.tool) return runtime.gateway.handle(request)
      const body = (await request.clone().json()) as { name: string }
      const response = await runtime.gateway.handle(request)
      toolReplies.push({ name: body.name, reply: (await response.clone().json()) as ToolCallResponse })
      return response
    }),
  )
  return Object.assign(runtime, { turns, store, runLog, toolReplies })
}

async function start(runtime: ReturnType<typeof setup>, doc: Y.Doc, conversationId: string | null = null) {
  const events: AgentStreamEvent[] = []
  const started = await runtime.start({
    flowId: 'flow-1',
    userId: 'u1',
    conversationId,
    text: '开始',
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

/** 这个会话落库的模型上下文里的工具结果 */
function storedResults(runtime: ReturnType<typeof setup>, threadId: string) {
  return (runtime.store.rows.get(threadId)?.llmMessages ?? []).flatMap((message) =>
    message.role === 'toolResult'
      ? [{ name: message.toolName, isError: message.isError, text: message.content.map((p) => (p.type === 'text' ? p.text : '')).join('') }]
      : [],
  )
}

const skillLoaded = (events: AgentStreamEvent[]) =>
  events.flatMap((event) =>
    event.type === AgentEventType.CUSTOM && event.name === AGENT_SKILL_LOADED_EVENT ? [(event.value as AgentSkillLoadedMessage).skill] : [],
  )

/** 加载过的 `load_skill` 回复里交给 runner 的内置技能 id */
const loadedForRunner = (runtime: ReturnType<typeof setup>) =>
  runtime.toolReplies.flatMap(({ name, reply }) => (name === 'load_skill' && !reply.isError ? [reply.details.loadedSkills ?? null] : []))

// —— 解析 ——

describe('解析 SKILL.md', () => {
  it('frontmatter name / description / requires（YAML 数组或逗号分隔）+ 正文；requires 省略 = 空；BOM、CRLF 照认', () => {
    const skill = parseTextSkill(
      '---\nname: storyboard-review\ndescription: 按分镜规范检查导演台场景\nrequires: [director, canvas]\n---\n\n检查每个镜头。\n',
      'skills/storyboard-review/SKILL.md',
    )
    expect(skill).toEqual({
      name: 'storyboard-review',
      description: '按分镜规范检查导演台场景',
      requires: ['director', 'canvas'],
      body: '检查每个镜头。',
      filePath: 'skills/storyboard-review/SKILL.md',
    })
    expect(parseTextSkill('---\nname: a\ndescription: d\nrequires: director, canvas\n---\n正文', 'a.md').requires).toEqual(['director', 'canvas'])
    expect(parseTextSkill('\uFEFF---\r\nname: a\r\ndescription: d\r\n---\r\n正文', 'a.md')).toMatchObject({ requires: [], body: '正文' })
  })

  it('每一种不合法都抛错并指出文件', () => {
    const bad = (text: string, file = 'skills/bad.md') => () => parseTextSkill(text, file)
    expect(bad('name: x\n')).toThrow(/skills\/bad\.md.*frontmatter/)
    expect(bad('---\ndescription: d\n---\n正文')).toThrow(/skills\/bad\.md.*name/)
    expect(bad('---\nname: x\n---\n正文')).toThrow(/description/)
    expect(bad('---\nname: x\ndescription: "  "\n---\n正文')).toThrow(/description/)
    expect(bad(`---\nname: x\ndescription: ${'长'.repeat(TEXT_SKILL_DESCRIPTION_LIMIT + 1)}\n---\n正文`)).toThrow(/超过 1024/)
    expect(bad('---\nname: x\ndescription: d\nlicense: MIT\n---\n正文')).toThrow(/不认识的字段 license/)
    expect(bad('---\nname: x\ndescription: d\ndisable-model-invocation: true\n---\n正文')).toThrow(/不支持 disable-model-invocation.*斜杠命令/)
    expect(bad('---\nname: x\ndescription: d\nrequires: 3\n---\n正文')).toThrow(/requires/)
    expect(bad('---\nname: x\ndescription: d\nrequires: [canvas, 3]\n---\n正文')).toThrow(/requires/)
    expect(bad('---\nname: x\ndescription: d\nrequires: []\n---\n正文')).toThrow(/requires.*空/)
    expect(bad('---\nname: x\ndescription: d\nrequires: [canvas, canvas]\n---\n正文')).toThrow(/canvas 写了两次/)
    expect(bad('---\nname: x\ndescription: d\n---\n   \n')).toThrow(/正文是空的/)
    expect(bad('---\nname: x\ndescription: d\n---\n正文', 'skills/y/SKILL.md')).toThrow(/要和所在目录同名（y）/)
  })
})

describe('注册表的启动校验', () => {
  it('合法的照建；按名字查', () => {
    const registry = textRegistry([textSkill('review', ['notes']), textSkill('plan')])
    expect(registry.skills.map((skill) => skill.name)).toEqual(['review', 'plan'])
    expect(registry.get('review')?.requires).toEqual(['notes'])
    expect(registry.get('notes')).toBeUndefined()
  })

  it('名字不合法、重名、和内置技能 / 它们的旧 id 撞、requires 不是现有的内置技能：都抛，指出文件', () => {
    expect(() => textRegistry([textSkill('Bad_Name')])).toThrow(/skills\/Bad_Name\/SKILL\.md.*不合法/)
    expect(() => textRegistry([textSkill('1abc')])).toThrow(/不合法/)
    expect(() => textRegistry([textSkill('a'), textSkill('a', [], { filePath: 'skills/a.md' })])).toThrow(/skills\/a\.md.*skills\/a\/SKILL\.md.*重复/)
    expect(() => textRegistry([textSkill('notes')])).toThrow(/和内置技能重名/)
    expect(() => textRegistry([textSkill('canvas-edit')])).toThrow(/内置技能 canvas 的旧 id/)
    expect(() => textRegistry([textSkill('delegate')])).toThrow(/内置技能 agents 的旧 id/)
    expect(() => textRegistry([textSkill('a', ['no-such'])])).toThrow(/requires 里的 no-such 不是内置技能/)
    expect(() => textRegistry([textSkill('a', ['canvas-edit'])])).toThrow(/canvas-edit 是旧 id，写 canvas/)
    expect(() => textRegistry([textSkill('a', ['b']), textSkill('b')])).toThrow(/requires 里的 b 是文字技能/)
  })

  it('createAgentRuntime 按它自己的技能注册表再校验一次', () => {
    const builtin = createTextSkillRegistry([textSkill('a', ['director'])], { skills: BUILTIN_SKILLS })
    expect(() =>
      createAgentRuntime({
        ...registerScriptedModel().runtimeOptions(createInlineDriver({ skills: TEST_SKILLS })),
        agents: testAgentRegistry(TEST_SKILLS),
        skills: TEST_SKILLS,
        textSkills: builtin,
        store: createMemoryConversationStore(),
        runLog: createMemoryRunLog(),
        userProfiles: async () => new Map(),
        authorities: createMemoryAuthorityProvider(),
      }),
    ).toThrow(/requires 里的 director 不是内置技能/)
  })
})

describe('目录的发现规则', () => {
  const write = (file: string, name: string, body = '正文') => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `---\nname: ${name}\ndescription: ${name} 的一句话\n---\n${body}`)
  }

  it('子目录里的 SKILL.md 各一个（不再往下找）、没有 SKILL.md 的子目录接着往下找、根上的 *.md 各一个；根上的 README.md 不算；点开头的跳过', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'text-skills-'))
    try {
      writeFileSync(path.join(dir, 'README.md'), '# 说明\n\n这不是技能，没有 frontmatter。')
      writeFileSync(path.join(dir, 'notes.txt'), '不是技能')
      write(path.join(dir, 'zeta.md'), 'zeta')
      write(path.join(dir, 'beta', 'SKILL.md'), 'beta')
      // 技能目录里别的文件、更深的 SKILL.md 都不读
      writeFileSync(path.join(dir, 'beta', 'notes.md'), '参考资料')
      write(path.join(dir, 'beta', 'inner', 'SKILL.md'), 'inner')
      // 没有 SKILL.md 的子目录：往下找 SKILL.md，它自己的 .md 不算
      write(path.join(dir, 'group', 'alpha', 'SKILL.md'), 'alpha')
      writeFileSync(path.join(dir, 'group', 'loose.md'), '---\nname: loose\ndescription: d\n---\n不算')
      write(path.join(dir, '.hidden', 'SKILL.md'), 'hidden')
      expect(loadTextSkills(dir).map((skill) => [skill.name, path.relative(dir, skill.filePath)])).toEqual([
        ['beta', path.join('beta', 'SKILL.md')],
        ['alpha', path.join('group', 'alpha', 'SKILL.md')],
        ['zeta', 'zeta.md'],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('README 不分大小写；根上直接放 SKILL.md 报错；目录不存在 = 没有文字技能', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'text-skills-'))
    try {
      writeFileSync(path.join(dir, 'Readme.md'), '说明')
      expect(loadTextSkills(dir)).toEqual([])
      write(path.join(dir, 'SKILL.md'), 'root')
      expect(() => loadTextSkills(dir)).toThrow(/根上不能直接放 SKILL\.md/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(loadTextSkills(path.join(tmpdir(), 'no-such-text-skills-dir'))).toEqual([])
  })

  it('仓库里的目录（packages/agent/skills/）只有说明它的 README.md：没有文字技能，和内置技能一起校验通过', () => {
    const repoDir = fileURLToPath(new URL('../skills/', import.meta.url))
    const skills = loadTextSkills(repoDir)
    expect(skills).toEqual([])
    expect(createTextSkillRegistry(skills, { skills: BUILTIN_SKILLS }).skills).toEqual([])
  })
})

// —— 运行时 ——

describe('技能目录：文字技能排在内置技能后面，标明「文字技能」', () => {
  it('入口 agent 的目录：内置技能在前、文字技能在后（带依赖）；文字技能不是工具，一开始不加载', async () => {
    const runtime = setup(() => say('好'), { textSkills: textRegistry([textSkill('review-text', ['notes', 's-b']), textSkill('plain')]) })
    await start(runtime, new Y.Doc())
    const prompt = runtime.turns[0]!.systemPrompt
    const builtinLine = prompt.indexOf('- notes：测试技能 notes')
    const textLine = prompt.indexOf('- review-text（文字技能）：文字技能 review-text 的一句话（加载时一起加载：notes、s-b）')
    expect(builtinLine).toBeGreaterThan(-1)
    expect(textLine).toBeGreaterThan(builtinLine)
    expect(prompt).toContain('- plain（文字技能）：文字技能 plain 的一句话\n')
    expect(prompt).toContain('标「文字技能」的只有做法说明、不带新工具')
    expect(prompt).not.toContain('文字技能 review-text 的做法')
    expect(runtime.turns[0]!.tools).not.toContain('review-text')
  })

  it('没有文字技能时系统提示和以前一样（没有那句说明）', async () => {
    const runtime = setup(() => say('好'))
    await start(runtime, new Y.Doc())
    expect(runtime.turns[0]!.systemPrompt).not.toContain('文字技能')
  })

  it('提供给每个 agent：被调用的 agent 的目录里也有', async () => {
    const runtime = setup((turn) => (turn.called ? say('做完了') : turn.step === 1 ? call('run_agent', { agent: 'canvas', task: '看看' }) : say('好')), {
      textSkills: textRegistry([textSkill('review-text', ['notes'])]),
    })
    await start(runtime, new Y.Doc())
    const sub = runtime.turns.find((turn) => turn.called)!
    expect(sub.systemPrompt).toContain('- review-text（文字技能）：')
  })
})

describe('load_skill 一个文字技能', () => {
  it('正文进结果，依赖的内置技能一起加载：runner 经 loadedSkills 拿到两个依赖（没有文字技能的 id），下一步就能调它们的工具；对话里各一行「已加载」', async () => {
    const runtime = setup(
      (turn) =>
        turn.step === 1
          ? call('load_skill', { id: 'review-text' })
          : turn.step === 2
            ? fauxAssistantMessage([fauxToolCall('notes_tool', {}), fauxToolCall('s_b_tool', {})], { stopReason: 'toolUse' })
            : say('好了'),
      { textSkills: textRegistry([textSkill('review-text', ['notes', 's-b'])]) },
    )
    const { events, last, threadId } = await start(runtime, new Y.Doc())
    expect(last.outcome).toEqual({ type: 'success' })
    expect(runtime.turns).toHaveLength(3)

    expect(loadedForRunner(runtime)).toEqual([['notes', 's-b']])
    expect(runtime.turns[1]!.tools).toEqual(expect.arrayContaining(['notes_tool', 's_b_tool']))
    // 系统提示一轮之内不变
    expect(runtime.turns[1]!.systemPrompt).toBe(runtime.turns[0]!.systemPrompt)

    const results = storedResults(runtime, threadId)
    expect(results).toMatchObject([
      { name: 'load_skill', isError: false },
      { name: 'notes_tool', isError: false, text: 'notes_tool ok' },
      { name: 's_b_tool', isError: false, text: 's_b_tool ok' },
    ])
    const loadText = results[0]!.text
    expect(loadText).toContain('已加载文字技能「review-text」')
    expect(loadText).toContain('已一起加载「技能 notes」（notes），现在可以用这些工具：notes_tool')
    expect(loadText).toContain('已一起加载「技能 s-b」（s-b），现在可以用这些工具：s_b_tool')
    expect(loadText).toContain('## review-text 的做法\n文字技能 review-text 的做法：先读再改。')
    expect(loadText).toContain('## 技能 notes 的用法\n技能 notes 的说明')

    expect(skillLoaded(events)).toEqual([
      { id: 'review-text', title: 'review-text' },
      { id: 'notes', title: '技能 notes' },
      { id: 's-b', title: '技能 s-b' },
    ])
    const view = await runtime.getConversation('flow-1', 'u1', threadId)
    expect(view!.skills.map((skill) => skill.id)).toEqual(['canvas', 'agents', 'review-text', 'notes', 's-b'])
  })

  it('依赖不提供（Grant 里缺它要的能力）：文字技能照样加载，结果说明哪个用不了、为什么；runner 拿到的是空的，模型看不到那个工具', async () => {
    const runtime = setup((turn) => (turn.step === 1 ? call('load_skill', { id: 'edit-text' }) : say('好')), {
      textSkills: textRegistry([textSkill('edit-text', ['writer', 'notes'])]),
      authority: { withhold: ['flow:write'] },
    })
    const { threadId } = await start(runtime, new Y.Doc())
    const [load] = storedResults(runtime, threadId)
    expect(load).toMatchObject({ name: 'load_skill', isError: false })
    expect(load!.text).toContain('「技能 writer」（writer）用不了：这一轮不提供（授权或部署条件不满足）')
    expect(load!.text).toContain('已一起加载「技能 notes」（notes）')
    expect(load!.text).toContain('## edit-text 的做法')
    expect(loadedForRunner(runtime)).toEqual([['notes']])
    expect(runtime.turns[1]!.tools).not.toContain('writer_tool')
    expect(runtime.turns[1]!.tools).toContain('notes_tool')
  })

  it('依赖被这个 agent 定义的工具白名单整个滤掉：照样加载，说明「不在这个 agent 能用的工具范围里」', async () => {
    const restricted: AgentConfig = { ...testAgentRegistry(TEST_SKILLS).entry, tools: ['read_canvas', 'get_node', 's_b_tool'] }
    const runtime = setup((turn) => (turn.step === 1 ? call('load_skill', { id: 'review-text' }) : say('好')), {
      textSkills: textRegistry([textSkill('review-text', ['notes', 's-b'])]),
      overrides: { agents: createAgentRegistry([restricted], { skills: TEST_SKILLS, models: [DEFAULT_AGENT_MODEL] }) },
    })
    const { threadId } = await start(runtime, new Y.Doc())
    const [load] = storedResults(runtime, threadId)
    expect(load).toMatchObject({ name: 'load_skill', isError: false })
    expect(load!.text).toContain('「技能 notes」（notes）用不了：不在这个 agent 能用的工具范围里')
    expect(load!.text).toContain('已一起加载「技能 s-b」（s-b），现在可以用这些工具：s_b_tool')
    expect(loadedForRunner(runtime)).toEqual([['s-b']])
    expect(runtime.turns[1]!.tools).not.toContain('notes_tool')
  })

  it('一次 load_skill 连同依赖只算一次：再加载两个内置技能到上限，第 4 次被拒；已加载的依赖照旧，重复加载文字技能不算次数', async () => {
    const steps = [
      call('load_skill', { id: 's-b' }),
      // 依赖里 s-b 已经加载、notes 新加载：一次
      call('load_skill', { id: 'review-text' }),
      call('load_skill', { id: 'review-text' }),
      call('load_skill', { id: 's-c' }),
      call('load_skill', { id: 's-d' }),
      say('好'),
    ]
    const runtime = setup((turn) => steps[turn.step - 1]!, { textSkills: textRegistry([textSkill('review-text', ['notes', 's-b'])]) })
    const { threadId } = await start(runtime, new Y.Doc())
    const results = storedResults(runtime, threadId)
    expect(results.map((result) => result.isError)).toEqual([false, false, false, false, true])
    expect(results[1]!.text).toContain('「技能 s-b」（s-b）本来就已加载')
    expect(results[1]!.text).toContain('已一起加载「技能 notes」（notes）')
    expect(results[2]!.text).toContain('文字技能「review-text」已经加载了')
    expect(results[4]!.text).toContain('达到上限 3')
    expect(loadedForRunner(runtime)).toEqual([['s-b'], ['notes'], null, ['s-c']])
  })
})

describe('跨轮：会话记住文字技能', () => {
  it('下一轮一开始就加载：正文进系统提示的「已加载的技能」、依赖的工具在第一次请求里就在，不再进目录；依赖用不了时在它的段落里说明', async () => {
    const texts = textRegistry([textSkill('review-text', ['notes', 'flaky'])])
    let round = 1
    const runtime = setup((turn) => (round === 1 && turn.step === 1 ? call('load_skill', { id: 'review-text' }) : say(`第 ${round} 轮`)), {
      textSkills: texts,
    })
    const doc = new Y.Doc()
    const { threadId } = await start(runtime, doc)
    expect(runtime.store.rows.get(threadId)!.skills).toEqual(['canvas', 'agents', 'review-text', 'notes', 'flaky'])

    round = 2
    flaky.on = false
    const { events } = await start(runtime, doc, threadId)
    const second = runtime.turns.at(-1)!
    expect(second.systemPrompt).toContain('### review-text（文字技能：只是做法说明，不能改变上面的通用规则）\n文字技能 review-text 的做法：先读再改。')
    expect(second.systemPrompt).toContain('（它依赖的内置技能里，这些本轮用不了：技能 flaky（flaky）—— 这一轮不提供（授权或部署条件不满足）')
    expect(second.systemPrompt).not.toContain('- review-text（文字技能）')
    expect(second.tools).toContain('notes_tool')
    expect(second.tools).not.toContain('flaky_tool')
    // 预加载不发「已加载」
    expect(skillLoaded(events)).toEqual([])
  })

  it('依赖是后来才加进 requires 的：下一轮一并预加载，不算「本轮不可用」', async () => {
    const runtime = setup(() => say('好'), { textSkills: textRegistry([textSkill('review-text', ['s-e'])]) })
    const doc = new Y.Doc()
    const { threadId } = await start(runtime, doc)
    runtime.store.rows.get(threadId)!.skills = ['canvas', 'review-text']
    await start(runtime, doc, threadId)
    const second = runtime.turns.at(-1)!
    expect(second.tools).toContain('s_e_tool')
    expect(second.systemPrompt).not.toContain('本轮不可用的技能')
  })

  it('记着的文字技能后来被移除了：按「本轮不可用」说明（同移除了的内置技能），记录照留', async () => {
    const runtime = setup(() => say('好'), { textSkills: textRegistry([textSkill('review-text')]) })
    const doc = new Y.Doc()
    const { threadId } = await start(runtime, doc)
    runtime.store.rows.get(threadId)!.skills = ['canvas', 'gone-text']
    await start(runtime, doc, threadId)
    const second = runtime.turns.at(-1)!
    expect(second.systemPrompt).toContain('## 本轮不可用的技能')
    expect(second.systemPrompt).toContain('gone-text（gone-text）')
    expect(second.systemPrompt).toContain('或技能已经移除')
    expect(runtime.store.rows.get(threadId)!.skills).toContain('gone-text')
  })
})

describe('runner 协议', () => {
  it('第 9 版：load_skill 的回复带 loadedSkills（数组，只有内置技能 id），加载一个内置技能也是一个元素的数组', async () => {
    expect(RUNNER_PROTOCOL_VERSION).toBe(9)
    const runtime = setup((turn) => (turn.step === 1 ? call('load_skill', { id: 'notes' }) : say('好')))
    await start(runtime, new Y.Doc())
    const reply = runtime.toolReplies.find((entry) => entry.name === 'load_skill')!.reply
    expect(reply.isError).toBe(false)
    expect(!reply.isError && reply.details).toMatchObject({ loadedSkills: ['notes'] })
    expect(!reply.isError && 'loadedSkill' in reply.details).toBe(false)
  })
})
