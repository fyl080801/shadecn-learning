import { request as httpRequest } from 'node:http'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { AGENT_GATEWAY_PATH, RUNNER_PROTOCOL_VERSION } from '@learning/agent-core/protocol'
import { createEngineClient, findEngineSocket, type EngineClient } from '@learning/agent-core/sandbox/drivers/engine'
import { createOciDriver, OCI_LABELS, type OciDriverOptions, type OciSandboxHandle } from '@learning/agent-core/sandbox/drivers/oci'
import { createAgentRuntime, type AgentRuntimeOptions } from '@learning/agent-core/session'
import { registerScriptedModel, SCRIPTED_API_KEY, TEST_TOKEN_SECRET, type ScriptedStep } from '@learning/agent-core/testing'
import { FlowDocStore } from '@learning/canvas'
import { agentApiPath, agentRunAbortPath, AgentEventType } from '@learning/contracts/agent'
import { nodesMap } from '@learning/contracts/flow-doc'
import { DataAccess } from '@learning/data-access'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { AgentRun, AgentToolCall } from '../src/entities.js'
import { type AgentTestContext, createHttpFlow as createFlow, createHttpProject as createProject, describeOnBothDatabases, parseSse } from './helpers.js'

/**
 * **真实容器引擎**上的 `oci` 驱动（docs/22 第三期、docs/31 §7 第 8 步）。默认跳过：要本机有 Podman / Docker 和构建好的 runner 镜像。
 *
 *   pnpm build:agent-runner-image
 *   AGENT_SANDBOX_OCI_IT=1 pnpm exec vitest run --project=agent-service sandbox-oci
 *
 * 可选：`AGENT_SANDBOX_OCI_IT_IMAGE`（默认 `learning-agent-runner:latest`）、`AGENT_SANDBOX_OCI_IT_SOCKET`（不给按常见位置找）、
 * `AGENT_SANDBOX_OCI_IT_HOST`（容器里看到的宿主名，默认 `host.docker.internal`；app 只听 127.0.0.1，所以是按 podman machine 写的，
 * 那里经 gvproxy 转回 Mac 的回环。Linux 上要改成宿主网卡地址并让 app 监听在那上面，docs/31 §6.4）。
 * `AGENT_SANDBOX_OCI_IT_STALE_IMAGE`：一个「旧版本」的镜像（runner 的兑换请求不带协议版本），给了才跑「旧镜像被拒」那条。
 *
 * 守的是验收 1、5、7 在真容器里的样子：跑完一轮（runner 在容器里经网关改了画布、环境变量只有那几个）；
 * 运行中的容器真的带着那些安全选项；中止当场杀掉并删除容器；reap 清掉本实例的孤儿、不碰别的实例；
 * 「服务端也在 internal 网络里」的部署形态下，沙箱只连得到网关、外网和宿主都连不上。
 * 从 `apps/server/test/agent/sandbox-oci.test.ts` 移植。
 */

const enabled = process.env.AGENT_SANDBOX_OCI_IT === '1'
const staleImage = process.env.AGENT_SANDBOX_OCI_IT_STALE_IMAGE?.trim() || ''
const image = process.env.AGENT_SANDBOX_OCI_IT_IMAGE?.trim() || 'learning-agent-runner:latest'
const hostName = process.env.AGENT_SANDBOX_OCI_IT_HOST?.trim() || 'host.docker.internal'
/** 这批用例自己的实例标识：只清自己建的容器 */
const instance = `it-${process.pid}`

type SandboxDriver = AgentRuntimeOptions['driver']

const NAME = 'oci 驱动：真实容器引擎（AGENT_SANDBOX_OCI_IT=1）'

function suite(ctx: AgentTestContext) {
  let socketPath = ''
  let engine: EngineClient
  const actor = (name?: string) => ctx.httpActor(name)
  const db = () => ctx.app.get(DataAccess).em()
  const appPort = () => Number(new URL(ctx.baseUrl).port)
  const gatewayUrl = () => `http://${hostName}:${appPort()}${AGENT_GATEWAY_PATH}`

  /** 引擎的原始 JSON（inspect 一类，客户端只取了驱动要的字段） */
  function raw(method: string, requestPath: string, body?: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = httpRequest({ socketPath, method, path: requestPath, headers: payload ? { 'content-type': 'application/json' } : {} }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }))
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  beforeAll(async () => {
    const found = findEngineSocket(process.env.AGENT_SANDBOX_OCI_IT_SOCKET?.trim() ?? '', process.env)
    if (!found.ok) throw new Error(found.reason)
    socketPath = found.path
    engine = createEngineClient(socketPath)
    if (!(await engine.imageExists(image))) throw new Error(`runner 镜像 ${image} 不存在：先 pnpm build:agent-runner-image`)
  })

  afterAll(async () => {
    // 兜底：这批用例的实例标识下还剩的容器一律删掉
    if (engine) {
      for (const label of [instance, `${instance}-other`]) {
        for (const container of await engine.listContainers([`${OCI_LABELS.instance}=${label}`])) await engine.removeContainer(container.Id)
      }
    }
  })

  function ociDriver(extra: Partial<OciDriverOptions> = {}) {
    const output: string[] = []
    const handles: OciSandboxHandle[] = []
    const base = createOciDriver({ engine, image, instance, onOutput: (_runId, _stream, line) => output.push(line), ...extra })
    const driver: SandboxDriver = {
      name: base.name,
      reap: (live) => base.reap(live),
      async start(spec) {
        const handle = (await base.start(spec)) as OciSandboxHandle
        handles.push(handle)
        return handle
      },
    }
    return { base, driver, output, handles }
  }

  function useOciRuntime(steps: ScriptedStep[], driverOptions: Partial<OciDriverOptions> = {}) {
    const scripted = registerScriptedModel()
    scripted.setResponses(steps)
    const sandbox = ociDriver(driverOptions)
    const runtime = createAgentRuntime({
      ...ctx.host,
      model: scripted.model,
      driver: sandbox.driver,
      gateway: { url: gatewayUrl(), secret: TEST_TOKEN_SECRET, upstreamFetch: scripted.fetch },
      sandbox: { image: driverOptions.image ?? image, resources: { cpu: 1, memoryMiB: 256, pids: 64, diskMiB: 64 } },
    })
    ctx.runtime.use(runtime)
    return { scripted, ...sandbox }
  }

  async function until(check: () => boolean | Promise<boolean>, ms = 30_000) {
    for (const started = Date.now(); !(await check()); ) {
      if (Date.now() - started > ms) throw new Error('等不到')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async function storedNodeLabels(flowId: string): Promise<string[]> {
    const row = await ctx.app.get(FlowDocStore, { strict: false }).read(flowId, { liveProject: false, legacy: false })
    const doc = new Y.Doc()
    if (row?.ydoc) Y.applyUpdate(doc, new Uint8Array(row.ydoc))
    return [...nodesMap(doc).values()].map((node) => (node.get('metadata') as Y.Map<unknown>).get('label') as string)
  }

  /** runner 启动行里报的环境变量名 */
  function envNames(output: string[]) {
    const line = output.find((entry) => entry.includes('环境变量：'))
    if (!line) throw new Error(`runner 没有报环境变量：\n${output.join('\n')}`)
    return line.split('环境变量：')[1]!.split(', ')
  }

  /** 引擎自己加的（不是密钥）：HOSTNAME / HOME，Podman 另加 container=podman */
  const ENGINE_ADDED = new Set(['HOSTNAME', 'HOME', 'container'])
  const THE_THREE = ['SHADECN_BOOTSTRAP_TOKEN', 'SHADECN_GATEWAY_URL', 'SHADECN_WORKDIR']

  it('跑完一轮：runner 在容器里经网关改了画布；环境变量只有网关地址 / 一次性凭证 / 工作目录 / PATH（+ 引擎加的）；容器结束即删除', async () => {
    const { scripted, output, handles } = useOciRuntime([
      fauxAssistantMessage([fauxText('我来加一个节点'), fauxToolCall('add_node', { type: 'text', metadata: { label: '容器里加的' } })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('加好了'),
    ])
    // 平台只听回环：容器够得着，靠的是引擎把这个主机名转回本机（podman machine 实测，docs/31 §6.4）
    expect(new URL(ctx.baseUrl).hostname).toBe('127.0.0.1')
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const res = await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '加一个节点' })
    expect(res.status).toBe(200)
    const events = parseSse(await res.text())
    expect(events.at(-1), JSON.stringify(output)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })

    expect(await storedNodeLabels(flowId)).toEqual(['容器里加的'])

    const names = envNames(output).filter((name) => !ENGINE_ADDED.has(name))
    expect(names).toEqual(['PATH', ...THE_THREE])
    expect(scripted.requests.map((request) => request.headers.get('authorization'))).toEqual([`Bearer ${SCRIPTED_API_KEY}`, `Bearer ${SCRIPTED_API_KEY}`])
    expect(await db().find(AgentToolCall, {})).toMatchObject([{ name: 'add_node', ok: true }])

    const [handle] = handles
    expect(await handle!.wait()).toEqual({ exitCode: 0 })
    expect((await raw('GET', `/containers/${handle!.containerId}/json`)).status).toBe(404)
  }, 120_000)

  it.skipIf(!staleImage)('旧镜像（runner 不带协议版本）→ 以 runner_protocol_mismatch 拒绝，不是 401，容器随后被清掉（AGENT_SANDBOX_OCI_IT_STALE_IMAGE）', async () => {
    const { scripted, output, handles } = useOciRuntime([fauxAssistantMessage('不该走到这里')], { image: staleImage })
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))

    const events = parseSse(await (await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '你好' })).text())
    expect(events.at(-1), JSON.stringify(output)).toMatchObject({
      type: AgentEventType.RUN_ERROR,
      code: 'runner_protocol_mismatch',
      message: `沙箱 runner 的协议版本 未声明（镜像过旧） 和服务端的 ${RUNNER_PROTOCOL_VERSION} 不一致，请重建沙箱镜像（pnpm build:agent-runner-image）`,
    })
    expect(scripted.requests).toHaveLength(0)
    const [handle] = handles
    // RUNNER_EXIT_PROTOCOL_MISMATCH：runner 听懂了 409，不是把它当 401 重试
    expect(await handle!.wait()).toEqual({ exitCode: 4 })
    expect((await raw('GET', `/containers/${handle!.containerId}/json`)).status).toBe(404)
  }, 120_000)

  it('运行中的容器带着全部安全选项；中止 → 当场杀掉并删除，cancelled + 原因', async () => {
    let reach!: () => void
    const reached = new Promise<void>((resolve) => (reach = resolve))
    const stuck: ScriptedStep = (_context, options) =>
      new Promise((resolve) => {
        reach()
        options.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('…')))
      })
    const { handles } = useOciRuntime([stuck])
    const alice = await actor()
    const flowId = await createFlow(alice, await createProject(alice))
    const pending = alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '慢慢来' })
    await reached

    const [handle] = handles
    const inspect = (await raw('GET', `/containers/${handle!.containerId}/json`)).json
    expect(inspect.State.Running).toBe(true)
    expect(inspect.Config.User).toBe('10001:10001')
    expect(inspect.Config.Labels).toMatchObject({ [OCI_LABELS.managed]: 'true', [OCI_LABELS.instance]: instance })
    const env = (inspect.Config.Env as string[]).map((pair) => pair.split('=')[0]!)
    expect(env.filter((name) => !ENGINE_ADDED.has(name)).sort()).toEqual(['PATH', ...THE_THREE])
    const host = inspect.HostConfig
    expect(host.ReadonlyRootfs).toBe(true)
    expect(host.Privileged).toBe(false)
    expect(host.SecurityOpt).toContain('no-new-privileges')
    expect(JSON.stringify(host.SecurityOpt)).not.toContain('unconfined')
    // Docker 原样回 ["ALL"]；Podman 展开成具体的能力列表。两种都不能有 CapAdd
    expect(host.CapDrop.includes('ALL') || host.CapDrop.includes('SETUID')).toBe(true)
    expect(host.CapAdd ?? []).toEqual([])
    expect(host.Memory).toBe(256 * 1024 * 1024)
    expect(host.PidsLimit).toBe(64)
    expect(host.NanoCpus).toBe(1e9)
    expect(Object.keys(host.Tmpfs).sort()).toEqual(['/tmp', '/work'])
    expect(host.Binds ?? []).toEqual([])
    expect((inspect.Mounts as { Type: string }[]).filter((mount) => mount.Type !== 'tmpfs')).toEqual([])

    const view = (await (await alice.request(agentApiPath(flowId))).json()) as { activeRuns: { runId: string }[] }
    const runId = view.activeRuns[0]!.runId
    const at = Date.now()
    expect((await alice.request(agentRunAbortPath(flowId, runId), { method: 'POST' })).status).toBe(204)
    const events = parseSse(await (await pending).text())
    expect(Date.now() - at).toBeLessThan(10_000)
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'cancelled' }, result: { error: '已中止' } })
    expect(await handle!.wait()).toEqual({ exitCode: null, reason: '已中止' })
    expect((await raw('GET', `/containers/${handle!.containerId}/json`)).status).toBe(404)
    expect(await db().findOneOrFail(AgentRun, runId)).toMatchObject({ status: 'cancelled', error: '已中止' })
  }, 120_000)

  it('reap：上一个进程留下的容器（同一实例标识）被删；别的实例的不碰', async () => {
    const sleeper = ['node', '-e', 'setInterval(() => {}, 1000)']
    const previous = ociDriver({ command: sleeper })
    const orphan = (await previous.base.start(itSpec('it_orphan'))) as OciSandboxHandle
    const other = ociDriver({ command: sleeper, instance: `${instance}-other` })
    const foreign = (await other.base.start(itSpec('it_foreign'))) as OciSandboxHandle
    try {
      // 「重启之后」的新驱动：同一个实例标识，手里没有任何在跑的轮次
      const restarted = ociDriver()
      await restarted.base.reap(new Set())
      expect((await raw('GET', `/containers/${orphan.containerId}/json`)).status).toBe(404)
      expect((await raw('GET', `/containers/${foreign.containerId}/json`)).json.State.Running).toBe(true)
      // 老句柄看到的是「容器被外部删除」
      expect((await orphan.wait()).exitCode).toBeNull()
    } finally {
      await foreign.kill('测试收尾')
    }
  }, 120_000)

  it('镜像、网络不存在：真引擎的报错能被认出来，消息写明该配哪一项，不留容器', async () => {
    const noImage = ociDriver({ image: 'learning-agent-it-missing:1' })
    await expect(noImage.base.start(itSpec('it_noimage'))).rejects.toThrow(/沙箱镜像 learning-agent-it-missing:1 不存在.*pnpm build:agent-runner-image.*agent\.sandbox\.image/)
    const noNetwork = ociDriver({ network: 'learning-agent-it-missing' })
    await expect(noNetwork.base.start(itSpec('it_nonet'))).rejects.toThrow(/沙箱网络 learning-agent-it-missing 不存在（agent\.sandbox\.oci\.network）/)
    for (const spec of ['it_noimage', 'it_nonet'].map((name) => itSpec(name))) expect(await engine.listContainers([`${OCI_LABELS.run}=${spec.runId}`])).toEqual([])
  }, 120_000)

  it('internal 网络（服务端也接在里面的部署形态）：沙箱只连得到网关，外网和宿主都连不上', async () => {
    const network = `learning-agent-it-${process.pid}`
    const createdNet = await raw('POST', '/networks/create', { Name: network, Internal: true, Labels: { [OCI_LABELS.managed]: 'true' } })
    expect(createdNet.status).toBe(201)
    const gateway = ociDriver({
      network,
      command: ['node', '-e', "require('node:http').createServer((q, s) => s.end('gateway-ok')).listen(8080, () => console.log('listening'))"],
    })
    const gw = (await gateway.base.start(itSpec('it_gw'))) as OciSandboxHandle
    try {
      await until(() => gateway.output.includes('listening'))
      const probe =
        'const get = (url) => fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.text()).catch((e) => "ERR " + (e.cause?.code ?? e.name));' +
        `Promise.all([get('http://${gw.name}:8080/'), get('http://1.1.1.1/'), get('http://${hostName}:${appPort()}/api/health')])` +
        '.then(([gateway, internet, host]) => console.log(JSON.stringify({ gateway, internet, host })))'
      const prober = ociDriver({ network, command: ['node', '-e', probe] })
      const handle = await prober.base.start(itSpec('it_probe'))
      expect(await handle.wait(), prober.output.join('\n')).toEqual({ exitCode: 0 })
      const result = JSON.parse(prober.output.find((line) => line.startsWith('{'))!) as Record<string, string>
      expect(result.gateway).toBe('gateway-ok')
      expect(result.internet).toMatch(/^ERR /)
      expect(result.host).toMatch(/^ERR /)
    } finally {
      await gw.kill('测试收尾')
      await raw('DELETE', `/networks/${network}`)
    }
  }, 120_000)
}

function itSpec(name: string) {
  return {
    // 容器名由它来：带 pid，上一次崩溃留下的容器不会让这一次撞名
    runId: `${name}_${process.pid}`,
    flowId: 'it_flow',
    ownerId: 'it',
    grantId: 'it',
    image,
    resources: { cpu: 1, memoryMiB: 128, pids: 32, diskMiB: 16, deadlineMs: 60_000 },
    gatewayUrl: 'http://unused/api/agent-gateway',
    credential: { kind: 'bootstrap' as const, token: 'unused' },
  }
}

// 跳过时不进 describeOnBothDatabases：它在收集阶段就要建临时目录
if (enabled) describeOnBothDatabases(NAME, 'agent_oci', suite, { http: true })
else describe.skip(NAME, () => suite({} as AgentTestContext))
