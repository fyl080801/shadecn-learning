import { type AppTaskView, parseAppTasksMessage } from '@learning/contracts/apps'
import { nodesMap } from '@learning/contracts/flow-doc'
import { CollabServer, roomOf } from '@learning/collab'
import { DataAccess } from '@learning/data-access'
import { SessionService } from '@learning/session'
import { FlowAsset } from '@learning/storage'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { AppTask } from '../src/entities.js'
import { TaskRunner } from '../src/task-runner.js'
import { AppTasks } from '../src/tasks.js'
import {
  type Actor,
  anonymous,
  arkUpstream,
  type AppsTestContext,
  CHAT_APP,
  chatUpstream,
  connect,
  createFlow,
  createProject,
  describeOnBothDatabases,
  IMAGE_APP,
  joinViaInvite,
  nodeRecord,
  nodeWithStatus,
  ownAsset,
  PNG,
  seedNodes,
  storedNode,
  submit,
  taskDone,
  taskRow,
  type TestClient,
  until,
  VIDEO_APP,
} from './helpers.js'

/**
 * 画布节点的生成任务 `/api/flows/:flowId/apps`（docs/29 §3.8、§3.10）。从 `apps/server/test/routes/flow-apps.test.ts` 移植：
 * 提交即返回 202 + 任务；`FlowMemberGuard`（非成员 404）、参考图里**本画布的资源**换成字节（不请求那个地址）、外部地址原样交给驱动、
 * 图片产物存成本画布的资源，**由服务端写回节点**；失败、409、取消、续查。
 */

const NODES = [nodeRecord('n_img', 'image'), nodeRecord('n_vid', 'video'), nodeRecord('n_txt', 'text'), nodeRecord('n_txt_filled', 'text', { text: '我写的字' })]

describeOnBothDatabases('生成任务', 'apps_flow_test', (ctx: AppsTestContext) => {
  const clients: TestClient[] = []
  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy()
  })

  /** 建好项目、画布、节点和成员 */
  async function setup() {
    const alice = await ctx.actor('alice')
    const projectId = await createProject(alice)
    const flowId = await createFlow(alice, projectId)
    const otherFlowId = await createFlow(alice, projectId, '另一张')
    const bob = await ctx.actor('bob')
    const carol = await ctx.actor('carol')
    await joinViaInvite(alice, projectId, carol)
    await seedNodes(ctx.app, flowId, NODES)
    return {
      alice,
      bob,
      carol,
      projectId,
      flowId,
      otherFlowId,
      removeCarol: () => alice.json(`/api/projects/${projectId}/members/${carol.userId}`, 'DELETE'),
    }
  }

  const open = async (flowId: string, actor: Actor) => {
    const client = connect(ctx.baseUrl, flowId, actor.cookie)
    clients.push(client)
    await until(() => client.synced(), '客户端同步完成')
    return client
  }
  const clientNode = (client: TestClient, id: string) => nodesMap(client.doc).get(id) as Y.Map<unknown> | undefined
  const clientGroup = (client: TestClient, id: string, group: string) => clientNode(client, id)?.get(group) as Y.Map<unknown> | undefined
  const countTasks = () => ctx.app.get(DataAccess).em().count(AppTask, {})

  describe('提交', () => {
    it('未登录 → 401，不建任务', async () => {
      const { flowId } = await setup()
      arkUpstream()
      const res = await anonymous(ctx.app, `/api/flows/${flowId}/apps/tasks`)
      expect(res.status).toBe(401)
      expect((await anonymous(ctx.app, `/api/flows/${flowId}/apps/${encodeURIComponent(IMAGE_APP)}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
      expect(await countTasks()).toBe(0)
    })

    it('不是这张画布的成员 → 404（画布守卫），不建任务、不调上游；列表和取消也是 404', async () => {
      const { flowId, bob } = await setup()
      const requests = arkUpstream()
      expect((await submit(bob, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })).status).toBe(404)
      expect((await bob.request(`/api/flows/${flowId}/apps/tasks`)).status).toBe(404)
      expect((await bob.json(`/api/flows/${flowId}/apps/tasks/whatever/cancel`, 'POST')).status).toBe(404)
      expect(requests).toHaveLength(0)
      expect(await countTasks()).toBe(0)
    })

    it('参数不对 / 缺 nodeId / 请求体不对 → 400，没有的应用 404，当场报、不建任务', async () => {
      const { flowId, alice } = await setup()
      arkUpstream()
      const bad = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x', nope: 1 }, nodeId: 'n_img' })
      expect(bad.status).toBe(400)
      expect(bad.body).toMatchObject({ code: 'invalid_params', error: expect.stringContaining('不认识的参数 nope') })
      expect((await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' } })).status).toBe(400)
      expect((await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n'.repeat(65) })).status).toBe(400)
      expect((await submit(alice, flowId, IMAGE_APP, { params: [], nodeId: 'n_img' })).status).toBe(400)
      expect((await submit(alice, flowId, 'missing', { params: {}, nodeId: 'n_img' })).status).toBe(404)
      expect(await countTasks()).toBe(0)
    })

    it('坏 JSON 先于守卫：Fastify 在路由之前就解析，非成员也是 400（同 canvas），响应带 error', async () => {
      const { flowId, bob } = await setup()
      const res = await bob.request(`/api/flows/${flowId}/apps/${encodeURIComponent(IMAGE_APP)}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
      expect(res.status).toBe(400)
      expect(res.json()).toEqual({ error: '请求体不是合法 JSON' })
    })

    it('请求体上限同别的路由是 1MB：超过是 413，不建任务', async () => {
      const { flowId, alice } = await setup()
      const big = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`
      const tooBig = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x', image: [big] }, nodeId: 'n_img' })
      expect(tooBig.status).toBe(413)
      expect((await alice.request(`/api/flows/${flowId}/apps/tasks`)).json<{ tasks: unknown[] }>().tasks).toEqual([])
    })

    it('202 + 任务；服务端执行：本画布的参考图换 data URL、外部地址原样；产物存成资源并写回节点', async () => {
      const { flowId, alice } = await setup()
      const own = await ownAsset(ctx.app, ctx.s3, flowId, alice.userId)
      const requests = arkUpstream()
      const { status, task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: '把图1换成图2的风格', image: [own, 'https://elsewhere.example/b.png'] }, nodeId: 'n_img' })
      expect(status).toBe(202)
      expect(task).toMatchObject({ flowId, nodeId: 'n_img', appId: IMAGE_APP, appTitle: '测试文生图', owner: { id: alice.userId, name: 'alice' } })

      const row = await taskDone(ctx.app, task!.id)
      expect(row.status).toBe('succeeded')
      const sent = requests.find((request) => request.url.endsWith('/images/generations'))!.body as { image: string[] }
      expect(sent.image[0]).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
      expect(sent.image[1]).toBe('https://elsewhere.example/b.png')
      // 本画布的资源是按键从存储读的，没有去请求那个地址
      expect(requests.some((request) => request.url === own)).toBe(false)

      const [output] = JSON.parse(row.outputs!) as { url: string; meta: { assetKey: string } }[]
      expect(output.url).toMatch(/^https:\/\/s3\.example\.test\/canvas-bucket\/canvas\/assets\//)
      expect(await ctx.app.get(DataAccess).em().findOne(FlowAsset, { key: output.meta.assetKey, flow: flowId })).toMatchObject({ contentType: 'image/png' })

      const node = await nodeWithStatus(ctx.app, flowId, 'n_img', 'completed')
      expect(node.data).toMatchObject({ src: output.url, form: 'asset' })
      // 结果同时留进生成历史（gen.<taskId>）
      expect(node.data[`gen.${task!.id}`]).toMatchObject({ src: output.url, createdAt: expect.any(Number) })
      expect(node.runtime).toMatchObject({ status: 'completed', taskId: task!.id })
      expect(node.runtime.error).toBeUndefined()
    })

    it('别的画布的资源不换成字节（归属对不上 = 不是我们的资源）', async () => {
      const { flowId, otherFlowId, alice } = await setup()
      const foreign = await ownAsset(ctx.app, ctx.s3, otherFlowId, alice.userId)
      const requests = arkUpstream()
      const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x', image: [foreign] }, nodeId: 'n_img' })
      await taskDone(ctx.app, task!.id)
      const sent = requests.find((request) => request.url.endsWith('/images/generations'))!.body as { image: string }
      expect(sent.image).toBe(foreign)
    })

    it('上游失败：任务 failed 落库，节点 runtime 是 error + 原因', async () => {
      const { flowId, alice } = await setup()
      arkUpstream({ imageFails: true })
      const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
      const row = await taskDone(ctx.app, task!.id)
      expect(row).toMatchObject({ status: 'failed', error: expect.stringContaining('提示词不合规') })
      const node = await nodeWithStatus(ctx.app, flowId, 'n_img', 'error')
      expect(node.runtime).toMatchObject({ taskId: task!.id, error: expect.stringContaining('提示词不合规') })
      expect(node.data.src).toBeUndefined()
    })

    it('视频任务：句柄存表、进度可查、完成后视频 + 尾帧预览图写回节点', async () => {
      const { flowId, alice } = await setup()
      arkUpstream({ videoRunsFor: 3 })
      const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
      const running = await until(async () => {
        const row = await taskRow(ctx.app, task!.id)
        return row?.handle && row.progress ? row : null
      }, '句柄和进度存进任务表')
      expect(JSON.parse(running.handle!)).toEqual({ upstreamId: 'cgt-1' })
      await taskDone(ctx.app, task!.id)
      const node = await nodeWithStatus(ctx.app, flowId, 'n_vid', 'completed')
      expect(node.data.src).toMatch(/canvas-bucket/)
      expect(node.data.poster).toMatch(/canvas-bucket/)
    })
  })

  describe('结果进房间', () => {
    it('真的 provider 不刷新就看到：processing → 结果，推送带进度；刷新后的列表是空的', async () => {
      const { flowId, alice, carol } = await setup()
      const a = await open(flowId, alice)
      const c = await open(flowId, carol)
      arkUpstream({ videoRunsFor: 3 })
      const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })

      await until(() => clientGroup(c, 'n_vid', 'runtime')?.get('status') === 'processing', '别的成员看到 processing')
      await until(() => c.stateless.map(parseAppTasksMessage).some((message) => message?.tasks.some((item) => item.id === task!.id && item.progress)), '推送带着进度')
      await until(() => clientGroup(c, 'n_vid', 'data')?.get('src'), '结果到了别的成员的文档里')
      expect(clientGroup(a, 'n_vid', 'runtime')?.get('status')).toBe('completed')
      expect(clientGroup(c, 'n_vid', 'runtime')?.get('taskId')).toBe(task!.id)
      // 最后一条推送：任务已经不在进行中
      await until(() => parseAppTasksMessage(c.stateless.at(-1) ?? '')?.tasks.length === 0, '最后一条推送是空列表')
      expect((await alice.request(`/api/flows/${flowId}/apps/tasks`)).json()).toMatchObject({ tasks: [] })
    }, 20_000)

    it('写回不进任何人的撤销栈：房间里的事务 origin 是 apps 标记，客户端的 UndoManager 撤销不掉', async () => {
      const { flowId, alice } = await setup()
      const a = await open(flowId, alice)
      const undo = new Y.UndoManager(nodesMap(a.doc), { trackedOrigins: new Set([null]) })
      const origins: unknown[] = []
      const room = ctx.app.get(CollabServer, { strict: false }).hocuspocus.documents.get(roomOf(flowId))!
      room.on('afterTransaction', (transaction: Y.Transaction) => {
        if (transaction.local) origins.push(transaction.origin)
      })
      arkUpstream()
      const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
      await taskDone(ctx.app, task!.id)
      await until(() => clientGroup(a, 'n_img', 'data')?.get('src'), '结果到了')
      expect(undo.canUndo()).toBe(false)
      expect(origins).toContainEqual({ source: 'apps', taskId: task!.id })
      undo.destroy()
    })

    it('生成期间有人改了别的字段：两边都留（按键写，不整块替换）', async () => {
      const { flowId, alice } = await setup()
      const a = await open(flowId, alice)
      let open_ = () => {}
      const imageGate = new Promise((resolve) => {
        open_ = () => resolve(null)
      })
      arkUpstream({ imageGate })
      const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
      await until(() => clientGroup(a, 'n_img', 'runtime')?.get('status') === 'processing', '节点在生成中')
      clientGroup(a, 'n_img', 'data')!.set('prompt', '生成期间写的')
      await until(() => ctx.app.get(CollabServer, { strict: false }).hocuspocus.documents.get(roomOf(flowId))?.getMap('nodes').get('n_img'), '房间里有节点')
      await until(() => ((ctx.app.get(CollabServer, { strict: false }).hocuspocus.documents.get(roomOf(flowId))?.getMap('nodes').get('n_img') as Y.Map<unknown>)?.get('data') as Y.Map<unknown>)?.get('prompt'), '房间收到改动')
      open_()
      await taskDone(ctx.app, task!.id)
      await until(() => clientGroup(a, 'n_img', 'data')?.get('src'), '结果到了')
      expect(clientGroup(a, 'n_img', 'data')?.get('prompt')).toBe('生成期间写的')
      a.destroy()
      const node = await nodeWithStatus(ctx.app, flowId, 'n_img', 'completed')
      expect(node.data).toMatchObject({ prompt: '生成期间写的', src: expect.any(String) })
    })

    it('节点在生成期间被删了：任务照样记成功，不复活节点，不崩', async () => {
      const { flowId, alice } = await setup()
      const a = await open(flowId, alice)
      let open_ = () => {}
      const imageGate = new Promise((resolve) => {
        open_ = () => resolve(null)
      })
      arkUpstream({ imageGate })
      const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
      await until(() => clientGroup(a, 'n_img', 'runtime')?.get('status') === 'processing', '节点在生成中')
      nodesMap(a.doc).delete('n_img')
      await until(() => !ctx.app.get(CollabServer, { strict: false }).hocuspocus.documents.get(roomOf(flowId))?.getMap('nodes').has('n_img'), '房间里没这个节点了')
      open_()
      expect((await taskDone(ctx.app, task!.id)).status).toBe('succeeded')
      expect(clientNode(a, 'n_img')).toBeUndefined()
    })

    it('节点的 runtime.taskId 被盖掉了（不再是这个任务）：结果只记任务表，不碰节点', async () => {
      const { flowId, alice } = await setup()
      const a = await open(flowId, alice)
      let open_ = () => {}
      const imageGate = new Promise((resolve) => {
        open_ = () => resolve(null)
      })
      arkUpstream({ imageGate })
      const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
      await until(() => clientGroup(a, 'n_img', 'runtime')?.get('status') === 'processing', '节点在生成中')
      clientGroup(a, 'n_img', 'runtime')!.set('taskId', 'someone-else')
      const room = () => ctx.app.get(CollabServer, { strict: false }).hocuspocus.documents.get(roomOf(flowId))
      await until(() => ((room()?.getMap('nodes').get('n_img') as Y.Map<unknown>)?.get('runtime') as Y.Map<unknown>)?.get('taskId') === 'someone-else', '房间收到改动')
      open_()
      expect((await taskDone(ctx.app, task!.id)).status).toBe('succeeded')
      await until(() => ctx.runner.running().length === 0, '任务收尾')
      expect(clientGroup(a, 'n_img', 'data')?.get('src')).toBeUndefined()
    })

    it('房间到了容量上限：不写回节点，任务结果照常记在表里', async () => {
      const { flowId, alice } = await setup()
      const requests = arkUpstream()
      const quota = vi.spyOn(ctx.app.get(CollabServer, { strict: false }), 'quotaLocked').mockReturnValue('超过容量上限')
      try {
        const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
        expect((await taskDone(ctx.app, task!.id)).status).toBe('succeeded')
        await until(() => ctx.runner.running().length === 0, '任务收尾')
        expect(requests.some((request) => request.url.endsWith('/images/generations'))).toBe(true)
        const node = await storedNode(ctx.app, flowId, 'n_img')
        expect(node?.runtime).toEqual({ status: 'idle' })
        expect(node?.data.src).toBeUndefined()
      } finally {
        quota.mockRestore()
      }
    })
  })

  describe('文本节点用语言服务生成（docs/29 §3.8）', () => {
    it('llm.providers 里带模型的提供方自动成为 text 应用：节点选它生成，文字由服务端写进 data.text，思考不进节点', async () => {
      const { flowId, alice } = await setup()
      const requests = chatUpstream('生成的文字')
      const list = (await alice.request('/api/apps')).json<{ id: string; model?: string; title: string; category: string; params: Record<string, unknown> }[]>()
      // 每个模型一条：吃不吃图各看各的（同一提供方有吃图的模型时，不吃图的那个去掉 images）
      const generated = list.filter((item) => item.id.startsWith('llm-selfhost:'))
      expect(generated.slice(0, 2).map((item) => [item.id, item.title, item.category, item.model, 'images' in item.params])).toEqual([
        ['llm-selfhost:qwen3', '千问 3', 'text', 'qwen3', false],
        ['llm-selfhost:qwen-vl', 'qwen-vl', 'text', 'qwen-vl', true],
      ])

      const { status, task } = await submit(alice, flowId, 'llm-selfhost:qwen-vl', { params: { prompt: '写一句诗' }, nodeId: 'n_txt' })
      expect(status).toBe(202)
      // 任务表的 model 列照旧记下这个应用的模型
      expect(task).toMatchObject({ appId: 'llm-selfhost:qwen-vl', appTitle: 'qwen-vl', model: 'qwen-vl' })
      expect((await taskDone(ctx.app, task!.id)).status).toBe('succeeded')
      expect(requests[0]).toMatchObject({ url: 'http://llm.internal/v1/chat/completions', authorization: 'Bearer llm-key', body: { model: 'qwen-vl' } })

      const node = await nodeWithStatus(ctx.app, flowId, 'n_txt', 'completed')
      expect(node.data.text).toBe('生成的文字')
      expect(JSON.stringify(node.data)).not.toContain('先想一想')
      expect(Object.keys(node.data).filter((key) => key.startsWith('gen.'))).toEqual([])
      // 任务表里的产物照原样，文字不丢
      const [output] = JSON.parse((await taskRow(ctx.app, task!.id))!.outputs!) as { kind: string; text: string }[]
      expect(output).toMatchObject({ kind: 'text', text: '生成的文字' })
    })

    it('模型 id 里带冒号、斜杠的：应用 id 经编码能走通整条提交路径', async () => {
      const { flowId, alice } = await setup()
      const requests = chatUpstream('生成的文字')
      for (const [appId, model, nodeId] of [
        ['llm-selfhost:deepseek-v4.1-flash:1017-cloud', 'deepseek-v4.1-flash:1017-cloud', 'n_txt'],
        ['llm-selfhost:vendor/model', 'vendor/model', 'n_txt_filled'],
      ]) {
        const { status, task } = await submit(alice, flowId, appId, { params: { prompt: 'x' }, nodeId })
        expect(status).toBe(202)
        expect((await taskDone(ctx.app, task!.id)).status).toBe('succeeded')
        expect(requests.at(-1)!.body.model).toBe(model)
      }
    })

    it('节点上已有正文：生成的文字接在后面，不覆盖', async () => {
      const { flowId, alice } = await setup()
      chatUpstream('生成的文字')
      const { task } = await submit(alice, flowId, CHAT_APP, { params: { prompt: 'x' }, nodeId: 'n_txt_filled' })
      await taskDone(ctx.app, task!.id)
      expect((await nodeWithStatus(ctx.app, flowId, 'n_txt_filled', 'completed')).data.text).toBe('我写的字\n\n生成的文字')
    })

    it('模型回了空文字：节点 error，正文不动', async () => {
      const { flowId, alice } = await setup()
      chatUpstream('')
      const { task } = await submit(alice, flowId, CHAT_APP, { params: { prompt: 'x' }, nodeId: 'n_txt_filled' })
      await taskDone(ctx.app, task!.id)
      const node = await nodeWithStatus(ctx.app, flowId, 'n_txt_filled', 'error')
      expect(node.runtime.error).toBe('应用没有返回可以放进这个节点的结果')
      expect(node.data.text).toBe('我写的字')
    })

    it('文字应用落到不输出文字的节点上（绕过界面）：节点 error，不写 data.text', async () => {
      const { flowId, alice } = await setup()
      chatUpstream('生成的文字')
      const { task } = await submit(alice, flowId, CHAT_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
      await taskDone(ctx.app, task!.id)
      const node = await nodeWithStatus(ctx.app, flowId, 'n_img', 'error')
      expect(node.data.text).toBeUndefined()
    })
  })

  describe('任务列表与取消', () => {
    it('同一个节点已有进行中的任务 → 409；列表里有它和进度', async () => {
      const { flowId, alice } = await setup()
      arkUpstream({ videoRunsFor: Infinity })
      const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
      await until(async () => (await taskRow(ctx.app, task!.id))?.progress, '有进度')
      const again = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '再来' }, nodeId: 'n_vid' })
      expect(again.status).toBe(409)
      expect(again.body).toMatchObject({ code: 'busy' })

      const list = (await alice.request(`/api/flows/${flowId}/apps/tasks`)).json<{ tasks: AppTaskView[]; now: number }>()
      expect(list.tasks).toHaveLength(1)
      expect(list.tasks[0]).toMatchObject({ id: task!.id, status: 'running', progress: { status: expect.any(String) } })
      expect(list.now).toEqual(expect.any(Number))

      await alice.json(`/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, 'POST')
      await taskDone(ctx.app, task!.id)
    })

    it('同一个节点并发提交：只有一个建得出来，其余 409（靠唯一约束，不是先查后插）', async () => {
      const { flowId, alice } = await setup()
      arkUpstream({ videoRunsFor: Infinity })
      const results = await Promise.all(Array.from({ length: 6 }, () => submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })))
      expect(results.map((result) => result.status).sort()).toEqual([202, 409, 409, 409, 409, 409])
      expect(await ctx.app.get(DataAccess).em().count(AppTask, { flowId, nodeId: 'n_vid' })).toBe(1)
    })

    it('别的节点、别的画布不受影响；任务结束（成功 / 失败 / 取消）后这个节点又能提交', async () => {
      const { flowId, otherFlowId, alice } = await setup()
      await seedNodes(ctx.app, otherFlowId, [nodeRecord('n_img', 'image')])
      arkUpstream()
      const first = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
      const other = await submit(alice, otherFlowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
      expect(first.status).toBe(202)
      expect(other.status).toBe(202)
      await taskDone(ctx.app, first.task!.id)
      await taskDone(ctx.app, other.task!.id)

      arkUpstream({ imageFails: true })
      const failed = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
      expect(failed.status).toBe(202)
      expect((await taskDone(ctx.app, failed.task!.id)).status).toBe('failed')

      arkUpstream({ videoRunsFor: Infinity })
      const running = await submit(alice, flowId, VIDEO_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })
      expect(running.status).toBe(202)
      await until(async () => (await taskRow(ctx.app, running.task!.id))?.handle, '上游任务建好')
      await alice.json(`/api/flows/${flowId}/apps/tasks/${running.task!.id}/cancel`, 'POST')
      await taskDone(ctx.app, running.task!.id)
      expect((await submit(alice, flowId, VIDEO_APP, { params: { prompt: 'x' }, nodeId: 'n_img' })).status).toBe(202)
    })

    it('取消：别的成员 403；发起人取消 → canceled、撤上游任务、节点回到 idle；再取消 204（幂等）', async () => {
      const { flowId, alice, carol } = await setup()
      const requests = arkUpstream({ videoRunsFor: Infinity })
      const { task } = await submit(carol, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
      await until(async () => (await taskRow(ctx.app, task!.id))?.handle, '上游任务建好')

      const stranger = await ctx.actor('dave')
      expect((await stranger.json(`/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, 'POST')).status).toBe(404)
      expect((await carol.json(`/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, 'POST')).status).toBe(204)
      expect((await taskDone(ctx.app, task!.id)).status).toBe('canceled')
      await until(() => requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/tasks/cgt-1')), '撤销上游任务')
      const node = await nodeWithStatus(ctx.app, flowId, 'n_vid', 'idle')
      expect(node.data.src).toBeUndefined()
      expect((await alice.json(`/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, 'POST')).status).toBe(204)
      expect((await alice.request(`/api/flows/${flowId}/apps/tasks`)).json()).toMatchObject({ tasks: [] })
    })

    it('取消权限：别的普通成员 403，项目管理员可以；别的画布的任务 id 不存在一样 204、不取消', async () => {
      const { flowId, otherFlowId, alice, carol, projectId } = await setup()
      const dave = await ctx.actor('dave')
      await joinViaInvite(alice, projectId, dave)
      arkUpstream({ videoRunsFor: Infinity })
      const { task } = await submit(carol, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
      await until(async () => (await taskRow(ctx.app, task!.id))?.handle, '上游任务建好')

      const denied = await dave.json(`/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, 'POST')
      expect(denied.status).toBe(403)
      expect(denied.json()).toHaveProperty('error')
      expect((await taskRow(ctx.app, task!.id))?.status).toBe('running')
      expect((await alice.json(`/api/flows/${otherFlowId}/apps/tasks/${task!.id}/cancel`, 'POST')).status).toBe(204)
      expect((await taskRow(ctx.app, task!.id))?.status).toBe('running')
      expect((await alice.json(`/api/flows/${flowId}/apps/tasks/${task!.id}/cancel`, 'POST')).status).toBe(204)
      expect((await taskDone(ctx.app, task!.id)).status).toBe('canceled')
    })

    it('排队中的任务被取消：补推一次列表，别的成员的列表里去掉它', async () => {
      const { flowId, alice, carol } = await setup()
      const c = await open(flowId, carol)
      const tasks = ctx.app.get(AppTasks, { strict: false })
      const row = await tasks.create({ flowId, nodeId: 'n_img', userId: alice.userId, appId: IMAGE_APP, model: undefined, params: {} })
      expect((await alice.json(`/api/flows/${flowId}/apps/tasks/${row!.id}/cancel`, 'POST')).status).toBe(204)
      await until(() => parseAppTasksMessage(c.stateless.at(-1) ?? '')?.tasks.length === 0, '补推的列表到了')
      expect((await taskRow(ctx.app, row!.id))?.status).toBe('canceled')
    })
  })

  describe('任务表的条件写', () => {
    it('接手：并发只有一个抢得到；租约没过期抢不到，过期了能抢', async () => {
      const { flowId, alice } = await setup()
      const tasks = ctx.app.get(AppTasks, { strict: false })
      const row = (await tasks.create({ flowId, nodeId: 'n_img', userId: alice.userId, appId: IMAGE_APP, model: undefined, params: {} }))!
      const wins = await Promise.all(Array.from({ length: 8 }, (_, index) => tasks.claim(row.id, `owner-${index}`, 30_000)))
      expect(wins.filter(Boolean)).toHaveLength(1)
      expect(await tasks.claim(row.id, 'late', 30_000)).toBe(false)
      await ctx.app.get(DataAccess).em().nativeUpdate(AppTask, { id: row.id }, { leaseUntil: new Date(Date.now() - 1000) })
      expect(await tasks.claim(row.id, 'late', 30_000)).toBe(true)
    })

    it('取消和收尾并发：只有一个算数；被接手之后旧持有者一笔也写不进去', async () => {
      const { flowId, alice } = await setup()
      const tasks = ctx.app.get(AppTasks, { strict: false })
      const row = (await tasks.create({ flowId, nodeId: 'n_img', userId: alice.userId, appId: IMAGE_APP, model: undefined, params: {} }))!
      await tasks.claim(row.id, 'old', 30_000)
      const [finished, canceled] = await Promise.all([tasks.finish(row.id, 'old', { status: 'succeeded', outputs: [] }), tasks.cancel(row.id)])
      expect([finished, canceled].filter(Boolean)).toHaveLength(1)

      const second = (await tasks.create({ flowId, nodeId: 'n_img', userId: alice.userId, appId: IMAGE_APP, model: undefined, params: {} }))!
      await tasks.claim(second.id, 'old', 30_000)
      await ctx.app.get(DataAccess).em().nativeUpdate(AppTask, { id: second.id }, { leaseUntil: new Date(Date.now() - 1000) })
      await tasks.claim(second.id, 'new', 30_000)
      expect(await tasks.renew(second.id, 'old', 30_000)).toBe(false)
      expect(await tasks.saveHandle(second.id, 'old', { upstreamId: 'x' })).toBe(0)
      expect(await tasks.finish(second.id, 'old', { status: 'failed', error: 'x' })).toBe(false)
      expect(await tasks.release(second.id, 'old')).toBe(0)
      expect((await tasks.get(second.id))?.leaseOwner).toBe('new')
    })

    it('被取消之后收尾写不进去：执行方拿不到 true，任务还是 canceled，也不写产物', async () => {
      const { flowId, alice } = await setup()
      const tasks = ctx.app.get(AppTasks, { strict: false })
      const row = (await tasks.create({ flowId, nodeId: 'n_img', userId: alice.userId, appId: IMAGE_APP, model: undefined, params: {} }))!
      await tasks.claim(row.id, 'owner', 30_000)
      expect(await tasks.cancel(row.id)).toBe(true)
      expect(await tasks.finish(row.id, 'owner', { status: 'succeeded', outputs: [] })).toBe(false)
      expect(await tasks.get(row.id)).toMatchObject({ status: 'canceled', outputs: null })
      expect(await tasks.cancel(row.id)).toBe(false)
    })

    it('执行中被别的进程接手（租约丢了不是取消）：什么都不写，让持有者去写', async () => {
      const { flowId, alice } = await setup()
      arkUpstream({ videoRunsFor: Infinity })
      const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
      await until(async () => (await taskRow(ctx.app, task!.id))?.handle, '上游任务建好')
      await ctx.app.get(DataAccess).em().nativeUpdate(AppTask, { id: task!.id }, { leaseOwner: 'other-process', leaseUntil: new Date(Date.now() + 60_000) })
      ctx.runner.abortTask(task!.id, 'lost')
      await until(() => ctx.runner.running().length === 0, '任务停下来')
      const row = await taskRow(ctx.app, task!.id)
      expect(row).toMatchObject({ status: 'running', leaseOwner: 'other-process' })
      const node = await storedNode(ctx.app, flowId, 'n_vid')
      expect(node?.runtime.status).toBe('processing')
      await ctx.app.get(AppTasks, { strict: false }).cancel(task!.id)
    })
  })

  describe('执行身份：凭发起人', () => {
    it('执行中发起人被移出项目：当场叫停 —— 撤上游任务、任务记失败，不再写节点', async () => {
      const { flowId, carol, removeCarol } = await setup()
      const requests = arkUpstream({ videoRunsFor: Infinity })
      const { task } = await submit(carol, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
      await until(async () => (await taskRow(ctx.app, task!.id))?.handle, '上游任务建好')

      expect((await removeCarol()).status).toBe(204)
      const row = await taskDone(ctx.app, task!.id)
      expect(row).toMatchObject({ status: 'failed', error: expect.stringContaining('失去这张画布的访问权限') })
      await until(() => requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/tasks/cgt-1')), '撤销上游任务')
      // 节点停在接手时写的 processing：失权之后不再以发起人的身份写
      const node = await until(async () => {
        const found = await storedNode(ctx.app, flowId, 'n_vid')
        return found?.runtime.taskId === task!.id ? found : null
      }, '节点落库')
      expect(node.runtime.status).toBe('processing')
      expect(node.data.src).toBeUndefined()
    })

    it('画布被删：同样叫停', async () => {
      const { flowId, alice, carol } = await setup()
      arkUpstream({ videoRunsFor: Infinity })
      const { task } = await submit(carol, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
      await until(async () => (await taskRow(ctx.app, task!.id))?.handle, '上游任务建好')
      expect((await alice.json(`/api/flows/${flowId}`, 'DELETE')).status).toBe(204)
      expect(await taskDone(ctx.app, task!.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('失去这张画布的访问权限') })
    })

    it('和登录态无关：发起人退出登录，任务照常跑完', async () => {
      const { flowId, alice } = await setup()
      arkUpstream({ videoRunsFor: 2 })
      const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
      await ctx.app.get(SessionService, { strict: false }).deleteByToken(alice.cookie.slice('sid='.length))
      expect((await alice.request(`/api/flows/${flowId}/apps/tasks`)).status).toBe(401)
      expect((await taskDone(ctx.app, task!.id)).status).toBe('succeeded')
    })
  })

  describe('续查（进程重启后接手）', () => {
    /** 一条「上一个进程留下的」任务：在跑、租约已过期 */
    async function orphan(flowId: string, userId: string, appId: string, nodeId: string, handle: object | null) {
      const em = ctx.app.get(DataAccess).em()
      const row = em.create(AppTask, {
        flowId,
        nodeId,
        userId,
        appId,
        model: null,
        params: JSON.stringify({ prompt: '海浪' }),
        status: 'running',
        activeKey: `${flowId}/${nodeId}`,
        progress: null,
        handle: handle ? JSON.stringify(handle) : null,
        error: null,
        outputs: null,
        leaseOwner: 'dead-instance',
        leaseUntil: new Date(Date.now() - 1_000),
        startedAt: new Date(),
        finishedAt: null,
      })
      await em.flush()
      return row.id
    }

    it('有续查句柄：接着查（不重新提交），完成后写回节点', async () => {
      const { flowId, alice } = await setup()
      const id = await orphan(flowId, alice.userId, VIDEO_APP, 'n_vid', { upstreamId: 'cgt-1' })
      const requests = arkUpstream({ videoRunsFor: 1 })
      await ctx.app.get(TaskRunner, { strict: false }).sweep()
      expect((await taskDone(ctx.app, id)).status).toBe('succeeded')
      expect(requests.some((request) => request.method === 'POST' && request.url.endsWith('/contents/generations/tasks'))).toBe(false)
      const node = await nodeWithStatus(ctx.app, flowId, 'n_vid', 'completed')
      expect(node.runtime.taskId).toBe(id)
    })

    it('接手时发起人已不能进这张画布：任务记失败，不续查上游、不碰节点', async () => {
      const { flowId, bob } = await setup()
      // bob 不是这个项目的成员（比如提交之后被移出、进程又重启了）
      const id = await orphan(flowId, bob.userId, VIDEO_APP, 'n_vid', { upstreamId: 'cgt-1' })
      const requests = arkUpstream()
      await ctx.runner.sweep()
      expect(await taskDone(ctx.app, id)).toMatchObject({ status: 'failed', error: expect.stringContaining('发起人已不能访问这张画布') })
      expect(requests).toHaveLength(0)
      expect((await storedNode(ctx.app, flowId, 'n_vid'))?.runtime).toEqual({ status: 'idle' })
    })

    it('没有句柄却在 running（同步上游调到一半进程没了）：记失败，不重复提交', async () => {
      const { flowId, alice } = await setup()
      const id = await orphan(flowId, alice.userId, IMAGE_APP, 'n_img', null)
      const requests = arkUpstream()
      await ctx.runner.sweep()
      expect(await taskDone(ctx.app, id)).toMatchObject({ status: 'failed', error: expect.stringContaining('执行中断') })
      expect(requests).toHaveLength(0)
    })

    it('排队中没人接手的（派发丢了）：对账接手，照常提交', async () => {
      const { flowId, alice } = await setup()
      const row = await ctx.app.get(AppTasks, { strict: false }).create({ flowId, nodeId: 'n_img', userId: alice.userId, appId: IMAGE_APP, model: 'x', params: { prompt: 'x' } })
      arkUpstream()
      await ctx.runner.sweep()
      expect((await taskDone(ctx.app, row!.id)).status).toBe('succeeded')
    })

    it('时限从开始算，续查不重置：已经过了时限的直接超时，不再请求上游', async () => {
      const { flowId, alice } = await setup()
      const id = await orphan(flowId, alice.userId, VIDEO_APP, 'n_vid', { upstreamId: 'cgt-1' })
      await ctx.app.get(DataAccess).em().nativeUpdate(AppTask, { id }, { startedAt: new Date(Date.now() - 24 * 3600 * 1000) })
      const requests = arkUpstream()
      await ctx.runner.sweep()
      expect(await taskDone(ctx.app, id)).toMatchObject({ status: 'failed', error: expect.stringContaining('没有完成') })
      expect(requests).toHaveLength(0)
    })

    it('应用已经不在配置里：任务记失败', async () => {
      const { flowId, alice } = await setup()
      const row = await ctx.app.get(AppTasks, { strict: false }).create({ flowId, nodeId: 'n_img', userId: alice.userId, appId: 'gone:model', model: 'x', params: {} })
      arkUpstream()
      await ctx.runner.sweep()
      expect(await taskDone(ctx.app, row!.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('已经不在配置里') })
    })
  })
})

describe('退出顺序', () => {
  it('协同开始关房间时任务已经停了、租约已经放掉：断开 direct connection 要用的房间和 Redis 扩展那时还开着', async () => {
    const { bootAppsApp, createActor } = await import('./helpers.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-shutdown-'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = await bootAppsApp({ databaseUrl: `file:${path.join(dir, 'test.db')}` })
    try {
      const alice = await createActor(app, 'alice')
      const flowId = await createFlow(alice, await createProject(alice))
      await seedNodes(app, flowId, [nodeRecord('n_vid', 'video')])
      arkUpstream({ videoRunsFor: Infinity })
      const { task } = await submit(alice, flowId, VIDEO_APP, { params: { prompt: '海浪' }, nodeId: 'n_vid' })
      await until(async () => (await taskRow(app, task!.id))?.handle, '上游任务建好')

      const collab = app.get(CollabServer, { strict: false })
      const runner = app.get(TaskRunner, { strict: false })
      const closeRooms = collab.beforeApplicationShutdown.bind(collab)
      let atCollabShutdown: { running: string[]; lease: string | null | undefined } | undefined
      vi.spyOn(collab, 'beforeApplicationShutdown').mockImplementation(async () => {
        atCollabShutdown = { running: runner.running(), lease: (await taskRow(app, task!.id))?.leaseOwner }
        await closeRooms()
      })
      await app.close()
      expect(atCollabShutdown).toEqual({ running: [], lease: null })
    } finally {
      vi.unstubAllGlobals()
      fs.rmSync(dir, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })
})

describe('没有对象存储', () => {
  it('产物原样，节点挂的是上游地址；字节产物不进任务表', async () => {
    const { bootAppsApp, createActor } = await import('./helpers.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-no-s3-'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let app: NestFastifyApplication | undefined
    try {
      app = await bootAppsApp({ databaseUrl: `file:${path.join(dir, 'test.db')}` })
      const alice = await createActor(app, 'alice')
      const flowId = await createFlow(alice, await createProject(alice))
      await seedNodes(app, flowId, [nodeRecord('n_img', 'image')])
      arkUpstream()
      const { task } = await submit(alice, flowId, IMAGE_APP, { params: { prompt: 'x', image: ['https://elsewhere.example/a.png'] }, nodeId: 'n_img' })
      await taskDone(app, task!.id)
      const node = await nodeWithStatus(app, flowId, 'n_img', 'completed')
      expect(node.data.src).toBe('https://ark-cdn.example/out.png')
    } finally {
      vi.unstubAllGlobals()
      await app?.close()
      fs.rmSync(dir, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })
})
