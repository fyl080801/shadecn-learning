import { Flow } from '@learning/canvas'
import { DataAccess, User } from '@learning/data-access'
import { expect, it } from 'vitest'
import { AgentConversation, AgentRun, AgentToolCall } from '../src/entities.js'
import { AgentConversations, AgentRunLog, usageColumns } from '../src/stores.js'
import { createFlow, createProject, describeOnBothDatabases, type Actor } from './helpers.js'

/**
 * 表上的那几步。第一道门（路由的 403）在第 6 步才有，这里钉第二道：**写和带模型上下文的读 `where` 带 user**，别人的会话和不存在的会话是同一个结果。
 * 展示用的读只按 flow 取（成员看得到别人的会话，只读）。外键跟着级联，审计表没有外键。
 */
describeOnBothDatabases('stores', 'agent_stores', (ctx) => {
  const store = () => ctx.app.get(AgentConversations, { strict: false })
  const runLog = () => ctx.app.get(AgentRunLog, { strict: false })
  const db = () => ctx.app.get(DataAccess).em()

  async function conversationOf(owner: Actor, flowId: string) {
    return store().create({ flowId, userId: owner.userId, title: '标题', summary: '', messages: [], llmMessages: [], nodeId: null })
  }

  async function shared() {
    const alice = await ctx.actor('alice')
    const bob = await ctx.actor('bob')
    const flowId = await createFlow(alice, await createProject(alice))
    return { alice, bob, flowId, conversation: await conversationOf(alice, flowId) }
  }

  it('save：别人的会话改不到（where 带 user），改 0 行回 false', async () => {
    const { alice, bob, flowId, conversation } = await shared()
    const patch = { messages: [], summary: '别人改的', llmMessages: [], canvasDigest: null, skills: ['canvas'] }
    expect(await store().save(flowId, bob.userId, conversation.id, patch)).toBe(false)
    expect((await store().get(flowId, conversation.id))?.summary).toBe('')
    expect(await store().save(flowId, alice.userId, conversation.id, { ...patch, summary: '自己改的' })).toBe(true)
    expect((await store().get(flowId, conversation.id))?.summary).toBe('自己改的')
  })

  it('save 和 where 里的 flow：同一个人，别的画布上的同一个 id 也改不到', async () => {
    const { alice, conversation } = await shared()
    const other = await createFlow(alice, await createProject(alice, '别的项目'))
    expect(await store().save(other, alice.userId, conversation.id, { messages: [], summary: 'x' })).toBe(false)
    expect(await store().rename(other, alice.userId, conversation.id, 'x')).toBe(false)
    expect(await store().remove(other, alice.userId, conversation.id)).toBe(false)
  })

  it('rename：别人的会话改不到；改标题不动 updatedAt', async () => {
    const { alice, bob, flowId, conversation } = await shared()
    expect(await store().rename(flowId, bob.userId, conversation.id, '别人起的')).toBe(false)
    expect((await store().get(flowId, conversation.id))?.title).toBe('标题')
    const before = (await store().get(flowId, conversation.id))!.updatedAt
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await store().rename(flowId, alice.userId, conversation.id, '新标题')).toBe(true)
    const after = await store().get(flowId, conversation.id)
    expect(after?.title).toBe('新标题')
    expect(after?.updatedAt).toBe(before)
  })

  it('save 写 updatedAt（nativeUpdate 不触发 onUpdate）', async () => {
    const { alice, flowId, conversation } = await shared()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store().save(flowId, alice.userId, conversation.id, { messages: [], summary: 'x' })
    expect((await store().get(flowId, conversation.id))!.updatedAt).toBeGreaterThan(conversation.updatedAt)
  })

  it('remove：别人的会话删不掉', async () => {
    const { alice, bob, flowId, conversation } = await shared()
    expect(await store().remove(flowId, bob.userId, conversation.id)).toBe(false)
    expect(await store().get(flowId, conversation.id)).not.toBeNull()
    expect(await store().remove(flowId, alice.userId, conversation.id)).toBe(true)
    expect(await store().get(flowId, conversation.id)).toBeNull()
  })

  it('模型上下文只给本人：getWithContext、latest 的 where 带 user；展示用的 list / get 不带', async () => {
    const { alice, bob, flowId, conversation } = await shared()
    expect(await store().getWithContext(flowId, bob.userId, conversation.id)).toBeNull()
    expect(await store().latest(flowId, bob.userId)).toBeNull()
    expect((await store().getWithContext(flowId, alice.userId, conversation.id))?.id).toBe(conversation.id)
    expect((await store().latest(flowId, alice.userId))?.id).toBe(conversation.id)
    expect((await store().list(flowId)).map((row) => row.id)).toEqual([conversation.id])
    expect((await store().get(flowId, conversation.id))?.userId).toBe(alice.userId)
  })

  it('库里的 JSON 是外部数据：坏了当空，不让整个面板打不开；旧技能 id 读出时换掉', async () => {
    const { alice, flowId, conversation } = await shared()
    await db().nativeUpdate(AgentConversation, { id: conversation.id }, { messages: 'not json', llmMessages: '{}', canvasDigest: 'garbage', skills: '["canvas-edit",3]' })
    const row = await store().getWithContext(flowId, alice.userId, conversation.id)
    expect(row).toMatchObject({ messages: [], llmMessages: [], canvasDigest: null, skills: ['canvas'] })
  })

  it('外键：画布行、人没了，会话跟着级联；审计表没有外键，留着', async () => {
    const { alice, flowId, conversation } = await shared()
    await runLog().startRun({ runId: 'run_keep', conversationId: conversation.id, flowId, userId: alice.userId, model: 'm', grantId: null, startedAt: Date.now() })
    await runLog().recordToolCall({ runId: 'run_keep', grantId: null, toolCallId: 'c1', name: 'add_node', ok: true, args: '{}', elementIds: [], error: null, durationMs: 1, createdAt: Date.now() })

    await db().nativeDelete(Flow, { id: flowId })
    expect(await db().count(AgentConversation, { id: conversation.id })).toBe(0)
    expect(await db().count(AgentRun, { id: 'run_keep' })).toBe(1)
    expect(await db().count(AgentToolCall, { runId: 'run_keep' })).toBe(1)

    const second = await shared()
    await db().nativeDelete(User, { id: second.alice.userId })
    expect(await db().count(AgentConversation, { id: second.conversation.id })).toBe(0)
  })

  it('外键真的查：指向不存在的画布建不了会话', async () => {
    const alice = await ctx.actor('alice')
    await expect(store().create({ flowId: 'flow_gone', userId: alice.userId, title: 't', summary: '', messages: [], llmMessages: [], nodeId: null })).rejects.toThrow()
  })

  it('运行日志：startRun 写 running，finishRun 收尾；startRun 没写进去，finishRun 照样留下完整的一行；开头的字段以 startRun 为准', async () => {
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.000_012_4 }
    await runLog().startRun({ runId: 'run_a', conversationId: 'c', flowId: 'f', userId: 'u', model: '开头的模型', grantId: 'g', startedAt: 1000 })
    await runLog().finishRun({ runId: 'run_a', conversationId: 'c', flowId: 'f', userId: 'u', model: '收尾的模型', grantId: 'g', startedAt: 2000, status: 'success', error: null, toolCallCount: 3, usage, finishedAt: 3000 })
    expect(await db().findOneOrFail(AgentRun, 'run_a')).toMatchObject({ status: 'success', model: '开头的模型', toolCallCount: 3, inputTokens: 1, costMicroUsd: 12 })
    expect((await db().findOneOrFail(AgentRun, 'run_a')).startedAt.getTime()).toBe(1000)

    await runLog().finishRun({ runId: 'run_b', conversationId: 'c', flowId: 'f', userId: 'u', model: 'm', grantId: null, startedAt: 2000, status: 'error', error: '坏了', toolCallCount: 0, usage: { ...usage, costUsd: null }, finishedAt: 3000 })
    expect(await db().findOneOrFail(AgentRun, 'run_b')).toMatchObject({ status: 'error', error: '坏了', costMicroUsd: null })
  })

  it('用量：夹在 32 位 int 内，费用换成整数微美元', () => {
    expect(usageColumns({ inputTokens: 5_000_000_000, outputTokens: -1, cacheReadTokens: 1.6, cacheWriteTokens: 0, costUsd: 5000 })).toEqual({ inputTokens: 2_147_483_647, outputTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 0, costMicroUsd: 2_147_483_647 })
  })
})
