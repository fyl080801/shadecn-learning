import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxToolCall, type Context } from '@mariozechner/pi-ai'
import { AgentEventType, type AgentStreamEvent } from '@shadecn/shared/agent'
import { nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import { createMemoryAuthorityProvider } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { MediaReadError, sniffImageType, type MediaAsset, type MediaReader } from '../src/media.ts'
import { parseEventsRequest, runnerEventOf } from '../src/protocol.ts'
import { createAgentRuntime, type AgentRuntimeOptions, type OpenedCanvas } from '../src/session.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import { gatewayFetch, loadSkillStep, registerScriptedModel, type ScriptedModel, type ScriptedStep } from '../src/testing.ts'
import { TOOL_LIMITS, VIEW_MEDIA_TOOL_NAME } from '../src/tools.ts'

/**
 * `view_node_media`（docs/20 §3.10.7）走完整的二期路径：runner 里的 pi 调工具 → 网关代执行（服务端读素材）→
 * 图片块经 `/canvas/tool` 回到 runner → 进下一次模型请求（脚本化上游收到 `image_url`）。
 * 同时守：上报的事件、落库的模型上下文、给前端的工具结果里都没有图片字节；模型不吃图片时工具不出现；
 * 视频只看预览图；超限 / 外部地址 / 不是图的字节给模型可读的错误。
 */

/** 最小的 PNG 文件头 + 一点内容：够 `sniffImageType` 认出来 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9])
const PNG_BASE64 = Buffer.from(PNG).toString('base64')
const JPEG_BASE64 = Buffer.from(JPEG).toString('base64')

const OWN = 'https://s3.example.test/bucket/canvas/assets/'

/** 假的素材读取：只认 {@link OWN} 开头的地址，记下每次读了什么 */
function fakeReader(objects: Record<string, MediaAsset>) {
  const reads: string[] = []
  const reader: MediaReader = {
    async read(url, { maxBytes }) {
      reads.push(url)
      if (!url.startsWith(OWN)) throw new MediaReadError('foreign', '外部地址')
      const asset = objects[url]
      if (!asset) throw new MediaReadError('not_found', '没有')
      if (asset.data.byteLength > maxBytes) throw new MediaReadError('too_large', '太大')
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

function runtimeWith(
  responses: ScriptedStep[],
  options: { imageInput?: boolean; overrides?: Partial<AgentRuntimeOptions> } = {},
) {
  faux = registerScriptedModel({ imageInput: options.imageInput ?? true })
  faux.setResponses(responses)
  const store = createMemoryConversationStore()
  const runLog = createMemoryRunLog()
  const runtime = createAgentRuntime({
    ...faux.runtimeOptions(),
    store,
    runLog,
    userProfiles: async (ids) => new Map(ids.map((id) => [id, { id, name: id, avatarUrl: null }])),
    authorities: createMemoryAuthorityProvider(),
    ...options.overrides,
  })
  vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request)))
  return Object.assign(runtime, { store, runLog, scripted: faux })
}

function seed(doc: Y.Doc, id: string, type: string, data: Record<string, unknown>) {
  nodesMap(doc).set(id, toYNode({ ...buildNodeRecord({ id, type, label: `名字-${id}`, position: { x: 0, y: 0 } }), data }))
}

async function runOnce(runtime: ReturnType<typeof runtimeWith>, doc: Y.Doc) {
  const events: AgentStreamEvent[] = []
  const open = async (runId: string): Promise<OpenedCanvas> => ({
    ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }),
    async close() {},
  })
  const started = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: null, text: '看看这张图', openCanvas: open, emit: (e) => events.push(e) })
  if (!started.ok) throw new Error(started.message)
  await started.done
  return events
}

/** 先加载技能 media-view（按需技能，docs/23），再调 view_node_media，最后记下模型这次收到的上下文再收尾 */
function viewThenStop(ids: string[]) {
  const seen: { context: Context | null } = { context: null }
  const steps: ScriptedStep[] = [
    loadSkillStep('media-view'),
    fauxAssistantMessage([fauxToolCall(VIEW_MEDIA_TOOL_NAME, { ids })], { stopReason: 'toolUse' }),
    (context) => {
      seen.context = context
      return fauxAssistantMessage('看完了')
    },
  ]
  return { steps, seen }
}

/** 上游最后一次请求里的图片（pi 放在工具结果后面那条用户消息里的 `image_url`） */
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

/** 最后一条工具结果（前面那条是 load_skill 的） */
function toolResultText(context: Context | null): string {
  const result = context?.messages.findLast((message) => message.role === 'toolResult')
  return result && result.role === 'toolResult'
    ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
    : ''
}

describe('view_node_media：图片进到模型请求里', () => {
  it('图片节点 → 图片块经网关回到 runner → 下一次模型请求带着 image_url（data: base64）', async () => {
    const { reader, reads } = fakeReader({ [`${OWN}a.png`]: { data: PNG, contentType: 'image/png' } })
    const { steps, seen } = viewThenStop(['n_img'])
    const runtime = runtimeWith(steps, { overrides: { mediaReader: reader } })
    const doc = new Y.Doc()
    seed(doc, 'n_img', 'image', { src: `${OWN}a.png` })

    const events = await runOnce(runtime, doc)

    expect(events.at(-1)?.type).toBe(AgentEventType.RUN_FINISHED)
    expect(reads).toEqual([`${OWN}a.png`])
    expect(upstreamImages(runtime.scripted)).toEqual([`data:image/png;base64,${PNG_BASE64}`])
    // 模型看到的工具结果里有一句说明，图本身在后面那条用户消息里
    expect(toolResultText(seen.context)).toContain('节点 n_img（image，名字「名字-n_img」）：下面是它的图片（image/png')
    const imageMessage = seen.context?.messages.find(
      (message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((part) => part.type === 'image'),
    )
    expect(imageMessage).toBeDefined()
  })

  it('图片字节不出服务端的下行：事件流（给前端）、落库的模型上下文、运行日志里都没有 base64，只有文字占位', async () => {
    const { reader } = fakeReader({ [`${OWN}a.png`]: { data: PNG, contentType: 'image/png' } })
    const { steps } = viewThenStop(['n_img'])
    const runtime = runtimeWith(steps, { overrides: { mediaReader: reader } })
    const doc = new Y.Doc()
    seed(doc, 'n_img', 'image', { src: `${OWN}a.png` })

    const events = await runOnce(runtime, doc)

    expect(JSON.stringify(events)).not.toContain(PNG_BASE64)
    const result = events.find((event) => event.type === AgentEventType.TOOL_CALL_RESULT)
    expect(result).toMatchObject({ metadata: { status: 'done', summary: '查看 1 张图片' } })
    expect((result as { content: string }).content).toContain('[图片 image/png')

    const threadId = (events[0] as { threadId: string }).threadId
    const stored = await runtime.store.getWithContext('flow-1', 'u1', threadId)
    const llm = JSON.stringify(stored?.llmMessages)
    expect(llm).not.toContain(PNG_BASE64)
    expect(llm).not.toContain('"type":"image"')
    expect(llm).toContain('需要再看请重新调用 view_node_media')
    expect(JSON.stringify(runtime.runLog.toolCalls)).not.toContain(PNG_BASE64)
    expect(runtime.runLog.toolCalls).toMatchObject([
      { name: 'load_skill', ok: true },
      { name: VIEW_MEDIA_TOOL_NAME, ok: true, args: 'ids=[n_img]' },
    ])
  })

  it('下一轮的上下文里只有占位：上一轮看过的图不会再发给模型', async () => {
    const { reader } = fakeReader({ [`${OWN}a.png`]: { data: PNG, contentType: 'image/png' } })
    const { steps } = viewThenStop(['n_img'])
    const runtime = runtimeWith(steps, { overrides: { mediaReader: reader } })
    const doc = new Y.Doc()
    seed(doc, 'n_img', 'image', { src: `${OWN}a.png` })
    const first = await runOnce(runtime, doc)
    const threadId = (first[0] as { threadId: string }).threadId

    runtime.scripted.setResponses([fauxAssistantMessage('好')])
    const open = async (runId: string): Promise<OpenedCanvas> => ({ ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }), async close() {} })
    const second = runtime.start({ flowId: 'flow-1', userId: 'u1', conversationId: threadId, text: '再说说', openCanvas: open, emit: () => {} })
    if (!second.ok) throw new Error(second.message)
    await second.done

    expect(upstreamImages(runtime.scripted)).toEqual([])
    expect(JSON.stringify(runtime.scripted.requests.at(-1)?.body)).toContain('[图片 image/png')
  })
})

describe('view_node_media：给不给模型', () => {
  it('模型不吃图片（input 只有 text）→ 技能 media-view 不提供：工具不出现，技能目录里也没有它', async () => {
    const { reader } = fakeReader({})
    let toolNames: string[] = []
    let systemPrompt = ''
    const runtime = runtimeWith(
      [
        (context) => {
          toolNames = (context.tools ?? []).map((tool) => tool.name)
          systemPrompt = context.systemPrompt ?? ''
          return fauxAssistantMessage('好')
        },
      ],
      { imageInput: false, overrides: { mediaReader: reader } },
    )
    await runOnce(runtime, new Y.Doc())
    expect(toolNames).toContain('get_node')
    expect(toolNames).not.toContain(VIEW_MEDIA_TOOL_NAME)
    expect(systemPrompt).not.toContain('media-view')
    expect(systemPrompt).not.toContain(VIEW_MEDIA_TOOL_NAME)
  })

  it('宿主没接素材读取 → 不提供；接了且模型吃图片 → 进技能目录（按需），load_skill 之后同一轮的下一次请求才带上工具', async () => {
    let systemPrompt = ''
    const toolNames: string[][] = []
    const probe: ScriptedStep = (context) => {
      toolNames.push((context.tools ?? []).map((tool) => tool.name))
      systemPrompt = context.systemPrompt ?? ''
      return fauxAssistantMessage('好')
    }
    await runOnce(runtimeWith([probe]), new Y.Doc())
    expect(toolNames[0]).not.toContain(VIEW_MEDIA_TOOL_NAME)
    expect(systemPrompt).not.toContain('media-view')

    toolNames.length = 0
    const loadProbe: ScriptedStep = (context) => {
      toolNames.push((context.tools ?? []).map((tool) => tool.name))
      systemPrompt = context.systemPrompt ?? ''
      return loadSkillStep('media-view')
    }
    await runOnce(runtimeWith([loadProbe, probe], { overrides: { mediaReader: fakeReader({}).reader } }), new Y.Doc())
    expect(systemPrompt).toContain('## 技能目录')
    expect(systemPrompt).toContain('- media-view：')
    expect(toolNames[0]).not.toContain(VIEW_MEDIA_TOOL_NAME)
    expect(toolNames[1]).toContain(VIEW_MEDIA_TOOL_NAME)
  })
})

describe('view_node_media：视频与出错', () => {
  it('视频有预览图 → 交给模型的是预览图（data.poster），不读视频本身', async () => {
    const { reader, reads } = fakeReader({ [`${OWN}cover.jpg`]: { data: JPEG, contentType: 'image/jpeg' } })
    const { steps, seen } = viewThenStop(['n_vid'])
    const runtime = runtimeWith(steps, { overrides: { mediaReader: reader } })
    const doc = new Y.Doc()
    seed(doc, 'n_vid', 'video', { src: `${OWN}clip.mp4`, poster: `${OWN}cover.jpg` })

    await runOnce(runtime, doc)

    expect(reads).toEqual([`${OWN}cover.jpg`])
    expect(upstreamImages(runtime.scripted)).toEqual([`data:image/jpeg;base64,${JPEG_BASE64}`])
    expect(toolResultText(seen.context)).toContain('视频本身看不到，下面是它的预览图')
  })

  it('视频没有预览图 → 文字告知看不到（不算出错），一个请求都不发', async () => {
    const { reader, reads } = fakeReader({})
    const { steps, seen } = viewThenStop(['n_vid'])
    const runtime = runtimeWith(steps, { overrides: { mediaReader: reader } })
    const doc = new Y.Doc()
    seed(doc, 'n_vid', 'video', { src: `${OWN}clip.mp4`, poster: '' })

    const events = await runOnce(runtime, doc)

    expect(reads).toEqual([])
    expect(upstreamImages(runtime.scripted)).toEqual([])
    expect(toolResultText(seen.context)).toContain('没有预览图（data.poster），这一版看不到视频内容')
    expect(events.find((event) => event.type === AgentEventType.TOOL_CALL_RESULT)).toMatchObject({ metadata: { status: 'done' } })
  })

  it('外部地址 / 不是图的字节 / 文本节点 / 没有图 → 每个节点一句可读的原因；全都看不了时整个调用是错误', async () => {
    const { reader } = fakeReader({ [`${OWN}fake.png`]: { data: new TextEncoder().encode('<html>'), contentType: 'image/png' } })
    const { steps, seen } = viewThenStop(['n_ext', 'n_fake', 'n_txt', 'n_empty'])
    const runtime = runtimeWith(steps, { overrides: { mediaReader: reader } })
    const doc = new Y.Doc()
    seed(doc, 'n_ext', 'image', { src: 'http://169.254.169.254/latest/meta-data/x.png' })
    seed(doc, 'n_fake', 'image', { src: `${OWN}fake.png` })
    seed(doc, 'n_txt', 'text', { text: '你好' })
    seed(doc, 'n_empty', 'image', { src: '' })

    const events = await runOnce(runtime, doc)

    const text = toolResultText(seen.context)
    expect(text).toContain('n_ext')
    expect(text).toContain('外部链接不能查看')
    expect(text).toContain('不是能查看的图片格式')
    expect(text).toContain('只有图片和视频节点能查看')
    expect(text).toContain('还没有图片（data.src 为空）')
    expect(upstreamImages(runtime.scripted)).toEqual([])
    expect(events.find((event) => event.type === AgentEventType.TOOL_CALL_RESULT)).toMatchObject({ metadata: { status: 'error' } })
  })

  it(`单张超过 ${TOOL_LIMITS.mediaBytes / 1024 / 1024} MB 被拒；其余照常交给模型（部分可看时不算出错）`, async () => {
    const big = new Uint8Array(TOOL_LIMITS.mediaBytes + 1)
    big.set(PNG)
    const { reader } = fakeReader({
      [`${OWN}big.png`]: { data: big, contentType: 'image/png' },
      [`${OWN}a.png`]: { data: PNG, contentType: 'image/png' },
    })
    const { steps, seen } = viewThenStop(['n_big', 'n_ok'])
    const runtime = runtimeWith(steps, { overrides: { mediaReader: reader } })
    const doc = new Y.Doc()
    seed(doc, 'n_big', 'image', { src: `${OWN}big.png` })
    seed(doc, 'n_ok', 'image', { src: `${OWN}a.png` })

    await runOnce(runtime, doc)

    expect(toolResultText(seen.context)).toContain('它的图片超过 5.0 MB，不能查看')
    expect(upstreamImages(runtime.scripted)).toEqual([`data:image/png;base64,${PNG_BASE64}`])
  })

  it('一轮累计超过上限被拒：预算挂在这一轮的工具实例上', async () => {
    // 4 张 4MB 的图 = 16MB 正好到顶，第 5 张被拒
    const image = new Uint8Array(4 * 1024 * 1024)
    image.set(PNG)
    const objects = Object.fromEntries(
      ['1', '2', '3', '4', '5'].map((n) => [`${OWN}${n}.png`, { data: image, contentType: 'image/png' }]),
    )
    const { reader } = fakeReader(objects)
    let second: Context | null = null
    const runtime = runtimeWith(
      [
        loadSkillStep('media-view'),
        fauxAssistantMessage([fauxToolCall(VIEW_MEDIA_TOOL_NAME, { ids: ['n1', 'n2', 'n3', 'n4'] })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxToolCall(VIEW_MEDIA_TOOL_NAME, { ids: ['n5'] })], { stopReason: 'toolUse' }),
        (context) => {
          second = context
          return fauxAssistantMessage('好')
        },
      ],
      { overrides: { mediaReader: reader } },
    )
    const doc = new Y.Doc()
    for (const n of ['1', '2', '3', '4', '5']) seed(doc, `n${n}`, 'image', { src: `${OWN}${n}.png` })

    await runOnce(runtime, doc)

    const results = (second as Context | null)?.messages.filter((message) => message.role === 'toolResult') ?? []
    const last = results.at(-1)
    expect(last && last.role === 'toolResult' ? last.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : '').toContain(
      '超过每轮上限 16.0 MB',
    )
  })

  it('点名的节点有一个不存在 → 整个调用拒绝，不读任何素材', async () => {
    const { reader, reads } = fakeReader({ [`${OWN}a.png`]: { data: PNG, contentType: 'image/png' } })
    const { steps, seen } = viewThenStop(['n_img', 'n_gone'])
    const runtime = runtimeWith(steps, { overrides: { mediaReader: reader } })
    const doc = new Y.Doc()
    seed(doc, 'n_img', 'image', { src: `${OWN}a.png` })

    await runOnce(runtime, doc)

    expect(reads).toEqual([])
    expect(toolResultText(seen.context)).toContain('这些节点不存在：n_gone')
  })
})

describe('协议两端都把图片换成占位', () => {
  const image = { type: 'image', data: PNG_BASE64, mimeType: 'image/png' }

  it('runner 上报（runnerEventOf）：message_end / tool_execution_end 里没有图片，原消息不被改', () => {
    const message = { role: 'toolResult', toolCallId: 't1', toolName: 'view_node_media', content: [{ type: 'text', text: '说明' }, image], isError: false, timestamp: 0 }
    const slim = runnerEventOf({ type: 'message_end', message } as never, () => undefined)
    expect(JSON.stringify(slim)).not.toContain(PNG_BASE64)
    expect(message.content[1]).toBe(image)

    const end = runnerEventOf(
      { type: 'tool_execution_end', toolCallId: 't1', toolName: 'view_node_media', result: { content: [image], details: {} }, isError: false } as never,
      () => undefined,
    )
    expect(JSON.stringify(end)).not.toContain(PNG_BASE64)
  })

  it('服务端解析（parseEventsRequest）：不可信的 runner 塞进来的图片也换成占位', () => {
    const parsed = parseEventsRequest({
      seq: 0,
      events: [
        { type: 'message_end', message: { role: 'toolResult', toolCallId: 't1', toolName: 'x', content: [image], isError: false, timestamp: 0 } },
        { type: 'tool_execution_end', toolCallId: 't1', toolName: 'x', result: { content: [image] }, isError: false },
      ],
    })
    expect(parsed).not.toBeNull()
    expect(JSON.stringify(parsed)).not.toContain(PNG_BASE64)
    expect(JSON.stringify(parsed)).toContain('[图片 image/png')
  })

  it('sniffImageType 按文件头认 png / jpeg / gif / webp，认不出回 null', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })
})
