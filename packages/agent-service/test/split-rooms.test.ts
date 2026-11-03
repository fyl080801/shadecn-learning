import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { createAgentRuntime } from '@learning/agent-core/session'
import { gatewayFetch, registerScriptedModel, type ScriptedStep } from '@learning/agent-core/testing'
import { ClusterModule } from '@learning/cluster'
import { CollabGatewayModule, CollabServer, roomOf } from '@learning/collab'
import { testConfigModule } from '@learning/config/testing'
import { agentApiPath, AgentEventType, parseAgentRunsMessage, type AgentRunEntry, type AgentStreamEvent } from '@learning/contracts/agent'
import { AGENT_RUNS_MESSAGE } from '@learning/contracts/collab'
import { nodeGroupMap, nodesMap, toYNode } from '@learning/contracts/flow-doc'
import { buildNodeRecord } from '@learning/contracts/flow-node-types'
import { DataAccess, DataAccessModule } from '@learning/data-access'
import { boundHttpClose } from '@learning/foundation'
import { ApiSessionGuard, SessionIdentityModule } from '@learning/session'
import { Module } from '@nestjs/common'
import { APP_GUARD, NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { AgentCanvasAccess } from '../src/canvas-access.js'
import { AGENT_HOST_OPTIONS, type AgentHostOptions } from '../src/runtime.js'
import { AGENT_RUNTIME } from '../src/sandbox.js'
import { assertTestDatabase, bootAgentApp, createHttpActor, createHttpFlow, createHttpProject, ensureRunnerBuilt, gated, type HttpActor, joinHttpInvite, parseSse, realFetch, silenceConsole, storedNodeIds, type SwitchableRuntime, TEST_ENV, until } from './helpers.js'

/**
 * 拆开形态（docs/31 §6.2、§7 第 7 小步）：平台有房间、没有 WebSocket 入口，人连在协同副本上，两边只经真 Redis 相通。
 * 平台这边走生产的控制器和网关挂载（`http: true`），副本是真 WebSocket + 真 `@hocuspocus/provider`，模型是脚本。
 * 没设 `PLATFORM_TEST_REDIS_URL` 整组跳过。库默认 SQLite 临时文件，设了 `PLATFORM_TEST_DATABASE_URL` 走 PostgreSQL 的独立 schema。
 */

const redisUrl = process.env.PLATFORM_TEST_REDIS_URL
const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL
const TIMEOUT = { timeout: 10_000, interval: 20 }

@Module({ providers: [{ provide: APP_GUARD, useClass: ApiSessionGuard }] })
class ReplicaGuardModule {}

interface Watcher {
  doc: Y.Doc
  provider: HocuspocusProvider
  /** 收到的每一条 `agent:runs` */
  runs: { flowId: string; runs: AgentRunEntry[]; now?: number }[]
  synced(): boolean
}

/** 真的 provider。Node 的全局 WebSocket（undici）能带请求头，正好代替浏览器自动带的 cookie；`fetch` 被换掉不影响它 */
function connect(wsUrl: string, flowId: string, cookie: string): Watcher {
  class CookieWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, { protocols, headers: { cookie } } as never)
    }
  }
  const doc = new Y.Doc()
  const runs: Watcher['runs'] = []
  let synced = false
  const provider = new HocuspocusProvider({
    url: `${wsUrl}/ws/collaboration`,
    name: roomOf(flowId),
    document: doc,
    WebSocketPolyfill: CookieWebSocket,
    onStateless: ({ payload }: { payload: string }) => {
      if (!payload.includes(AGENT_RUNS_MESSAGE)) return
      const parsed = parseAgentRunsMessage(payload)
      if (parsed) runs.push(parsed)
    },
    onSynced: () => {
      synced = true
    },
    // 配置原样转给内部的 HocuspocusProviderWebsocket，只是类型上没写这一项
  } as ConstructorParameters<typeof HocuspocusProvider>[0])
  return { doc, provider, runs, synced: () => synced }
}

/** 边到边攒的 SSE */
function follow(res: Response) {
  const state = { raw: '', ended: false }
  const decoder = new TextDecoder()
  const ended = (async () => {
    const reader = res.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      state.raw += decoder.decode(value, { stream: true })
    }
    state.ended = true
  })()
  return { state, ended, events: (): AgentStreamEvent[] => parseSse(state.raw) }
}

function textNode(id: string) {
  return toYNode({ ...buildNodeRecord({ id, type: 'text', label: `节点${id}`, position: { x: 0, y: 0 } }), data: { text: '原文' } })
}

const dataOf = (doc: Y.Doc, id: string) => nodeGroupMap(nodesMap(doc).get(id), 'data')?.toJSON() as Record<string, unknown> | undefined

describe.skipIf(!redisUrl)('拆开形态：平台的房间和协同副本（真 Redis）', () => {
  const schema = 'agent_split_rooms'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-split-'))
  const databaseUrl = postgresUrl ? `${postgresUrl}?schema=${schema}` : `file:${path.join(dir, 'test.db')}`
  const cluster = { mode: 'redis', url: redisUrl }

  let platform: NestFastifyApplication
  let baseUrl = ''
  let replica: NestFastifyApplication
  let wsUrl = ''
  const watchers: Watcher[] = []
  const runtimes: { abortAll(reason: string): Promise<unknown> }[] = []

  async function bootReplica(): Promise<{ app: NestFastifyApplication; wsUrl: string }> {
    const app = await NestFactory.create<NestFastifyApplication>(
      {
        module: ReplicaGuardModule,
        imports: [testConfigModule({ database: { url: databaseUrl, schemaSync: 'off' }, session: { ttlSeconds: 3600 }, cluster }, { env: TEST_ENV }), DataAccessModule, ClusterModule, SessionIdentityModule, CollabGatewayModule],
      },
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    )
    boundHttpClose(app)
    await app.listen(0, '127.0.0.1')
    return { app, wsUrl: (await app.getUrl()).replace('http://', 'ws://') }
  }

  /** 脚本化模型 + 生产的宿主接线；runner 在进程内，经真 socket 走 `/api/agent-gateway` */
  function useScripted(steps: ScriptedStep[]) {
    const scripted = registerScriptedModel()
    scripted.setResponses(steps)
    const runtime = createAgentRuntime({ ...scripted.runtimeOptions(), ...platform.get<AgentHostOptions>(AGENT_HOST_OPTIONS, { strict: false }) })
    runtimes.push(runtime)
    platform.get<SwitchableRuntime>(AGENT_RUNTIME, { strict: false }).use(runtime)
    vi.stubGlobal('fetch', gatewayFetch((request) => realFetch(new Request(`${baseUrl}${new URL(request.url).pathname}`, request))))
    return { scripted, runtime }
  }

  const collab = () => platform.get(CollabServer, { strict: false })

  function watch(url: string, flowId: string, who: HttpActor): Watcher {
    const watcher = connect(url, flowId, who.cookie)
    watchers.push(watcher)
    return watcher
  }

  async function room(): Promise<{ alice: HttpActor; bob: HttpActor; flowId: string }> {
    const alice = await createHttpActor(platform, baseUrl, 'alice')
    const bob = await createHttpActor(platform, baseUrl, 'bob')
    const projectId = await createHttpProject(alice)
    await joinHttpInvite(alice, projectId, bob)
    return { alice, bob, flowId: await createHttpFlow(alice, projectId) }
  }

  const send = async (who: HttpActor, flowId: string, text: string) => {
    const res = await who.json(`${agentApiPath(flowId)}/messages`, 'POST', { text })
    expect(res.status).toBe(200)
    return follow(res)
  }

  beforeAll(async () => {
    silenceConsole()
    ensureRunnerBuilt()
    if (postgresUrl) assertTestDatabase(postgresUrl)
    // 先于副本：副本 off，不建表
    platform = await bootAgentApp({ databaseUrl, values: { cluster }, http: true })
    baseUrl = await platform.getUrl()
    const booted = await bootReplica()
    replica = booted.app
    wsUrl = booted.wsUrl
  }, 60_000)

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.abortAll('用例结束')))
    for (const watcher of watchers.splice(0)) watcher.provider.destroy()
    await until(() => collab().hocuspocus.getConnectionsCount() === 0, '平台的房间散场')
    vi.unstubAllGlobals()
    platform.get<SwitchableRuntime>(AGENT_RUNTIME, { strict: false }).use(null)
  })

  afterAll(async () => {
    await replica?.close()
    if (postgresUrl) await platform?.get(DataAccess).orm.schema.execute(`drop schema if exists ${schema} cascade`)
    await platform?.close()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  }, 30_000)

  it('agent:runs 到得了副本上的人：一轮开始、占用变化都推全量，结束推空列表（这时平台的房间已经散了）', async () => {
    const hold = gated()
    useScripted([fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: '新的' }, data: { text: '正文' } })], { stopReason: 'toolUse' }), hold.step])
    const { alice, bob, flowId } = await room()
    const onReplica = watch(wsUrl, flowId, bob)
    await vi.waitFor(() => expect(onReplica.synced()).toBe(true), TIMEOUT)

    const stream = await send(alice, flowId, '加一个')
    await hold.reached
    await vi.waitFor(() => expect(onReplica.runs.some((message) => message.runs[0]?.occupies.length === 1)).toBe(true), TIMEOUT)
    const first = onReplica.runs[0]!
    expect(first.flowId).toBe(flowId)
    expect(first.now).toEqual(expect.any(Number))
    expect(first.runs).toEqual([expect.objectContaining({ runId: expect.any(String), owner: { id: alice.userId, name: 'alice', avatarUrl: null } })])
    // 不是平台本地发的：平台上没有 WebSocket 连接，人在副本上
    expect(collab().hocuspocus.documents.get(roomOf(flowId))?.getConnections()).toEqual([])
    expect(replica.get(CollabServer, { strict: false }).hocuspocus.documents.get(roomOf(flowId))?.getConnections()).toHaveLength(1)

    hold.release()
    await stream.ended
    expect(stream.events().at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED })
    // 一轮收尾时 direct connection 已经断开、房间卸载了，这条只能走共享层，不然副本上的人要等 expiresAt（30 秒）才看到它结束
    await vi.waitFor(() => expect(onReplica.runs.at(-1)?.runs).toEqual([]), TIMEOUT)
  })

  it('平台上没有这个房间时，任务列表照样经共享层到副本', async () => {
    const { alice, flowId } = await room()
    const onReplica = watch(wsUrl, flowId, alice)
    await vi.waitFor(() => expect(onReplica.synced()).toBe(true), TIMEOUT)
    expect(collab().hocuspocus.documents.has(roomOf(flowId))).toBe(false)

    expect(platform.get(AgentCanvasAccess, { strict: false }).broadcastRuns(flowId, [])).toBe(false)
    await vi.waitFor(() => expect(onReplica.runs).toEqual([expect.objectContaining({ flowId, runs: [] })]), TIMEOUT)
  })

  it('副本上的人改节点：模型下一步的请求里带着改动通知，被改的节点写入被拒绝，工具结果里是拒绝文案', async () => {
    const hold = gated()
    const { alice, bob, flowId } = await room()
    const onReplica = watch(wsUrl, flowId, bob)
    await vi.waitFor(() => expect(onReplica.synced()).toBe(true), TIMEOUT)
    nodesMap(onReplica.doc).set('n1', textNode('n1'))

    const reply = fauxAssistantMessage([fauxToolCall('update_node', { id: 'n1', data: { text: 'agent 写的' } })], { stopReason: 'toolUse' })
    const first: ScriptedStep = async (context, options) => {
      await hold.step(context, options, { callCount: 0 })
      return reply
    }
    const { scripted } = useScripted([first, fauxAssistantMessage('知道了')])
    const stream = await send(alice, flowId, '改 n1')
    await hold.reached
    // 这一步之前平台上已经开了房间，还收到了副本上那个节点（开房间时等到对方的状态）
    const live = () => collab().hocuspocus.documents.get(roomOf(flowId))
    await vi.waitFor(() => expect(live() && dataOf(live()!, 'n1')).toEqual({ text: '原文' }), TIMEOUT)
    expect(JSON.stringify(scripted.requests[0]!.body)).not.toContain('其他协作者')

    nodeGroupMap(nodesMap(onReplica.doc).get('n1'), 'data')!.set('text', '乙改的')
    await vi.waitFor(() => expect(dataOf(live()!, 'n1')).toEqual({ text: '乙改的' }), TIMEOUT)

    hold.release()
    await stream.ended
    expect(scripted.requests).toHaveLength(2)
    const nextRequest = JSON.stringify(scripted.requests[1]!.body)
    // 改动通知：redis 转发来的认不出是谁，就是「其他协作者」（docs/31 §6.2）
    expect(nextRequest).toContain('其他协作者 改动了画布')
    expect(nextRequest).toContain('n1')
    // 工具结果：这次写入被拒绝
    expect(nextRequest).toContain('在你读过之后被改过')
    const failed = stream.events().find((event) => event.type === AgentEventType.TOOL_CALL_RESULT && String((event as { content?: unknown }).content).includes('在你读过之后被改过'))
    expect(failed, JSON.stringify(stream.events().map((event) => event.type))).toBeDefined()
    // 副本上的人写的还在，agent 那次写入没有落到文档里
    await vi.waitFor(() => expect(dataOf(onReplica.doc, 'n1')).toEqual({ text: '乙改的' }), TIMEOUT)
  })

  it('一个副本退出，这一轮继续：另一个副本上的人收到写入，发起者的流不断，内容在库里', async () => {
    const hold = gated()
    const writeAfterRelease: ScriptedStep = async (context, options) => {
      await hold.step(context, options, { callCount: 0 })
      return fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: '退出之后写的' }, data: { text: '正文' } })], { stopReason: 'toolUse' })
    }
    useScripted([writeAfterRelease, fauxAssistantMessage('写完了')])
    const { alice, bob, flowId } = await room()
    const leaving = await bootReplica()
    let leavingClosed = false
    try {
      const onLeaving = watch(leaving.wsUrl, flowId, alice)
      const onStaying = watch(wsUrl, flowId, bob)
      await vi.waitFor(() => expect(onLeaving.synced() && onStaying.synced()).toBe(true), TIMEOUT)
      nodesMap(onLeaving.doc).set('before', textNode('before'))
      await vi.waitFor(() => expect([...nodesMap(onStaying.doc).keys()]).toEqual(['before']), TIMEOUT)

      const stream = await send(alice, flowId, '写一个')
      await hold.reached
      await leaving.app.close()
      leavingClosed = true
      expect(stream.state.ended).toBe(false)

      hold.release()
      await stream.ended
      expect(stream.events().at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED })
      await vi.waitFor(() => expect(nodesMap(onStaying.doc).size).toBe(2), TIMEOUT)
      expect([...nodesMap(onStaying.doc).keys()]).toContain('before')
      onStaying.provider.destroy()
      await vi.waitFor(async () => expect(await storedNodeIds(platform, flowId)).toHaveLength(2), TIMEOUT)
    } finally {
      if (!leavingClosed) await leaving.app.close()
    }
  }, 30_000)

  it('别的副本的人和这一轮共用同一份内容：agent 写的节点在副本上看得到，副本上的人没落库的节点 agent 也读得到', async () => {
    const seen: string[] = []
    const { alice, flowId } = await room()
    const onReplica = watch(wsUrl, flowId, alice)
    await vi.waitFor(() => expect(onReplica.synced()).toBe(true), TIMEOUT)
    nodesMap(onReplica.doc).set('unsaved', textNode('unsaved'))
    // 落库防抖还没到：库里没有，下面只可能是开房间时从副本同步来的
    expect(await storedNodeIds(platform, flowId)).toEqual([])

    useScripted([
      fauxAssistantMessage([fauxToolCall('get_node', { id: 'unsaved' })], { stopReason: 'toolUse' }),
      (context) => {
        const result = [...context.messages].reverse().find((message) => message.role === 'toolResult')
        seen.push(JSON.stringify(result))
        return fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: 'agent 的' }, data: { text: '正文' } })], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('好了'),
    ])
    const stream = await send(alice, flowId, '读一下再写一个')
    await stream.ended
    expect(seen[0]).toContain('原文')
    await vi.waitFor(() => expect(nodesMap(onReplica.doc).size).toBe(2), TIMEOUT)
  })
})
