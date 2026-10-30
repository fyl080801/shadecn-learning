import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentChatMessage } from '@shadecn/shared/agent'
import { AgentConversation, AgentGrant, AgentGrantScope, AgentRun, AgentToolCall } from '../../db/entities/index.ts'
import { agentConversations, agentGrants, agentRunLog } from '../../store/agent.ts'
import { db, resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject, type Actor } from '../helpers/project.ts'

/**
 * `@shadecn/agent/store` 两个接口的 MikroORM 实现：归属（展示用的读只按 flow；写和模型上下文 flow + user 都在 where 里）、
 * 列表倒序、lazy 列、nativeUpdate 自己写 updatedAt、运行日志按 runId upsert。
 * 跑在测试库上（SQLite，或 TEST_DATABASE_URL 指向的 PostgreSQL）。
 */

let alice: Actor
let bob: Actor
let flowId: string
let otherFlowId: string

beforeEach(async () => {
  await resetDb()
  alice = await actor('alice')
  bob = await actor('bob')
  const projectId = await createProject(alice)
  flowId = await createFlow(alice, projectId, '一')
  otherFlowId = await createFlow(alice, projectId, '二')
})

const userMessage = (text: string): AgentChatMessage => ({ id: `m_${text}`, role: 'user', text, createdAt: 1 })

function create(owner = alice.userId, flow = flowId, title = '标题', nodeId: string | null = null) {
  return agentConversations.create({
    flowId: flow,
    userId: owner,
    title,
    summary: '',
    messages: [userMessage(title)],
    llmMessages: [],
    nodeId,
  })
}

const later = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('会话', () => {
  it('入口节点：nodeId 建会话时写下；skills 新会话为空，save 给了才改，列表里也带着（docs/23 §3.4）', async () => {
    const plain = await create()
    expect(plain).toMatchObject({ nodeId: null, skills: [] })
    const scoped = await create(alice.userId, flowId, '导演台', 'n_dir')
    expect(scoped).toMatchObject({ nodeId: 'n_dir', skills: [] })

    expect(
      await agentConversations.save(flowId, alice.userId, scoped.id, {
        messages: [userMessage('导演台')],
        summary: '',
        skills: ['canvas', 'media-view'],
      }),
    ).toBe(true)
    // 不给 skills 的 save 保持原样
    await agentConversations.save(flowId, alice.userId, scoped.id, { messages: [userMessage('导演台')], summary: '再来' })

    expect(await agentConversations.get(flowId, scoped.id)).toMatchObject({ nodeId: 'n_dir', skills: ['canvas', 'media-view'] })
    expect(await agentConversations.getWithContext(flowId, alice.userId, scoped.id)).toMatchObject({ skills: ['canvas', 'media-view'] })
    const listed = await agentConversations.list(flowId)
    expect(listed.find((row) => row.id === scoped.id)).toMatchObject({ nodeId: 'n_dir', skills: ['canvas', 'media-view'] })
    expect(listed.find((row) => row.id === plain.id)).toMatchObject({ nodeId: null, skills: [] })
  })

  it('create 读回来就是写进去的；messageCount 按条数写', async () => {
    const created = await create()
    expect(created).toMatchObject({ flowId, userId: alice.userId, title: '标题', summary: '', messageCount: 1 })
    expect(typeof created.createdAt).toBe('number')
    expect(created.updatedAt).toBeGreaterThanOrEqual(created.createdAt)

    const got = await agentConversations.get(flowId, created.id)
    expect(got?.messages).toEqual([userMessage('标题')])
    const withContext = await agentConversations.getWithContext(flowId, alice.userId, created.id)
    expect(withContext?.llmMessages).toEqual([])
  })

  it('归属：展示用的读只按画布（别人的会话读得到、列表里有）；模型上下文、latest、改、删只认发起人；别的画布上一律查不到', async () => {
    const created = await create()
    await later()
    const bobs = await create(bob.userId, flowId, '乙的')
    // 项目画布上会话只读可见（docs/20 §3.10.5）：get / list 不带 user
    expect((await agentConversations.get(flowId, created.id))?.userId).toBe(alice.userId)
    expect((await agentConversations.list(flowId)).map((row) => [row.id, row.userId])).toEqual([
      [bobs.id, bob.userId],
      [created.id, alice.userId],
    ])
    expect(await agentConversations.get(otherFlowId, created.id)).toBeNull()
    expect(await agentConversations.list(otherFlowId)).toEqual([])
    // 模型上下文（含工具调用原始参数）不随只读可见放开
    expect(await agentConversations.getWithContext(flowId, bob.userId, created.id)).toBeNull()
    expect((await agentConversations.latest(flowId, bob.userId))?.id).toBe(bobs.id)

    expect(await agentConversations.save(flowId, bob.userId, created.id, { messages: [], summary: 'x' })).toBe(false)
    expect(await agentConversations.remove(flowId, bob.userId, created.id)).toBe(false)
    expect(await agentConversations.remove(otherFlowId, alice.userId, created.id)).toBe(false)
    expect((await agentConversations.get(flowId, created.id))?.messageCount).toBe(1)
  })

  it('save 刷新 updatedAt（nativeUpdate 不会自己改），列表和 latest 按它倒序', async () => {
    const first = await create(alice.userId, flowId, '先')
    await later()
    const second = await create(alice.userId, flowId, '后')
    expect((await agentConversations.list(flowId)).map((row) => row.id)).toEqual([second.id, first.id])

    await later()
    const messages: AgentChatMessage[] = [
      userMessage('先'),
      { id: 'a', role: 'assistant', text: '回复', toolCalls: [], createdAt: 2 },
    ]
    expect(await agentConversations.save(flowId, alice.userId, first.id, { messages, summary: '回复' })).toBe(true)

    const list = await agentConversations.list(flowId)
    expect(list.map((row) => row.id)).toEqual([first.id, second.id])
    expect(list[0]).toMatchObject({ summary: '回复', messageCount: 2 })
    expect(list[0]!.updatedAt).toBeGreaterThan(first.updatedAt)
    // 列表一行不含消息
    expect(list[0]).not.toHaveProperty('messages')

    const latest = await agentConversations.latest(flowId, alice.userId)
    expect(latest?.id).toBe(first.id)
    expect(latest?.messages).toEqual(messages)
  })

  it('save 只在给了 llmMessages 时覆盖模型上下文', async () => {
    const created = await create()
    const llm = [{ role: 'user', content: 'x', timestamp: 1 }] as never[]
    await agentConversations.save(flowId, alice.userId, created.id, { messages: [], summary: '', llmMessages: llm })
    await agentConversations.save(flowId, alice.userId, created.id, { messages: [], summary: '' })
    expect((await agentConversations.getWithContext(flowId, alice.userId, created.id))?.llmMessages).toEqual(llm)
  })

  it('列表查询不取 lazy 的 messages / llmMessages / canvasDigest 列', async () => {
    await create()
    const [row] = await db().find(AgentConversation, { flow: flowId })
    expect(row?.messages).toBeUndefined()
    expect(row?.llmMessages).toBeUndefined()
    expect(row?.canvasDigest).toBeUndefined()
  })

  it('画布摘要（canvasDigest）：新会话为 null；save 给了才改、给 null 清掉；读回来就是写进去的，坏数据读成 null', async () => {
    const created = await create()
    const read = async () => (await agentConversations.getWithContext(flowId, alice.userId, created.id))?.canvasDigest
    expect(await read()).toBeNull()

    const digest = {
      v: 1 as const,
      nodes: { n1: { t: 'text', l: '标题', p: null, k: { 'data.text': 'abc', 'metadata.label': 'def' } } },
      edges: { e1: { s: 'n1', t: 'n2' } },
    }
    await agentConversations.save(flowId, alice.userId, created.id, { messages: [], summary: '', canvasDigest: digest })
    expect(await read()).toEqual(digest)
    // 不给 = 保持原样
    await agentConversations.save(flowId, alice.userId, created.id, { messages: [], summary: '' })
    expect(await read()).toEqual(digest)
    // 展示用的读不带它
    expect(await agentConversations.get(flowId, created.id)).not.toHaveProperty('canvasDigest')

    await db().nativeUpdate(AgentConversation, { id: created.id }, { canvasDigest: '{坏的' })
    expect(await read()).toBeNull()
    await agentConversations.save(flowId, alice.userId, created.id, { messages: [], summary: '', canvasDigest: null })
    expect(await read()).toBeNull()
  })

  it('库里存着合并前的旧技能 id canvas-edit：读出时换成 canvas，去重后保持先后（docs/23 §4）', async () => {
    const created = await create()
    await db().nativeUpdate(AgentConversation, { id: created.id }, { skills: JSON.stringify(['canvas', 'canvas-edit', 'director']) })
    expect((await agentConversations.get(flowId, created.id))?.skills).toEqual(['canvas', 'director'])
    expect((await agentConversations.getWithContext(flowId, alice.userId, created.id))?.skills).toEqual(['canvas', 'director'])
    await db().nativeUpdate(AgentConversation, { id: created.id }, { skills: JSON.stringify(['canvas-edit', 'notes']) })
    expect((await agentConversations.list(flowId)).find((row) => row.id === created.id)?.skills).toEqual(['canvas', 'notes'])
  })

  it('remove 删掉之后查不到；库里的 JSON 坏了读成空数组而不是抛', async () => {
    const created = await create()
    await db().nativeUpdate(AgentConversation, { id: created.id }, { messages: '{坏的', updatedAt: new Date() })
    expect((await agentConversations.get(flowId, created.id))?.messages).toEqual([])

    expect(await agentConversations.remove(flowId, alice.userId, created.id)).toBe(true)
    expect(await agentConversations.get(flowId, created.id)).toBeNull()
  })
})

describe('运行日志', () => {
  const start = {
    runId: 'run_test_1',
    conversationId: 'conv-1',
    flowId: 'flow-x',
    userId: 'user-x',
    model: 'Faux',
    grantId: 'grant-x',
    startedAt: Date.UTC(2026, 0, 1),
  }

  it('startRun 写一行 running；finishRun 只改收尾字段', async () => {
    await agentRunLog.startRun(start)
    expect(await db().findOne(AgentRun, 'run_test_1')).toMatchObject({ status: 'running', finishedAt: null })

    await agentRunLog.finishRun({
      ...start,
      conversationId: '不该覆盖',
      status: 'cancelled',
      error: '已中止',
      toolCallCount: 3,
      finishedAt: Date.UTC(2026, 0, 1, 0, 1),
    })
    const row = await db().findOneOrFail(AgentRun, 'run_test_1')
    expect(row).toMatchObject({ status: 'cancelled', error: '已中止', toolCallCount: 3, conversationId: 'conv-1', grantId: 'grant-x' })
    expect(row.finishedAt?.toISOString()).toBe('2026-01-01T00:01:00.000Z')
    expect(row.startedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('startRun 没写进去时 finishRun 照样留下完整的一行', async () => {
    await agentRunLog.finishRun({ ...start, status: 'success', error: null, toolCallCount: 0, finishedAt: start.startedAt + 1 })
    expect(await db().findOne(AgentRun, 'run_test_1')).toMatchObject({ status: 'success', flowId: 'flow-x', model: 'Faux', grantId: 'grant-x' })
  })

  it('expired 是合法的收尾状态，原因写在 error', async () => {
    await agentRunLog.finishRun({ ...start, status: 'expired', error: '这一轮的授权已到期', toolCallCount: 1, finishedAt: start.startedAt + 1 })
    expect(await db().findOne(AgentRun, 'run_test_1')).toMatchObject({ status: 'expired', error: '这一轮的授权已到期' })
  })

  it('recordToolCall 一次一行；不建外键 —— 画布 / 会话不存在也写得进去', async () => {
    await agentRunLog.recordToolCall({
      runId: 'run_no_such',
      grantId: 'grant-x',
      toolCallId: 'tc1',
      name: 'add_node',
      ok: false,
      args: 'type=text label(4字)',
      elementIds: ['n_1', 'n_2'],
      error: '节点不存在',
      durationMs: 12.6,
      createdAt: Date.UTC(2026, 0, 1),
    })
    const rows = await db().find(AgentToolCall, { runId: 'run_no_such' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'add_node', ok: false, grantId: 'grant-x', elementIds: '["n_1","n_2"]', error: '节点不存在', durationMs: 13 })
  })
})

describe('委托授权（Grant）', () => {
  const grant = (userId = 'user-x', expiresAt = new Date(Date.now() + 60_000)) => ({
    userId,
    runId: 'run_g',
    flowId: 'flow-gone',
    projectId: 'project-gone',
    projectKind: 'team',
    personalOwnerId: null,
    expiresAt,
    scopes: [
      { scope: 'flow:read', resource: 'flow:flow-gone', onRevoke: 'stop', required: true },
      { scope: 'llm:invoke', resource: 'model:Faux', onRevoke: 'stop', required: true },
    ],
  })

  it('一个事务写下 Grant 和它的 scope；不建外键 —— 画布 / 用户不存在也写得进去', async () => {
    const id = await agentGrants.create(grant())
    expect(await db().findOneOrFail(AgentGrant, id)).toMatchObject({ runId: 'run_g', revokedAt: null, revokeReason: null })
    const scopes = await db().find(AgentGrantScope, { grantId: id }, { orderBy: { scope: 'asc' } })
    expect(scopes.map((row) => [row.scope, row.resource, row.onRevoke, row.required])).toEqual([
      ['flow:read', 'flow:flow-gone', 'stop', true],
      ['llm:invoke', 'model:Faux', 'stop', true],
    ])
  })

  it('撤销只写一次：先写下的原因不被后来的盖掉', async () => {
    const id = await agentGrants.create(grant())
    expect(await agentGrants.revoke(id, '失权')).toBe(true)
    expect(await agentGrants.revoke(id, '本轮已结束')).toBe(false)
    expect(await agentGrants.state(id)).toMatchObject({ revokeReason: '失权' })
  })

  it('revokeAllForUser 只撤这个人还有效的；expireDue 只标过期未撤销的', async () => {
    const mine = await agentGrants.create(grant('u-a'))
    const old = await agentGrants.create(grant('u-a', new Date(Date.now() - 1000)))
    const others = await agentGrants.create(grant('u-b', new Date(Date.now() - 1000)))
    expect(await agentGrants.revokeAllForUser('u-a', '账号已封禁')).toBe(2)
    expect(await agentGrants.expireDue('已到期')).toBe(1)
    expect((await agentGrants.state(mine))?.revokeReason).toBe('账号已封禁')
    expect((await agentGrants.state(old))?.revokeReason).toBe('账号已封禁')
    expect((await agentGrants.state(others))?.revokeReason).toBe('已到期')
  })
})
