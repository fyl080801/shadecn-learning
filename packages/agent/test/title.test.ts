import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, type Context } from '@earendil-works/pi-ai'
import { AGENT_CONVERSATION_TITLE_EVENT, AgentEventType, formatNodeMention, type AgentRunEntry, type AgentStreamEvent } from '@shadecn/shared/agent'
import { nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import { createMemoryAuthorityProvider } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { createAgentRuntime, type AgentRuntimeOptions, type OpenedCanvas } from '../src/session.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import { gatewayFetch, registerScriptedModel, type ScriptedStep } from '../src/testing.ts'
import { normalizeGeneratedTitle, TITLE_SYSTEM_PROMPT } from '../src/title.ts'

/**
 * 会话标题（docs/20 §3.9「会话标题」）：新会话第一轮开始后，服务端另问一次模型要标题，落库并以 CUSTOM 事件推给界面；
 * 生成失败保留首条消息的开头；续聊不再生成；没配 `titleModel` 不发这次请求。
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const isTitleRequest = (context: Context) => context.systemPrompt === TITLE_SYSTEM_PROMPT

/**
 * 标题请求和入口 agent 的请求并行，到达上游的先后不定：每一步都按请求是哪种来答。
 * `title` 是标题请求的回答；入口 agent 回一句话
 */
function steps(title: string, count = 2): ScriptedStep[] {
  return Array.from({ length: count }, () => (context: Context) =>
    isTitleRequest(context) ? fauxAssistantMessage(title) : fauxAssistantMessage('好的，已经处理了'),
  )
}

function runtimeWith(responses: ScriptedStep[], overrides: Partial<AgentRuntimeOptions> = {}) {
  const faux = registerScriptedModel()
  faux.setResponses(responses)
  const store = createMemoryConversationStore()
  const changes: AgentRunEntry[][] = []
  const runtime = createAgentRuntime({
    ...faux.runtimeOptions(),
    store,
    runLog: createMemoryRunLog(),
    userProfiles: async (ids) => new Map(ids.map((id) => [id, { id, name: id, avatarUrl: null }])),
    onRunsChange: (_flowId, runs) => changes.push(runs),
    authorities: createMemoryAuthorityProvider(),
    titleModel: 'default',
    ...overrides,
  })
  vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request)))
  return { runtime, store, faux, changes }
}

async function runOnce(runtime: ReturnType<typeof runtimeWith>['runtime'], text: string, conversationId: string | null = null, doc = new Y.Doc()) {
  const events: AgentStreamEvent[] = []
  const open = async (runId: string): Promise<OpenedCanvas> => ({
    ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }),
    async close() {},
  })
  const started = await runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId, text, openCanvas: open, emit: (event) => events.push(event) })
  if (!started.ok) throw new Error(`应该启动成功：${started.message}`)
  await started.done
  const run = events.find((event) => event.type === AgentEventType.RUN_STARTED)
  return { events, threadId: run && run.type === AgentEventType.RUN_STARTED ? run.threadId : '' }
}

const titleEvents = (events: AgentStreamEvent[]) =>
  events.filter((event) => event.type === AgentEventType.CUSTOM && event.name === AGENT_CONVERSATION_TITLE_EVENT)

describe('normalizeGeneratedTitle', () => {
  it('去掉前缀、引号、句末标点，只取第一行', () => {
    expect(normalizeGeneratedTitle('标题：「整理画布布局」。\n多余的解释')).toBe('整理画布布局')
    expect(normalizeGeneratedTitle('"Summarize the storyboard"')).toBe('Summarize the storyboard')
    expect(normalizeGeneratedTitle('<think>想一想</think>\n\n**生成产品海报**')).toBe('生成产品海报')
  })

  it('空回答 → 空串；过长的截到上限并加省略号', () => {
    expect(normalizeGeneratedTitle('  \n ')).toBe('')
    const long = normalizeGeneratedTitle('长'.repeat(100))
    expect(Array.from(long)).toHaveLength(60)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('会话标题生成', () => {
  it('新会话 → 模型生成的标题落库，标题事件排在收尾帧之前，任务列表也换成新标题', async () => {
    const { runtime, store, faux, changes } = runtimeWith(steps('整理画布布局'))
    const { events, threadId } = await runOnce(runtime, '帮我把画布上的节点重新排一下，太乱了')

    const titles = titleEvents(events)
    expect(titles).toHaveLength(1)
    expect(titles[0]).toMatchObject({ value: { conversationId: threadId, title: '整理画布布局' } })
    expect(events.indexOf(titles[0]!)).toBeLessThan(events.findIndex((event) => event.type === AgentEventType.RUN_FINISHED))
    expect((await store.get('flow-1', threadId))?.title).toBe('整理画布布局')
    expect(changes.some((runs) => runs.some((run) => run.conversationTitle === '整理画布布局'))).toBe(true)
    // 标题请求只带首条消息和标题的系统提示，不带工具
    const titleRequest = faux.requests.find((request) => JSON.stringify(request.body).includes('你为一段对话起标题'))
    expect(titleRequest).toBeDefined()
    expect((titleRequest!.body as { tools?: unknown }).tools ?? []).toHaveLength(0)
  })

  it('提及换成节点名交给模型', async () => {
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', toYNode(buildNodeRecord({ id: 'n1', type: 'text', label: '开场白', position: { x: 0, y: 0 } })))
    let seen = ''
    const { runtime } = runtimeWith(
      Array.from({ length: 2 }, () => (context: Context) => {
        if (!isTitleRequest(context)) return fauxAssistantMessage('好')
        const content = context.messages[0]?.content
        seen = typeof content === 'string' ? content : JSON.stringify(content)
        return fauxAssistantMessage('润色开场白')
      }),
    )
    await runOnce(runtime, `润色一下 ${formatNodeMention('n1')}`, null, doc)
    expect(seen).toContain('「开场白」')
    expect(seen).not.toContain('@{node:')
  })

  it('模型答了个空 → 保留首条消息的开头，不发标题事件', async () => {
    const { runtime, store } = runtimeWith(steps('   '))
    const { events, threadId } = await runOnce(runtime, '加一个文本节点')
    expect(titleEvents(events)).toHaveLength(0)
    expect((await store.get('flow-1', threadId))?.title).toBe('加一个文本节点')
  })

  it('续聊不再生成标题', async () => {
    const { runtime, store, faux } = runtimeWith([...steps('第一轮的标题'), fauxAssistantMessage('第二轮')])
    const first = await runOnce(runtime, '第一条')
    const before = faux.requests.length
    const second = await runOnce(runtime, '第二条', first.threadId)
    expect(titleEvents(second.events)).toHaveLength(0)
    expect(faux.requests.length - before).toBe(1)
    expect((await store.get('flow-1', first.threadId))?.title).toBe('第一轮的标题')
  })

  it('没配 titleModel → 不发标题请求', async () => {
    const { runtime, faux } = runtimeWith([fauxAssistantMessage('好')], { titleModel: undefined })
    const { events } = await runOnce(runtime, '你好')
    expect(titleEvents(events)).toHaveLength(0)
    expect(faux.requests).toHaveLength(1)
  })

  it('titleModel 不在模型表里 → 建 runtime 时抛错', () => {
    expect(() => runtimeWith([], { titleModel: 'cheap' })).toThrow(/不在模型表里/)
  })
})
