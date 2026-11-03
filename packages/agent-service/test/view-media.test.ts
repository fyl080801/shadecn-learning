import { fauxAssistantMessage, fauxToolCall, type Context } from '@earendil-works/pi-ai'
import type { ScriptedModel, ScriptedStep } from '@learning/agent-core/testing'
import { MediaReadError } from '@learning/agent-core/media'
import { AgentEventType } from '@learning/contracts/agent'
import { DataAccess } from '@learning/data-access'
import { AssetStorage, FlowAsset } from '@learning/storage'
import { describe, expect, it, vi } from 'vitest'
import { AgentConversation } from '../src/entities.js'
import { AgentMediaReader } from '../src/media.js'
import { buildAssetKey } from '../../storage/src/keys.js'
import { createFlow, createProject, describeOnBothDatabases } from './helpers.js'

/**
 * agent 看图（`view_node_media`，docs/20 §3.10.7）的接线：生产的 `AgentMediaReader`（素材地址 → 本桶的对象键 → 按键读）+ 假的对象存储，跑完整路径。
 * 守的是：本桶的图片交到上游模型请求里；外部地址一个请求都不发（防 SSRF）；超限被拒；落库的对话里没有图片字节；复制出来的画布上读得到。
 * 从 `apps/server/test/agent/view-media.test.ts` 移植。
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const PNG_BASE64 = Buffer.from(PNG).toString('base64')
const KEY_PREFIX = 'canvas'

/**
 * 四步：加载技能 media-view → 建一个带 `src` 的图片节点 → 用它的 id 调 view_node_media → 记下模型这次收到的上下文再收尾。
 * id 是服务端建节点时生成的，从上一个工具结果（add_node 的 JSON）里取。
 */
function addThenView(src: string) {
  const seen: { context: Context | null } = { context: null }
  const lastToolText = (context: Context) => {
    const result = context.messages.filter((message) => message.role === 'toolResult').at(-1)
    return result && result.role === 'toolResult' ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : ''
  }
  const steps: ScriptedStep[] = [
    // 看图是按需技能 media-view（docs/23）：先单独加载
    fauxAssistantMessage([fauxToolCall('load_skill', { id: 'media-view' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('add_node', { type: 'image', metadata: { label: '参考图' }, data: { src } })], { stopReason: 'toolUse' }),
    (context) => {
      const { id } = JSON.parse(lastToolText(context)) as { id: string }
      return fauxAssistantMessage([fauxToolCall('view_node_media', { ids: [id] })], { stopReason: 'toolUse' })
    },
    (context) => {
      seen.context = context
      return fauxAssistantMessage('看完了')
    },
  ]
  return { steps, seen, lastToolText }
}

function upstreamImages(scripted: ScriptedModel): string[] {
  const body = scripted.requests.at(-1)?.body as { messages: { content: unknown }[] }
  return body.messages.flatMap((message) =>
    Array.isArray(message.content) ? (message.content as { type: string; image_url?: { url: string } }[]).filter((part) => part.type === 'image_url').map((part) => part.image_url!.url) : [],
  )
}

describeOnBothDatabases('view_node_media（生产接线：AgentMediaReader + 对象存储）', 'agent_view_media', (ctx) => {
  const reader = () => ctx.app.get(AgentMediaReader, { strict: false })
  const key = (name: string) => buildAssetKey(KEY_PREFIX, { name, contentType: 'image/png' })
  const useMedia = (steps: ScriptedStep[]) => ctx.useScripted(steps, { mediaReader: reader() }, { imageInput: true })

  it('本桶的图片 → 按键读、交到上游模型请求里；事件流和落库的对话里没有图片字节', async () => {
    const assetKey = key('cat.png')
    ctx.s3.objects.set(assetKey, { body: PNG, contentType: 'image/png' })
    const { steps } = addThenView(ctx.s3.client.objectUrl(assetKey))
    const runtime = useMedia(steps)
    const alice = await ctx.actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const events = await ctx.send(runtime, alice, flowId, '看看这张图')

    expect(events.at(-1)?.type).toBe(AgentEventType.RUN_FINISHED)
    expect(ctx.s3.reads).toEqual([assetKey])
    expect(upstreamImages(runtime.scripted)).toEqual([`data:image/png;base64,${PNG_BASE64}`])
    expect(JSON.stringify(events)).not.toContain(PNG_BASE64)

    const threadId = (events[0] as { threadId: string }).threadId
    // llmMessages 是 lazy 的文本列：显式带上
    const row = await ctx.app.get(DataAccess).em().findOneOrFail(AgentConversation, threadId, { populate: ['llmMessages'] })
    const stored = row.llmMessages
    expect(stored).not.toContain(PNG_BASE64)
    expect(stored).toContain('[图片 image/png')
  })

  it('外部地址（含内网元数据地址）→ 模型收到「外部链接不能查看」，对象存储和网络一个请求都不发', async () => {
    const { steps, seen, lastToolText } = addThenView('http://169.254.169.254/latest/meta-data/iam.png')
    const runtime = useMedia(steps)
    const alice = await ctx.actor()
    const flowId = await createFlow(alice, await createProject(alice))

    // useMedia 换上的 fetch 只放行测试网关，别的地址抛错：这里再记一笔，看有没有人试过
    const gateway = globalThis.fetch
    const requested: string[] = []
    vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requested.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return gateway(input, init)
    })
    const events = await ctx.send(runtime, alice, flowId, '看看这张图')

    expect(ctx.s3.reads).toEqual([])
    expect(requested.filter((url) => url.includes('169.254'))).toEqual([])
    expect(lastToolText(seen.context!)).toContain('外部链接不能查看')
    expect(events.filter((event) => event.type === AgentEventType.TOOL_CALL_RESULT).at(-1)).toMatchObject({ metadata: { status: 'error' } })
  })

  it('本桶里的图超过单张上限 → 不读完、拒绝并告诉模型', async () => {
    const assetKey = key('huge.png')
    const huge = new Uint8Array(5 * 1024 * 1024 + 1)
    huge.set(PNG)
    ctx.s3.objects.set(assetKey, { body: huge, contentType: 'image/png' })
    const { steps, seen, lastToolText } = addThenView(ctx.s3.client.objectUrl(assetKey))
    const runtime = useMedia(steps)
    const alice = await ctx.actor()
    const flowId = await createFlow(alice, await createProject(alice))

    await ctx.send(runtime, alice, flowId, '看看这张图')

    expect(ctx.s3.reads).toEqual([assetKey])
    expect(lastToolText(seen.context!)).toContain('超过 5.0 MB，不能查看')
    expect(upstreamImages(runtime.scripted)).toEqual([])
  })

  it('复制出来的画布上读得到：复制不带上传记录（AssetStorage.read 查归属，读不到），走 readByUrl', async () => {
    const assetKey = key('cat.png')
    const url = ctx.s3.client.objectUrl(assetKey)
    ctx.s3.objects.set(assetKey, { body: PNG, contentType: 'image/png' })
    const alice = await ctx.actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const em = ctx.app.get(DataAccess).em()
    em.create(FlowAsset, { key: assetKey, flow: flowId, contentType: 'image/png', createdById: alice.userId })
    await em.flush()

    const copy = (await alice.json(`/api/flows/${flowId}/duplicate`, 'POST')).json<{ id: string }>().id
    expect(copy).not.toBe(flowId)
    const storage = ctx.app.get(AssetStorage, { strict: false })
    expect(await storage.read(flowId, url, { maxBytes: 1024 })).not.toBeNull()
    expect(await storage.read(copy, url, { maxBytes: 1024 })).toBeNull()

    const { steps } = addThenView(url)
    const runtime = useMedia(steps)
    const events = await ctx.send(runtime, alice, copy, '看看这张图')
    expect(events.at(-1)?.type).toBe(AgentEventType.RUN_FINISHED)
    expect(upstreamImages(runtime.scripted)).toEqual([`data:image/png;base64,${PNG_BASE64}`])
  })

  describe('AgentMediaReader 把 readByUrl 的结果映射成 MediaReadError', () => {
    const failure = async (url: string, maxBytes = 1024) => {
      const err = await reader().read(url, { maxBytes }).then(() => null, (error: unknown) => error)
      expect(err).toBeInstanceOf(MediaReadError)
      return err as MediaReadError
    }

    it('foreign（一个 S3 请求都不发）；not_found；too_large', async () => {
      const foreign = await failure('https://evil.example/x.png')
      expect(foreign.kind).toBe('foreign')
      expect(ctx.s3.reads).toEqual([])
      // 别的桶也不算
      expect((await failure('https://s3.example.test/other-bucket/canvas/assets/x.png')).kind).toBe('foreign')
      expect(ctx.s3.reads).toEqual([])

      const assetKey = key('big.png')
      expect((await failure(ctx.s3.client.objectUrl(assetKey))).kind).toBe('not_found')
      ctx.s3.objects.set(assetKey, { body: PNG, contentType: 'image/png' })
      expect((await failure(ctx.s3.client.objectUrl(assetKey), 1)).kind).toBe('too_large')
    })

    it('类型取自 S3 记的，字节原样交回', async () => {
      const assetKey = key('ok.png')
      ctx.s3.objects.set(assetKey, { body: PNG, contentType: 'image/webp' })
      expect(await reader().read(ctx.s3.client.objectUrl(assetKey), { maxBytes: 1024 })).toEqual({ data: PNG, contentType: 'image/webp' })
    })

    it('S3 出错（reject）→ unavailable，细节不进模型上下文；调用方已中止就原样抛', async () => {
      const assetKey = key('down.png')
      const get = vi.spyOn(ctx.s3.client, 'getObject').mockRejectedValue(new Error('桶名 secret-bucket 500'))
      try {
        const err = await failure(ctx.s3.client.objectUrl(assetKey))
        expect(err.kind).toBe('unavailable')
        expect(err.message).not.toContain('secret-bucket')

        const controller = new AbortController()
        controller.abort()
        await expect(reader().read(ctx.s3.client.objectUrl(assetKey), { maxBytes: 1024, signal: controller.signal })).rejects.toThrow('secret-bucket')
      } finally {
        get.mockRestore()
      }
    })
  })
})

describeOnBothDatabases(
  '没配对象存储',
  'agent_no_s3',
  (ctx) => {
    it('告诉模型暂时读不到，一个请求都不发（生产接线在没配 S3 时根本不接这个工具，见 module.test.ts）', async () => {
      const { steps, seen, lastToolText } = addThenView('https://s3.example.test/canvas-bucket/x.png')
      const runtime = ctx.useScripted(steps, { mediaReader: ctx.app.get(AgentMediaReader, { strict: false }) }, { imageInput: true })
      const alice = await ctx.actor()
      const flowId = await createFlow(alice, await createProject(alice))

      await ctx.send(runtime, alice, flowId, '看看这张图')

      expect(lastToolText(seen.context!)).toContain('暂时读不到')
    })

    it('读 → unavailable', async () => {
      const err = await ctx.app.get(AgentMediaReader, { strict: false }).read('https://s3.example.test/canvas-bucket/x.png', { maxBytes: 1024 }).then(() => null, (error: unknown) => error)
      expect(err).toMatchObject({ kind: 'unavailable', message: '服务端没有配置对象存储' })
    })
  },
  { s3: null },
)
