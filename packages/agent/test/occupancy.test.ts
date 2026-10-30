import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type Context, type JsonObject } from '@earendil-works/pi-ai'
import { AgentEventType, type AgentRunEntry, type AgentStreamEvent } from '@shadecn/shared/agent'
import { edgesMap, nodeGroupMap, nodesMap, toYEdge, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import { createMemoryAuthorityProvider } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { createMemoryLeaseRegistry, dataWriteTargets, leaseKey, type NodeLease } from '../src/occupancy.ts'
import { GATEWAY_ROUTES, RUNNER_PROTOCOL_VERSION } from '../src/protocol.ts'
import type { SandboxDriver } from '../src/sandbox/driver.ts'
import { createAgentRuntime, type AgentRuntimeOptions, type OpenedCanvas } from '../src/session.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import { gatewayFetch, registerScriptedModel, type ScriptedModel, type ScriptedStep } from '../src/testing.ts'

/**
 * 节点占用与写入检查（docs/20 §3.10.8）：走完整的二期路径（进程内 runner → 网关 → 编排层），
 * 守的是：只有写节点 data 才占用、两轮写同一个节点后来的被拒且不停整轮、一轮结束（任何结局）释放、续期、
 * 过期后别人能占而旧持有者续不回、「改过」检查（别人改 data 后写被拒、重读后通过、只挪位置不算）、
 * 读工具标出别人的占用、空闲上限。
 */

let faux: ScriptedModel | null = null

afterEach(() => {
  faux = null
  vi.unstubAllGlobals()
})

const profiles = async (ids: string[]) => new Map(ids.map((id) => [id, { id, name: `名字-${id}`, avatarUrl: null }]))

function runtimeWith(responses: ScriptedStep[], overrides: Partial<AgentRuntimeOptions> = {}) {
  faux = registerScriptedModel()
  faux.setResponses(responses)
  const leases = createMemoryLeaseRegistry()
  const changes: AgentRunEntry[][] = []
  const store = createMemoryConversationStore()
  const runtime = createAgentRuntime({
    ...faux.runtimeOptions(),
    leases,
    store,
    runLog: createMemoryRunLog(),
    userProfiles: profiles,
    authorities: createMemoryAuthorityProvider(),
    onRunsChange: (_flowId, runs) => changes.push(runs),
    limits: { changeWindowMs: 5, runsThrottleMs: 5 },
    ...overrides,
  })
  vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request)))
  return Object.assign(runtime, { leases: (overrides.leases ?? leases) as typeof leases, changes, store, scripted: faux })
}

function seedText(doc: Y.Doc, id: string, text = '原文') {
  nodesMap(doc).set(
    id,
    toYNode({ ...buildNodeRecord({ id, type: 'text', label: `节点${id}`, position: { x: 0, y: 0 } }), data: { text } }),
  )
}

function open(doc: Y.Doc) {
  return async (runId: string): Promise<OpenedCanvas> => ({
    ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }),
    async close() {},
  })
}

async function start(runtime: ReturnType<typeof runtimeWith>, doc: Y.Doc, userId = 'u1', text = '开始') {
  const events: AgentStreamEvent[] = []
  const started = await runtime.start({ flowId: 'flow-1', userId, conversationId: null, text, openCanvas: open(doc), emit: (e) => events.push(e) })
  if (!started.ok) throw new Error(`应该启动成功：${started.message}`)
  return Object.assign(started, { events })
}

const call = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })

/** 上下文里最后一条工具结果的文字（脚本化上游从 OpenAI 请求还原上下文，`isError` 还原不出来，看文字） */
function lastToolResult(context: Context): { text: string } {
  const result = [...context.messages].reverse().find((message) => message.role === 'toolResult')
  if (!result || result.role !== 'toolResult') return { text: '' }
  const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
  return { text }
}

/** 记下上下文里最后一条工具结果，再回 `next` */
function capture(into: { text: string }[], next: ReturnType<typeof fauxAssistantMessage> | (() => ReturnType<typeof fauxAssistantMessage>)): ScriptedStep {
  return (context) => {
    into.push(lastToolResult(context))
    return typeof next === 'function' ? next() : next
  }
}

/** 一直等着、直到 `release()` 才回复的一步（中止时立刻收尾）：用来让一轮停在「持有占用」的状态 */
function gated(final: string | AssistantMessage = '完成') {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const step: ScriptedStep = (_context, options) =>
    new Promise((resolve) => {
      options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
      void gate.then(() => resolve(typeof final === 'string' ? fauxAssistantMessage(final) : final))
    })
  return { step, release }
}

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const dataOf = (doc: Y.Doc, id: string) => nodeGroupMap(nodesMap(doc).get(id), 'data')?.toJSON()

describe('登记表（内存实现，语义同宿主的 SharedMap）', () => {
  it('claim 只在不存在时成功；过期后别人能占，旧持有者续不回、也删不掉别人的', async () => {
    let now = 1000
    const registry = createMemoryLeaseRegistry({ ttlMs: 100, now: () => now })
    const a: NodeLease = { runId: 'r_a', agentId: 'main', conversationId: 'c_a', owner: { id: 'u1', name: '甲', avatarUrl: null }, instanceId: 'i1', since: 1 }
    const b: NodeLease = { ...a, runId: 'r_b', conversationId: 'c_b' }
    expect(await registry.claim('f', 'n1', a)).toBe(true)
    expect(await registry.claim('f', 'n1', b)).toBe(false)
    expect(await registry.renew('f', 'n1', a)).toBe(true)
    now += 99
    expect(await registry.get('f', 'n1')).toEqual(a)
    now += 100
    expect(await registry.get('f', 'n1')).toBeNull()
    expect(await registry.claim('f', 'n1', b)).toBe(true)
    expect(await registry.renew('f', 'n1', a)).toBe(false)
    expect(await registry.release('f', 'n1', a)).toBe(false)
    expect(await registry.get('f', 'n1')).toEqual(b)
    // 转交（预留给子 run）：只在值仍是 from 时生效
    const child = { ...b, runId: 'r_child' }
    expect(await registry.transfer('f', 'n1', a, child)).toBe(false)
    expect(await registry.transfer('f', 'n1', b, child)).toBe(true)
    expect([...(await registry.list('f')).keys()]).toEqual(['n1'])
    expect(await registry.list('f2')).toEqual(new Map())
    expect(await registry.release('f', 'n1', child)).toBe(true)
    expect(registry.entries.size).toBe(0)
  })

  it('哪些写算：update_node 改 data / 删数据算，只改 metadata 不算；删除只算节点；导演台写工具算 nodeId', () => {
    const isNode = (id: string) => id.startsWith('n')
    const t = (name: string, args: unknown, skillId: string | null = 'canvas', writes = true) =>
      dataWriteTargets({ name, skillId, writes, args }, isNode)
    expect(t('update_node', { id: 'n1', data: { text: 'x' } })).toEqual(['n1'])
    expect(t('update_node', { id: 'n1', removeData: ['text'] })).toEqual(['n1'])
    expect(t('update_node', { id: 'n1', metadata: { label: 'x' } })).toEqual([])
    expect(t('update_node', { id: 'n1', metadata: { label: 'x' }, data: {} })).toEqual([])
    expect(t('delete_elements', { ids: ['n1', 'e1', 'n1'] })).toEqual(['n1'])
    for (const name of ['connect', 'move_nodes', 'resize_node', 'group_nodes', 'ungroup', 'auto_layout', 'get_node', 'read_canvas']) {
      expect(t(name, { id: 'n1', ids: ['n1'], source: 'n1', target: 'n2' })).toEqual([])
    }
    expect(t('add_objects', { nodeId: 'n_d' }, 'director')).toEqual(['n_d'])
    expect(t('get_director_scene', { nodeId: 'n_d' }, 'director', false)).toEqual([])
  })
})

describe('两轮写同一个节点', () => {
  it('后来的那一轮写被拒（模型可见的错误，不停整轮）；第一轮结束后占用释放，再写就能通过', async () => {
    const holdA = gated()
    const seenByB: { text: string }[] = []
    const runtime = runtimeWith([
      call('update_node', { id: 'n1', data: { text: '甲改的' } }),
      holdA.step,
      call('update_node', { id: 'n1', data: { text: '乙改的' } }),
      capture(seenByB, fauxAssistantMessage('n1 被占用了，我先停下')),
    ])
    const doc = new Y.Doc()
    seedText(doc, 'n1')

    const a = await start(runtime, doc, 'u1', '甲的事')
    await until(() => runtime.scripted.state.callCount >= 2)
    expect((await runtime.activeRuns('flow-1'))[0]).toMatchObject({ runId: a.runId, occupies: ['n1'], expiresAt: expect.any(Number) })
    expect((await runtime.leases.get('flow-1', 'n1'))?.runId).toBe(a.runId)

    const b = await start(runtime, doc, 'u2', '乙的事')
    await b.done
    expect(seenByB[0]!.text).toContain('节点 n1 正在被 名字-u1的助手 修改')
    expect(dataOf(doc, 'n1')).toMatchObject({ text: '甲改的' })
    // 乙那一轮照常收尾（被拒不是整轮的错误），也没占到任何节点
    expect(b.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    expect((await runtime.activeRuns('flow-1')).map((run) => run.occupies)).toEqual([['n1']])

    holdA.release()
    await a.done
    expect(runtime.leases.entries.size).toBe(0)
    expect((await runtime.activeRuns('flow-1'))).toEqual([])
    // 广播里最后一份是空列表（标签随之消失）
    expect(runtime.changes.at(-1)).toEqual([])
    // 某一次广播里出现过 occupies: ['n1']（占用变化时推过全量）
    expect(runtime.changes.some((runs) => runs.some((run) => run.occupies.includes('n1')))).toBe(true)

    // 再来一轮写它：通过
    runtime.scripted.setResponses([call('update_node', { id: 'n1', data: { text: '丙改的' } }), fauxAssistantMessage('好了')])
    await (await start(runtime, doc, 'u3')).done
    expect(dataOf(doc, 'n1')).toMatchObject({ text: '丙改的' })
  })

  it('同一轮里已占着的节点直接过（不重复登记）；同一个人别的会话照样算「别人」', async () => {
    const hold = gated()
    const seen: { text: string }[] = []
    const runtime = runtimeWith([
      call('update_node', { id: 'n1', data: { text: '一' } }),
      call('update_node', { id: 'n1', data: { text: '二' } }),
      hold.step,
      call('update_node', { id: 'n1', data: { text: '别的会话' } }),
      capture(seen, fauxAssistantMessage('被占了')),
    ])
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    const a = await start(runtime, doc)
    await until(() => runtime.scripted.state.callCount >= 3)
    expect(dataOf(doc, 'n1')).toMatchObject({ text: '二' })
    expect((await runtime.activeRuns('flow-1'))[0]!.occupies).toEqual(['n1'])
    await (await start(runtime, doc, 'u1', '同一个人的另一个会话')).done
    expect(seen[0]!.text).toContain('正在被 名字-u1的助手 修改')
    hold.release()
    await a.done
  })
})

describe('哪些写占用', () => {
  it('只连线、挪位置、改尺寸、只改 metadata、读：都不占用', async () => {
    const leasesSeen: number[] = []
    let registry: ReturnType<typeof createMemoryLeaseRegistry> | null = null
    const peek: ScriptedStep = async () => {
      leasesSeen.push((await registry!.list('flow-1')).size)
      return fauxAssistantMessage('完')
    }
    const runtime = runtimeWith([
      fauxAssistantMessage(
        [
          fauxToolCall('connect', { source: 'n1', target: 'n2' }),
          fauxToolCall('move_nodes', { moves: [{ id: 'n1', x: 100, y: 100 }] }),
          fauxToolCall('resize_node', { id: 'n2', width: 300, height: 200 }),
          fauxToolCall('update_node', { id: 'n1', metadata: { label: '改名' } }),
          fauxToolCall('get_node', { id: 'n1' }),
          fauxToolCall('read_canvas', {}),
        ],
        { stopReason: 'toolUse' },
      ),
      peek,
    ])
    registry = runtime.leases
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    nodesMap(doc).set('n2', toYNode(buildNodeRecord({ id: 'n2', type: 'image', label: '图', position: { x: 400, y: 0 } })))
    const out = await start(runtime, doc)
    await out.done
    expect(edgesMap(doc).size).toBe(1)
    expect(leasesSeen).toEqual([0])
    expect(runtime.changes.every((runs) => runs.every((run) => run.occupies.length === 0))).toBe(true)
  })

  it('删除节点算占用（连线不算）；新建节点（add_node / duplicate_node）执行后占用新 id', async () => {
    let held: string[] = []
    let registry: ReturnType<typeof createMemoryLeaseRegistry> | null = null
    const peek: ScriptedStep = async () => {
      held = [...(await registry!.list('flow-1')).keys()].sort()
      return fauxAssistantMessage('完')
    }
    const runtime = runtimeWith([
      call('delete_elements', { ids: ['n1', 'e1'] }),
      call('add_node', { type: 'text', metadata: { label: '新的' }, data: { text: '新' } }),
      call('duplicate_node', { id: 'n3' }),
      peek,
    ])
    registry = runtime.leases
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    seedText(doc, 'n2')
    seedText(doc, 'n3')
    edgesMap(doc).set('e1', toYEdge({ id: 'e1', source: 'n2', target: 'n3', data: {} } as never))
    const out = await start(runtime, doc)
    await out.done
    const created = [...nodesMap(doc).keys()].filter((id) => !['n2', 'n3'].includes(id))
    expect(created).toHaveLength(2)
    expect(held).toEqual(['n1', ...created].sort())
    expect(held).not.toContain('e1')
    expect(held).not.toContain('n3')
    expect(runtime.leases.entries.size).toBe(0)
  })
})

describe('一轮结束释放占用', () => {
  it('中止：释放、离开列表', async () => {
    const hold = gated()
    const runtime = runtimeWith([call('update_node', { id: 'n1', data: { text: '改' } }), hold.step])
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    const a = await start(runtime, doc)
    await until(() => runtime.leases.entries.size === 1 && runtime.scripted.state.callCount >= 2)
    expect(await runtime.abort('flow-1', a.runId, { userId: 'u1', admin: false })).toBe('aborted')
    await a.done
    expect(a.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' } })
    expect(runtime.leases.entries.size).toBe(0)
  })

  it('出错（模型报错）：释放', async () => {
    const runtime = runtimeWith([
      call('update_node', { id: 'n1', data: { text: '改' } }),
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: '上游挂了' }),
    ])
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    const a = await start(runtime, doc)
    await a.done
    expect(a.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_ERROR })
    expect(runtime.leases.entries.size).toBe(0)
  })

  it('服务退出（abortAll）：释放', async () => {
    const hold = gated()
    const runtime = runtimeWith([call('update_node', { id: 'n1', data: { text: '改' } }), hold.step])
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    await start(runtime, doc)
    await until(() => runtime.leases.entries.size === 1 && runtime.scripted.state.callCount >= 2)
    await runtime.abortAll('服务正在停止')
    expect(runtime.leases.entries.size).toBe(0)
  })

  it('写入失败（节点不存在）：这次刚占的退掉，不挂着', async () => {
    let size = -1
    let registry: ReturnType<typeof createMemoryLeaseRegistry> | null = null
    const runtime = runtimeWith([
      call('update_node', { id: 'n_missing', data: { text: '改' } }),
      async () => {
        size = (await registry!.list('flow-1')).size
        return fauxAssistantMessage('没这个节点')
      },
    ])
    registry = runtime.leases
    await (await start(runtime, new Y.Doc())).done
    expect(size).toBe(0)
  })
})

describe('续期与过期', () => {
  it('持有者每 1/3 TTL 续期（比较后写）并重推列表；过期后别人占走的，旧持有者续不回来、收尾也不删别人的', async () => {
    const hold = gated()
    const leases = createMemoryLeaseRegistry({ ttlMs: 90 })
    const runtime = runtimeWith([call('update_node', { id: 'n1', data: { text: '改' } }), hold.step], { leases })
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    const a = await start(runtime, doc)
    await until(() => leases.entries.size === 1 && runtime.scripted.state.callCount >= 2)
    const firstExpiry = leases.entries.get(leaseKey('flow-1', 'n1'))!.expiresAt
    // 等过好几个 TTL：一直续着
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await leases.get('flow-1', 'n1')).toMatchObject({ runId: a.runId })
    expect(leases.entries.get(leaseKey('flow-1', 'n1'))!.expiresAt).toBeGreaterThan(firstExpiry + 100)
    const expiries = runtime.changes.flatMap((runs) => runs.filter((run) => run.runId === a.runId).map((run) => run.expiresAt!))
    expect(new Set(expiries).size).toBeGreaterThan(2)

    // 模拟「过期后被别人占走」：换成别人的值
    const foreign: NodeLease = { runId: 'r_other', agentId: 'main', conversationId: 'c', owner: { id: 'u9', name: '某人', avatarUrl: null }, instanceId: 'i9', since: 1 }
    leases.entries.set(leaseKey('flow-1', 'n1'), { raw: JSON.stringify(foreign), expiresAt: Date.now() + 60_000 })
    await until(async () => (await runtime.activeRuns('flow-1'))[0]?.occupies.length === 0)
    hold.release()
    await a.done
    expect(await leases.get('flow-1', 'n1')).toEqual(foreign)
  })
})

describe('「改过」检查', () => {
  it('人改了 data → 写被拒（附被谁改了什么）；重读之后写通过', async () => {
    const seen: { text: string }[] = []
    const doc = new Y.Doc()
    const humanEdits: ScriptedStep = () => {
      doc.transact(() => nodeGroupMap(nodesMap(doc).get('n1'), 'data')!.set('text', '人改的正文'), 'human')
      return call('update_node', { id: 'n1', data: { text: 'agent 想写的' } })
    }
    const runtime = runtimeWith([
      call('get_node', { id: 'n1' }),
      humanEdits,
      capture(seen, call('get_node', { id: 'n1' })),
      call('update_node', { id: 'n1', data: { text: '重读后写的' } }),
      capture(seen, fauxAssistantMessage('好了')),
    ])
    seedText(doc, 'n1')
    await (await start(runtime, doc)).done
    expect(seen[0]!.text).toContain('节点 n1 在你读过之后被改过')
    expect(seen[0]!.text).toContain('其他协作者')
    expect(seen[0]!.text).toContain('data.text')
    expect(seen[0]!.text).toContain('人改的正文')
    expect(seen[1]!.text).not.toContain('没有执行')
    expect(dataOf(doc, 'n1')).toMatchObject({ text: '重读后写的' })
  })

  it('人只挪位置、只改名字：不算「改过」，写照常通过', async () => {
    const seen: { text: string }[] = []
    const doc = new Y.Doc()
    const humanMoves: ScriptedStep = () => {
      doc.transact(() => {
        const node = nodesMap(doc).get('n1')!
        node.set('position', { x: 500, y: 500 })
        nodeGroupMap(node, 'metadata')!.set('label', '人改的名字')
      }, 'human')
      return call('update_node', { id: 'n1', data: { text: 'agent 写的' } })
    }
    const runtime = runtimeWith([call('get_node', { id: 'n1' }), humanMoves, capture(seen, fauxAssistantMessage('好了'))])
    seedText(doc, 'n1')
    await (await start(runtime, doc)).done
    expect(seen[0]!.text).not.toContain('没有执行')
    expect(dataOf(doc, 'n1')).toMatchObject({ text: 'agent 写的' })
  })

  it('别的轮次改了 data 也算（起点是本轮打开画布，没读过的节点同样要先读）', async () => {
    const holdB = gated(call('update_node', { id: 'n1', data: { text: '乙写的' } }))
    const seen: { text: string }[] = []
    const runtime = runtimeWith([holdB.step])
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    // 乙先开始（打开画布），停在模型那里
    const b = await start(runtime, doc, 'u2', '乙')
    await until(() => runtime.scripted.state.callCount >= 1)
    // 甲来写 n1、结束（占用随之释放）
    runtime.scripted.appendResponses([call('update_node', { id: 'n1', data: { text: '甲写的' } }), fauxAssistantMessage('甲完了')])
    await (await start(runtime, doc, 'u1', '甲')).done
    // 乙接着写 n1：不是「正在改」（甲已结束），而是「改过」—— 说是甲的 agent 改的
    runtime.scripted.appendResponses([capture(seen, fauxAssistantMessage('乙停下'))])
    holdB.release()
    await b.done
    expect(seen[0]!.text).toContain('在你读过之后被改过')
    expect(seen[0]!.text).toContain('名字-u1 的 agent')
    expect(dataOf(doc, 'n1')).toMatchObject({ text: '甲写的' })
  })
})

describe('读类工具标出占用', () => {
  it('get_node / read_canvas 的结果里标出别的轮次正占用着的节点；readNodeIds 不交给 runner、不进模型上下文', async () => {
    const hold = gated()
    const seen: { text: string }[] = []
    const runtime = runtimeWith([
      call('update_node', { id: 'n1', data: { text: '甲' } }),
      hold.step,
      call('get_node', { id: 'n1' }),
      capture(seen, call('read_canvas', {})),
      capture(seen, call('get_node', { id: 'n2' })),
      capture(seen, fauxAssistantMessage('看完了')),
    ])
    const doc = new Y.Doc()
    seedText(doc, 'n1')
    seedText(doc, 'n2')
    const a = await start(runtime, doc)
    await until(() => runtime.scripted.state.callCount >= 2)
    const b = await start(runtime, doc, 'u2', '乙看看')
    await b.done
    expect(seen[0]!.text).toContain('【节点占用】')
    expect(seen[0]!.text).toContain('n1（名字-u1的助手）')
    expect(seen[1]!.text).toContain('n1（名字-u1的助手）')
    // 只读了 n2：不标
    expect(seen[2]!.text).not.toContain('【节点占用】')
    const conversation = [...runtime.store.rows.values()].find((row) => row.userId === 'u2')!
    expect(JSON.stringify(conversation.llmMessages)).not.toContain('readNodeIds')
    hold.release()
    await a.done
  })
})

describe('空闲上限', () => {
  it('runner 兑换了令牌之后不再请求网关：空闲上限到了就停下这一轮，原因写明空闲', async () => {
    const runtimeRef: { current: ReturnType<typeof runtimeWith> | null } = { current: null }
    let killed: string | null = null
    const stuck: SandboxDriver = {
      name: 'stuck',
      reap: async () => {},
      async start(spec) {
        if (spec.credential.kind !== 'bootstrap') throw new Error('只认 bootstrap')
        await runtimeRef.current!.gateway.handle(
          new Request(`${spec.gatewayUrl}${GATEWAY_ROUTES.token}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ grantType: 'bootstrap', bootstrapToken: spec.credential.token, protocolVersion: RUNNER_PROTOCOL_VERSION }),
          }),
        )
        let exit!: (value: { exitCode: number | null; reason?: string }) => void
        const exited = new Promise<{ exitCode: number | null; reason?: string }>((resolve) => (exit = resolve))
        return {
          id: 'stuck-1',
          wait: () => exited,
          async kill(reason) {
            killed = reason
            exit({ exitCode: null, reason })
          },
        }
      },
    }
    const runtime = runtimeWith([], { driver: stuck, limits: { idleTimeoutMs: 80 } })
    runtimeRef.current = runtime
    const a = await start(runtime, new Y.Doc())
    await a.done
    expect(a.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' } })
    expect(JSON.stringify(a.events.at(-1))).toContain('空闲')
    expect(killed).toContain('空闲')
  })

  it('模型请求在途（长时间流式输出）不算空闲', async () => {
    const hold = gated('想好了')
    const runtime = runtimeWith([hold.step], { limits: { idleTimeoutMs: 60 } })
    const a = await start(runtime, new Y.Doc())
    await new Promise((resolve) => setTimeout(resolve, 250))
    hold.release()
    await a.done
    expect(a.events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
  })
})
