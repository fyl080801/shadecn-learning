import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SandboxSpec } from '../../src/sandbox/driver.ts'
import {
  createK8sDriver,
  K8S_LABELS,
  K8S_RUN_WORKDIR,
  k8sPodExit,
  k8sPodName,
  k8sPodSpec,
  k8sPrivilegedPodSpec,
  k8sRunnerEnv,
  parseK8sNodeSelector,
  type K8sDriverOptions,
  type K8sSandboxHandle,
  type PodObject,
} from '../../src/sandbox/drivers/k8s.ts'
import {
  createKubeClient,
  createLineSplitter,
  kubeConnection,
  SERVICE_ACCOUNT_CA_FILE,
  SERVICE_ACCOUNT_TOKEN_FILE,
  type KubeClient,
} from '../../src/sandbox/drivers/kube.ts'

/**
 * `k8s` 驱动（docs/22 §7.5）对着一个**假的 Kubernetes API**（测试里在 127.0.0.1 上起的 http server）测：
 * Pod 规格里的每个安全字段、环境变量只有那三个、label、资源换算、`activeDeadlineSeconds`、删除的先后与 grace 0、
 * `wait()` 在删除之后才兑现、Pending 超时、OOMKilled / DeadlineExceeded 的映射、日志限量、`reap` 只删该删的、
 * API 失联有上限、token 文件每次重读、自检失败的错误。真集群上的一轮在 apps/server 的 `sandbox-k8s.test.ts`（默认跳过）。
 */

const NS = 'sandbox-ns'

interface Recorded {
  method: string
  path: string
  auth: string | undefined
  body: any
}

interface FakePod {
  object: Record<string, any>
  logs: string[]
  followers: ServerResponse[]
  /** 日志跟随被客户端断开过 */
  followerClosed: boolean
}

const json = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) return void res.writeHead(status).end()
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}
const status = (res: ServerResponse, code: number, reason: string, message: string) =>
  json(res, code, { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason, message, code })

class FakeKube {
  readonly requests: Recorded[] = []
  readonly pods = new Map<string, FakePod>()
  readonly namespaces = new Set([NS])
  /** SelfSubjectAccessReview：`verb resource` → 允许；没列的 = 不允许 */
  permissions: Record<string, boolean> = {
    'create pods': true,
    'get pods': true,
    'list pods': true,
    'watch pods': true,
    'delete pods': true,
    'get pods/log': true,
  }
  /** 准入（建 Pod 和 dry-run 都过它）：返回错误就拒绝。默认像 Pod Security restricted 那样拒绝 privileged 的容器（准入兜底在） */
  admission: (pod: Record<string, any>) => { code: number; reason: string; message: string } | null = (pod) =>
    (pod.spec?.containers as any[] | undefined)?.some((c) => c.securityContext?.privileged === true)
      ? { code: 403, reason: 'Forbidden', message: `pods "${pod.metadata?.name}" is forbidden: violates PodSecurity "restricted:latest": privileged` }
      : null
  /** 建好之后做什么（默认 10ms 后跑起来） */
  onCreate: (name: string) => void = (name) => setTimeout(() => this.run(name), 10)
  fail: { delete?: number } = {}
  private watchers: { name: string; res: ServerResponse }[] = []
  private readonly deleted = new Set<string>()
  private rv = 100
  private uidSeq = 0
  server: Server | null = null
  port = 0

  get url() {
    return `http://127.0.0.1:${this.port}`
  }

  async listen(port = 0) {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve))
    this.port = (this.server!.address() as AddressInfo).port
  }

  /** 模拟 API 失联：关掉监听、掐掉所有连接（之后的请求 ECONNREFUSED） */
  async stop() {
    if (!this.server) return
    for (const watcher of this.watchers.splice(0)) watcher.res.destroy()
    for (const pod of this.pods.values()) for (const res of pod.followers.splice(0)) res.destroy()
    this.server?.closeAllConnections()
    await new Promise((resolve) => this.server?.close(resolve))
    this.server = null
  }

  find(method: string, pattern: RegExp) {
    return this.requests.find((r) => r.method === method && pattern.test(r.path))
  }

  index(method: string, pattern: RegExp) {
    return this.requests.findIndex((r) => r.method === method && pattern.test(r.path))
  }

  /** 预置一个 Pod（reap 用） */
  seed(name: string, labels: Record<string, string>, extra: { createdAgoMs?: number; deadlineSeconds?: number; phase?: string } = {}) {
    const object = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: NS,
        uid: `uid-${name}`,
        labels,
        resourceVersion: String((this.rv += 1)),
        creationTimestamp: new Date(Date.now() - (extra.createdAgoMs ?? 0)).toISOString(),
      },
      spec: { activeDeadlineSeconds: extra.deadlineSeconds ?? 660 },
      status: { phase: extra.phase ?? 'Running' },
    }
    this.pods.set(name, { object, logs: [], followers: [], followerClosed: false })
  }

  pod(name: string) {
    return this.pods.get(name)!
  }

  setStatus(name: string, next: Record<string, unknown>) {
    const pod = this.pods.get(name)
    if (!pod) return
    pod.object.status = { ...pod.object.status, ...next }
    pod.object.metadata.resourceVersion = String((this.rv += 1))
    this.broadcast(name, { type: 'MODIFIED', object: pod.object })
  }

  run(name: string) {
    this.setStatus(name, {
      phase: 'Running',
      conditions: [{ type: 'PodScheduled', status: 'True' }],
      containerStatuses: [{ name: 'runner', state: { running: { startedAt: new Date().toISOString() } } }],
    })
  }

  exit(name: string, code: number, opts: { reason?: string; podReason?: string; podMessage?: string } = {}) {
    const pod = this.pods.get(name)
    if (!pod) return
    this.setStatus(name, {
      phase: code === 0 && !opts.podReason ? 'Succeeded' : 'Failed',
      ...(opts.podReason ? { reason: opts.podReason, message: opts.podMessage ?? '' } : {}),
      containerStatuses: [
        {
          name: 'runner',
          state: { terminated: { exitCode: code, reason: opts.reason ?? (code === 0 ? 'Completed' : 'Error'), startedAt: new Date().toISOString() } },
        },
      ],
    })
    for (const res of pod.followers.splice(0)) res.end()
  }

  log(name: string, text: string) {
    const pod = this.pods.get(name)!
    pod.logs.push(text)
    for (const res of pod.followers) res.write(text)
  }

  remove(name: string) {
    const pod = this.pods.get(name)
    if (!pod) return
    this.pods.delete(name)
    this.deleted.add(name)
    pod.object.metadata.resourceVersion = String((this.rv += 1))
    this.broadcast(name, { type: 'DELETED', object: pod.object })
    for (const res of pod.followers.splice(0)) res.end()
  }

  /** 所有 watch 收到 410（resourceVersion 太旧）并结束 */
  expireWatches() {
    for (const watcher of this.watchers.splice(0)) {
      watcher.res.end(`${JSON.stringify({ type: 'ERROR', object: { kind: 'Status', code: 410, reason: 'Expired', message: 'too old resource version' } })}\n`)
    }
  }

  private broadcast(name: string, event: unknown) {
    for (const watcher of this.watchers) if (watcher.name === name) watcher.res.write(`${JSON.stringify(event)}\n`)
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? JSON.parse(raw) : undefined
    const url = new URL(req.url!, 'http://kube')
    this.requests.push({ method: req.method!, path: url.pathname + url.search, auth: req.headers.authorization, body })

    if (url.pathname === '/version') return json(res, 200, { major: '1', minor: '31', gitVersion: 'v1.31.2' })
    if (url.pathname === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews') {
      const attrs = body.spec.resourceAttributes
      const key = `${attrs.verb} ${attrs.resource}${attrs.subresource ? `/${attrs.subresource}` : ''}`
      return json(res, 201, { ...body, status: { allowed: this.permissions[key] === true } })
    }
    // /api/v1/namespaces/{ns}/pods[/{name}[/log]]
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 5 || parts.length > 7 || parts.slice(0, 3).join('/') !== 'api/v1/namespaces' || parts[4] !== 'pods' || (parts[6] ?? 'log') !== 'log') {
      return status(res, 404, 'NotFound', `unknown ${url.pathname}`)
    }
    const [, , , ns, , name, sub] = parts
    if (!name) {
      if (req.method === 'POST') {
        if (!this.namespaces.has(ns!)) return status(res, 404, 'NotFound', `namespaces "${ns}" not found`)
        const rejected = this.admission(body)
        if (rejected) return status(res, rejected.code, rejected.reason, rejected.message)
        const podName = body.metadata.name as string
        if (url.searchParams.get('dryRun') === 'All') return json(res, 201, body)
        if (this.pods.has(podName)) return status(res, 409, 'AlreadyExists', `pods "${podName}" already exists`)
        const object = {
          ...body,
          metadata: {
            ...body.metadata,
            uid: `uid-${(this.uidSeq += 1)}`,
            resourceVersion: String((this.rv += 1)),
            creationTimestamp: new Date().toISOString(),
          },
          status: { phase: 'Pending' },
        }
        this.pods.set(podName, { object, logs: [], followers: [], followerClosed: false })
        json(res, 201, object)
        this.onCreate(podName)
        return
      }
      if (url.searchParams.get('watch') === 'true') {
        const watched = /^metadata\.name=(.+)$/.exec(url.searchParams.get('fieldSelector') ?? '')?.[1] ?? ''
        const since = Number(url.searchParams.get('resourceVersion') ?? 0)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.flushHeaders()
        const current = this.pods.get(watched)
        // 补发：从请求的版本之后发生过的变化（假 API 只记最新状态）
        if (current && Number(current.object.metadata.resourceVersion) > since) {
          res.write(`${JSON.stringify({ type: 'MODIFIED', object: current.object })}\n`)
        } else if (!current && this.deleted.has(watched)) {
          res.write(`${JSON.stringify({ type: 'DELETED', object: { metadata: { name: watched } } })}\n`)
        }
        const watcher = { name: watched, res }
        this.watchers.push(watcher)
        res.on('close', () => (this.watchers = this.watchers.filter((entry) => entry !== watcher)))
        return
      }
      const wanted = (url.searchParams.get('labelSelector') ?? '').split(',').filter(Boolean)
      const items = [...this.pods.values()]
        .map((pod) => pod.object)
        .filter((object) =>
          wanted.every((pair) => {
            const [key, value] = pair.split('=')
            return object.metadata.labels?.[key!] === value
          }),
        )
      return json(res, 200, { kind: 'PodList', items })
    }
    const pod = this.pods.get(decodeURIComponent(name))
    if (sub === 'log') {
      if (!pod) return status(res, 404, 'NotFound', `pods "${name}" not found`)
      const state = pod.object.status?.containerStatuses?.[0]?.state
      if (!state?.running && !state?.terminated) {
        return status(res, 400, 'BadRequest', `container "runner" in pod "${name}" is waiting to start: ContainerCreating`)
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      for (const text of pod.logs) res.write(text)
      if (state.running && url.searchParams.get('follow') === 'true') {
        pod.followers.push(res)
        res.on('close', () => {
          if (pod.followers.includes(res)) {
            pod.followerClosed = true
            pod.followers = pod.followers.filter((entry) => entry !== res)
          }
        })
      } else res.end()
      return
    }
    if (req.method === 'DELETE') {
      if (this.fail.delete) return status(res, this.fail.delete, 'InternalError', 'delete failed')
      if (!pod) return status(res, 404, 'NotFound', `pods "${name}" not found`)
      if (body?.preconditions?.uid && body.preconditions.uid !== pod.object.metadata.uid) {
        return status(res, 409, 'Conflict', 'Precondition failed: UID in precondition does not match')
      }
      const object = pod.object
      this.remove(decodeURIComponent(name))
      return json(res, 200, object)
    }
    if (!pod) return status(res, 404, 'NotFound', `pods "${name}" not found`)
    return json(res, 200, pod.object)
  }
}

let dir = ''
let fake: FakeKube | null = null
const clients: KubeClient[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const client of clients.splice(0)) client.destroy()
  await fake?.stop()
  fake = null
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function fakeKube() {
  fake = new FakeKube()
  await fake.listen()
  return fake
}

function client(api: FakeKube, tokenFile: string | null = null) {
  const kube = createKubeClient({ server: api.url, tokenFile, caFile: null })
  clients.push(kube)
  return kube
}

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    runId: 'run_1',
    flowId: 'flow_1',
    ownerId: 'u1',
    grantId: 'g1',
    image: 'registry.example/sandbox:test',
    resources: { cpu: 1.5, memoryMiB: 256, pids: 32, diskMiB: 64, deadlineMs: 30_000 },
    gatewayUrl: 'http://10.1.2.3:3000/api/agent-gateway',
    credential: { kind: 'bootstrap', token: 'one-time-token' },
    ...overrides,
  }
}

function driverOn(api: FakeKube, extra: Partial<K8sDriverOptions> = {}) {
  const lines: { stream: string; line: string }[] = []
  const driver = createK8sDriver({
    kube: client(api),
    image: 'registry.example/sandbox:test',
    instance: 'inst-a',
    namespace: NS,
    onOutput: (_runId, stream, line) => lines.push({ stream, line }),
    retryMs: 20,
    killConfirmMs: 300,
    startTimeoutMs: 400,
    ...extra,
  })
  return { driver, lines }
}

const createdBody = (api: FakeKube) => api.requests.find((r) => r.method === 'POST' && /\/pods$/.test(r.path))!.body as Record<string, any>

async function until(check: () => boolean, ms = 5000) {
  for (const started = Date.now(); !check(); ) {
    if (Date.now() - started > ms) throw new Error('等不到')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('k8s 驱动：Pod 规格', () => {
  it('安全字段：Never 重启、不挂 SA token、不注入 Service 环境、不共享宿主命名空间、非 root + RuntimeDefault、只读根、drop ALL、内存型 emptyDir、requests = limits、activeDeadlineSeconds、label', async () => {
    const api = await fakeKube()
    api.onCreate = (name) => setTimeout(() => api.exit(name, 0), 10)
    const { driver } = driverOn(api)
    const handle = (await driver.start(spec())) as K8sSandboxHandle
    await handle.wait()

    expect(handle.podName).toBe('shadecn-agent-run-1')
    expect(handle.id).toBe(`k8s:${NS}/shadecn-agent-run-1`)
    // toEqual：多一个字段（hostPath、privileged: true、额外的 env、command…）都不行
    expect(createdBody(api)).toEqual({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'shadecn-agent-run-1',
        namespace: NS,
        labels: {
          [K8S_LABELS.managed]: 'true',
          [K8S_LABELS.run]: 'run_1',
          [K8S_LABELS.flow]: 'flow_1',
          [K8S_LABELS.grant]: 'g1',
          [K8S_LABELS.instance]: 'inst-a',
        },
      },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        hostNetwork: false,
        hostPID: false,
        hostIPC: false,
        shareProcessNamespace: false,
        terminationGracePeriodSeconds: 1,
        activeDeadlineSeconds: 30,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 10001,
          runAsGroup: 10001,
          fsGroup: 10001,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: 'runner',
            image: 'registry.example/sandbox:test',
            env: [
              { name: 'SHADECN_GATEWAY_URL', value: 'http://10.1.2.3:3000/api/agent-gateway' },
              { name: 'SHADECN_BOOTSTRAP_TOKEN', value: 'one-time-token' },
              { name: 'SHADECN_WORKDIR', value: '/work/run' },
            ],
            workingDir: '/work',
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              privileged: false,
              capabilities: { drop: ['ALL'] },
            },
            resources: {
              requests: { cpu: '1500m', memory: '256Mi', 'ephemeral-storage': '128Mi' },
              limits: { cpu: '1500m', memory: '256Mi', 'ephemeral-storage': '128Mi' },
            },
            volumeMounts: [
              { name: 'work', mountPath: '/work' },
              { name: 'tmp', mountPath: '/tmp' },
            ],
          },
        ],
        volumes: [
          { name: 'work', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
          { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
        ],
      },
    })
  })

  it('环境变量只有网关地址、一次性 token、工作目录三个；服务端进程里的密钥一个都不进请求', async () => {
    vi.stubEnv('AGENT_API_KEY', 'sk-should-not-leak')
    vi.stubEnv('DATABASE_URL', 'postgresql://secret@db/app')
    vi.stubEnv('SESSION_SECRET', 'session-secret')
    vi.stubEnv('REDIS_URL', 'redis://:pw@redis:6379')
    const api = await fakeKube()
    api.onCreate = (name) => setTimeout(() => api.exit(name, 0), 10)
    const { driver } = driverOn(api)
    await (await driver.start(spec())).wait()

    const env = createdBody(api).spec.containers[0].env as { name: string }[]
    expect(env.map((entry) => entry.name).sort()).toEqual(['SHADECN_BOOTSTRAP_TOKEN', 'SHADECN_GATEWAY_URL', 'SHADECN_WORKDIR'])
    expect(env).toEqual(k8sRunnerEnv(spec()))
    expect(env).toContainEqual({ name: 'SHADECN_WORKDIR', value: K8S_RUN_WORKDIR })
    expect(JSON.stringify(api.requests)).not.toMatch(/sk-should-not-leak|secret@db|session-secret|redis:/)
  })

  it('可选项：RuntimeClass（gVisor）、nodeSelector、拉镜像的 Secret、拉取策略、覆盖入口；资源换算（小数核 → millicores，ephemeral-storage 可调）', async () => {
    const api = await fakeKube()
    api.onCreate = (name) => setTimeout(() => api.exit(name, 0), 10)
    const { driver } = driverOn(api, {
      runtimeClassName: 'gvisor',
      nodeSelector: { 'kubernetes.io/arch': 'arm64', pool: 'agents' },
      imagePullSecret: 'harbor-pull-secret',
      imagePullPolicy: 'IfNotPresent',
      command: ['node', '-e', '0'],
      ephemeralStorageMiB: 32,
    })
    await (await driver.start(spec({ resources: { cpu: 0.25, memoryMiB: 1024.7, pids: 1, diskMiB: 300, deadlineMs: 61_500 } }))).wait()
    const body = createdBody(api)
    expect(body.spec).toMatchObject({
      runtimeClassName: 'gvisor',
      nodeSelector: { 'kubernetes.io/arch': 'arm64', pool: 'agents' },
      imagePullSecrets: [{ name: 'harbor-pull-secret' }],
      activeDeadlineSeconds: 62,
      volumes: [{ emptyDir: { sizeLimit: '300Mi' } }, { emptyDir: { sizeLimit: '64Mi' } }],
    })
    expect(body.spec.containers[0]).toMatchObject({
      imagePullPolicy: 'IfNotPresent',
      command: ['node', '-e', '0'],
      args: [],
      resources: { limits: { cpu: '250m', memory: '1024Mi', 'ephemeral-storage': '32Mi' } },
    })
  })

  it('Pod 名由 runId 转成 DNS-1123；id 不能做 Pod 名 / label 的拒绝，一个请求都不发', async () => {
    expect(k8sPodName('run_lq3x5k_ab12cd34')).toBe('shadecn-agent-run-lq3x5k-ab12cd34')
    const api = await fakeKube()
    const { driver } = driverOn(api)
    await expect(driver.start(spec({ runId: '../escape' }))).rejects.toThrow('label')
    await expect(driver.start(spec({ flowId: '_leading' }))).rejects.toThrow('label')
    await expect(driver.start(spec({ grantId: 'x'.repeat(64) }))).rejects.toThrow('label')
    expect(api.requests).toHaveLength(0)
    expect(() => driverOn(api, { namespace: 'Bad_NS' })).toThrow('命名空间')
    expect(() => driverOn(api, { nodeSelector: { 'kubernetes.io/arch': 'arm64 ' } })).toThrow('nodeSelector')
  })

  it('nodeSelector：空 = 不写这个字段；空对象同样不写', () => {
    const base = { image: 'r.example/s:1', instance: 'inst-a' }
    expect(k8sPodSpec(spec(), base).spec).not.toHaveProperty('nodeSelector')
    expect(k8sPodSpec(spec(), { ...base, nodeSelector: {} }).spec).not.toHaveProperty('nodeSelector')
  })

  it('AGENT_SANDBOX_K8S_NODE_SELECTOR 的解析：逗号分隔 key=value、空白忽略、空串 = 不限；格式错写明是哪一项', () => {
    expect(parseK8sNodeSelector('')).toEqual({ ok: true, value: {} })
    expect(parseK8sNodeSelector('  ')).toEqual({ ok: true, value: {} })
    expect(parseK8sNodeSelector(' kubernetes.io/arch = arm64 , node.example.com/pool=agents_1 ')).toEqual({
      ok: true,
      value: { 'kubernetes.io/arch': 'arm64', 'node.example.com/pool': 'agents_1' },
    })
    const reason = (text: string) => {
      const parsed = parseK8sNodeSelector(text)
      return parsed.ok ? '' : parsed.reason
    }
    expect(reason('kubernetes.io/arch')).toContain('「kubernetes.io/arch」不是 key=value')
    expect(reason('=arm64')).toContain('不是 key=value')
    expect(reason('a=b,')).toContain('「」不是 key=value')
    expect(reason('kubernetes.io/arch=')).toContain('值「」不是合法的 label 值')
    expect(reason('arch=arm64/v8')).toContain('值「arm64/v8」不是合法的 label 值')
    expect(reason('arch=a=b')).toContain('值「a=b」')
    expect(reason('Kubernetes.IO/arch=arm64')).toContain('不是合法的 label 键')
    expect(reason('/arch=arm64')).toContain('不是合法的 label 键')
    expect(reason('a/b/c=1')).toContain('不是合法的 label 键')
    expect(reason(`${'x'.repeat(64)}=1`)).toContain('不是合法的 label 键')
    expect(reason(`arch=${'x'.repeat(64)}`)).toContain('不是合法的 label 值')
    expect(reason('arch=arm64,arch=amd64')).toBe('AGENT_SANDBOX_K8S_NODE_SELECTOR 里 arch 出现了不止一次')
  })

  it('准入兜底的反例：和正式规格只差 privileged（+ 允许提权，否则 API 先 422），别的一样', () => {
    const options = { image: 'r.example/s:1', instance: 'inst-a', nodeSelector: { 'kubernetes.io/arch': 'arm64' } }
    const normal = k8sPodSpec(spec(), options, 'p') as any
    const probe = k8sPrivilegedPodSpec(spec(), options, 'p') as any
    expect(probe.spec.containers[0].securityContext).toEqual({ ...normal.spec.containers[0].securityContext, privileged: true, allowPrivilegeEscalation: true })
    probe.spec.containers[0].securityContext = normal.spec.containers[0].securityContext
    expect(probe).toEqual(normal)
  })
})

describe('k8s 驱动：生命周期', () => {
  it('正常退出：watch 跟到终态 → 日志逐行转发 → 删除（grace 0 + uid 前提）→ 确认消失之后 wait() 才兑现', async () => {
    const api = await fakeKube()
    api.onCreate = (name) =>
      setTimeout(() => {
        api.run(name)
        api.log(name, 'hel')
        api.log(name, 'lo\r\nwor')
        api.log(name, 'ld\n')
        setTimeout(() => api.exit(name, 0), 40)
      }, 10)
    const { driver, lines } = driverOn(api)
    const handle = (await driver.start(spec())) as K8sSandboxHandle
    expect(await handle.wait()).toEqual({ exitCode: 0 })

    expect(api.pods.has(handle.podName)).toBe(false)
    const create = api.index('POST', /\/namespaces\/sandbox-ns\/pods$/)
    const watch = api.index('GET', /\/pods\?watch=true&fieldSelector=metadata.name%3Dshadecn-agent-run-1&resourceVersion=\d+&timeoutSeconds=60$/)
    const logs = api.index('GET', /\/pods\/shadecn-agent-run-1\/log\?container=runner&follow=true&limitBytes=\d+$/)
    const remove = api.index('DELETE', /\/pods\/shadecn-agent-run-1$/)
    expect(watch).toBeGreaterThan(create)
    expect(logs).toBeGreaterThan(create)
    expect(remove).toBeGreaterThan(logs)
    expect(api.requests[remove]!.body).toEqual({
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      gracePeriodSeconds: 0,
      preconditions: { uid: 'uid-1' },
    })
    // k8s 的日志接口不分流：一律按 stdout 交
    expect(lines).toEqual([
      { stream: 'stdout', line: 'hello' },
      { stream: 'stdout', line: 'world' },
    ])
  })

  it('kill：删除（grace 0），等它消失才返回；结局带原因；幂等', async () => {
    const api = await fakeKube()
    const { driver } = driverOn(api)
    const handle = (await driver.start(spec())) as K8sSandboxHandle
    await until(() => api.pods.get(handle.podName)?.object.status.phase === 'Running')

    await handle.kill('已中止')
    expect(api.pods.has(handle.podName)).toBe(false)
    expect(api.find('DELETE', /\/pods\/shadecn-agent-run-1$/)!.body).toMatchObject({ gracePeriodSeconds: 0 })
    expect(await handle.wait()).toEqual({ exitCode: null, reason: '已中止' })
    await handle.kill('又一次')
    expect(await handle.wait()).toEqual({ exitCode: null, reason: '已中止' })
    expect(api.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
  })

  it('Pending 超时：调度不了 → 删掉 Pod，原因写明卡在哪', async () => {
    const api = await fakeKube()
    api.onCreate = (name) =>
      api.setStatus(name, {
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/3 nodes are available: 3 Insufficient memory.' }],
      })
    const { driver } = driverOn(api, { startTimeoutMs: 200 })
    const handle = (await driver.start(spec())) as K8sSandboxHandle
    const exit = await handle.wait()
    expect(exit.exitCode).toBeNull()
    expect(exit.reason).toBe('沙箱 Pod 0 秒内没有起来：调度不了（Unschedulable）：0/3 nodes are available: 3 Insufficient memory.')
    expect(api.pods.has(handle.podName)).toBe(false)
  })

  it('Pending 超时：镜像拉不下来 → 原因写明镜像和该查的配置项；不会自己好的（CreateContainerConfigError）当场收尾', async () => {
    const api = await fakeKube()
    api.onCreate = (name) =>
      api.setStatus(name, {
        containerStatuses: [{ name: 'runner', state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "registry.example/sandbox:test"' } } }],
      })
    const { driver } = driverOn(api, { startTimeoutMs: 200 })
    const pulled = await (await driver.start(spec())).wait()
    expect(pulled.reason).toMatch(/没有起来：镜像 registry\.example\/sandbox:test 拉不下来（ImagePullBackOff）.*AGENT_SANDBOX_IMAGE.*AGENT_SANDBOX_K8S_PULL_SECRET/)

    api.onCreate = (name) =>
      setTimeout(
        () =>
          api.setStatus(name, {
            containerStatuses: [{ name: 'runner', state: { waiting: { reason: 'CreateContainerConfigError', message: 'container has runAsNonRoot and image will run as root' } } }],
          }),
        10,
      )
    const { driver: patient } = driverOn(api, { startTimeoutMs: 10_000 })
    const at = Date.now()
    const config = await (await patient.start(spec({ runId: 'run_2' }))).wait()
    expect(Date.now() - at).toBeLessThan(3000)
    expect(config).toEqual({ exitCode: null, reason: expect.stringContaining('沙箱 Pod 起不来（CreateContainerConfigError）：container has runAsNonRoot') })
    expect(api.pods.size).toBe(0)
  })

  it('结局映射：OOMKilled → 内存上限；DeadlineExceeded → 时长上限；Evicted → 被驱逐；128+n → 信号；其余退出码原样', async () => {
    const api = await fakeKube()
    api.onCreate = (name) =>
      setTimeout(() => {
        api.run(name)
        setTimeout(() => api.exit(name, 137, { reason: 'OOMKilled' }), 20)
      }, 10)
    const { driver } = driverOn(api)
    expect(await (await driver.start(spec())).wait()).toEqual({ exitCode: 137, reason: '内存超过上限 256 MiB，被 OOM 结束' })

    const resources = spec().resources
    const terminated = (exitCode: number, reason = 'Error') => ({ containerStatuses: [{ name: 'runner', state: { terminated: { exitCode, reason } } }] })
    const pod = (status: Record<string, unknown>): PodObject => ({ status: { phase: 'Failed', ...status } })
    expect(k8sPodExit(pod({ reason: 'DeadlineExceeded', message: 'Pod was active on the node longer than the specified deadline', ...terminated(137) }), resources)).toEqual({
      exitCode: null,
      reason: '超过沙箱时长上限 30 秒（activeDeadlineSeconds）',
    })
    expect(k8sPodExit(pod({ reason: 'Evicted', message: 'Pod ephemeral local storage usage exceeds the total limit of containers 128Mi.' }), resources)).toEqual({
      exitCode: null,
      reason: '沙箱 Pod 被节点驱逐：Pod ephemeral local storage usage exceeds the total limit of containers 128Mi.',
    })
    expect(k8sPodExit(pod(terminated(143)), resources)).toEqual({ exitCode: null, reason: '被信号 15 结束（退出码 143）' })
    expect(k8sPodExit(pod(terminated(4)), resources)).toEqual({ exitCode: 4 })
    expect(k8sPodExit({ status: { phase: 'Succeeded', ...terminated(0, 'Completed') } }, resources)).toEqual({ exitCode: 0 })
    expect(k8sPodExit(pod({ reason: 'OutOfcpu', message: 'Node didn\'t have enough resource: cpu' }), resources)).toEqual({
      exitCode: null,
      reason: "沙箱 Pod Failed（OutOfcpu：Node didn't have enough resource: cpu）",
    })
  })

  it('超过 deadlineMs 兜底删掉，原因写明', async () => {
    const api = await fakeKube()
    const { driver } = driverOn(api)
    const handle = await driver.start(spec({ resources: { ...spec().resources, deadlineMs: 150 } }))
    const exit = await handle.wait()
    expect(exit).toEqual({ exitCode: null, reason: '超过沙箱时长上限 0 秒' })
    expect(api.find('DELETE', /\/pods\//)).toBeTruthy()
  })

  it('输出限行：第 500 行换成提示，之后断开日志流；超长的行截断', async () => {
    const api = await fakeKube()
    let podName = ''
    api.onCreate = (name) => {
      podName = name
      setTimeout(() => {
        api.run(name)
        api.log(name, `${'x'.repeat(5000)}\n`)
        api.log(name, Array.from({ length: 600 }, (_, i) => `line ${i}\n`).join(''))
      }, 10)
    }
    const { driver, lines } = driverOn(api)
    const handle = await driver.start(spec())
    await until(() => lines.length >= 500)
    await until(() => api.pod(podName).followerClosed)
    await handle.kill('收尾')
    expect(lines).toHaveLength(500)
    expect(lines[0]!.line).toHaveLength(2000)
    expect(lines.at(-1)!.line).toContain('输出太多')
  })

  it('watch 过期（410）/ 断开：重新 GET 再 watch，终态照样跟得到', async () => {
    const api = await fakeKube()
    let podName = ''
    api.onCreate = (name) => {
      podName = name
      setTimeout(() => api.run(name), 10)
    }
    const { driver } = driverOn(api)
    const handle = await driver.start(spec())
    await until(() => api.requests.filter((r) => r.path.includes('watch=true')).length >= 1 && podName !== '')
    api.expireWatches()
    await until(() => api.requests.filter((r) => r.path.includes('watch=true')).length >= 2)
    api.exit(podName, 0)
    expect(await handle.wait()).toEqual({ exitCode: 0 })
    expect(api.find('GET', /\/pods\/shadecn-agent-run-1$/)).toBeTruthy()
  })

  it('被外部删除：结局写明', async () => {
    const api = await fakeKube()
    let podName = ''
    api.onCreate = (name) => {
      podName = name
      setTimeout(() => api.run(name), 10)
    }
    const { driver } = driverOn(api)
    const handle = await driver.start(spec())
    await until(() => api.pods.get(podName)?.object.status.phase === 'Running')
    api.remove(podName)
    expect(await handle.wait()).toEqual({ exitCode: null, reason: '沙箱 Pod 已不存在（被外部删除）' })
  })

  it('API 失联：删不掉、等不到确认 —— 最多等 killConfirmMs 就放弃（留给 reap），一轮不卡死', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = await fakeKube()
    const { driver } = driverOn(api)
    const handle = (await driver.start(spec())) as K8sSandboxHandle
    await until(() => api.pods.get(handle.podName)?.object.status.phase === 'Running')
    const port = api.port
    await api.stop()
    const at = Date.now()
    await handle.kill('已中止')
    expect(Date.now() - at).toBeLessThan(3000)
    expect(await handle.wait()).toEqual({ exitCode: null, reason: '已中止' })
    expect(warn.mock.calls.flat().join('\n')).toMatch(/没能确认删除（k8s API 不可达或删除未生效，留给孤儿清理）/)
    // API 回来了：不再归这个驱动管，reap 会删它
    await api.listen(port)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await driver.reap(new Set())
    expect(api.pods.size).toBe(0)
  })
})

describe('k8s 驱动：起不来', () => {
  it('命名空间不存在 / 配额满 / RBAC / 准入拒绝：错误写明该查什么；一次性 token 不进错误信息', async () => {
    const api = await fakeKube()
    const { driver } = driverOn(api, { namespace: 'missing-ns' })
    await expect(driver.start(spec())).rejects.toThrow(/沙箱命名空间 missing-ns 不存在（AGENT_SANDBOX_K8S_NAMESPACE/)

    const cases: [{ code: number; reason: string; message: string }, RegExp][] = [
      [{ code: 403, reason: 'Forbidden', message: 'pods "x" is forbidden: exceeded quota: agent-sandbox, requested: pods=1, used: pods=20, limited: pods=20' }, /配额已满/],
      [{ code: 403, reason: 'Forbidden', message: 'pods is forbidden: User "system:serviceaccount:dev:app" cannot create resource "pods"' }, /没有在 sandbox-ns 建 Pod 的权限/],
      [{ code: 403, reason: 'Forbidden', message: 'pods "x" is forbidden: violates PodSecurity "restricted:latest": token=one-time-token' }, /被集群的准入拒绝：.*violates PodSecurity/],
      [{ code: 422, reason: 'Invalid', message: 'Pod "x" is invalid: spec.containers[0].resources' }, /规格不合法/],
    ]
    const { driver: plain } = driverOn(api)
    for (const [rejection, expected] of cases) {
      api.admission = () => rejection
      const failure = await plain.start(spec()).then(
        () => new Error('不该起得来'),
        (err: unknown) => err as Error,
      )
      expect(failure.message).toMatch(expected)
      expect(failure.message).not.toContain('one-time-token')
    }
    expect(api.pods.size).toBe(0)
  })

  it('API 连不上：错误写明地址', async () => {
    const api = await fakeKube()
    const { driver } = driverOn(api)
    const url = api.url
    await api.stop()
    await expect(driver.start(spec())).rejects.toThrow(`连不上 k8s API（${url}：ECONNREFUSED）`)
  })
})

describe('k8s 驱动：reap 与自检', () => {
  it('reap：本实例的删不在 liveRunIds、也不是本驱动正在管的；别的实例的只删过了时长上限的；删都是 grace 0', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const api = await fakeKube()
    const managed = { [K8S_LABELS.managed]: 'true' }
    api.seed('own-orphan', { ...managed, [K8S_LABELS.instance]: 'inst-a', [K8S_LABELS.run]: 'run_dead' })
    api.seed('own-done', { ...managed, [K8S_LABELS.instance]: 'inst-a', [K8S_LABELS.run]: 'run_dead2' }, { phase: 'Succeeded' })
    api.seed('own-live', { ...managed, [K8S_LABELS.instance]: 'inst-a', [K8S_LABELS.run]: 'run_live' })
    api.seed('other-fresh', { ...managed, [K8S_LABELS.instance]: 'inst-b', [K8S_LABELS.run]: 'run_x' }, { createdAgoMs: 60_000, deadlineSeconds: 660 })
    api.seed('other-expired', { ...managed, [K8S_LABELS.instance]: 'inst-b', [K8S_LABELS.run]: 'run_y' }, { createdAgoMs: 60 * 60_000, deadlineSeconds: 660 })
    api.seed('not-ours', { [K8S_LABELS.instance]: 'inst-a', [K8S_LABELS.run]: 'run_z' })
    const { driver } = driverOn(api)
    // 本驱动正在跑的一轮：调用方的 liveRunIds 漏了它也不能删
    const mine = (await driver.start(spec({ runId: 'run_mine' }))) as K8sSandboxHandle

    await driver.reap(new Set(['run_live']))
    expect([...api.pods.keys()].sort()).toEqual(['not-ours', 'other-fresh', 'own-live', mine.podName].sort())
    const list = api.find('GET', /\/pods\?labelSelector=/)!
    expect(decodeURIComponent(list.path)).toContain(`labelSelector=${K8S_LABELS.managed}=true`)
    for (const removed of ['own-orphan', 'own-done', 'other-expired']) {
      const request = api.requests.find((r) => r.method === 'DELETE' && r.path === `/api/v1/namespaces/${NS}/pods/${removed}`)
      expect(request!.body).toMatchObject({ gracePeriodSeconds: 0, preconditions: { uid: `uid-${removed}` } })
    }
    await mine.kill('收尾')
  })

  it('check：版本、权限（SelfSubjectAccessReview）、dry-run 建一个沙箱 Pod、privileged 的反例被准入拒绝；全过时没有 problems', async () => {
    const api = await fakeKube()
    const { driver } = driverOn(api, { runtimeClassName: 'gvisor' })
    const check = await driver.check()
    expect(check).toMatchObject({ server: api.url, version: 'v1.31.2', namespace: NS, runtimeClassName: 'gvisor', problems: [], warnings: [] })
    expect(check.permissions.map((p) => `${p.verb} ${p.resource}`)).toEqual([
      'create pods',
      'get pods',
      'list pods',
      'watch pods',
      'delete pods',
      'get pods/log',
    ])
    const dryRun = api.find('POST', /\/pods\?dryRun=All$/)!
    expect(dryRun.body.spec).toMatchObject({ runtimeClassName: 'gvisor', automountServiceAccountToken: false })
    expect(dryRun.body.metadata.name).toMatch(/^shadecn-agent-selfcheck-[0-9a-f]{6}$/)
    expect(dryRun.body.spec.containers[0].securityContext.privileged).toBe(false)
    const guard = api.requests.filter((r) => r.method === 'POST' && r.path.endsWith('?dryRun=All'))[1]!
    expect(guard.body.metadata.name).toMatch(/^shadecn-agent-selfcheck-guard-[0-9a-f]{6}$/)
    expect(guard.body.spec.containers[0].securityContext).toMatchObject({ privileged: true, allowPrivilegeEscalation: true })
    // dry-run 不落库
    expect(api.pods.size).toBe(0)
  })

  it('check：准入放行了 privileged 的反例（命名空间没有 Pod Security、也没有 VAP）→ problem；反例撞上配额只告警；正式规格过不了时不再试反例', async () => {
    const api = await fakeKube()
    api.admission = () => null
    const open = await driverOn(api).driver.check()
    expect(open.problems).toEqual([expect.stringMatching(/^命名空间 sandbox-ns 的准入放行了 privileged 的沙箱 Pod（dry-run）：服务端的 pods create 等于节点 root/)])
    expect(open.problems[0]).toContain('k8s/variants/agent-sandbox-vap.yaml')

    api.admission = (pod) =>
      pod.spec.containers[0].securityContext.privileged ? { code: 403, reason: 'Forbidden', message: 'pods "x" is forbidden: exceeded quota: q' } : null
    const quota = await driverOn(api).driver.check()
    expect(quota.problems).toEqual([])
    expect(quota.warnings.join('\n')).toContain('没能确认准入兜底（配额此刻已满）')

    api.requests.length = 0
    api.admission = () => ({ code: 403, reason: 'Forbidden', message: 'pods "x" is forbidden: ValidatingAdmissionPolicy denied request' })
    const refused = await driverOn(api).driver.check()
    expect(refused.problems).toEqual([expect.stringContaining('沙箱 Pod 的规格过不了集群的准入')])
    expect(api.requests.filter((r) => r.path.endsWith('?dryRun=All'))).toHaveLength(1)
  })

  it('check 的失败：缺权限 / 命名空间不存在 / 准入拒绝 → problems；权限给多了、镜像没写仓库、没配 RuntimeClass → warnings；401 / 连不上 → 抛', async () => {
    const api = await fakeKube()
    api.permissions['get pods/log'] = false
    api.permissions['watch pods'] = false
    api.permissions['get secrets'] = true
    const { driver } = driverOn(api, { image: 'shadecn-agent-sandbox:latest' })
    const check = await driver.check()
    expect(check.problems).toEqual([
      `服务端的 ServiceAccount 在命名空间 ${NS} 缺少权限：watch pods、get pods/log（Role 见 k8s/agent-sandbox.yaml）`,
    ])
    expect(check.warnings.join('\n')).toMatch(/权限多于需要：get secrets/)
    expect(check.warnings.join('\n')).toMatch(/没写仓库地址/)
    expect(check.warnings.join('\n')).toMatch(/没有配 RuntimeClass/)

    const { driver: missing } = driverOn(api, { namespace: 'gone-ns' })
    expect((await missing.check()).problems).toContainEqual(expect.stringContaining('沙箱命名空间 gone-ns 不存在'))

    api.admission = () => ({ code: 403, reason: 'Forbidden', message: 'pods "x" is forbidden: violates PodSecurity "restricted:latest": hostPath volumes' })
    api.permissions['get pods/log'] = true
    api.permissions['watch pods'] = true
    expect((await driverOn(api).driver.check()).problems).toEqual([expect.stringContaining('沙箱 Pod 的规格过不了集群的准入：pods "x" is forbidden: violates PodSecurity')])

    // 连不上 / 凭据被拒：抛（宿主据此把 agent 标成未启用）
    const url = api.url
    await api.stop()
    await expect(driverOn(api).driver.check()).rejects.toThrow(`连不上 k8s API（${url}：ECONNREFUSED）`)
    const denied = createServer((_req, res) => status(res, 401, 'Unauthorized', 'Unauthorized'))
    await new Promise<void>((resolve) => denied.listen(0, '127.0.0.1', resolve))
    try {
      const kube = createKubeClient({ server: `http://127.0.0.1:${(denied.address() as AddressInfo).port}`, tokenFile: null, caFile: null })
      clients.push(kube)
      await expect(createK8sDriver({ kube, image: 'r.example/s:1', instance: 'i' }).check()).rejects.toThrow(/不认服务端的凭据（401）.*AGENT_SANDBOX_K8S_TOKEN_FILE/)
    } finally {
      denied.closeAllConnections()
      await new Promise((resolve) => denied.close(resolve))
    }
  })
})

describe('k8s API 客户端', () => {
  it('token 文件每个请求重新读（projected token 会被 kubelet 轮换）；读不到写明该配哪一项', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'k8s-'))
    const tokenFile = path.join(dir, 'token')
    await writeFile(tokenFile, 'token-1\n')
    const api = await fakeKube()
    const kube = client(api, tokenFile)
    await kube.json('GET', '/version')
    await writeFile(tokenFile, 'token-2')
    await kube.json('GET', '/version')
    expect(api.requests.map((r) => r.auth)).toEqual(['Bearer token-1', 'Bearer token-2'])

    await rm(tokenFile)
    await expect(kube.json('GET', '/version')).rejects.toThrow(/读不到 ServiceAccount token .*（ENOENT）.*AGENT_SANDBOX_K8S_TOKEN_FILE/)
    // 不配 token（kubectl proxy）：不带 Authorization
    await client(api, null).json('GET', '/version')
    expect(api.requests.at(-1)!.auth).toBeUndefined()
  })

  it('kubeConnection：集群内按 KUBERNETES_SERVICE_HOST / PORT（IPv6 加方括号）；显式地址优先；http 只许回环；token / CA 默认 ServiceAccount 的、留空 = 不用', () => {
    expect(kubeConnection({ apiUrl: '' }, { KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' })).toEqual({
      ok: true,
      value: { server: 'https://10.96.0.1:443', tokenFile: SERVICE_ACCOUNT_TOKEN_FILE, caFile: SERVICE_ACCOUNT_CA_FILE },
    })
    expect(kubeConnection({ apiUrl: '' }, { KUBERNETES_SERVICE_HOST: 'fd00::1' })).toMatchObject({ ok: true, value: { server: 'https://[fd00::1]:443' } })
    expect(kubeConnection({ apiUrl: '' }, {})).toEqual({ ok: false, reason: expect.stringContaining('AGENT_SANDBOX_K8S_API_URL') })
    expect(kubeConnection({ apiUrl: 'http://127.0.0.1:8001/', tokenFile: '' }, { KUBERNETES_SERVICE_HOST: '10.96.0.1' })).toEqual({
      ok: true,
      value: { server: 'http://127.0.0.1:8001', tokenFile: null, caFile: null },
    })
    expect(kubeConnection({ apiUrl: 'http://10.0.0.1:6443' }, {})).toEqual({ ok: false, reason: expect.stringContaining('http:// 只许回环地址') })
    expect(kubeConnection({ apiUrl: 'ftp://x' }, {})).toEqual({ ok: false, reason: expect.stringContaining('只能是 https://') })
    expect(kubeConnection({ apiUrl: 'https://k8s.example:6443/k8s/clusters/c-1', tokenFile: '/t', caFile: '' }, {})).toEqual({
      ok: true,
      value: { server: 'https://k8s.example:6443/k8s/clusters/c-1', tokenFile: '/t', caFile: null },
    })
  })

  it('CA 文件读不到：建客户端时就报错，写明该配哪一项', () => {
    expect(() => createKubeClient({ server: 'https://10.96.0.1:443', tokenFile: null, caFile: '/nonexistent/ca.crt' })).toThrow(
      /读不到 k8s API 的 CA 证书（\/nonexistent\/ca\.crt：ENOENT）.*AGENT_SANDBOX_K8S_CA_FILE/,
    )
  })

  it('切行：UTF-8 字符跨块、\\r\\n、超长的行只留前 N 字（不在内存里无限长）、结尾的半行也交出去', () => {
    const lines: string[] = []
    const splitter = createLineSplitter(5, (line) => lines.push(line))
    const all = Buffer.from('你好\r\n世界很长很长很长\n尾巴')
    for (let i = 0; i < all.length; i += 2) splitter.push(all.subarray(i, i + 2))
    splitter.end()
    expect(lines).toEqual(['你好', '世界很长很', '尾巴'])
  })
})
