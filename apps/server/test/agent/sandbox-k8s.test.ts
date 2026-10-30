import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createAdaptorServer } from '@hono/node-server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { AGENT_GATEWAY_PATH } from '@shadecn/agent/protocol'
import {
  createK8sDriver,
  createKubeClient,
  K8S_LABELS,
  kubeConnection,
  parseK8sNodeSelector,
  type K8sDriverOptions,
  type K8sSandboxHandle,
  type KubeClient,
  type PodObject,
  type SandboxDriver,
} from '@shadecn/agent/sandbox/drivers'
import { createAgentRuntime } from '@shadecn/agent/session'
import { registerScriptedModel, TEST_TOKEN_SECRET } from '@shadecn/agent/testing'
import { agentApiPath, AgentEventType, type AgentStreamEvent } from '@shadecn/shared/agent'
import { nodesMap } from '@shadecn/shared/flow-doc'
import { agentHostOptions, replaceAgentRuntime } from '../../agent/index.ts'
import { app } from '../../app.ts'
import { attachCollabServer } from '../../collab/hocuspocus.ts'
import { flushCollabWrites, loadFlowState, roomOf } from '../../collab/persistence.ts'
import { resetDb } from '../helpers/db.ts'
import { actor, createFlow, createProject } from '../helpers/project.ts'

/**
 * **真实集群**上的 `k8s` 驱动（docs/22 第四期）。默认跳过，而且**每一项都要显式给**，没有任何默认值会去连一个集群：
 *
 *   AGENT_SANDBOX_K8S_IT=1 \
 *   AGENT_SANDBOX_K8S_IT_API_URL=http://127.0.0.1:8001 \      # 例如 kubectl proxy（⚠️ 它用的是 kubectl 当前的 context，先确认）
 *   AGENT_SANDBOX_K8S_IT_NAMESPACE=shadecn-agent-sandbox \     # 已按 k8s/variants/agent-sandbox.yaml 建好的测试命名空间
 *   AGENT_SANDBOX_IMAGE=<节点拉得到的沙箱镜像完整引用> \
 *   TEST_DATABASE_URL= pnpm exec vitest run --project=server sandbox-k8s
 *
 * 可选：`AGENT_SANDBOX_K8S_IT_TOKEN_FILE` / `_CA_FILE`（直连 API server 时；kubectl proxy 不要）、
 * `AGENT_SANDBOX_K8S_IT_PULL_SECRET`、`AGENT_SANDBOX_K8S_IT_RUNTIME_CLASS`、`AGENT_SANDBOX_K8S_IT_NODE_SELECTOR`（同 `AGENT_SANDBOX_K8S_NODE_SELECTOR` 的写法）；
 * `AGENT_SANDBOX_K8S_IT_GATEWAY_HOST` = 集群里的 Pod 连得到本机的地址（给了才跑「完整一轮」，app 会监听 0.0.0.0）；
 * `AGENT_SANDBOX_K8S_IT_NETPOL=1` = 命名空间里已经应用了 NetworkPolicy（给了才跑「出不了网」那条）。
 *
 * 守的是：自检通过；Pod 真的带着那些安全字段、环境里没有服务端的东西；跑完 / 杀掉都删 Pod；reap 只清本实例的；
 * NetworkPolicy 下沙箱出不了网、解析不了名字；完整一轮里 runner 在 Pod 里经网关改了画布。
 *
 * 自检要求准入拦得下 privileged 的反例：独立命名空间靠 Pod Security restricted；在 dev（共用命名空间 + VAP）里跑时，
 * VAP 只认服务端的 ServiceAccount，所以 kubectl proxy 要带 `--as=system:serviceaccount:dev:shadecn-learning`。
 */

const env = (name: string) => process.env[name]?.trim() ?? ''
const apiUrl = env('AGENT_SANDBOX_K8S_IT_API_URL')
const namespace = env('AGENT_SANDBOX_K8S_IT_NAMESPACE')
const image = env('AGENT_SANDBOX_IMAGE')
const gatewayHost = env('AGENT_SANDBOX_K8S_IT_GATEWAY_HOST')
const enabled = env('AGENT_SANDBOX_K8S_IT') === '1' && Boolean(apiUrl && namespace && image)
const itNodeSelector = parseK8sNodeSelector(env('AGENT_SANDBOX_K8S_IT_NODE_SELECTOR'))
/** 这批用例自己的实例标识：只清自己建的 Pod */
const instance = `it-${process.pid}`

let kube: KubeClient

function k8sDriver(extra: Partial<K8sDriverOptions> = {}) {
  const output: string[] = []
  const handles: K8sSandboxHandle[] = []
  const base = createK8sDriver({
    kube,
    image,
    instance,
    namespace,
    ...(env('AGENT_SANDBOX_K8S_IT_PULL_SECRET') ? { imagePullSecret: env('AGENT_SANDBOX_K8S_IT_PULL_SECRET') } : {}),
    ...(env('AGENT_SANDBOX_K8S_IT_RUNTIME_CLASS') ? { runtimeClassName: env('AGENT_SANDBOX_K8S_IT_RUNTIME_CLASS') } : {}),
    ...(itNodeSelector.ok && Object.keys(itNodeSelector.value).length > 0 ? { nodeSelector: itNodeSelector.value } : {}),
    onOutput: (_runId, _stream, line) => output.push(line),
    ...extra,
  })
  const driver: SandboxDriver = {
    name: base.name,
    reap: (live) => base.reap(live),
    async start(spec) {
      const handle = (await base.start(spec)) as K8sSandboxHandle
      handles.push(handle)
      return handle
    },
  }
  return { base, driver, output, handles }
}

function itSpec(runId: string) {
  return {
    runId,
    flowId: 'it_flow',
    ownerId: 'it',
    grantId: 'it',
    image,
    resources: { cpu: 0.5, memoryMiB: 256, pids: 64, diskMiB: 32, deadlineMs: 120_000 },
    gatewayUrl: 'http://unused.invalid/api/agent-gateway',
    credential: { kind: 'bootstrap' as const, token: 'unused' },
  }
}

const getPod = (name: string) => kube.json<PodObject & { spec: any }>('GET', `/api/v1/namespaces/${namespace}/pods/${name}`)
const podGone = (name: string) =>
  getPod(name).then(
    () => false,
    (err: { status?: number }) => err.status === 404,
  )

async function until(check: () => boolean | Promise<boolean>, ms = 60_000) {
  for (const started = Date.now(); !(await check()); ) {
    if (Date.now() - started > ms) throw new Error('等不到')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

describe.skipIf(!enabled)('k8s 驱动：真实集群（AGENT_SANDBOX_K8S_IT=1）', () => {
  beforeAll(() => {
    // 只用显式给的值：不读 KUBERNETES_SERVICE_HOST，也没有 ServiceAccount 文件的默认位置
    const connection = kubeConnection({ apiUrl, tokenFile: env('AGENT_SANDBOX_K8S_IT_TOKEN_FILE'), caFile: env('AGENT_SANDBOX_K8S_IT_CA_FILE') }, {})
    if (!connection.ok) throw new Error(connection.reason)
    kube = createKubeClient(connection.value)
  })

  afterAll(async () => {
    if (!kube) return
    // 兜底：这批用例的实例标识下还剩的 Pod 一律删掉
    const selector = encodeURIComponent(`${K8S_LABELS.instance}=${instance}`)
    const list = await kube.json<{ items?: PodObject[] }>('GET', `/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}`)
    for (const pod of list?.items ?? []) {
      await kube.json('DELETE', `/api/v1/namespaces/${namespace}/pods/${pod.metadata!.name}`, { gracePeriodSeconds: 0 }).catch(() => undefined)
    }
    kube.destroy()
  })

  it('自检通过：连得上、有权限、命名空间在、沙箱 Pod 的规格过得了准入', async () => {
    const check = await k8sDriver().base.check()
    expect(check.problems, check.warnings.join('\n')).toEqual([])
  }, 60_000)

  it('跑一个探针：环境里只有那三个 + k8s / 运行时自己加的（没有服务端的任何东西）；结束即删 Pod', async () => {
    const probe = k8sDriver({ command: ['node', '-e', 'console.log("ENV " + Object.keys(process.env).sort().join(","))'] })
    const handle = (await probe.base.start(itSpec('it_env'))) as K8sSandboxHandle
    expect(await handle.wait(), probe.output.join('\n')).toEqual({ exitCode: 0 })
    const names = probe.output.find((line) => line.startsWith('ENV '))!.slice(4).split(',')
    // kubelet 无条件注入 default 命名空间 kubernetes Service 的地址（enableServiceLinks: false 也去不掉）；运行时加 HOSTNAME（可能还有 HOME）
    const platform = (name: string) => name.startsWith('KUBERNETES_') || name === 'HOSTNAME' || name === 'HOME'
    expect(names.filter((name) => !platform(name))).toEqual(['PATH', 'SHADECN_BOOTSTRAP_TOKEN', 'SHADECN_GATEWAY_URL', 'SHADECN_WORKDIR'])
    expect(await podGone(handle.podName)).toBe(true)
  }, 120_000)

  it('运行中的 Pod 带着全部安全字段；kill → 删除（grace 0）后消失，原因原样', async () => {
    const sleeper = k8sDriver({ command: ['node', '-e', 'console.log("up"); setInterval(() => {}, 1000)'] })
    const handle = (await sleeper.base.start(itSpec('it_kill'))) as K8sSandboxHandle
    await until(() => sleeper.output.includes('up'))
    const pod = await getPod(handle.podName)
    expect(pod.spec).toMatchObject({
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: { runAsNonRoot: true, runAsUser: 10001, seccompProfile: { type: 'RuntimeDefault' } },
    })
    expect(pod.spec.containers[0].securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } })
    expect(pod.spec.volumes.some((volume: any) => volume.projected || volume.secret)).toBe(false)
    const at = Date.now()
    await handle.kill('已中止')
    expect(Date.now() - at).toBeLessThan(15_000)
    expect(await handle.wait()).toEqual({ exitCode: null, reason: '已中止' })
    expect(await podGone(handle.podName)).toBe(true)
  }, 120_000)

  it('reap：上一个进程留下的 Pod（同一实例标识）被删；别的实例的（还没过时长上限）不碰', async () => {
    const command = ['node', '-e', 'setInterval(() => {}, 1000)']
    const previous = k8sDriver({ command })
    const orphan = (await previous.base.start(itSpec('it_orphan'))) as K8sSandboxHandle
    const other = k8sDriver({ command, instance: `${instance}-other` })
    const foreign = (await other.base.start(itSpec('it_foreign'))) as K8sSandboxHandle
    try {
      await k8sDriver().base.reap(new Set())
      await until(() => podGone(orphan.podName))
      expect(await podGone(foreign.podName)).toBe(false)
      expect((await orphan.wait()).exitCode).toBeNull()
    } finally {
      await foreign.kill('测试收尾')
    }
  }, 120_000)

  it.skipIf(env('AGENT_SANDBOX_K8S_IT_NETPOL') !== '1')('NetworkPolicy：沙箱连不了外网、解析不了名字、连不了 k8s API', async () => {
    // 只看 TCP 连不连得上（TLS 错误也算「连上了」，所以不用 fetch https）
    const script =
      'const net = require("node:net"); const dns = require("node:dns").promises;' +
      'const tcp = (host, port) => new Promise((done) => { const s = net.connect({ host, port, timeout: 3000 });' +
      ' s.on("connect", () => { s.destroy(); done("OK") }); s.on("timeout", () => { s.destroy(); done("ERR timeout") }); s.on("error", (e) => done("ERR " + e.code)) });' +
      'Promise.all([tcp("1.1.1.1", 80), dns.lookup("kubernetes.default.svc").then(() => "OK").catch((e) => "ERR " + e.code),' +
      ' tcp(process.env.KUBERNETES_SERVICE_HOST, Number(process.env.KUBERNETES_SERVICE_PORT))])' +
      '.then(([internet, dns, api]) => console.log("NET " + JSON.stringify({ internet, dns, api })))'
    const probe = k8sDriver({ command: ['node', '-e', script] })
    const handle = await probe.base.start(itSpec('it_netpol'))
    expect(await handle.wait(), probe.output.join('\n')).toEqual({ exitCode: 0 })
    const result = JSON.parse(probe.output.find((line) => line.startsWith('NET '))!.slice(4)) as Record<string, string>
    expect(result.internet).toMatch(/^ERR /)
    expect(result.dns).toMatch(/^ERR /)
    expect(result.api).toMatch(/^ERR /)
  }, 120_000)

  describe.skipIf(!gatewayHost)('完整一轮（AGENT_SANDBOX_K8S_IT_GATEWAY_HOST）', () => {
    let server: Server

    beforeAll(async () => {
      await attachCollabServer(createServer() as never)
      server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as Server
      await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    })

    afterAll(async () => {
      replaceAgentRuntime(null)
      await flushCollabWrites()
      if (server) await new Promise((resolve) => server.close(resolve))
    })

    beforeEach(async () => {
      await resetDb()
    })

    it('runner 在 Pod 里经网关改了画布，跑完 Pod 删掉', async () => {
      const scripted = registerScriptedModel()
      scripted.setResponses([
        fauxAssistantMessage([fauxText('加一个'), fauxToolCall('add_node', { type: 'text', metadata: { label: 'Pod 里加的' } })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('加好了'),
      ])
      const sandbox = k8sDriver()
      const port = (server.address() as AddressInfo).port
      replaceAgentRuntime(
        createAgentRuntime({
          model: scripted.model,
          driver: sandbox.driver,
          gateway: { url: `http://${gatewayHost}:${port}${AGENT_GATEWAY_PATH}`, secret: TEST_TOKEN_SECRET, upstreamFetch: scripted.fetch },
          sandbox: { image, resources: { cpu: 0.5, memoryMiB: 256, pids: 64, diskMiB: 32 } },
          ...agentHostOptions,
        }),
      )
      const alice = await actor()
      const flowId = await createFlow(alice, await createProject(alice))
      const res = await alice.json(`${agentApiPath(flowId)}/messages`, 'POST', { text: '加一个节点' })
      const events = (await res.text())
        .split('\n\n')
        .map((frame) => frame.trim())
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => JSON.parse(frame.slice('data: '.length)) as AgentStreamEvent)
      expect(events.at(-1), sandbox.output.join('\n')).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
      await flushCollabWrites()
      const doc = new Y.Doc()
      const state = await loadFlowState(roomOf(flowId))
      if (state) Y.applyUpdate(doc, state)
      expect([...nodesMap(doc).values()].map((node) => (node.get('metadata') as Y.Map<unknown>).get('label'))).toEqual(['Pod 里加的'])
      const [handle] = sandbox.handles
      expect(await handle!.wait()).toEqual({ exitCode: 0 })
      expect(await podGone(handle!.podName)).toBe(true)
    }, 180_000)
  })
})
