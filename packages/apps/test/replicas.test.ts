import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { CollabServer, roomOf } from '@learning/collab'
import { type AppTaskView, parseAppTasksMessage } from '@learning/contracts/apps'
import { nodesMap, toYNode } from '@learning/contracts/flow-doc'
import { DataAccess } from '@learning/data-access'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as Y from 'yjs'
import { AppTask } from '../src/entities.js'
import { TaskRunner } from '../src/task-runner.js'
import {
  type Actor,
  arkUpstream,
  assertTestDatabase,
  bootAppsApp,
  connect,
  createActor,
  createFlow,
  createProject,
  fakeS3,
  IMAGE_APP,
  joinViaInvite,
  nodeRecord,
  nodeWithStatus,
  storedNode,
  submit,
  taskDone,
  taskRow,
  type TestClient,
  until,
  VIDEO_APP,
} from './helpers.js'

const redisUrl = process.env.PLATFORM_TEST_REDIS_URL
const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL

/**
 * 和部署同样的形状（docs/30 §3、§8）：平台（`PlatformBaseModule`，`apply`，有 `AppsModule`，**没有协同入口**）+ 两个副本（`off`，只有协同入口），共用数据库和真 Redis。
 * 用户都连在副本上，任务在平台上跑，结果经平台进程里的 direct connection + Redis 扩展进房间。没设 `PLATFORM_TEST_REDIS_URL` 整组跳过。
 */
describe.skipIf(!redisUrl)('平台 + 两个副本（真 Redis）', () => {
  const schema = 'apps_replicas_test'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-replicas-'))
  const databaseUrl = postgresUrl ? `${postgresUrl}?schema=${schema}` : `file:${path.join(dir, 'test.db')}`
  const values = { cluster: { mode: 'redis', url: redisUrl } }
  const s3 = fakeS3()

  let platform: NestFastifyApplication
  let replica1: { app: NestFastifyApplication; url: string }
  let replica2: { app: NestFastifyApplication; url: string }
  const clients: TestClient[] = []

  const bootPlatform = (runner?: Parameters<typeof bootAppsApp>[0]['runner']) => bootAppsApp({ databaseUrl, gateway: false, values, s3: s3.client, runner })
  async function bootReplica() {
    const app = await bootAppsApp({ databaseUrl, replica: true, values: { ...values, database: { url: databaseUrl, schemaSync: 'off' }, apps: undefined, llm: undefined } })
    return { app, url: await app.getUrl() }
  }
  const open = (replica: { url: string }, flowId: string, actor: Actor) => {
    const client = connect(replica.url, flowId, actor.cookie)
    clients.push(client)
    return client
  }
  const synced = (client: TestClient) => until(() => client.synced(), '客户端同步完成')
  const group = (client: TestClient, nodeId: string, name: string) => (nodesMap(client.doc).get(nodeId) as Y.Map<unknown> | undefined)?.get(name) as Y.Map<unknown> | undefined
  const platformDocs = (app: NestFastifyApplication) => app.get(CollabServer, { strict: false }).hocuspocus.documents

  /** 节点是客户端写的、**还没落库**：只可能经 Redis 扩展到平台的房间 */
  function addNode(client: TestClient, record: ReturnType<typeof nodeRecord>) {
    client.doc.transact(() => {
      nodesMap(client.doc).set(record.id, toYNode(record))
    })
  }

  async function room(members: Actor[] = []) {
    const alice = await createActor(platform, 'alice')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    for (const member of members) await joinViaInvite(alice, projectId, member)
    return { alice, projectId, flowId }
  }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    if (postgresUrl) assertTestDatabase(postgresUrl)
    platform = await bootPlatform()
    replica1 = await bootReplica()
    replica2 = await bootReplica()
  }, 60_000)

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy()
    const runner = platform.get(TaskRunner, { strict: false })
    for (const id of runner.running()) runner.abortTask(id, 'canceled')
    await until(() => runner.running().length === 0, '任务都停下来')
    await until(() => platformDocs(platform).size === 0, '平台的房间散场')
    vi.unstubAllGlobals()
  }, 30_000)

  afterAll(async () => {
    await replica1?.app.close()
    await replica2?.app.close()
    if (postgresUrl) await platform?.get(DataAccess).orm.schema.execute(`drop schema if exists ${schema} cascade`)
    await platform?.close()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('平台进程有房间但没有 WebSocket 入口：没有 upgrade 监听，/api/collab 和 /doc 都没有，应用接口在', async () => {
    expect((platform.getHttpServer() as http.Server).listenerCount('upgrade')).toBe(0)
    const { alice, flowId } = await room()
    expect((await alice.request('/api/collab/health')).status).toBe(404)
    expect((await alice.request(`/api/flows/${flowId}/doc`)).status).toBe(404)
    expect((await alice.request('/api/apps')).status).toBe(200)
    // 副本这边没有应用接口：前置代理把它们分给平台（apps/collab/test/app.test.ts）
    const replicaGet = (url: string) => replica1.app.inject({ method: 'GET', url, headers: { cookie: alice.cookie } })
    expect((await replicaGet('/api/apps')).statusCode).toBe(404)
    expect((await replicaGet(`/api/flows/${flowId}/apps/tasks`)).statusCode).toBe(404)
  })

  it('结果进房间：两个账号连在不同副本上，都不刷新就看到 processing → 结果；还没落库的节点平台也看得到；断开后落库', async () => {
    const carol = await createActor(platform, 'carol')
    const { alice, flowId } = await room([carol])
    const a = open(replica1, flowId, alice)
    const c = open(replica2, flowId, carol)
    await synced(a)
    await synced(c)
    addNode(a, nodeRecord('n_vid', 'video'))
    await until(() => group(c, 'n_vid', 'runtime'), '节点到了另一个副本')
    // 这时库里还没有这个节点：防抖 2 秒没到
    expect(await storedNode(platform, flowId, 'n_vid')).toBeNull()

    arkUpstream({ videoRunsFor: 3 })
    const { status, task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
    expect(status).toBe(202)
    await until(() => group(a, 'n_vid', 'runtime')?.get('status') === 'processing' && group(c, 'n_vid', 'runtime')?.get('status') === 'processing', '两个副本上都是 processing')
    expect(platformDocs(platform).has(roomOf(flowId))).toBe(true)

    await until(() => group(a, 'n_vid', 'data')?.get('src') && group(c, 'n_vid', 'data')?.get('src'), '结果在两个副本上都看得见')
    expect(group(c, 'n_vid', 'data')?.get('src')).toMatch(/canvas-bucket/)
    expect(group(c, 'n_vid', 'data')?.get('poster')).toMatch(/canvas-bucket/)
    expect(group(c, 'n_vid', 'runtime')?.get('status')).toBe('completed')
    expect((await taskRow(platform, task!.id))?.status).toBe('succeeded')

    // 任务结束：平台不再钉着房间，副本上的人还在
    await until(() => !platformDocs(platform).has(roomOf(flowId)), '平台的房间散场')
    const node = await nodeWithStatus(platform, flowId, 'n_vid', 'completed')
    expect(node.data.src).toEqual(group(c, 'n_vid', 'data')?.get('src'))
  }, 30_000)

  it('推送跨副本：连在两个副本上的人都收到 apps:tasks，带进度，最后一条是空列表；GET 列表一致', async () => {
    const carol = await createActor(platform, 'carol')
    const { alice, flowId } = await room([carol])
    const a = open(replica1, flowId, alice)
    const c = open(replica2, flowId, carol)
    await synced(a)
    await synced(c)
    addNode(a, nodeRecord('n_vid', 'video'))
    await until(() => group(c, 'n_vid', 'runtime'), '节点到了另一个副本')
    arkUpstream({ videoRunsFor: 3 })
    const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
    const running = (client: TestClient) => client.stateless.map(parseAppTasksMessage).some((message) => message?.tasks.some((item: AppTaskView) => item.id === task!.id && item.status === 'running' && item.progress))
    await until(() => running(a) && running(c), '两个副本上都收到带进度的推送')
    await taskDone(platform, task!.id)
    await until(() => parseAppTasksMessage(a.stateless.at(-1) ?? '')?.tasks.length === 0 && parseAppTasksMessage(c.stateless.at(-1) ?? '')?.tasks.length === 0, '最后一条推送是空列表')
    expect((await alice.request(`/api/flows/${flowId}/apps/tasks`)).json()).toMatchObject({ tasks: [] })
  }, 30_000)

  it('不丢：生成期间别的副本上的人继续改，写回和改动都在房间里、都落进库', async () => {
    const carol = await createActor(platform, 'carol')
    const { alice, flowId } = await room([carol])
    const a = open(replica1, flowId, alice)
    const c = open(replica2, flowId, carol)
    await synced(a)
    await synced(c)
    addNode(a, nodeRecord('n_img', 'image'))
    await until(() => group(c, 'n_img', 'runtime'), '节点到了另一个副本')
    let release = () => {}
    const imageGate = new Promise((resolve) => {
      release = () => resolve(null)
    })
    arkUpstream({ imageGate })
    const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
    await until(() => group(c, 'n_img', 'runtime')?.get('status') === 'processing', '开始生成')
    group(c, 'n_img', 'data')!.set('prompt', '生成期间写的')
    nodesMap(c.doc).set('n_other', toYNode(nodeRecord('n_other', 'text')))
    const inPlatform = () => platformDocs(platform).get(roomOf(flowId))?.getMap('nodes')
    await until(() => inPlatform()?.has('n_other'), '改动到了平台的房间')
    release()
    await taskDone(platform, task!.id)
    await until(() => group(a, 'n_img', 'data')?.get('src'), '结果到了')
    expect(group(a, 'n_img', 'data')?.get('prompt')).toBe('生成期间写的')
    expect(nodesMap(a.doc).has('n_other')).toBe(true)

    for (const client of [a, c]) client.destroy()
    const node = await nodeWithStatus(platform, flowId, 'n_img', 'completed')
    expect(node.data).toMatchObject({ prompt: '生成期间写的', src: expect.any(String) })
    expect(await storedNode(platform, flowId, 'n_other')).not.toBeNull()
  }, 30_000)

  it('撤权在平台上发生：任务当场叫停、节点不再写', async () => {
    const carol = await createActor(platform, 'carol')
    const { alice, projectId, flowId } = await room([carol])
    const c = open(replica1, flowId, carol)
    const a = open(replica2, flowId, alice)
    await synced(c)
    await synced(a)
    addNode(c, nodeRecord('n_vid', 'video'))
    await until(() => group(a, 'n_vid', 'runtime'), '节点到了另一个副本')
    const requests = arkUpstream({ videoRunsFor: Infinity })
    const { task } = await submit(carol, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
    await until(async () => (await taskRow(platform, task!.id))?.handle, '上游任务建好')
    await until(() => group(a, 'n_vid', 'runtime')?.get('status') === 'processing', '节点在生成中')
    expect((await alice.json(`/api/projects/${projectId}/members/${carol.userId}`, 'DELETE')).status).toBe(204)
    expect(await taskDone(platform, task!.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('失去这张画布的访问权限') })
    await until(() => requests.some((request) => request.method === 'DELETE'), '撤销上游任务')
    expect(group(a, 'n_vid', 'runtime')?.get('status')).toBe('processing')
    expect(group(a, 'n_vid', 'data')?.get('src')).toBeUndefined()
  }, 30_000)

  it('复制画布：平台自己的房间也回 flush，复制出来的有还没落库的写回', async () => {
    const { alice, flowId } = await room()
    const a = open(replica1, flowId, alice)
    await synced(a)
    addNode(a, nodeRecord('n_vid', 'video'))
    await until(() => group(a, 'n_vid', 'runtime'), '节点在')
    arkUpstream({ videoRunsFor: Infinity })
    const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
    await until(async () => (await taskRow(platform, task!.id))?.handle, '上游任务建好')
    await until(() => group(a, 'n_vid', 'runtime')?.get('status') === 'processing', '节点在生成中')
    const res = await alice.json(`/api/flows/${flowId}/duplicate`, 'POST', {})
    expect(res.status).toBe(201)
    const copy = await storedNode(platform, res.json<{ id: string }>().id, 'n_vid')
    expect(copy?.runtime.status).toBe('processing')
    await alice.json(`/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, 'POST')
    await taskDone(platform, task!.id)
  }, 30_000)

  it('一个副本在任务中途退出：连在另一个副本上的人照样收到结果', async () => {
    const victim = await bootReplica()
    try {
      const carol = await createActor(platform, 'carol')
      const { alice, flowId } = await room([carol])
      const a = open(victim, flowId, alice)
      const c = open(replica2, flowId, carol)
      await synced(a)
      await synced(c)
      addNode(a, nodeRecord('n_vid', 'video'))
      await until(() => group(c, 'n_vid', 'runtime'), '节点到了另一个副本')
      arkUpstream({ videoRunsFor: 20 })
      const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
      await until(() => group(c, 'n_vid', 'runtime')?.get('status') === 'processing', '开始生成')
      a.destroy()
      await victim.app.close()
      await until(() => group(c, 'n_vid', 'data')?.get('src'), '结果到了还连着的副本')
      expect((await taskRow(platform, task!.id))?.status).toBe('succeeded')
    } finally {
      await victim.app.close().catch(() => undefined)
    }
  }, 40_000)

  describe('两个平台进程', () => {
    it('在 A 上跑的任务在 B 上取消：经总线当场停，节点回 idle', async () => {
      const second = await bootPlatform()
      try {
        const { alice, flowId } = await room()
        const a = open(replica1, flowId, alice)
        await synced(a)
        addNode(a, nodeRecord('n_vid', 'video'))
        await until(() => group(a, 'n_vid', 'runtime'), '节点在')
        const requests = arkUpstream({ videoRunsFor: Infinity })
        const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
        await until(async () => (await taskRow(platform, task!.id))?.handle, '上游任务建好')
        expect(platform.get(TaskRunner, { strict: false }).running()).toContain(task!.id)

        const onSecond = await second.inject({ method: 'POST', url: `/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, headers: { cookie: alice.cookie } })
        expect(onSecond.statusCode).toBe(204)
        // 3 秒内：只靠续租要等 10 秒（租约 / 3）才发现，那就是总线没通知到
        await until(() => requests.some((request) => request.method === 'DELETE'), '撤销上游任务', 3_000)
        await until(() => group(a, 'n_vid', 'runtime')?.get('status') === 'idle', '节点回到 idle')
        await until(() => platform.get(TaskRunner, { strict: false }).running().length === 0, '任务停下来')
      } finally {
        await second.close()
      }
    }, 30_000)

    it('并发对账：同一条过期任务只有一个进程接手，不重复提交', async () => {
      const second = await bootPlatform()
      try {
        const { alice, flowId } = await room()
        const em = platform.get(DataAccess).em()
        em.create(AppTask, { flowId, nodeId: 'n_vid', userId: alice.userId, appId: VIDEO_APP, model: null, params: JSON.stringify({ prompt: 'x' }), status: 'queued', activeKey: `${flowId}/n_vid`, progress: null, handle: null, error: null, outputs: null, leaseOwner: null, leaseUntil: null, startedAt: null, finishedAt: null })
        await em.flush()
        const requests = arkUpstream({ videoRunsFor: 1 })
        await Promise.all([platform.get(TaskRunner, { strict: false }).sweep(), second.get(TaskRunner, { strict: false }).sweep()])
        const all = [...platform.get(TaskRunner, { strict: false }).running(), ...second.get(TaskRunner, { strict: false }).running()]
        expect(all).toHaveLength(1)
        await until(() => platform.get(TaskRunner, { strict: false }).running().length + second.get(TaskRunner, { strict: false }).running().length === 0, '任务收尾')
        expect(requests.filter((request) => request.method === 'POST' && request.url.endsWith('/contents/generations/tasks'))).toHaveLength(1)
      } finally {
        await second.close()
      }
    }, 30_000)

    it('平台优雅退出：放掉租约、不写节点；重启后接着查（不重新提交），结果照样进副本上的房间', async () => {
      const victim = await bootPlatform()
      let next: NestFastifyApplication | undefined
      try {
        const { alice, flowId } = await room()
        const a = open(replica1, flowId, alice)
        await synced(a)
        addNode(a, nodeRecord('n_vid', 'video'))
        await until(() => group(a, 'n_vid', 'runtime'), '节点在')
        const requests = arkUpstream({ videoRunsFor: 15 })
        const actor = { ...alice, json: (url: string, method: string, body?: unknown) => victim.inject({ method: method as 'POST', url, headers: { cookie: alice.cookie, 'content-type': 'application/json' }, payload: JSON.stringify(body) }).then((res) => ({ status: res.statusCode, text: res.body, json: <T>() => JSON.parse(res.body) as T })) }
        const { task } = await submit(actor, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
        await until(async () => (await taskRow(platform, task!.id))?.handle, '上游任务建好')
        await until(() => group(a, 'n_vid', 'runtime')?.get('status') === 'processing', '节点在生成中')
        expect(victim.get(TaskRunner, { strict: false }).running()).toEqual([task!.id])

        await victim.close()
        const released = await taskRow(platform, task!.id)
        expect(released).toMatchObject({ status: 'running', leaseOwner: null, leaseUntil: null })
        expect(group(a, 'n_vid', 'runtime')?.get('status')).toBe('processing')
        expect(requests.filter((request) => request.method === 'POST' && request.url.endsWith('/contents/generations/tasks'))).toHaveLength(1)

        next = await bootPlatform({ firstSweepMs: 10 })
        await until(() => group(a, 'n_vid', 'data')?.get('src'), '接手后结果进了房间')
        expect((await taskDone(platform, task!.id)).status).toBe('succeeded')
        expect(requests.filter((request) => request.method === 'POST' && request.url.endsWith('/contents/generations/tasks'))).toHaveLength(1)
      } finally {
        await victim.close().catch(() => undefined)
        await next?.close()
      }
    }, 40_000)
  })
})
