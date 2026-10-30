import { createServer } from 'node:http'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall, type Context } from '@earendil-works/pi-ai'
import type { ScriptedModel, ScriptedStep } from '@shadecn/agent/testing'
import { agentApiPath, AgentEventType, type AgentStreamEvent } from '@shadecn/shared/agent'
import { replaceAgentRuntime } from '../../agent/index.ts'
import { agentMediaReader } from '../../agent/media.ts'
import { attachCollabServer } from '../../collab/hocuspocus.ts'
import { flushCollabWrites } from '../../collab/persistence.ts'
import { s3Config } from '../../config.ts'
import { AgentConversation } from '../../db/entities/index.ts'
import { replaceAssetStorage } from '../../storage/index.ts'
import { buildAssetKey } from '../../storage/keys.ts'
import type { S3Client } from '../../storage/s3.ts'
import { useScripted } from '../helpers/agent.ts'
import { db, resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, type Actor } from '../helpers/project.ts'

/**
 * agent 看图（`view_node_media`，docs/20 §3.10.7）在本服务里的接线：生产的 `agentMediaReader`
 * （素材地址 → 本桶的对象键 → 按键签名读）+ 假的对象存储，经整个 app 的网关路由跑完整的二期路径。
 * 守的是：本桶的图片交到上游模型请求里；外部地址一个请求都不发（防 SSRF）；超限被拒；落库的对话里没有图片字节。
 */

beforeAll(async () => {
  await attachCollabServer(createServer() as never)
})

beforeEach(async () => {
  await resetDb()
})

afterEach(async () => {
  replaceAgentRuntime(null)
  replaceAssetStorage(undefined)
  await flushCollabWrites()
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const PNG_BASE64 = Buffer.from(PNG).toString('base64')

/** 假的对象存储：`getObject` 记下读了哪些键，按上限回 too_large */
function fakeStorage(objects: Map<string, Uint8Array>) {
  const reads: string[] = []
  const client: S3Client = {
    objectUrl: (key) => `https://s3.example.test/canvas-bucket/${key}`,
    putObject: async (key) => client.objectUrl(key),
    headObject: async () => null,
    async getObject(key, { maxBytes }) {
      reads.push(key)
      const body = objects.get(key)
      if (!body) return { status: 'not_found' }
      if (body.byteLength > maxBytes) return { status: 'too_large' }
      return { status: 'ok', body, contentType: 'image/png' }
    },
    createMultipartUpload: async () => 'u',
    uploadPart: async () => '"e"',
    completeMultipartUpload: async (key) => client.objectUrl(key),
    abortMultipartUpload: async () => {},
  }
  return { client, reads }
}

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
    fauxAssistantMessage([fauxToolCall('add_node', { type: 'image', metadata: { label: '参考图' }, data: { src } })], {
      stopReason: 'toolUse',
    }),
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

function parseSse(raw: string): AgentStreamEvent[] {
  return raw
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as AgentStreamEvent)
}

async function runOnce(who: Actor, flowId: string) {
  const res = await who.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '看看这张图' })
  expect(res.status).toBe(200)
  const raw = await res.text()
  return { raw, events: parseSse(raw) }
}

function upstreamImages(scripted: ScriptedModel): string[] {
  const body = scripted.requests.at(-1)?.body as { messages: { content: unknown }[] }
  return body.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as { type: string; image_url?: { url: string } }[])
          .filter((part) => part.type === 'image_url')
          .map((part) => part.image_url!.url)
      : [],
  )
}

describe('view_node_media（生产接线：agentMediaReader + 对象存储）', () => {
  it('本桶的图片 → 按键读、交到上游模型请求里；SSE 和落库的对话里没有图片字节', async () => {
    const key = buildAssetKey(s3Config.keyPrefix, { name: 'cat.png', contentType: 'image/png' })
    const storage = fakeStorage(new Map([[key, PNG]]))
    replaceAssetStorage(storage.client)
    const { steps } = addThenView(storage.client.objectUrl(key))
    const runtime = useScripted(steps, { mediaReader: agentMediaReader }, { imageInput: true })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const { raw, events } = await runOnce(alice, flowId)

    expect(events.at(-1)?.type).toBe(AgentEventType.RUN_FINISHED)
    expect(storage.reads).toEqual([key])
    expect(upstreamImages(runtime.scripted)).toEqual([`data:image/png;base64,${PNG_BASE64}`])
    expect(raw).not.toContain(PNG_BASE64)

    const threadId = (events[0] as { threadId: string }).threadId
    // llmMessages 是 lazy 的文本列：显式带上
    const row = await db().findOneOrFail(AgentConversation, threadId, { populate: ['llmMessages'] })
    const stored = row.llmMessages
    expect(stored).not.toContain(PNG_BASE64)
    expect(stored).toContain('[图片 image/png')
  })

  it('外部地址（含内网元数据地址）→ 模型收到「外部链接不能查看」，对象存储和网络一个请求都不发', async () => {
    const storage = fakeStorage(new Map())
    replaceAssetStorage(storage.client)
    const { steps, seen, lastToolText } = addThenView('http://169.254.169.254/latest/meta-data/iam.png')
    useScripted(steps, { mediaReader: agentMediaReader }, { imageInput: true })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const { events } = await runOnce(alice, flowId)

    expect(storage.reads).toEqual([])
    expect(lastToolText(seen.context!)).toContain('外部链接不能查看')
    expect(events.filter((event) => event.type === AgentEventType.TOOL_CALL_RESULT).at(-1)).toMatchObject({
      metadata: { status: 'error' },
    })
  })

  it('本桶里的图超过单张上限 → 不读完、拒绝并告诉模型', async () => {
    const key = buildAssetKey(s3Config.keyPrefix, { name: 'huge.png', contentType: 'image/png' })
    const huge = new Uint8Array(5 * 1024 * 1024 + 1)
    huge.set(PNG)
    const storage = fakeStorage(new Map([[key, huge]]))
    replaceAssetStorage(storage.client)
    const { steps, seen, lastToolText } = addThenView(storage.client.objectUrl(key))
    const runtime = useScripted(steps, { mediaReader: agentMediaReader }, { imageInput: true })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    await runOnce(alice, flowId)

    expect(storage.reads).toEqual([key])
    expect(lastToolText(seen.context!)).toContain('超过 5.0 MB，不能查看')
    expect(upstreamImages(runtime.scripted)).toEqual([])
  })

  it('没配对象存储 → 告诉模型暂时读不到（生产接线在没配 S3 时根本不接这个工具，见 agent/index.ts）', async () => {
    replaceAssetStorage(null)
    const { steps, seen, lastToolText } = addThenView('https://s3.example.test/canvas-bucket/x.png')
    useScripted(steps, { mediaReader: agentMediaReader }, { imageInput: true })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    await runOnce(alice, flowId)

    expect(lastToolText(seen.context!)).toContain('暂时读不到')
  })
})
