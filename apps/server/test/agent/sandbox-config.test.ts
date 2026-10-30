import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { K8S_LABELS, OCI_LABELS, PROCESS_DRIVER_REFUSED_IN_PRODUCTION } from '@shadecn/agent/sandbox/drivers'
import { forwardedImports, runnerCommand } from '../../agent/runner-command.ts'

/**
 * 沙箱相关的配置与装配（docs/22 §7）：`AGENT_SANDBOX` 的取值、生产环境拒绝 process 驱动（除非显式放行）、
 * `oci` 驱动的 socket / 网关地址 / 资源上限、`k8s` 驱动的 API 连接 / Pod IP 网关地址 / 自检决定启不启用、
 * 启动自检与清孤儿、令牌密钥的来路、runner 的启动命令。
 * config.ts / agent/index.ts 的值在模块加载时算定，所以每个用例 resetModules 重新 import。
 */

let engineServer: Server | null = null
let engineDir = ''
let kubeServer: Server | null = null

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
  for (const server of [engineServer, kubeServer]) {
    if (!server) continue
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  engineServer = null
  kubeServer = null
  if (engineDir) await rm(engineDir, { recursive: true, force: true })
  engineDir = ''
})

interface EngineRequest {
  method: string
  path: string
}

/** 一个最小的假 Engine API（unix socket）：镜像都不存在、默认网络、给一个本实例的孤儿容器 */
async function fakeEngine(orphanLabels: () => Record<string, string>) {
  engineDir = await mkdtemp(path.join(tmpdir(), 'oci-cfg-'))
  const socketPath = path.join(engineDir, 'engine.sock')
  const requests: EngineRequest[] = []
  engineServer = createServer((req, res) => {
    requests.push({ method: req.method!, path: decodeURIComponent(req.url!) })
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (req.url === '/version') return json(200, { Version: '9.9', ApiVersion: '1.44', Components: [{ Name: 'Fake Engine' }] })
    if (req.url!.startsWith('/images/')) return json(404, { message: 'no such image' })
    if (req.url!.startsWith('/containers/json')) {
      return json(200, [{ Id: 'orphan', Names: ['/shadecn-agent-run_old'], State: 'running', Labels: orphanLabels() }])
    }
    if (req.method === 'DELETE') return res.writeHead(204).end()
    return json(404, { message: 'not found' })
  })
  await new Promise<void>((resolve) => engineServer!.listen(socketPath, resolve))
  return { socketPath, requests }
}

interface KubeRequest {
  method: string
  path: string
  body: any
}

/**
 * 一个最小的假 k8s API（127.0.0.1 上的 http）：版本、SelfSubjectAccessReview（`denied` 里的一律不允许）、
 * 建 Pod（含 dry-run；命名空间不在 `namespaces` 里就 404；privileged 的按准入兜底 403 拒绝，`guard: false` = 没有兜底）、
 * 按 label 列 Pod（给一个孤儿）、删 Pod
 */
async function fakeKube(
  options: { denied?: string[]; namespaces?: string[]; guard?: boolean | (() => boolean); orphanLabels?: () => Record<string, string> } = {},
) {
  const requests: KubeRequest[] = []
  const namespaces = new Set(options.namespaces ?? ['shadecn-agent-sandbox'])
  kubeServer = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined
      const url = new URL(req.url!, 'http://kube')
      requests.push({ method: req.method!, path: decodeURIComponent(url.pathname + url.search), body })
      const json = (status: number, payload: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
      if (url.pathname === '/version') return json(200, { gitVersion: 'v1.31.0' })
      if (url.pathname.endsWith('/selfsubjectaccessreviews')) {
        const a = body.spec.resourceAttributes
        const key = `${a.verb} ${a.resource}${a.subresource ? `/${a.subresource}` : ''}`
        const allowed = !['get secrets', 'create pods/exec', ...(options.denied ?? [])].includes(key)
        return json(201, { status: { allowed } })
      }
      const ns = /^\/api\/v1\/namespaces\/([^/]+)\/pods/.exec(url.pathname)?.[1] ?? ''
      if (req.method === 'POST') {
        if (!namespaces.has(ns)) return json(404, { kind: 'Status', reason: 'NotFound', message: `namespaces "${ns}" not found`, code: 404 })
        const privileged = (body.spec.containers as { securityContext?: { privileged?: boolean } }[]).some((c) => c.securityContext?.privileged)
        const guarded = typeof options.guard === 'function' ? options.guard() : options.guard !== false
        if (privileged && guarded) {
          return json(403, { kind: 'Status', reason: 'Forbidden', message: `pods "${body.metadata.name}" is forbidden: privileged`, code: 403 })
        }
        return json(201, { ...body, metadata: { ...body.metadata, uid: 'uid-new', resourceVersion: '1' }, status: { phase: 'Pending' } })
      }
      if (req.method === 'GET' && url.searchParams.has('labelSelector')) {
        const labels = options.orphanLabels?.() ?? {}
        return json(200, { items: [{ metadata: { name: 'shadecn-agent-run-old', uid: 'uid-old', labels }, spec: { activeDeadlineSeconds: 660 }, status: { phase: 'Running' } }] })
      }
      if (req.method === 'DELETE') return json(200, {})
      return json(404, { kind: 'Status', reason: 'NotFound', message: 'not found', code: 404 })
    })
  })
  await new Promise<void>((resolve) => kubeServer!.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(kubeServer.address() as AddressInfo).port}`, requests }
}

/** 指向假 API 的 k8s 环境：不在集群里（没有 KUBERNETES_SERVICE_HOST），不带 token（像 kubectl proxy） */
function k8sEnv(apiUrl: string, extra: Record<string, string> = {}) {
  return {
    AGENT_SANDBOX: 'k8s',
    KUBERNETES_SERVICE_HOST: '',
    AGENT_SANDBOX_K8S_API_URL: apiUrl,
    AGENT_SANDBOX_K8S_TOKEN_FILE: '',
    AGENT_SANDBOX_K8S_PULL_POLICY: '',
    AGENT_SANDBOX_K8S_NODE_SELECTOR: '',
    AGENT_SANDBOX_IMAGE: 'registry.example/agent-sandbox:1',
    POD_IP: '10.2.3.4',
    PORT: '3100',
    ...extra,
  }
}

async function until(check: () => boolean, ms = 5000) {
  for (const started = Date.now(); !check(); ) {
    if (Date.now() - started > ms) throw new Error('等不到')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function loadConfig() {
  vi.resetModules()
  return import('../../config.ts')
}

describe('AGENT_SANDBOX / AGENT_TOKEN_SECRET', () => {
  it('不配 = process；local（一期的取值）= process + 媒体工具；oci / k8s 原样；不认识的带着原值', async () => {
    vi.stubEnv('AGENT_SANDBOX', '')
    expect((await loadConfig()).agentConfig).toMatchObject({ sandbox: 'process', sandboxExec: false })
    vi.stubEnv('AGENT_SANDBOX', 'local')
    expect((await loadConfig()).agentConfig).toMatchObject({ sandbox: 'process', sandboxExec: true })
    vi.stubEnv('AGENT_SANDBOX', 'oci')
    expect((await loadConfig()).agentConfig.sandbox).toBe('oci')
    vi.stubEnv('AGENT_SANDBOX', 'k8s')
    expect((await loadConfig()).agentConfig.sandbox).toBe('k8s')
    vi.stubEnv('AGENT_SANDBOX', 'docker')
    expect((await loadConfig()).agentConfig.sandbox).toEqual({ unknown: 'docker' })
  })

  it('令牌密钥：显式的优先；否则由 SESSION_SECRET 派生（不等于它本身）；网关地址默认本机回环 + PORT', async () => {
    vi.stubEnv('AGENT_TOKEN_SECRET', 'explicit')
    expect((await loadConfig()).agentConfig.tokenSecret).toBe('explicit')
    vi.stubEnv('AGENT_TOKEN_SECRET', '')
    vi.stubEnv('SESSION_SECRET', 'session-secret')
    const derived = (await loadConfig()).agentConfig.tokenSecret
    expect(derived).not.toBe('session-secret')
    expect(derived).toBe((await loadConfig()).agentConfig.tokenSecret)
    vi.stubEnv('HOST', '0.0.0.0')
    vi.stubEnv('PORT', '3100')
    expect((await loadConfig()).agentConfig.gatewayUrl).toBe('http://127.0.0.1:3100')
  })

  it('oci：网关地址默认是引擎给容器的宿主名（容器里的回环是它自己）；显式配置优先', async () => {
    vi.stubEnv('PORT', '3100')
    vi.stubEnv('AGENT_SANDBOX', 'oci')
    expect((await loadConfig()).agentConfig.gatewayUrl).toBe('http://host.docker.internal:3100')
    vi.stubEnv('AGENT_GATEWAY_URL', 'http://shadecn:3000/')
    expect((await loadConfig()).agentConfig.gatewayUrl).toBe('http://shadecn:3000')
  })

  it('k8s：网关地址默认是本 Pod 的 IP（Downward API 的 POD_IP，IPv6 加方括号）—— 沙箱要连回发起它的副本；没有 POD_IP 就是空；显式配置优先', async () => {
    vi.stubEnv('PORT', '3100')
    vi.stubEnv('AGENT_SANDBOX', 'k8s')
    vi.stubEnv('POD_IP', '10.2.3.4')
    expect((await loadConfig()).agentConfig.gatewayUrl).toBe('http://10.2.3.4:3100')
    vi.stubEnv('POD_IP', 'fd00::5')
    expect((await loadConfig()).agentConfig.gatewayUrl).toBe('http://[fd00::5]:3100')
    vi.stubEnv('POD_IP', '')
    expect((await loadConfig()).agentConfig.gatewayUrl).toBe('')
    vi.stubEnv('AGENT_GATEWAY_URL', 'http://shadecn-0.shadecn-headless.dev.svc:3000')
    expect((await loadConfig()).agentConfig.gatewayUrl).toBe('http://shadecn-0.shadecn-headless.dev.svc:3000')
  })

  it('k8s 的配置项：命名空间 / RuntimeClass / 拉镜像的 Secret / 拉取策略 / nodeSelector / API 地址；token、CA 文件不配 = 默认位置，配成空 = 不用', async () => {
    expect((await loadConfig()).agentConfig.k8s).toEqual({
      namespace: '',
      runtimeClass: '',
      pullSecret: '',
      pullPolicy: '',
      nodeSelector: '',
      apiUrl: '',
      tokenFile: undefined,
      caFile: undefined,
    })
    vi.stubEnv('AGENT_SANDBOX_K8S_NAMESPACE', 'agents')
    vi.stubEnv('AGENT_SANDBOX_K8S_RUNTIME_CLASS', 'gvisor')
    vi.stubEnv('AGENT_SANDBOX_K8S_PULL_SECRET', 'harbor-pull-secret')
    vi.stubEnv('AGENT_SANDBOX_K8S_PULL_POLICY', 'IfNotPresent')
    vi.stubEnv('AGENT_SANDBOX_K8S_NODE_SELECTOR', ' kubernetes.io/arch=arm64 ')
    vi.stubEnv('AGENT_SANDBOX_K8S_API_URL', 'http://127.0.0.1:8001')
    vi.stubEnv('AGENT_SANDBOX_K8S_TOKEN_FILE', '')
    vi.stubEnv('AGENT_SANDBOX_K8S_CA_FILE', '/etc/k8s/ca.crt')
    expect((await loadConfig()).agentConfig.k8s).toEqual({
      namespace: 'agents',
      runtimeClass: 'gvisor',
      pullSecret: 'harbor-pull-secret',
      pullPolicy: 'IfNotPresent',
      nodeSelector: 'kubernetes.io/arch=arm64',
      apiUrl: 'http://127.0.0.1:8001',
      tokenFile: '',
      caFile: '/etc/k8s/ca.crt',
    })
  })

  it('沙箱的镜像 / 网络 / 资源上限：有默认值，可配；配坏了（非正数、不是数）退回默认', async () => {
    expect((await loadConfig()).agentConfig).toMatchObject({
      sandboxImage: 'shadecn-agent-sandbox:latest',
      ociNetwork: 'bridge',
      sandboxRuntime: '',
      sandboxResources: { cpu: 1, memoryMiB: 512, pids: 128, diskMiB: 512 },
    })
    vi.stubEnv('AGENT_SANDBOX_IMAGE', 'registry.example/agent-sandbox:1')
    vi.stubEnv('AGENT_SANDBOX_OCI_NETWORK', 'agent-internal')
    vi.stubEnv('AGENT_SANDBOX_RUNTIME', 'runsc')
    vi.stubEnv('AGENT_SANDBOX_CPUS', '0.5')
    vi.stubEnv('AGENT_SANDBOX_MEMORY_MIB', '1024')
    vi.stubEnv('AGENT_SANDBOX_PIDS', '-1')
    vi.stubEnv('AGENT_SANDBOX_DISK_MIB', 'lots')
    expect((await loadConfig()).agentConfig).toMatchObject({
      sandboxImage: 'registry.example/agent-sandbox:1',
      ociNetwork: 'agent-internal',
      sandboxRuntime: 'runsc',
      sandboxResources: { cpu: 0.5, memoryMiB: 1024, pids: 128, diskMiB: 512 },
    })
  })
})

describe('装配', () => {
  async function runtimeWith(env: Record<string, string>) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    vi.resetModules()
    const { agentRuntime } = await import('../../agent/index.ts')
    return agentRuntime()
  }

  // ollama 预设不要 key：模型这一关一定过，测的是驱动那一关
  const ollama = { AGENT_PROVIDER: 'ollama', AGENT_MODEL: 'qwen3', AGENT_BASE_URL: '' }

  it('开发环境：process 驱动，启用', async () => {
    const runtime = await runtimeWith({ ...ollama, AGENT_SANDBOX: 'process' })
    expect(runtime.enabled).toBe(true)
  })

  it('NODE_ENV=production：process 驱动不放行就未启用，原因写明；AGENT_SANDBOX_ALLOW_PROCESS=1 才启用', async () => {
    const refused = await runtimeWith({ ...ollama, NODE_ENV: 'production', AGENT_SANDBOX: 'process' })
    expect(refused.enabled).toBe(false)
    expect(refused.disabledReason).toBe(PROCESS_DRIVER_REFUSED_IN_PRODUCTION)

    const allowed = await runtimeWith({ ...ollama, NODE_ENV: 'production', AGENT_SANDBOX: 'process', AGENT_SANDBOX_ALLOW_PROCESS: '1' })
    expect(allowed.enabled).toBe(true)
  })

  it('oci：生产环境照常启用（不受 process 驱动的拒绝限制）；socket 找不到 → 未启用，原因写明该配哪一项', async () => {
    const { socketPath } = await fakeEngine(() => ({}))
    const enabled = await runtimeWith({ ...ollama, NODE_ENV: 'production', AGENT_SANDBOX: 'oci', AGENT_SANDBOX_OCI_SOCKET: socketPath })
    expect(enabled.enabled).toBe(true)

    const missing = await runtimeWith({
      ...ollama,
      NODE_ENV: 'production',
      AGENT_SANDBOX: 'oci',
      AGENT_SANDBOX_OCI_SOCKET: path.join(engineDir, 'gone.sock'),
    })
    expect(missing.enabled).toBe(false)
    expect(missing.disabledReason).toContain('AGENT_SANDBOX_OCI_SOCKET')
  })

  it('oci 启动：自检告警（镜像不存在、默认网络可以出网），并清掉本实例的孤儿容器（按 instance label 列）', async () => {
    let instance = ''
    const engine = await fakeEngine(() => ({ [OCI_LABELS.managed]: 'true', [OCI_LABELS.instance]: instance, [OCI_LABELS.run]: 'run_old' }))
    for (const [key, value] of Object.entries({ AGENT_SANDBOX: 'oci', AGENT_SANDBOX_OCI_SOCKET: engine.socketPath, PORT: '3100' })) {
      vi.stubEnv(key, value)
    }
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const agent = await import('../../agent/index.ts')
    instance = agent.agentSandboxInstance
    expect(agent.agentGatewayUrl).toBe('http://host.docker.internal:3100/api/agent-gateway')

    const stop = agent.startAgentSandboxReaper()
    try {
      await until(() => engine.requests.some((request) => request.method === 'DELETE'))
    } finally {
      stop()
    }
    const warnings = warn.mock.calls.flat().join('\n')
    expect(warnings).toContain('镜像 shadecn-agent-sandbox:latest 不存在')
    expect(warnings).toMatch(/oci 沙箱可以出网：网络 bridge 不是 internal/)
    const list = engine.requests.find((request) => request.path.startsWith('/containers/json'))!
    expect(list.path).toContain(`"${OCI_LABELS.managed}=true","${OCI_LABELS.instance}=${instance}"`)
    expect(engine.requests.find((request) => request.method === 'DELETE')!.path).toMatch(/^\/containers\/orphan\?force=true/)
  })

  it('process 驱动：启动时不碰任何容器引擎（reap 是空操作）', async () => {
    const engine = await fakeEngine(() => ({}))
    vi.stubEnv('AGENT_SANDBOX', 'process')
    vi.stubEnv('AGENT_SANDBOX_OCI_SOCKET', engine.socketPath)
    vi.stubEnv('DOCKER_HOST', `unix://${engine.socketPath}`)
    vi.resetModules()
    const agent = await import('../../agent/index.ts')
    const stop = agent.startAgentSandboxReaper()
    await new Promise((resolve) => setTimeout(resolve, 200))
    stop()
    expect(engine.requests).toEqual([])
  })

  it('不认识的驱动：未启用，原因写明（k8s 已经是可选值）', async () => {
    const unknown = (await runtimeWith({ ...ollama, AGENT_SANDBOX: 'docker' })).disabledReason
    expect(unknown).toContain('AGENT_SANDBOX=docker')
    expect(unknown).toContain('process / oci / k8s')
  })

  it('k8s 建不起来：没有 POD_IP（连不回发起的副本）/ 不在集群里又没配 API 地址 / 拉取策略认不出 / nodeSelector 格式错 / http 不是回环 → 未启用，原因写明该配哪一项', async () => {
    const base = k8sEnv('http://127.0.0.1:1')
    expect((await runtimeWith({ ...ollama, ...base, POD_IP: '' })).disabledReason).toMatch(/POD_IP（fieldRef: status\.podIP）.*AGENT_GATEWAY_URL/)
    expect((await runtimeWith({ ...ollama, ...base, AGENT_SANDBOX_K8S_API_URL: '' })).disabledReason).toContain('没配 AGENT_SANDBOX_K8S_API_URL')
    expect((await runtimeWith({ ...ollama, ...base, AGENT_SANDBOX_K8S_PULL_POLICY: 'Sometimes' })).disabledReason).toContain('AGENT_SANDBOX_K8S_PULL_POLICY=Sometimes')
    expect((await runtimeWith({ ...ollama, ...base, AGENT_SANDBOX_K8S_NODE_SELECTOR: 'kubernetes.io/arch:arm64' })).disabledReason).toBe(
      'AGENT_SANDBOX_K8S_NODE_SELECTOR 的「kubernetes.io/arch:arm64」不是 key=value（多项用逗号分隔，如 kubernetes.io/arch=arm64）',
    )
    expect((await runtimeWith({ ...ollama, ...base, AGENT_SANDBOX_K8S_NODE_SELECTOR: 'kubernetes.io/arch=arm64,kubernetes.io/arch=amd64' })).disabledReason).toContain(
      'kubernetes.io/arch 出现了不止一次',
    )
    expect((await runtimeWith({ ...ollama, ...base, AGENT_SANDBOX_K8S_API_URL: 'http://10.0.0.1:6443' })).disabledReason).toContain('http:// 只许回环地址')
    // 集群内的默认（KUBERNETES_SERVICE_HOST + ServiceAccount 的 CA）：这台机器上没有那个 CA 文件
    const inCluster = await runtimeWith({ ...ollama, ...base, AGENT_SANDBOX_K8S_API_URL: '', KUBERNETES_SERVICE_HOST: '10.96.0.1' })
    expect(inCluster.disabledReason).toMatch(/读不到 k8s API 的 CA 证书（\/var\/run\/secrets\/kubernetes\.io\/serviceaccount\/ca\.crt/)
  })

  it('k8s 启动：自检通过 → 启用（生产照常），清掉本实例的孤儿 Pod（按 managed label 列、grace 0 删）', async () => {
    let instance = ''
    const kube = await fakeKube({ orphanLabels: () => ({ [K8S_LABELS.managed]: 'true', [K8S_LABELS.instance]: instance, [K8S_LABELS.run]: 'run_old' }) })
    const env = { ...ollama, ...k8sEnv(kube.url), NODE_ENV: 'production', HOST: '0.0.0.0', AGENT_SANDBOX_K8S_NODE_SELECTOR: 'kubernetes.io/arch=arm64' }
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const agent = await import('../../agent/index.ts')
    instance = agent.agentSandboxInstance
    expect(agent.agentGatewayUrl).toBe('http://10.2.3.4:3100/api/agent-gateway')

    const stop = agent.startAgentSandboxReaper()
    try {
      await until(() => kube.requests.some((request) => request.method === 'DELETE'))
    } finally {
      stop()
    }
    expect(agent.agentRuntime().enabled).toBe(true)
    expect(info.mock.calls.flat().join('\n')).toMatch(/k8s 沙箱：Kubernetes v1\.31\.0（http:\/\/127\.0\.0\.1:\d+），命名空间 shadecn-agent-sandbox，镜像 registry\.example\/agent-sandbox:1/)
    // 没配 RuntimeClass：告警「不是 gVisor」
    expect(warn.mock.calls.flat().join('\n')).toContain('没有配 RuntimeClass')
    const dryRun = kube.requests.find((request) => request.method === 'POST' && request.path.endsWith('?dryRun=All'))!
    expect(dryRun.path).toMatch(/^\/api\/v1\/namespaces\/shadecn-agent-sandbox\/pods/)
    expect(dryRun.body.spec.containers[0].env.find((entry: { name: string }) => entry.name === 'SHADECN_GATEWAY_URL').value).toBe('http://dry-run.invalid/api/agent-gateway')
    // AGENT_SANDBOX_K8S_NODE_SELECTOR 进了 Pod 规格（自检的 dry-run 和真建的是同一份规格）
    expect(dryRun.body.spec.nodeSelector).toEqual({ 'kubernetes.io/arch': 'arm64' })
    // 准入兜底的反例（privileged）也 dry-run 过，并且被拒了（否则不会启用）
    expect(kube.requests.some((request) => request.path.endsWith('?dryRun=All') && request.body.spec.containers[0].securityContext.privileged === true)).toBe(true)
    const list = kube.requests.find((request) => request.method === 'GET' && request.path.includes('labelSelector'))!
    expect(list.path).toContain(`labelSelector=${K8S_LABELS.managed}=true`)
    expect(kube.requests.find((request) => request.method === 'DELETE')).toMatchObject({
      path: '/api/v1/namespaces/shadecn-agent-sandbox/pods/shadecn-agent-run-old',
      body: { gracePeriodSeconds: 0, preconditions: { uid: 'uid-old' } },
    })
  })

  it('k8s 运行中：每次清孤儿前都重查自检 —— 准入兜底被拿掉（VAP 被删）这一轮就停用、装回去就恢复；结论不变不重复打详情', async () => {
    let guard = true
    const kube = await fakeKube({ namespaces: ['dev'], guard: () => guard })
    for (const [key, value] of Object.entries({ ...ollama, ...k8sEnv(kube.url), AGENT_SANDBOX_K8S_NAMESPACE: 'dev' })) vi.stubEnv(key, value)
    vi.resetModules()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const agent = await import('../../agent/index.ts')
    const stop = agent.startAgentSandboxReaper(30)
    try {
      await until(() => kube.requests.filter((request) => request.path.includes('labelSelector')).length >= 2)
      expect(agent.agentRuntime().enabled).toBe(true)
      guard = false
      await until(() => !agent.agentRuntime().enabled)
      expect(agent.agentRuntime().disabledReason).toMatch(/^命名空间 dev 的准入放行了 privileged 的沙箱 Pod/)
      // 停用期间照常重查，但不清孤儿：再等好几轮，列 Pod 的请求一个都没多
      const lists = () => kube.requests.filter((request) => request.path.includes('labelSelector')).length
      const listsWhileDown = lists()
      const checksWhileDown = kube.requests.filter((request) => request.path.endsWith('/version')).length
      await until(() => kube.requests.filter((request) => request.path.endsWith('/version')).length >= checksWhileDown + 4)
      expect(lists()).toBe(listsWhileDown)
      guard = true
      await until(() => agent.agentRuntime().enabled)
      await until(() => lists() > listsWhileDown)
    } finally {
      stop()
    }
    // 详情：第一次、停用、恢复各一行；中间几十次结论不变的重查不打
    expect(info.mock.calls.flat().filter((line) => String(line).includes('k8s 沙箱：Kubernetes'))).toHaveLength(3)
    expect(error.mock.calls.flat().filter((line) => String(line).includes('k8s 沙箱不可用'))).toHaveLength(1)
    expect(info.mock.calls.flat()).toContain('[agent] k8s 沙箱自检通过，agent 恢复启用')
  })

  it('k8s 启动：自检没过（缺权限 / 命名空间不存在 / 准入放行了 privileged / API 连不上）→ agent 未启用、原因写明，起 Pod 也拒绝；不清孤儿', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    async function startWith(env: Record<string, string>) {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
      vi.resetModules()
      const agent = await import('../../agent/index.ts')
      // 先建好 runtime（自检还没查完时它是启用的），再开始自检：查完没过要把它换成未启用
      expect(agent.agentRuntime().enabled).toBe(true)
      const stop = agent.startAgentSandboxReaper()
      await until(() => !agent.agentRuntime().enabled)
      stop()
      return agent
    }

    const denied = await fakeKube({ denied: ['create pods', 'get pods/log'] })
    const noRbac = await startWith({ ...ollama, ...k8sEnv(denied.url) })
    expect(noRbac.agentRuntime().disabledReason).toBe(
      '服务端的 ServiceAccount 在命名空间 shadecn-agent-sandbox 缺少权限：create pods、get pods/log（Role 见 k8s/agent-sandbox.yaml）',
    )
    expect(error.mock.calls.flat().join('\n')).toContain('k8s 沙箱不可用（agent 未启用）')
    expect(denied.requests.some((request) => request.method === 'DELETE' || request.path.includes('labelSelector'))).toBe(false)
    kubeServer!.closeAllConnections()
    await new Promise((resolve) => kubeServer!.close(resolve))

    // dev 这种共用命名空间没有 Pod Security，VAP 又没 apply：privileged 的反例被放行 → 不启用
    const unguarded = await fakeKube({ namespaces: ['dev'], guard: false })
    const noGuard = await startWith({ ...ollama, ...k8sEnv(unguarded.url), AGENT_SANDBOX_K8S_NAMESPACE: 'dev' })
    expect(noGuard.agentRuntime().disabledReason).toMatch(/^命名空间 dev 的准入放行了 privileged 的沙箱 Pod（dry-run）.*k8s\/variants\/agent-sandbox-vap\.yaml/)
    expect(unguarded.requests.some((request) => request.method === 'DELETE' || request.path.includes('labelSelector'))).toBe(false)
    kubeServer!.closeAllConnections()
    await new Promise((resolve) => kubeServer!.close(resolve))

    const missing = await fakeKube({ namespaces: [] })
    const noNs = await startWith({ ...ollama, ...k8sEnv(missing.url), AGENT_SANDBOX_K8S_NAMESPACE: 'agents' })
    expect(noNs.agentRuntime().disabledReason).toContain('沙箱命名空间 agents 不存在')
    kubeServer!.closeAllConnections()
    await new Promise((resolve) => kubeServer!.close(resolve))
    kubeServer = null

    const gone = await startWith({ ...ollama, ...k8sEnv(missing.url) })
    expect(gone.agentRuntime().disabledReason).toMatch(/^k8s 沙箱自检失败：连不上 k8s API（http:\/\/127\.0\.0\.1:\d+：ECONNREFUSED）/)
  })
})

describe('runner 的启动命令', () => {
  it('源码态：node --import <tsx 的 loader> <packages/agent/src/runner/main.ts>', () => {
    const [node, flag, loader, main] = runnerCommand()
    expect(node).toBe(process.execPath)
    expect(flag).toBe('--import')
    expect(loader).toMatch(/^file:\/\/.*tsx\/dist\/loader\.mjs$/)
    expect(main).toMatch(/packages\/agent\/src\/runner\/main\.ts$/)
  })

  it('产物态转发 --import（本地 pnpm start 的解析钩子），相对路径按 cwd 换成绝对的；别的参数（--inspect…）不带', () => {
    expect(
      forwardedImports(['--inspect', '--import', './apps/server/scripts/local-start.mjs', '--import=file:///x.mjs', '--max-old-space-size=100'], '/repo'),
    ).toEqual(['--import', '/repo/apps/server/scripts/local-start.mjs', '--import=file:///x.mjs'])
  })
})
