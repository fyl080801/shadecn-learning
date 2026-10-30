import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxToolCall } from '@mariozechner/pi-ai'
import { AgentEventType, type AgentStreamEvent } from '@shadecn/shared/agent'
import { nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import {
  createMemoryAuthorityProvider,
  isRunAuthorityError,
  RunAuthorityError,
  stopsRun,
  type MemoryAuthorityOptions,
  type RunAuthority,
} from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { createMediaTool } from '../src/sandbox/media-tool.ts'
import type { Sandbox } from '../src/sandbox/types.ts'
import { createAgentRuntime, type OpenedCanvas } from '../src/session.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import {
  createInlineDriver,
  gatewayFetch,
  loadSkillStep,
  registerScriptedModel,
  type InlineDriverOptions,
  type ScriptedModel,
  type ScriptedStep,
} from '../src/testing.ts'
import { createCanvasTools } from '../src/tools.ts'

/**
 * 编排层的执行身份接线（docs/22 第一期）：开始时签发 Grant；每个工具执行之前判它声明的能力、
 * 每次请求模型之前判 `llm:invoke`；Grant 失效（撤销 / 到期）= 整轮立即停，不是回给模型一个错误；
 * 只拒一次的（不在授予范围里）不停；收尾时 release；运行日志带 grantId。宿主那一半（库、对账）在 apps/server 测。
 * 二期起：模型请求经网关的模型代理判 `llm:invoke`、画布工具经网关判各自的能力；runner 走进程内驱动。
 */

let faux: ScriptedModel | null = null

afterEach(() => {
  faux = null
  vi.unstubAllGlobals()
})

function runtimeWith(
  responses: ScriptedStep[],
  options: { authority?: MemoryAuthorityOptions; media?: InlineDriverOptions; timeoutMs?: number } = {},
) {
  faux = registerScriptedModel()
  faux.setResponses(responses)
  const authorities = createMemoryAuthorityProvider(options.authority)
  const runLog = createMemoryRunLog()
  const runtime = createAgentRuntime({
    ...faux.runtimeOptions(createInlineDriver(options.media ?? {})),
    store: createMemoryConversationStore(),
    runLog,
    userProfiles: async (ids) => new Map(ids.map((id) => [id, { id, name: id, avatarUrl: null }])),
    authorities,
    mediaTool: Boolean(options.media),
    ...(options.timeoutMs ? { limits: { timeoutMs: options.timeoutMs } } : {}),
  })
  vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request)))
  return { runtime, authorities, runLog }
}

/** 记下 openCanvas 拿到的 authority（宿主的画布实现用它判读写） */
function canvasOf(doc: Y.Doc) {
  const authorities: RunAuthority[] = []
  const open = async (runId: string, authority: RunAuthority): Promise<OpenedCanvas> => {
    authorities.push(authority)
    return { ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }), close: async () => {} }
  }
  return { open, authorities }
}

async function run(runtime: ReturnType<typeof runtimeWith>['runtime'], doc = new Y.Doc()) {
  const events: AgentStreamEvent[] = []
  const canvas = canvasOf(doc)
  const started = runtime.start({
    flowId: 'flow-1',
    userId: 'u1',
    conversationId: null,
    text: '做点什么',
    openCanvas: canvas.open,
    emit: (event) => events.push(event),
  })
  if (!started.ok) throw new Error(started.message)
  return { events, started, canvas }
}

/** 一条要等外面放行（或被中止）才回复的模型回复 */
function gated() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let reach!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const step: ScriptedStep = (_context, options) =>
    new Promise((resolve) => {
      reach()
      options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
      void gate.then(() => resolve(fauxAssistantMessage('完成')))
    })
  return { step, release, reached }
}

describe('工具声明的能力', () => {
  it('每个画布工具都声明了能力：读 flow:read、写 flow:write、删（含解组）flow:delete；媒体工具 sandbox:exec', () => {
    const canvas = createDocCanvasHandle(new Y.Doc(), { flowId: 'f', runId: 'r' })
    const caps = Object.fromEntries(createCanvasTools({ canvas }).map((tool) => [tool.name, tool.capability]))
    expect(caps).toEqual({
      read_canvas: 'flow:read',
      get_node: 'flow:read',
      view_node_media: 'flow:read',
      check_connection: 'flow:read',
      add_node: 'flow:write',
      update_node: 'flow:write',
      connect: 'flow:write',
      move_nodes: 'flow:write',
      resize_node: 'flow:write',
      duplicate_node: 'flow:write',
      group_nodes: 'flow:write',
      auto_layout: 'flow:write',
      delete_elements: 'flow:delete',
      ungroup: 'flow:delete',
    })
    expect(createMediaTool({} as Sandbox).capability).toBe('sandbox:exec')
  })

  it('RunAuthorityError：按形状认；revoked / expired 停整轮，denied 不停', () => {
    expect(isRunAuthorityError(new RunAuthorityError('denied', 'x'))).toBe(true)
    expect(isRunAuthorityError(new Error('x'))).toBe(false)
    expect(stopsRun(new RunAuthorityError('revoked', 'x'))).toBe(true)
    expect(stopsRun(new RunAuthorityError('expired', 'x'))).toBe(true)
    expect(stopsRun(new RunAuthorityError('denied', 'x'))).toBe(false)
  })
})

describe('签发与判权', () => {
  it('开始时签发 Grant（没配沙箱就不要 sandbox:exec）；每次请求模型前判 llm:invoke、每个工具执行前判它的能力；收尾 release；日志带 grantId', async () => {
    const { runtime, authorities, runLog } = runtimeWith([
      fauxAssistantMessage(
        [
          fauxToolCall('read_canvas', {}),
          fauxToolCall('add_node', { type: 'text', metadata: { label: '一' } }),
          fauxToolCall('delete_elements', { ids: ['nope'] }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('好了'),
    ])
    const { started, events, canvas } = await run(runtime)
    await started.done

    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    const [grant] = authorities.grants
    expect(grant!.request).toMatchObject({
      runId: started.runId,
      flowId: 'flow-1',
      userId: 'u1',
      capabilities: ['flow:read', 'flow:write', 'flow:delete', 'llm:invoke'],
      model: 'Faux',
      timeoutMs: 5 * 60_000,
    })
    expect(grant!.calls).toEqual(['llm:invoke', 'flow:read', 'flow:write', 'flow:delete', 'llm:invoke'])
    // 宿主的画布实现拿到的是同一份 authority（它按读写判 flow:read / flow:write）
    expect(canvas.authorities.map((authority) => authority.grantId)).toEqual([grant!.grantId])
    expect(grant!.released).toEqual({ status: 'success', reason: null })

    expect(runLog.runs.get(started.runId)).toMatchObject({ status: 'success', grantId: grant!.grantId })
    expect(runLog.toolCalls.map((call) => [call.name, call.grantId])).toEqual([
      ['read_canvas', grant!.grantId],
      ['add_node', grant!.grantId],
      ['delete_elements', grant!.grantId],
    ])
  })

  it('开了媒体工具才要 sandbox:exec；Grant 里缺写 / 删能力时 canvas 照样提供，写工具在网关逐个判权被拒（docs/23 §4）', async () => {
    let toolNames: string[] = []
    let systemPrompt = ''
    const { runtime, authorities, runLog } = runtimeWith(
      [
        (context) => {
          toolNames = (context.tools ?? []).map((tool) => tool.name)
          systemPrompt = context.systemPrompt ?? ''
          return fauxAssistantMessage([fauxToolCall('delete_elements', { ids: ['n1'] })], { stopReason: 'toolUse' })
        },
        fauxAssistantMessage('好'),
      ],
      { media: {}, authority: { withhold: ['flow:delete'] } },
    )
    const doc = new Y.Doc()
    nodesMap(doc).set('n1', toYNode(buildNodeRecord({ id: 'n1', type: 'text', label: '留着', position: { x: 0, y: 0 } })))
    const { started, events } = await run(runtime, doc)
    await started.done
    expect(authorities.grants[0]!.request.capabilities).toContain('sandbox:exec')
    // media-exec 是按需技能：提供了，在技能目录里，工具要 load_skill 之后才有
    expect(systemPrompt).toContain('- media-exec：')
    expect(toolNames).not.toContain('run_media_command')
    // canvas 只要 flow:read 就提供：13 个工具都在，包括要 flow:delete 的
    expect(toolNames).toEqual(expect.arrayContaining(['read_canvas', 'add_node', 'delete_elements']))
    // delete_elements 到网关判 flow:delete 被拒：只拒这一次（denied 不停整轮），节点还在
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    expect(authorities.grants[0]!.calls).toContain('flow:delete')
    expect(runLog.toolCalls).toMatchObject([{ name: 'delete_elements', ok: false }])
    expect(nodesMap(doc).has('n1')).toBe(true)
  })

  it('媒体工具在 runner 的工作目录里本地执行：不经网关判 sandbox:exec（docs/22 §3 沙箱内部动作），工作目录里有 canvas.json', async () => {
    // 一个假的 ffprobe：记下自己在哪个目录、看到的 canvas.json（不要求开发机装了 ffmpeg）
    const bin = await mkdtemp(path.join(tmpdir(), 'agent-bin-'))
    const marker = path.join(bin, 'ran.txt')
    try {
      await writeFile(path.join(bin, 'ffprobe'), `#!/bin/sh\nls canvas.json >> '${marker}'\n`)
      await chmod(path.join(bin, 'ffprobe'), 0o755)
      const { runtime, authorities, runLog } = runtimeWith(
        [
          loadSkillStep('media-exec'),
          fauxAssistantMessage([fauxToolCall('run_media_command', { command: 'ffprobe', args: ['a.mp4'] })], {
            stopReason: 'toolUse',
          }),
          fauxAssistantMessage('好'),
        ],
        { media: { pathEnv: `${bin}:/usr/bin:/bin` } },
      )
      const { started, events } = await run(runtime)
      await started.done
      expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
      // 模型请求三次 + load_skill 一次 flow:read：媒体命令没有经网关判 sandbox:exec
      expect(authorities.grants[0]!.calls).toEqual(['llm:invoke', 'flow:read', 'llm:invoke', 'llm:invoke'])
      expect((await readFile(marker, 'utf8')).trim()).toBe('canvas.json')
      // 只在 runner 里跑的工具按它上报的记日志
      expect(runLog.toolCalls).toMatchObject([
        { name: 'load_skill', ok: true, args: 'id=media-exec' },
        { name: 'run_media_command', ok: true, args: 'command=ffprobe args[1]' },
      ])
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })

  it('签发不出来（发起时就已失权）：RUN_ERROR，不调模型，运行日志 grantId 为 null', async () => {
    let calls = 0
    const { runtime, runLog } = runtimeWith(
      [
        () => {
          calls += 1
          return fauxAssistantMessage('不该走到这里')
        },
      ],
      { authority: { refuse: '这张画布已不存在，或你已无权访问它' } },
    )
    const { started, events } = await run(runtime)
    await started.done
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_ERROR, message: '这张画布已不存在，或你已无权访问它' })
    expect(calls).toBe(0)
    expect(runLog.runs.get(started.runId)).toMatchObject({ status: 'error', grantId: null })
  })
})

describe('Grant 失效 = 整轮停', () => {
  it('宿主对账叫停（模型请求中途）：立即中止，cancelled + 原因，release 记 cancelled', async () => {
    const { step, reached } = gated()
    const { runtime, authorities, runLog } = runtimeWith([step])
    const { started, events } = await run(runtime)
    await reached
    authorities.revoke(started.runId, '发起人已失去这张画布的访问权限，agent 已停止')
    await started.done

    expect(events.at(-1)).toMatchObject({
      type: AgentEventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
      result: { error: '发起人已失去这张画布的访问权限，agent 已停止' },
    })
    expect(runLog.runs.get(started.runId)).toMatchObject({
      status: 'cancelled',
      error: '发起人已失去这张画布的访问权限，agent 已停止',
    })
    expect(authorities.grants[0]!.released).toMatchObject({ status: 'cancelled' })
  })

  it('工具判权时发现 Grant 已撤销（宿主没主动叫停）：整轮停，模型不再被请求', async () => {
    let calls = 0
    const { runtime, authorities } = runtimeWith([
      () => {
        calls += 1
        // 模型这一步回来之前 Grant 被撤销了，但没人调 stop —— 只有下一次判权会发现
        authorities.grants[0]!.revoked = { kind: 'revoked', reason: '失权了' }
        return fauxAssistantMessage([fauxToolCall('add_node', { type: 'text', metadata: { label: '晚了' } })], {
          stopReason: 'toolUse',
        })
      },
      () => {
        calls += 1
        return fauxAssistantMessage('不该走到这里')
      },
    ])
    const doc = new Y.Doc()
    const { started, events } = await run(runtime, doc)
    await started.done
    expect(calls).toBe(1)
    expect(nodesMap(doc).size).toBe(0)
    expect(events.at(-1)).toMatchObject({ outcome: { type: 'cancelled' }, result: { error: '失权了' } })
  })

  it('Grant 到期：运行日志 expired，线上是 cancelled（契约不变），原因在 result.error', async () => {
    const { step, reached } = gated()
    const { runtime, authorities, runLog } = runtimeWith([step])
    const { started, events } = await run(runtime)
    await reached
    authorities.revoke(started.runId, '这一轮的授权已到期，agent 已停止', 'expired')
    await started.done
    expect(events.at(-1)).toMatchObject({
      type: AgentEventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
      result: { error: '这一轮的授权已到期，agent 已停止' },
    })
    expect(runLog.runs.get(started.runId)).toMatchObject({ status: 'expired', error: '这一轮的授权已到期，agent 已停止' })
    expect(authorities.grants[0]!.released).toMatchObject({ status: 'expired' })
  })

  it('先被用户停止、后失权：保留第一个原因', async () => {
    const { step, reached } = gated()
    const { runtime, authorities, runLog } = runtimeWith([step])
    const { started } = await run(runtime)
    await reached
    runtime.abort('flow-1', started.runId, { userId: 'u1', admin: false })
    authorities.revoke(started.runId, '失权', 'expired')
    await started.done
    expect(runLog.runs.get(started.runId)).toMatchObject({ status: 'cancelled', error: '已中止' })
  })

  it('不在授予范围里（denied）只拒这一次：回给模型，这一轮照常跑完', async () => {
    const { runtime } = runtimeWith(
      [
        fauxAssistantMessage([fauxToolCall('read_canvas', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('读不了，那就算了'),
      ],
      { authority: { withhold: ['flow:read'] } },
    )
    const { started, events } = await run(runtime)
    await started.done
    // read_canvas 不在工具列表里（pi 回「工具不存在」），这一轮不因此停
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
  })

  it('判 llm:invoke 不过（denied）：pi 兜住的失败按 error 收尾，而不是误报成功', async () => {
    const { runtime, runLog } = runtimeWith([fauxAssistantMessage('不该走到这里')], {
      authority: { withhold: ['llm:invoke'] },
    })
    const { started, events } = await run(runtime)
    await started.done
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_ERROR, code: 'model_error' })
    expect(runLog.runs.get(started.runId)).toMatchObject({ status: 'error' })
  })
})

describe('中止即杀沙箱进程（docs/22 §10 验收 5）', () => {
  it('失权叫停时正在跑的「ffmpeg」被立即杀掉，工作目录清理', async () => {
    // 一个假的 ffmpeg：记下自己的 pid，然后睡很久（不要求开发机装了 ffmpeg）
    const bin = await mkdtemp(path.join(tmpdir(), 'agent-bin-'))
    const root = await mkdtemp(path.join(tmpdir(), 'agent-ws-'))
    try {
      await writeFile(path.join(bin, 'ffmpeg'), '#!/bin/sh\necho $$ > started.pid\nexec sleep 30\n')
      await chmod(path.join(bin, 'ffmpeg'), 0o755)
      const { runtime, authorities } = runtimeWith(
        [
          loadSkillStep('media-exec'),
          fauxAssistantMessage([fauxToolCall('run_media_command', { command: 'ffmpeg', args: ['-version'] })], {
            stopReason: 'toolUse',
          }),
          fauxAssistantMessage('不该走到这里'),
        ],
        { media: { rootDir: root, pathEnv: `${bin}:/usr/bin:/bin` } },
      )
      const { started } = await run(runtime)
      const workdir = path.join(root, 'flow-1', started.runId)
      const pidFile = path.join(workdir, 'started.pid')
      let pid = 0
      for (let i = 0; i < 300 && !pid; i += 1) {
        pid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim()) || 0
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(pid).toBeGreaterThan(0)

      const stoppedAt = Date.now()
      authorities.revoke(started.runId, '失权')
      await started.done
      expect(Date.now() - stoppedAt).toBeLessThan(3000)
      // 进程没了（kill 0 只探测存在与否）、工作目录删了
      expect(() => process.kill(pid, 0)).toThrow()
      await expect(stat(workdir)).rejects.toThrow()
    } finally {
      await rm(bin, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  })
})
