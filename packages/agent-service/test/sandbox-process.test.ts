import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { AGENT_GATEWAY_PATH, PROTOCOL_MISMATCH_ERROR, RUNNER_ENV, RUNNER_EXIT_PROTOCOL_MISMATCH, RUNNER_PROTOCOL_VERSION } from '@learning/agent-core/protocol'
import { createProcessDriver, type ProcessSandboxHandle } from '@learning/agent-core/sandbox/drivers/process'
import { createAgentRuntime, type AgentRuntimeOptions } from '@learning/agent-core/session'
import { registerScriptedModel, SCRIPTED_API_KEY, TEST_TOKEN_SECRET, type ScriptedStep } from '@learning/agent-core/testing'
import { FlowDocStore } from '@learning/canvas'
import { agentApiPath, agentRunAbortPath, AgentEventType } from '@learning/contracts/agent'
import { nodesMap } from '@learning/contracts/flow-doc'
import { DataAccess } from '@learning/data-access'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { ACCESS_REVOKED } from '../src/authority.js'
import { AgentRun, AgentToolCall } from '../src/entities.js'
import { runnerCommand } from '../src/runner-command.js'
import { createHttpFlow as createFlow, createHttpProject as createProject, describeOnBothDatabases, ensureRunnerBuilt, type HttpActor as Actor, joinHttpInvite as joinViaInvite, parseSse } from './helpers.js'

/**
 * 真的 `process` 驱动（docs/22 第二期、docs/31 §7 第 6 步）：每一轮一个 `node` 子进程跑 agent-core 的 tsc 产物，经真实的 HTTP 连回 `/api/agent-gateway`（app 真的 listen 在一个随机端口上），模型请求由服务端打脚本化的上游。这是 §9 说的「真 runner + 真网关 + Nest」第一次合起来。
 * 守的是：runner 进程环境里没有密钥；跑完一轮画布真的变了、SSE 帧同形；失权、中止、超时都当场杀掉子进程（pid 没了、工作目录清掉、ffmpeg 一起没），以 cancelled 收尾写明原因；runner 崩了（没报收尾就退出）→ RUN_ERROR 写明原因。
 * 从 `apps/server/test/agent/sandbox-process.test.ts` 移植。
 */

type SandboxDriver = AgentRuntimeOptions['driver']

beforeAll(() => ensureRunnerBuilt())

describeOnBothDatabases('process 驱动', 'agent_process', (ctx) => {
const actor = (name?: string) => ctx.httpActor(name)
const db = () => ctx.app.get(DataAccess).em()
let workspaces = ''

beforeEach(async () => {
  workspaces = await mkdtemp(path.join(tmpdir(), 'agent-ws-'))
})

afterEach(async () => {
  await rm(workspaces, { recursive: true, force: true })
})

interface Spawned {
  handles: ProcessSandboxHandle[]
  output: string[]
}

/** 生产那套宿主接线 + 真的 process 驱动（起的命令就是 `runnerCommand()`）；记下起过的子进程和它们的输出 */
function useProcessRuntime(
  steps: ScriptedStep[],
  options: { command?: [string, ...string[]]; pathEnv?: string; overrides?: Partial<AgentRuntimeOptions> } = {},
) {
  const scripted = registerScriptedModel()
  scripted.setResponses(steps)
  const spawned: Spawned = { handles: [], output: [] }
  const base = createProcessDriver({
    command: options.command ?? runnerCommand(),
    rootDir: workspaces,
    pathEnv: options.pathEnv ?? process.env.PATH ?? '/usr/bin:/bin',
    production: false,
    onOutput: (_runId, _stream, line) => spawned.output.push(line),
  })
  const driver: SandboxDriver = {
    name: base.name,
    reap: (live) => base.reap(live),
    async start(spec) {
      const handle = (await base.start(spec)) as ProcessSandboxHandle
      spawned.handles.push(handle)
      return handle
    },
  }
  const runtime = createAgentRuntime({
    model: scripted.model,
    driver,
    gateway: { url: `${ctx.baseUrl}${AGENT_GATEWAY_PATH}`, secret: TEST_TOKEN_SECRET, upstreamFetch: scripted.fetch },
    ...ctx.host,
    ...options.overrides,
  })
  ctx.runtime.use(runtime)
  return { runtime, scripted, spawned }
}

function send(who: Actor, flowId: string, text: string) {
  return who.json(`${agentApiPath(flowId)}/messages`, 'POST', { text })
}

/** 卡在模型请求里，直到被叫停（上游请求被网关掐断） */
function stuck() {
  let reach!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const step: ScriptedStep = (_context, options) =>
    new Promise((resolve) => {
      reach()
      options.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
    })
  return { step, reached }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
  for (const started = Date.now(); !(await check()); ) {
    if (Date.now() - started > ms) throw new Error('等不到')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function storedNodeLabels(flowId: string): Promise<string[]> {
  const row = await ctx.app.get(FlowDocStore, { strict: false }).read(flowId, { liveProject: false, legacy: false })
  const doc = new Y.Doc()
  if (row?.ydoc) Y.applyUpdate(doc, new Uint8Array(row.ydoc))
  return [...nodesMap(doc).values()].map((node) => (node.get('metadata') as Y.Map<unknown>).get('label') as string)
}

describe('process 驱动：runner 在子进程里', () => {
  it('跑完一轮：模型调 add_node → 画布变了；SSE 帧和以前同形；runner 是独立进程，环境里没有任何密钥，结束后工作目录清掉', async () => {
    const { scripted, spawned } = useProcessRuntime([
      fauxAssistantMessage([fauxText('我来加一个节点'), fauxToolCall('add_node', { type: 'text', metadata: { label: '子进程加的' } })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('加好了'),
    ])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const res = await send(alice, flowId, '加一个节点')
    expect(res.status).toBe(200)
    const events = parseSse(await res.text())
    const types = events.map((event) => event.type)
    expect(types[0]).toBe(AgentEventType.RUN_STARTED)
    expect(types[1]).toBe(AgentEventType.CUSTOM)
    expect(types).toEqual(
      expect.arrayContaining([
        AgentEventType.TEXT_MESSAGE_START,
        AgentEventType.TEXT_MESSAGE_CONTENT,
        AgentEventType.TEXT_MESSAGE_END,
        AgentEventType.TOOL_CALL_START,
        AgentEventType.TOOL_CALL_ARGS,
        AgentEventType.TOOL_CALL_END,
        AgentEventType.TOOL_CALL_RESULT,
      ]),
    )
    expect(types.indexOf(AgentEventType.TOOL_CALL_RESULT)).toBeGreaterThan(types.indexOf(AgentEventType.TOOL_CALL_START))
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    expect(events.find((event) => event.type === AgentEventType.TOOL_CALL_RESULT)).toMatchObject({
      metadata: { status: 'done', summary: '新建节点「子进程加的」' },
    })

    expect(await storedNodeLabels(flowId)).toEqual(['子进程加的'])

    // 一个独立的子进程跑的这一轮，正常退出、工作目录清掉
    const [handle] = spawned.handles
    expect(handle!.pid).not.toBe(process.pid)
    expect(await handle!.wait()).toEqual({ exitCode: 0 })
    expect(alive(handle!.pid)).toBe(false)
    await expect(stat(handle!.workdir)).rejects.toThrow()

    // runner 启动时报的环境变量名：只有网关地址、一次性凭证、工作目录、PATH（macOS 系统给每个进程加的 __CF_* 除外）
    const envLine = spawned.output.find((line) => line.includes('环境变量：'))!
    const names = envLine.split('环境变量：')[1]!.split(', ').filter((name) => !name.startsWith('__CF_'))
    expect(names).toEqual(['PATH', 'SHADECN_BOOTSTRAP_TOKEN', 'SHADECN_GATEWAY_URL', 'SHADECN_WORKDIR'])

    // 上游只见过网关注入的真实 key；runner 手里的是 run 短令牌，从没出现在上游
    expect(scripted.requests.map((request) => request.headers.get('authorization'))).toEqual([
      `Bearer ${SCRIPTED_API_KEY}`,
      `Bearer ${SCRIPTED_API_KEY}`,
    ])
    // 审计：画布工具那一行来自网关的执行记录
    expect(await db().find(AgentToolCall, {})).toMatchObject([{ name: 'add_node', ok: true }])
  })

  it('发起人被移出项目：子进程当场被杀（pid 没了），cancelled + 原因', async () => {
    const hold = stuck()
    const { spawned } = useProcessRuntime([hold.step])
    const alice = await actor('alice')
    const bob = await actor('bob')
    const projectId = await createProject(alice)
    await joinViaInvite(alice, projectId, bob)
    const flowId = await createFlow(alice, projectId)

    const pending = send(bob, flowId, '慢慢来')
    await hold.reached
    const [handle] = spawned.handles
    expect(alive(handle!.pid)).toBe(true)

    const at = Date.now()
    expect((await alice.request(`/api/projects/${projectId}/members/${bob.userId}`, { method: 'DELETE' })).status).toBe(204)
    const events = parseSse(await (await pending).text())
    expect(Date.now() - at).toBeLessThan(5000)
    expect(events.at(-1)).toMatchObject({
      type: AgentEventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
      result: { error: ACCESS_REVOKED },
    })
    expect(await handle!.wait()).toMatchObject({ exitCode: null, reason: ACCESS_REVOKED })
    expect(alive(handle!.pid)).toBe(false)
    await expect(stat(handle!.workdir)).rejects.toThrow()
  })

  it('中止：子进程连同它正在跑的「ffmpeg」立即被杀，工作目录清理（验收 5）', async () => {
    // 一个假的 ffmpeg：记下自己的 pid，然后睡很久（不要求开发机装了 ffmpeg）
    const bin = await mkdtemp(path.join(tmpdir(), 'agent-bin-'))
    const pidFile = path.join(bin, 'ffmpeg.pid')
    try {
      await writeFile(path.join(bin, 'ffmpeg'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`)
      await chmod(path.join(bin, 'ffmpeg'), 0o755)
      const { spawned } = useProcessRuntime(
        [
          // 媒体处理是按需技能（docs/23）：先单独加载
          fauxAssistantMessage([fauxToolCall('load_skill', { id: 'media-exec' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage([fauxToolCall('run_media_command', { command: 'ffmpeg', args: ['-version'] })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('不该走到这里'),
        ],
        {
          pathEnv: `${bin}:/usr/bin:/bin`,
          // 媒体工具要 Grant 里有 sandbox:exec：这里换一份放行它的 authority
          overrides: { mediaTool: true, authorities: mediaAuthority() },
        },
      )
      const alice = await actor()
      const flowId = await createFlow(alice, await createProject(alice))
      const pending = send(alice, flowId, '处理一下视频')

      let ffmpeg = 0
      await until(async () => (ffmpeg = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim()) || 0) > 0)
      const [handle] = spawned.handles
      expect(alive(ffmpeg)).toBe(true)

      const view = (await (await alice.request(agentApiPath(flowId))).json()) as { activeRuns: { runId: string }[] }
      const runId = view.activeRuns[0]!.runId
      const at = Date.now()
      expect((await alice.request(agentRunAbortPath(flowId, runId), { method: 'POST' })).status).toBe(204)
      const events = parseSse(await (await pending).text())
      expect(Date.now() - at).toBeLessThan(5000)
      expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' }, result: { error: '已中止' } })
      expect(alive(handle!.pid)).toBe(false)
      await until(() => !alive(ffmpeg))
      await expect(stat(handle!.workdir)).rejects.toThrow()
      expect(await db().findOneOrFail(AgentRun, runId)).toMatchObject({ status: 'cancelled', error: '已中止' })
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })

  it('超时：到点杀掉子进程，cancelled + 「超过 N 秒」', async () => {
    const hold = stuck()
    const { spawned } = useProcessRuntime([hold.step], { overrides: { limits: { timeoutMs: 4000 } } })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const events = parseSse(await (await send(alice, flowId, '慢慢来')).text())
    expect(events.at(-1)).toMatchObject({
      type: AgentEventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
      result: { error: '超过 4 秒，已停止' },
    })
    expect(alive(spawned.handles[0]!.pid)).toBe(false)
  })

  it('runner 没报收尾就退出（崩了）：RUN_ERROR，原因写明退出码', async () => {
    const { spawned } = useProcessRuntime([fauxAssistantMessage('不该走到这里')], { command: [process.execPath, '-e', 'process.exit(7)'] })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const events = parseSse(await (await send(alice, flowId, '你好')).text())
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_ERROR, code: 'runner_failed' })
    expect((events.at(-1) as { message: string }).message).toContain('退出码 7')
    expect(await spawned.handles[0]!.wait()).toEqual({ exitCode: 7 })
  })
})

describe('runner 进程的退出码（协议版本）', () => {
  /** 一个假网关：只有 /sts/token，按给的状态码和 JSON 回；记下收到的兑换请求体 */
  async function fakeGateway(status: number, body: unknown) {
    const requests: Record<string, unknown>[] = []
    const fake = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        requests.push(JSON.parse(raw || '{}') as Record<string, unknown>)
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      })
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}${AGENT_GATEWAY_PATH}`
    return { url, requests, close: () => new Promise((resolve) => fake.close(resolve)) }
  }

  function runRunner(gatewayUrl: string): Promise<{ code: number | null; output: string }> {
    const [command, ...args] = runnerCommand()
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? '', [RUNNER_ENV.gatewayUrl]: gatewayUrl, [RUNNER_ENV.bootstrapToken]: 'boot-token', [RUNNER_ENV.workdir]: workspaces },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    return new Promise((resolve) => child.on('exit', (code) => resolve({ code, output })))
  }

  it('网关回 409 protocol_mismatch → runner 以退出码 4 退出（和令牌被拒的 3、普通错误的 1 分开）；兑换请求带着版本和构建 id', async () => {
    const gw = await fakeGateway(409, {
      error: PROTOCOL_MISMATCH_ERROR,
      message: '版本不一致',
      runnerVersion: RUNNER_PROTOCOL_VERSION,
      serverVersion: RUNNER_PROTOCOL_VERSION + 1,
    })
    try {
      const { code, output } = await runRunner(gw.url)
      expect(RUNNER_EXIT_PROTOCOL_MISMATCH).toBe(4)
      expect(code).toBe(4)
      expect(output).toContain('协议版本不一致')
      expect(gw.requests[0]).toMatchObject({ grantType: 'bootstrap', bootstrapToken: 'boot-token', protocolVersion: RUNNER_PROTOCOL_VERSION, buildId: 'source' })
    } finally {
      await gw.close()
    }
  })

  it('网关回 401 → 退出码 3（对照）', async () => {
    const gw = await fakeGateway(401, { error: 'unauthorized', message: 'x' })
    try {
      expect((await runRunner(gw.url)).code).toBe(3)
    } finally {
      await gw.close()
    }
  })
})

/** 放行 sandbox:exec 的一份 authority（生产里由 agent.sandbox.exec 决定，测试的配置没开） */
function mediaAuthority() {
  return ctx.authorityWith({ expiryMarginMs: 60_000, entitled: () => true })
}
}, { http: true })
