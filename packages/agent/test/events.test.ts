import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import {
  AGENT_CANVAS_CHANGE_EVENT,
  AGENT_SUBTASK_EVENT,
  AGENT_SUBTASK_UPDATE_EVENT,
  AGENT_USER_MESSAGE_EVENT,
  AgentEventType,
  applyAgentSubtaskUpdate,
  parseAgentSubtask,
  parseAgentSubtaskUpdate,
  type AgentStreamEvent,
} from '@shadecn/shared/agent'
import { createRunEventMapper } from '../src/events.ts'

/**
 * pi 事件 → AG-UI 事件。守的是顺序与字段 —— 前端（以及将来的 `@ag-ui/client`）照这个解析。
 */

function mapper() {
  return createRunEventMapper({
    threadId: 'flow-1',
    runId: 'run-1',
    assistantMessageId: 'msg-a',
    describeTool: (name, args) => `${name}:${JSON.stringify(args)}`,
    now: () => 1000,
  })
}

/** 只构造映射里读得到的字段 */
const textDelta = (delta: string) =>
  ({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta } }) as unknown as AgentEvent
const textEnd = () =>
  ({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end' } }) as unknown as AgentEvent
const assistantEnd = (stopReason = 'toolUse', errorMessage?: string) =>
  ({ type: 'message_end', message: { role: 'assistant', stopReason, errorMessage } }) as unknown as AgentEvent

describe('一轮完整的事件顺序', () => {
  it('文字 → 工具 → 文字：两段文字共用 messageId，拼起来等于存下来的 text', () => {
    const m = mapper()
    const out: AgentStreamEvent[] = []
    out.push(...m.start({ id: 'msg-u', role: 'user', text: '加个节点', createdAt: 1 }))
    out.push(...m.handle(textDelta('好的')))
    out.push(...m.handle(textDelta('，这就加')))
    out.push(...m.handle(textEnd()))
    out.push(...m.handle(assistantEnd()))
    out.push(
      ...m.handle({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'add_node', args: { label: 'X' } }),
    )
    out.push(
      ...m.handle({
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        toolName: 'add_node',
        isError: false,
        result: { content: [{ type: 'text', text: '{"id":"n1"}' }], details: { summary: '新建节点「X」' } },
      }),
    )
    out.push(...m.handle(textDelta('加好了')))
    out.push(...m.handle(assistantEnd('stop')))
    out.push(...m.finish({ type: 'success' }))

    expect(out.map((event) => event.type)).toEqual([
      AgentEventType.RUN_STARTED,
      AgentEventType.CUSTOM,
      AgentEventType.TEXT_MESSAGE_START,
      AgentEventType.TEXT_MESSAGE_CONTENT,
      AgentEventType.TEXT_MESSAGE_CONTENT,
      AgentEventType.TEXT_MESSAGE_END,
      AgentEventType.TOOL_CALL_START,
      AgentEventType.TOOL_CALL_ARGS,
      AgentEventType.TOOL_CALL_END,
      AgentEventType.TOOL_CALL_RESULT,
      AgentEventType.TEXT_MESSAGE_START,
      AgentEventType.TEXT_MESSAGE_CONTENT,
      AgentEventType.TEXT_MESSAGE_END,
      AgentEventType.RUN_FINISHED,
    ])

    expect(out[0]).toMatchObject({ threadId: 'flow-1', runId: 'run-1' })
    expect(out[1]).toMatchObject({ name: AGENT_USER_MESSAGE_EVENT, value: { id: 'msg-u', text: '加个节点' } })

    const textIds = out.filter((event) => 'messageId' in event && event.type.startsWith('TEXT_'))
    expect(new Set(textIds.map((event) => (event as { messageId: string }).messageId))).toEqual(new Set(['msg-a']))

    const deltas = out
      .filter((event) => event.type === AgentEventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as { delta: string }).delta)
      .join('')
    expect(deltas).toBe('好的，这就加\n\n加好了')

    expect(out[6]).toMatchObject({
      toolCallId: 'tc1',
      toolCallName: 'add_node',
      parentMessageId: 'msg-a',
      metadata: { summary: 'add_node:{"label":"X"}', status: 'running' },
    })
    expect(out[7]).toMatchObject({ delta: '{"label":"X"}' })
    const result = out[9] as Extract<AgentStreamEvent, { type: 'TOOL_CALL_RESULT' }>
    expect(result).toMatchObject({
      toolCallId: 'tc1',
      role: 'tool',
      content: '{"id":"n1"}',
      metadata: { summary: '新建节点「X」', status: 'done' },
    })
    expect(result.messageId).not.toBe('msg-a')

    const finished = out.at(-1) as Extract<AgentStreamEvent, { type: 'RUN_FINISHED' }>
    expect(finished.outcome).toEqual({ type: 'success' })
    expect(finished.result).toMatchObject({
      id: 'msg-a',
      role: 'assistant',
      text: '好的，这就加\n\n加好了',
      toolCalls: [{ id: 'tc1', name: 'add_node', summary: '新建节点「X」', status: 'done' }],
    })
    expect(finished.result.error).toBeUndefined()
  })

  it('工具失败：RESULT 的 status=error，error 是回给模型的那段原因', () => {
    const m = mapper()
    m.handle({ type: 'tool_execution_start', toolCallId: 'tc', toolName: 'update_node', args: {} })
    const [result] = m.handle({
      type: 'tool_execution_end',
      toolCallId: 'tc',
      toolName: 'update_node',
      isError: true,
      result: { content: [{ type: 'text', text: '节点 x 不存在' }], details: {} },
    })
    expect(result).toMatchObject({ metadata: { status: 'error', error: '节点 x 不存在' } })
    expect(m.message.toolCalls[0]).toMatchObject({ status: 'error', error: '节点 x 不存在' })
  })

  it('中止：先关掉没关的文字段，RUN_FINISHED outcome=cancelled，挂着的工具标成已中止', () => {
    const m = mapper()
    m.handle(textDelta('处理中'))
    m.handle({ type: 'tool_execution_start', toolCallId: 'tc', toolName: 'read_canvas', args: {} })
    const out = m.finish({ type: 'cancelled', reason: '已中止' })
    expect(out.map((event) => event.type)).toEqual([AgentEventType.RUN_FINISHED])
    const finished = out[0] as Extract<AgentStreamEvent, { type: 'RUN_FINISHED' }>
    expect(finished.outcome).toEqual({ type: 'cancelled' })
    expect(finished.result).toMatchObject({ text: '处理中', error: '已中止' })
    expect(finished.result.toolCalls[0]).toMatchObject({ status: 'error', error: '已中止' })
  })

  it('出错：RUN_ERROR，对话记录里那条带上原因', () => {
    const m = mapper()
    m.handle(textDelta('一半'))
    const out = m.finish({ type: 'error', message: '模型挂了', code: 'model_error' })
    expect(out.map((event) => event.type)).toEqual([AgentEventType.TEXT_MESSAGE_END, AgentEventType.RUN_ERROR])
    expect(out[1]).toMatchObject({ message: '模型挂了', code: 'model_error' })
    expect(m.message.error).toBe('模型挂了')
  })

  it('模型报错的那条 assistant 消息被记下来，交给收尾判定', () => {
    const m = mapper()
    m.handle(assistantEnd('error', '429 too many requests'))
    expect(m.modelError).toBe('429 too many requests')
  })
})

describe('画布改动通知', () => {
  it('CUSTOM agent.canvas-change：value 就是对话里那条消息（拷贝），先关掉没关的文字段', () => {
    const m = mapper()
    m.start({ id: 'msg-u', role: 'user', text: '一', createdAt: 1 })
    const opened = m.handle(textDelta('先说一句'))
    expect(opened.map((e) => e.type)).toEqual([AgentEventType.TEXT_MESSAGE_START, AgentEventType.TEXT_MESSAGE_CONTENT])

    const change = {
      id: 'chg-1',
      role: 'canvas-change' as const,
      scope: 'live' as const,
      summary: '爱丽丝 改动了画布（1 处）',
      items: ['新建节点 text「A」（a）'],
      actors: ['爱丽丝'],
      omitted: 0,
      createdAt: 5,
    }
    const out = m.canvasChange(change)
    expect(out).toEqual([
      { type: AgentEventType.TEXT_MESSAGE_END, messageId: 'msg-a', timestamp: 1000 },
      { type: AgentEventType.CUSTOM, name: AGENT_CANVAS_CHANGE_EVENT, value: change, timestamp: 1000 },
    ])
    const custom = out[1] as Extract<AgentStreamEvent, { name: typeof AGENT_CANVAS_CHANGE_EVENT }>
    expect(custom.value).not.toBe(change)
    // 不改 assistant 消息本身
    expect(m.message.text).toBe('先说一句')
  })
})

describe('子任务条目（docs/20 §3.10.11）', () => {
  const subtaskFrames = (events: AgentStreamEvent[]) =>
    events.filter(
      (event) => event.type === AgentEventType.CUSTOM && (event.name === AGENT_SUBTASK_EVENT || event.name === AGENT_SUBTASK_UPDATE_EVENT),
    )
  const valueOf = (event: AgentStreamEvent | undefined) => (event as { value: Record<string, unknown> }).value

  it('派发一帧完整条目，之后每次变化一帧 agent.subtask-update（只带变了的），不进 assistant 的文字和 toolCalls；依次合并 = 条目本身', () => {
    const m = mapper()
    const started = m.subtaskStart({ id: 'sub_1', toolCallId: 'call_d', brief: '搭场景', nodeIds: ['d1'], startedAt: 500 })
    expect(started).toMatchObject([
      { name: AGENT_SUBTASK_EVENT, value: { id: 'sub_1', toolCallId: 'call_d', brief: '搭场景', status: 'running', toolCalls: [], text: '', nodeIds: ['d1'] } },
    ])

    const toolStart = m.subtaskEvent('sub_1', { type: 'tool_execution_start', toolCallId: 't1', toolName: 'add_node', args: { type: 'text' } })
    expect(toolStart).toMatchObject([{ name: AGENT_SUBTASK_UPDATE_EVENT }])
    // 只带这一条工具调用：没有任务说明、节点、状态
    expect(valueOf(toolStart[0])).toEqual({
      id: 'sub_1',
      toolCalls: [{ id: 't1', name: 'add_node', status: 'running', summary: 'add_node:{"type":"text"}' }],
    })
    const toolEnd = m.subtaskEvent('sub_1', {
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'add_node',
      result: { content: [{ type: 'text', text: 'ok' }], details: { summary: '新建节点「A」' } },
      isError: false,
    })
    expect(valueOf(toolEnd[0])).toEqual({ id: 'sub_1', toolCalls: [{ id: 't1', name: 'add_node', status: 'done', summary: '新建节点「A」' }] })
    // load_skill / request_confirmation 不列进它的工具调用
    expect(m.subtaskEvent('sub_1', { type: 'tool_execution_start', toolCallId: 't2', toolName: 'load_skill', args: {} })).toEqual([])
    expect(m.subtaskEvent('sub_1', { type: 'tool_execution_start', toolCallId: 't3', toolName: 'request_confirmation', args: {} })).toEqual([])
    // 文字增量不逐帧发；一条回复结束时更新 text
    expect(m.subtaskEvent('sub_1', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '做' } })).toEqual([])
    const reply = m.subtaskEvent('sub_1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '做好了' }], stopReason: 'stop' } as never,
    })
    expect(valueOf(reply[0])).toEqual({ id: 'sub_1', text: '做好了' })

    const finished = m.subtaskFinish('sub_1', { status: 'done', changedNodeIds: ['n_a'] })
    expect(valueOf(finished[0])).toEqual({ id: 'sub_1', status: 'done', finishedAt: 1000, changedNodeIds: ['n_a'] })
    // 结束之后的事件不再改它；认不出的 id 忽略
    expect(m.subtaskEvent('sub_1', { type: 'tool_execution_start', toolCallId: 't4', toolName: 'get_node', args: {} })).toEqual([])
    expect(m.subtaskEvent('sub_x', { type: 'tool_execution_start', toolCallId: 't5', toolName: 'get_node', args: {} })).toEqual([])

    // 父 agent 的 assistant 消息：没有子 agent 的文字和工具调用，只有 subtasks
    expect(m.message.text).toBe('')
    expect(m.message.toolCalls).toEqual([])
    expect(m.message.subtasks).toHaveLength(1)
    // 帧里是拷贝：之后的变化不会改到已经发出去的帧
    expect(valueOf(started[0]).status).toBe('running')
    // 首帧依次合并之后的每一帧 = 落定消息里的完整条目
    let folded = parseAgentSubtask(valueOf(started[0]))!
    for (const frame of [...toolStart, ...toolEnd, ...reply, ...finished]) folded = applyAgentSubtaskUpdate(folded, parseAgentSubtaskUpdate(valueOf(frame))!)
    expect(folded).toEqual(m.message.subtasks![0])
  })

  it('只调了工具 / 出错的那条回复没有文字：条目上留着上一条有文字的回复（subtaskReply 同）', () => {
    const m = mapper()
    m.subtaskStart({ id: 'sub_1', toolCallId: 'call_d', brief: 'a', nodeIds: [], startedAt: 1 })
    m.subtaskEvent('sub_1', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '先说的' }], stopReason: 'toolUse' } as never })
    expect(m.subtaskEvent('sub_1', { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } as never })).toEqual([])
    expect(m.subtask('sub_1')!.text).toBe('先说的')
    expect(m.subtaskReply('sub_1')).toBe('先说的')
  })

  it('上游复用调用 id：父 agent 和子任务条目里后来的那条加后缀，end 归到最近一次 start；子任务挂在当前那次 delegate_task 上', () => {
    const m = mapper()
    const end = (toolCallId: string, toolName: string) =>
      ({ type: 'tool_execution_end', toolCallId, toolName, result: { content: [] }, isError: false }) as const
    m.handle({ type: 'tool_execution_start', toolCallId: 'call_0', toolName: 'delegate_task', args: {} })
    m.subtaskStart({ id: 'sub_1', toolCallId: 'call_0', brief: 'a', nodeIds: [], startedAt: 1 })
    m.handle(end('call_0', 'delegate_task'))
    const second = m.handle({ type: 'tool_execution_start', toolCallId: 'call_0', toolName: 'delegate_task', args: {} })
    expect(second[0]).toMatchObject({ type: AgentEventType.TOOL_CALL_START, toolCallId: 'call_0#2' })
    m.subtaskStart({ id: 'sub_2', toolCallId: 'call_0', brief: 'b', nodeIds: [], startedAt: 2 })
    expect(m.handle(end('call_0', 'delegate_task'))[0]).toMatchObject({ type: AgentEventType.TOOL_CALL_RESULT, toolCallId: 'call_0#2' })
    expect(m.message.toolCalls.map((item) => [item.id, item.status])).toEqual([
      ['call_0', 'done'],
      ['call_0#2', 'done'],
    ])
    expect(m.message.subtasks!.map((task) => task.toolCallId)).toEqual(['call_0', 'call_0#2'])
    expect(m.toolCall('call_0')!.id).toBe('call_0#2')
    // 子 agent 自己也复用 id
    m.subtaskEvent('sub_2', { type: 'tool_execution_start', toolCallId: 'call_0', toolName: 'get_node', args: {} })
    m.subtaskEvent('sub_2', end('call_0', 'get_node'))
    m.subtaskEvent('sub_2', { type: 'tool_execution_start', toolCallId: 'call_0', toolName: 'read_canvas', args: {} })
    expect(m.subtask('sub_2')!.toolCalls.map((item) => [item.id, item.name, item.status])).toEqual([
      ['call_0', 'get_node', 'done'],
      ['call_0#2', 'read_canvas', 'running'],
    ])
    expect(m.toolCall('call_0', 'sub_2')!.name).toBe('read_canvas')
  })

  it('收尾时还在跑的子任务标成失败（原因随结局），先各发一帧变化再发最后一帧；落定的消息里带着完整条目', () => {
    const m = mapper()
    m.subtaskStart({ id: 'sub_1', toolCallId: 'call_d', brief: 'a', nodeIds: [], startedAt: 1 })
    m.subtaskEvent('sub_1', { type: 'tool_execution_start', toolCallId: 't1', toolName: 'get_node', args: {} })
    const out = m.finish({ type: 'cancelled', reason: '已中止' })
    const frames = subtaskFrames(out)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      name: AGENT_SUBTASK_UPDATE_EVENT,
      value: { status: 'failed', error: '已中止', toolCalls: [{ id: 't1', status: 'error' }] },
    })
    expect(out.at(-1)).toMatchObject({
      type: AgentEventType.RUN_FINISHED,
      result: { subtasks: [{ id: 'sub_1', brief: 'a', status: 'failed', toolCalls: [{ id: 't1', status: 'error' }] }] },
    })
  })
})
