import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxToolCall, type Context } from '@earendil-works/pi-ai'
import { AgentEventType, type AgentStreamEvent } from '@shadecn/shared/agent'
import { nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import {
  agentToolWhitelist,
  createAgentRegistry,
  DEFAULT_AGENT_MODEL,
  ENTRY_AGENT_NAME,
  loadAgentConfigs,
  parseAgentConfig,
  type AgentConfig,
} from '../src/agents.ts'
import { createMemoryAuthorityProvider } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { PLATFORM_PROMPT, systemPromptFor } from '../src/prompt.ts'
import { createGatewayClient } from '../src/runner/client.ts'
import type { SandboxDriver, SandboxExit } from '../src/sandbox/driver.ts'
import { createAgentRuntime, type AgentRuntimeOptions, type OpenedCanvas } from '../src/session.ts'
import { BUILTIN_SKILLS, canvasSkill, createSkillRegistry } from '../src/skills/index.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import {
  AGENT_DEFINITIONS_DIR,
  gatewayFetch,
  registerScriptedModel,
  testAgentRegistry,
  type ScriptedModel,
  type ScriptedStep,
} from '../src/testing.ts'

/**
 * agent 定义（docs/26 P2）：pi 格式的 `agents/*.md` 的解析与启动校验、`canvas.md` 拼出的系统提示与拆分之前一字不差、
 * 工具白名单在服务端生效（模型看到的工具表、`load_skill`、网关执行前的检查）。
 */

/** 拆分之前 `PLATFORM_PROMPT` 的第一句（「你是谁」那一段，搬进了 canvas.md 的正文） */
const OLD_IDENTITY = '你是一个画布助手，正在协助用户处理一张节点画布（类似流程图 / 白板）。'

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: 'canvas',
  description: '画布助手',
  systemPrompt: '你是测试 agent。',
  filePath: `agents/${overrides.name ?? 'canvas'}.md`,
  ...overrides,
})

const registryOf = (configs: AgentConfig[], models: readonly string[] = [DEFAULT_AGENT_MODEL]) =>
  createAgentRegistry(configs, { skills: BUILTIN_SKILLS, models })

describe('解析 pi 格式的定义文件', () => {
  it('frontmatter + 正文：tools 逗号分隔的字符串与 YAML 数组都认（同 pi 的 parseToolList），正文去掉首尾空白', () => {
    const fromString = parseAgentConfig(
      '---\nname: reviewer\ndescription: 只读审查\ntools: read_canvas, get_node ,check_connection\nmodel: default\n---\n\n  你是审查员。\n\n',
      'a/reviewer.md',
    )
    expect(fromString).toEqual({
      name: 'reviewer',
      description: '只读审查',
      tools: ['read_canvas', 'get_node', 'check_connection'],
      model: 'default',
      systemPrompt: '你是审查员。',
      filePath: 'a/reviewer.md',
    })
    const fromArray = parseAgentConfig('\uFEFF---\r\nname: reviewer\r\ndescription: 只读审查\r\ntools: [read_canvas, get_node]\r\n---\r\n正文', 'b.md')
    expect(fromArray.tools).toEqual(['read_canvas', 'get_node'])
    expect(fromArray.systemPrompt).toBe('正文')
    // 省略 tools / model：字段不出现（= 全部工具、default 模型）
    const bare = parseAgentConfig('---\nname: x\ndescription: d\n---\n', 'c.md')
    expect(bare).toEqual({ name: 'x', description: 'd', systemPrompt: '', filePath: 'c.md' })
    expect(agentToolWhitelist(bare)).toBeNull()
  })

  it('缺字段、类型不对、写坏 / 写空的 tools、拼错的键、没有 frontmatter、坏 YAML：抛错并指出文件和字段', () => {
    const bad = (text: string) => () => parseAgentConfig(text, 'agents/bad.md')
    expect(bad('---\ndescription: d\n---\n')).toThrow(/agents\/bad\.md.*name/)
    expect(bad('---\nname: x\n---\n')).toThrow(/agents\/bad\.md.*description/)
    expect(bad('---\nname: x\ndescription: d\nmodel: 3\n---\n')).toThrow(/model/)
    expect(bad('---\nname: x\ndescription: d\ntools: 3\n---\n')).toThrow(/tools/)
    expect(bad('---\nname: x\ndescription: d\ntools: [read_canvas, 3]\n---\n')).toThrow(/tools/)
    // pi 会把这些当成「全部工具」：这里一律拒绝（写空 = 悄悄放宽）
    expect(bad('---\nname: x\ndescription: d\ntools: ""\n---\n')).toThrow(/tools.*空/)
    expect(bad('---\nname: x\ndescription: d\ntools: []\n---\n')).toThrow(/tools.*空/)
    expect(bad('---\nname: x\ndescription: d\ntool: read_canvas\n---\n')).toThrow(/不认识的字段 tool/)
    expect(bad('name: x\ndescription: d\n')).toThrow(/frontmatter/)
    expect(bad('---\nname: [x\n---\n')).toThrow(/YAML/)
    expect(bad('---\nname: x\nname: y\ndescription: d\n---\n')).toThrow(/YAML/)
  })

  it('读目录：只读 *.md，按文件名排序；目录不存在就抛', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-defs-'))
    try {
      writeFileSync(path.join(dir, 'b.md'), '---\nname: b\ndescription: B\n---\nB')
      writeFileSync(path.join(dir, 'a.md'), '---\nname: a\ndescription: A\n---\nA')
      writeFileSync(path.join(dir, 'notes.txt'), '不是定义')
      expect(loadAgentConfigs(dir).map((agent) => [agent.name, path.basename(agent.filePath)])).toEqual([
        ['a', 'a.md'],
        ['b', 'b.md'],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(() => loadAgentConfigs(path.join(tmpdir(), 'no-such-agent-defs-dir'))).toThrow(/读不到 agent 定义目录/)
  })
})

describe('注册表的启动校验', () => {
  it('仓库里的定义：canvas 没写 tools / model，正文是原来平台段的第一句；reviewer 只有读工具、不能调用别的 agent', () => {
    const registry = testAgentRegistry()
    expect(registry.agents.map((agent) => agent.name)).toEqual([ENTRY_AGENT_NAME, 'reviewer'])
    const reviewer = registry.agents.find((agent) => agent.name === 'reviewer')!
    expect(reviewer.tools).toEqual(['read_canvas', 'get_node'])
    expect(reviewer.model).toBeUndefined()
    expect(registry.entry).toMatchObject({ name: 'canvas', systemPrompt: OLD_IDENTITY })
    expect(registry.entry.tools).toBeUndefined()
    expect(registry.entry.model).toBeUndefined()
    expect(registry.entry.description).not.toBe('')
    expect(registry.entry.filePath).toBe(path.join(AGENT_DEFINITIONS_DIR, 'canvas.md'))
  })

  it('每条规则都在建表时抛，报错指出文件', () => {
    const canvas = config()
    expect(() => registryOf([canvas, config({ name: 'Bad_Name' })])).toThrow(/agents\/Bad_Name\.md.*name/)
    expect(() => registryOf([canvas, config({ name: '1abc' })])).toThrow(/name/)
    expect(() => registryOf([canvas, config({ name: '' })])).toThrow(/name/)
    expect(() => registryOf([canvas, config({ name: 'canvas', filePath: 'agents/copy.md' })])).toThrow(/agents\/copy\.md.*canvas.*agents\/canvas\.md.*重复/)
    expect(() => registryOf([canvas, config({ name: 'r', description: '  ' })])).toThrow(/agents\/r\.md.*description/)
    expect(() => registryOf([canvas, config({ name: 'r', tools: ['read_canvas', 'no_such_tool'] })])).toThrow(/agents\/r\.md.*no_such_tool/)
    expect(() => registryOf([canvas, config({ name: 'r', tools: ['read_canvas', 'read_canvas'] })])).toThrow(/两次/)
    // 平台工具是隐含的，不能写进白名单
    expect(() => registryOf([canvas, config({ name: 'r', tools: ['load_skill'] })])).toThrow(/平台工具 load_skill/)
    expect(() => registryOf([canvas, config({ name: 'r', tools: ['request_confirmation'] })])).toThrow(/平台工具 request_confirmation/)
    expect(() => registryOf([canvas, config({ name: 'r', model: 'missing' })])).toThrow(/agents\/r\.md.*model「missing」/)
    expect(() => registryOf([config({ name: 'reviewer' })])).toThrow(/canvas/)
    // 合法的：白名单是技能的工具、model 在表里
    const ok = registryOf([canvas, config({ name: 'reviewer', tools: ['read_canvas', 'run_agent'], model: 'default' })])
    expect(ok.get('reviewer')?.tools).toEqual(['read_canvas', 'run_agent'])
    expect(ok.entry).toBe(canvas)
  })

  it('createAgentRuntime 拿自己的技能注册表再判一次白名单（定义注册表按另一份建的也拦得住）', () => {
    const agents = registryOf([config({ tools: ['read_canvas', 'auto_layout'] })])
    const scripted = registerScriptedModel()
    const build = (skills: AgentRuntimeOptions['skills']) =>
      createAgentRuntime({
        ...scripted.runtimeOptions(),
        ...(skills ? { skills } : {}),
        agents,
        store: createMemoryConversationStore(),
        runLog: createMemoryRunLog(),
        userProfiles: async () => new Map(),
        authorities: createMemoryAuthorityProvider(),
      })
    expect(() => build(undefined)).not.toThrow()
    const onlyCanvas = createSkillRegistry([{ ...canvasSkill, tools: (ctx) => canvasSkill.tools(ctx).filter((tool) => tool.name !== 'auto_layout') }])
    expect(() => build(onlyCanvas)).toThrow(/auto_layout/)
  })
})

describe('系统提示', () => {
  it('canvas.md 的正文 + 空行 + 平台规则 = 拆分之前的平台段（一字不差）；正文为空不占位', () => {
    const input = { loaded: [], catalog: [], unavailable: [], maxSkillLoads: 3 }
    const prompt = systemPromptFor({ ...input, agentPrompt: testAgentRegistry().entry.systemPrompt })
    expect(prompt).toBe(`${OLD_IDENTITY}\n\n${PLATFORM_PROMPT}一轮最多加载 3 次。`)
    expect(prompt.startsWith(`${OLD_IDENTITY}\n\n## 通用规则\n1. 你**只能通过工具**读写画布。`)).toBe(true)
    expect(systemPromptFor({ ...input, agentPrompt: '' })).toBe(`${PLATFORM_PROMPT}一轮最多加载 3 次。`)
  })

  it('模型请求里的系统提示以定义的正文开头，后面接平台规则', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith([step(() => fauxAssistantMessage('好'))], registryOf([config({ systemPrompt: '你是一个只做测试的助手。' })]))
    await run(runtime, new Y.Doc())
    expect(requests[0]!.systemPrompt.startsWith('你是一个只做测试的助手。\n\n## 通用规则\n')).toBe(true)
    expect(requests[0]!.systemPrompt).not.toContain(OLD_IDENTITY)
  })
})

// —— 工具白名单（docs/26 §3.3，验收 2）——

let faux: ScriptedModel | null = null

afterEach(() => {
  faux = null
  vi.unstubAllGlobals()
})

function runtimeWith(steps: ScriptedStep[], agents = testAgentRegistry(), driver?: SandboxDriver) {
  faux = registerScriptedModel()
  faux.setResponses(steps)
  const store = createMemoryConversationStore()
  const runLog = createMemoryRunLog()
  const runtime = createAgentRuntime({
    ...faux.runtimeOptions(driver),
    agents,
    store,
    runLog,
    userProfiles: async (ids) => new Map(ids.map((id) => [id, { id, name: id, avatarUrl: null }])),
    authorities: createMemoryAuthorityProvider(),
  })
  vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request)))
  return Object.assign(runtime, { store, runLog })
}

async function run(runtime: ReturnType<typeof runtimeWith>, doc: Y.Doc, text = '做点事') {
  const events: AgentStreamEvent[] = []
  const open = async (runId: string): Promise<OpenedCanvas> => ({
    ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }),
    async close() {},
  })
  const started = await runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text, openCanvas: open, emit: (event) => events.push(event) })
  if (!started.ok) throw new Error(started.message)
  await started.done
  const first = events[0]
  return { events, threadId: first?.type === AgentEventType.RUN_STARTED ? first.threadId : '' }
}

/** 记下每次模型请求声明的工具名与系统提示 */
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

/** 落库的模型上下文里的工具结果 */
function storedResults(runtime: ReturnType<typeof runtimeWith>, threadId: string) {
  return (runtime.store.rows.get(threadId)?.llmMessages ?? []).flatMap((message) =>
    message.role === 'toolResult'
      ? [{ name: message.toolName, isError: message.isError, text: message.content.map((p) => (p.type === 'text' ? p.text : '')).join('') }]
      : [],
  )
}

function seed(doc: Y.Doc, id: string, type: string) {
  nodesMap(doc).set(id, toYNode({ ...buildNodeRecord({ id, type, label: `名字-${id}`, position: { x: 0, y: 0 } }), data: { text: '原文' } }))
}

const READ_ONLY = registryOf([config({ systemPrompt: OLD_IDENTITY, tools: ['read_canvas', 'get_node', 'check_connection'] })])

describe('工具白名单在服务端生效', () => {
  it('不写 tools（仓库里的 canvas.md）：工具表与原来相同 —— 画布 13 个 + run_agent + load_skill，技能目录照旧', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith([step(() => fauxAssistantMessage('好'))])
    await run(runtime, new Y.Doc())
    expect(requests[0]!.tools).toEqual([
      'load_skill',
      ...canvasSkill.tools({ side: 'runner' } as never).map((tool) => tool.name),
      'run_agent',
    ])
    expect(requests[0]!.systemPrompt).toContain('- director：')
  })

  it('只给读工具：模型请求里只声明它们和 load_skill；被滤空的技能不进目录；伪造的 update_node 被拒、画布没变', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith(
      [
        step(() => fauxAssistantMessage([fauxToolCall('update_node', { id: 'n1', data: { text: '被改了' } })], { stopReason: 'toolUse' })),
        step(() => fauxAssistantMessage('改不了')),
      ],
      READ_ONLY,
    )
    const doc = new Y.Doc()
    seed(doc, 'n1', 'text')
    const before = Y.encodeStateAsUpdate(doc)
    const { threadId } = await run(runtime, doc)

    expect(requests[0]!.tools).toEqual(['load_skill', 'read_canvas', 'get_node', 'check_connection'])
    // agents（run_agent）、director、media-view 的工具都不在白名单里：整个技能不提供，系统提示里没有技能目录
    expect(requests[0]!.systemPrompt).not.toContain('## 技能目录')
    expect(requests[0]!.systemPrompt).toContain('### 画布（canvas）')
    // 模型调了没声明的工具：服务端按 pi 的「Tool X not found」记结果（runner 那边照样发到网关，网关同一句话拒）
    expect(storedResults(runtime, threadId)).toEqual([{ name: 'update_node', isError: true, text: 'Tool update_node not found' }])
    expect(runtime.runLog.toolCalls.filter((call) => call.ok)).toEqual([])
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    expect((nodesMap(doc).get('n1')?.get('data') as Y.Map<unknown> | undefined)?.toJSON()).toEqual({ text: '原文' })
  })

  it('被滤空的技能：load_skill 拒绝（同没提供的技能），不进已加载', async () => {
    const { requests, step } = probe()
    const runtime = runtimeWith(
      [
        step(() => fauxAssistantMessage([fauxToolCall('load_skill', { id: 'director' })], { stopReason: 'toolUse' })),
        step(() => fauxAssistantMessage('好')),
      ],
      READ_ONLY,
    )
    const { threadId } = await run(runtime, new Y.Doc())
    expect(storedResults(runtime, threadId)).toEqual([
      { name: 'load_skill', isError: true, text: expect.stringContaining('技能 director 不在这个 agent 能用的工具范围里') },
    ])
    expect(requests[1]!.tools).toEqual(['load_skill', 'read_canvas', 'get_node', 'check_connection'])
    expect(runtime.store.rows.get(threadId)?.skills).not.toContain('director')
  })

  it('部分留下的技能：进目录，load_skill 只交出白名单里的工具，之后声明的也只有它们', async () => {
    const { requests, step } = probe()
    const agents = registryOf([config({ tools: ['read_canvas', 'get_director_scene'] })])
    const runtime = runtimeWith(
      [
        step(() => fauxAssistantMessage([fauxToolCall('load_skill', { id: 'director' })], { stopReason: 'toolUse' })),
        step(() => fauxAssistantMessage('好')),
      ],
      agents,
    )
    const { threadId } = await run(runtime, new Y.Doc())
    expect(requests[0]!.tools).toEqual(['load_skill', 'read_canvas'])
    expect(requests[0]!.systemPrompt).toContain('- director：')
    const [loaded] = storedResults(runtime, threadId)
    expect(loaded).toMatchObject({ name: 'load_skill', isError: false })
    expect(loaded!.text).toContain('现在可以用这些工具：get_director_scene。')
    expect(requests[1]!.tools).toEqual(['load_skill', 'read_canvas', 'get_director_scene'])
  })

  it('伪造的 runner 直接点名白名单外的工具：网关在对调用之前就拒（Tool X not found），画布不变', async () => {
    const replies: unknown[] = []
    const forged: SandboxDriver = {
      name: 'forged',
      async start(spec) {
        const done: Promise<SandboxExit> = (async () => {
          const client = createGatewayClient({ baseUrl: spec.gatewayUrl })
          await client.redeem(spec.credential.token)
          await client.input()
          replies.push(await client.tool({ toolCallId: 'c1', name: 'update_node', args: { id: 'n1', data: { text: '被改了' } } }))
          // 白名单里的工具：过了这一道，卡在「对不上模型的回复」（这个 runner 没请求过模型）
          replies.push(await client.tool({ toolCallId: 'c2', name: 'read_canvas', args: {} }))
          await client.finish({ error: null })
          return { exitCode: 0 }
        })()
        return { id: `forged:${spec.runId}`, wait: () => done, kill: async () => {} }
      },
      async reap() {},
    }
    const runtime = runtimeWith([], READ_ONLY, forged)
    const doc = new Y.Doc()
    seed(doc, 'n1', 'text')
    const before = Y.encodeStateAsUpdate(doc)
    await run(runtime, doc)
    expect(replies[0]).toEqual({ isError: true, message: 'Tool update_node not found' })
    expect(replies[1]).toMatchObject({ isError: true })
    expect((replies[1] as { message: string }).message).not.toContain('not found')
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})

it('canvas.md 本身就是 pi 的格式：只有 name / description 两个键', () => {
  const text = readFileSync(path.join(AGENT_DEFINITIONS_DIR, 'canvas.md'), 'utf8')
  expect(text.startsWith('---\nname: canvas\ndescription: ')).toBe(true)
  expect(parseAgentConfig(text, 'canvas.md')).toEqual({
    name: 'canvas',
    description: expect.any(String),
    systemPrompt: OLD_IDENTITY,
    filePath: 'canvas.md',
  })
})
