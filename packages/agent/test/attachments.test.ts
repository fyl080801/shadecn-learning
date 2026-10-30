import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxToolCall, type Context } from '@mariozechner/pi-ai'
import { AgentEventType, type AgentAttachment, type AgentStreamEvent } from '@shadecn/shared/agent'
import { createMemoryAuthorityProvider } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { MediaReadError, type MediaAsset, type MediaReader } from '../src/media.ts'
import { attachmentsPrompt } from '../src/prompt.ts'
import { createAgentRuntime, type AgentRuntimeOptions, type OpenedCanvas } from '../src/session.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import { gatewayFetch, loadSkillStep, registerScriptedModel, type ScriptedModel, type ScriptedStep } from '../src/testing.ts'
import { VIEW_ATTACHMENT_TOOL_NAME } from '../src/tools.ts'

/**
 * 消息附件（docs/20 §3.10.12）：宿主核对过归属的附件随用户消息进来 →
 * 存在用户消息上（回显、落库）、列进这一轮交给模型的那条消息、`view_attachment` 只认这个会话里发过的附件。
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])
const PNG_BASE64 = Buffer.from(PNG).toString('base64')
const OWN = 'https://s3.example.test/bucket/canvas/assets/'

const CAT: AgentAttachment = {
  key: 'canvas/assets/aa/bb/cat.png',
  url: `${OWN}aa/bb/cat.png`,
  contentType: 'image/png',
  name: '猫.png',
}
const CLIP: AgentAttachment = {
  key: 'canvas/assets/cc/dd/clip.mp4',
  url: `${OWN}cc/dd/clip.mp4`,
  contentType: 'video/mp4',
  name: '片段.mp4',
}

function fakeReader(objects: Record<string, MediaAsset>) {
  const reads: string[] = []
  const reader: MediaReader = {
    async read(url) {
      reads.push(url)
      const asset = objects[url]
      if (!asset) throw new MediaReadError('not_found', '没有')
      return asset
    },
  }
  return { reader, reads }
}

let faux: ScriptedModel | null = null

afterEach(() => {
  faux = null
  vi.unstubAllGlobals()
})

function runtimeWith(responses: ScriptedStep[], overrides: Partial<AgentRuntimeOptions> = {}) {
  faux = registerScriptedModel({ imageInput: true })
  faux.setResponses(responses)
  const store = createMemoryConversationStore()
  const runtime = createAgentRuntime({
    ...faux.runtimeOptions(),
    store,
    runLog: createMemoryRunLog(),
    userProfiles: async (ids) => new Map(ids.map((id) => [id, { id, name: id, avatarUrl: null }])),
    authorities: createMemoryAuthorityProvider(),
    ...overrides,
  })
  vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request)))
  return Object.assign(runtime, { store, scripted: faux })
}

async function run(
  runtime: ReturnType<typeof runtimeWith>,
  doc: Y.Doc,
  input: { text: string; attachments?: AgentAttachment[]; conversationId?: string | null },
) {
  const events: AgentStreamEvent[] = []
  const open = async (runId: string): Promise<OpenedCanvas> => ({
    ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }),
    async close() {},
  })
  const started = await runtime.start({
    flowId: 'flow-1',
    userId: 'u1',
    conversationId: input.conversationId ?? null,
    text: input.text,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    openCanvas: open,
    emit: (event) => events.push(event),
  })
  if (!started.ok) throw new Error(started.message)
  await started.done
  return events
}

/** 模型这次收到的最后一条用户消息（字符串内容） */
function lastUserText(context: Context | null): string {
  const message = context?.messages.findLast((item) => item.role === 'user')
  if (!message || message.role !== 'user') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
}

function lastToolResultText(context: Context | null): string {
  const result = context?.messages.findLast((message) => message.role === 'toolResult')
  return result && result.role === 'toolResult'
    ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
    : ''
}

function upstreamImages(scripted: ScriptedModel): string[] {
  const body = scripted.requests.at(-1)?.body as { messages: { role: string; content: unknown }[] }
  return body.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as { type: string; image_url?: { url: string } }[])
          .filter((part) => part.type === 'image_url')
          .map((part) => part.image_url!.url)
      : [],
  )
}

describe('附件进到这一轮', () => {
  it('附件存在用户消息上（回显与落库同一份），交给模型的消息末尾列出键、类型、文件名和地址', async () => {
    let seen: Context | null = null
    const runtime = runtimeWith([
      (context) => {
        seen = context
        return fauxAssistantMessage('收到')
      },
    ])
    const events = await run(runtime, new Y.Doc(), { text: '用这张图做封面', attachments: [CAT, CLIP] })

    expect(events.at(-1)?.type).toBe(AgentEventType.RUN_FINISHED)
    const echoed = events.find((event) => event.type === AgentEventType.CUSTOM && event.name === 'agent.user-message')
    expect((echoed as { value: { attachments?: AgentAttachment[] } }).value.attachments).toEqual([CAT, CLIP])

    const threadId = (events[0] as { threadId: string }).threadId
    const stored = await runtime.store.get('flow-1', threadId)
    const user = stored?.messages.find((message) => message.role === 'user')
    expect(user && user.role === 'user' ? user.attachments : null).toEqual([CAT, CLIP])

    const text = lastUserText(seen)
    expect(text.startsWith('用这张图做封面')).toBe(true)
    expect(text).toContain('<附件>')
    expect(text).toContain(`- 附件 ${CAT.key}：图片（image/png），文件名「猫.png」，地址 ${CAT.url}`)
    expect(text).toContain(`- 附件 ${CLIP.key}：视频（video/mp4），文件名「片段.mp4」，地址 ${CLIP.url}`)
    // 宿主没接素材读取：看不了内容，如实告诉模型
    expect(text).toContain('这一轮看不了附件的内容')
  })

  it('只发附件、不写字：照样开一轮，会话标题用附件名', async () => {
    let seen: Context | null = null
    const runtime = runtimeWith([
      (context) => {
        seen = context
        return fauxAssistantMessage('好')
      },
    ])
    const events = await run(runtime, new Y.Doc(), { text: '', attachments: [CAT] })
    const threadId = (events[0] as { threadId: string }).threadId
    const stored = await runtime.store.get('flow-1', threadId)
    expect(stored?.title).toBe('[附件] 猫.png')
    expect(lastUserText(seen).startsWith('<附件>')).toBe(true)
  })

  it('没有附件：交给模型的消息里没有附件块，用户消息上也不带这个字段', async () => {
    let seen: Context | null = null
    const runtime = runtimeWith([
      (context) => {
        seen = context
        return fauxAssistantMessage('好')
      },
    ])
    const events = await run(runtime, new Y.Doc(), { text: '你好' })
    expect(lastUserText(seen)).toBe('你好')
    const echoed = events.find((event) => event.type === AgentEventType.CUSTOM && event.name === 'agent.user-message')
    expect('attachments' in (echoed as { value: object }).value).toBe(false)
  })

  it('附件块的说明按能不能看来写：能看但没加载时提示先 load_skill', () => {
    expect(attachmentsPrompt([], { viewSkill: null })).toBe('')
    expect(attachmentsPrompt([CAT], { viewSkill: { id: 'media-view', loaded: false } })).toContain(
      "view_attachment({ keys })（先单独调用 load_skill({ id: 'media-view' }) 加载）",
    )
    expect(attachmentsPrompt([CAT], { viewSkill: { id: 'media-view', loaded: true } })).not.toContain('load_skill')
  })
})

describe('view_attachment', () => {
  it('加载 media-view 后看图片附件：图经网关回到 runner，下一次模型请求带着它', async () => {
    const { reader, reads } = fakeReader({ [CAT.url]: { data: PNG, contentType: 'image/png' } })
    let first: Context | null = null
    let seen: Context | null = null
    const runtime = runtimeWith(
      [
        (context) => {
          first = context
          return loadSkillStep('media-view')
        },
        fauxAssistantMessage([fauxToolCall(VIEW_ATTACHMENT_TOOL_NAME, { keys: [CAT.key] })], { stopReason: 'toolUse' }),
        (context) => {
          seen = context
          return fauxAssistantMessage('看完了')
        },
      ],
      { mediaReader: reader },
    )
    const events = await run(runtime, new Y.Doc(), { text: '看看', attachments: [CAT] })

    expect(events.at(-1)?.type).toBe(AgentEventType.RUN_FINISHED)
    expect(lastUserText(first)).toContain("先单独调用 load_skill({ id: 'media-view' })")
    expect(reads).toEqual([CAT.url])
    expect(upstreamImages(runtime.scripted)).toEqual([`data:image/png;base64,${PNG_BASE64}`])
    expect(lastToolResultText(seen)).toContain(`附件 ${CAT.key}（「猫.png」）：下面是它的内容（image/png`)
  })

  it('不是这个会话里的附件 → 整个调用拒绝，一个字节都不读；视频附件 → 看不了', async () => {
    const { reader, reads } = fakeReader({})
    const results: string[] = []
    const capture: ScriptedStep = (context) => {
      results.push(lastToolResultText(context))
      return fauxAssistantMessage([fauxToolCall(VIEW_ATTACHMENT_TOOL_NAME, { keys: [CLIP.key] })], { stopReason: 'toolUse' })
    }
    const runtime = runtimeWith(
      [
        loadSkillStep('media-view'),
        fauxAssistantMessage([fauxToolCall(VIEW_ATTACHMENT_TOOL_NAME, { keys: ['canvas/assets/ee/ff/other.png'] })], {
          stopReason: 'toolUse',
        }),
        capture,
        (context) => {
          results.push(lastToolResultText(context))
          return fauxAssistantMessage('好')
        },
      ],
      { mediaReader: reader },
    )
    await run(runtime, new Y.Doc(), { text: '看看', attachments: [CLIP] })

    expect(results[0]).toContain('这些不是这个会话里的附件：canvas/assets/ee/ff/other.png')
    expect(results[1]).toContain('是 video/mp4，只有图片附件能查看')
    expect(reads).toEqual([])
  })

  it('续聊：上一轮发过的附件这一轮还能看（会话里用户消息带过的都认）', async () => {
    const { reader, reads } = fakeReader({ [CAT.url]: { data: PNG, contentType: 'image/png' } })
    const runtime = runtimeWith([fauxAssistantMessage('收到')], { mediaReader: reader })
    const doc = new Y.Doc()
    const firstEvents = await run(runtime, doc, { text: '先收着', attachments: [CAT] })
    const threadId = (firstEvents[0] as { threadId: string }).threadId

    runtime.scripted.setResponses([
      loadSkillStep('media-view'),
      fauxAssistantMessage([fauxToolCall(VIEW_ATTACHMENT_TOOL_NAME, { keys: [CAT.key] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('看完了'),
    ])
    const second = await run(runtime, doc, { text: '现在看看上次那张', conversationId: threadId })

    expect(second.at(-1)?.type).toBe(AgentEventType.RUN_FINISHED)
    expect(reads).toEqual([CAT.url])
  })
})
