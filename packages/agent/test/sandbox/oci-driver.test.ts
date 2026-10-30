import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SandboxSpec } from '../../src/sandbox/driver.ts'
import {
  createEngineClient,
  createLogDemuxer,
  engineSocketCandidates,
  findEngineSocket,
} from '../../src/sandbox/drivers/engine.ts'
import {
  createOciDriver,
  OCI_LABELS,
  OCI_RUN_WORKDIR,
  ociRunnerEnv,
  type OciDriverOptions,
  type OciSandboxHandle,
} from '../../src/sandbox/drivers/oci.ts'

/**
 * `oci` 驱动（docs/22 §7.2）对着一个**假的 Engine API**（测试里在 unix socket 上起的 http server）测请求形状：
 * 容器配置里的安全选项、环境变量只有那三个、label、资源上限换算、杀 / 删的先后、`wait()` 在删完之后才兑现、
 * 时长兜底、OOM、输出限行、`reap` 只清本实例的孤儿、引擎连不上 / 镜像不存在时的错误。
 * 真的 Podman / Docker 跑一轮在 apps/server 的 `sandbox-oci.test.ts`（默认跳过）。
 */

interface FakeContainer {
  id: string
  name: string
  config: Record<string, unknown>
  labels: Record<string, string>
  state: 'created' | 'running' | 'exited'
  exitCode: number
  oom: boolean
  frames: Buffer[]
  waiters: ServerResponse[]
  logSubscribers: ServerResponse[]
}

interface Recorded {
  method: string
  path: string
  body: unknown
}

/** Docker 多路日志流的一帧 */
function frame(stream: 'stdout' | 'stderr', text: string | Buffer): Buffer {
  const payload = typeof text === 'string' ? Buffer.from(text) : text
  const header = Buffer.alloc(8)
  header[0] = stream === 'stdout' ? 1 : 2
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

class FakeEngine {
  readonly requests: Recorded[] = []
  readonly containers = new Map<string, FakeContainer>()
  readonly images = new Set<string>(['sandbox:test'])
  readonly networks = new Map<string, { Internal: boolean }>([['agent-internal', { Internal: true }]])
  /** 容器起来之后做什么（发日志、退出…） */
  onStart: (container: FakeContainer) => void = () => {}
  /** 让某个接口直接失败：返回状态码 */
  fail: Partial<Record<'start' | 'kill' | 'delete' | 'wait', number>> = {}
  /** wait 永远不回（模拟引擎失联） */
  hangWait = false
  private seq = 0
  server: Server | null = null

  readonly socketPath: string

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  async listen() {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve))
  }

  async close() {
    for (const c of this.containers.values()) {
      for (const res of [...c.waiters, ...c.logSubscribers]) res.destroy()
    }
    this.server?.closeAllConnections()
    await new Promise((resolve) => this.server?.close(resolve))
  }

  /** 第一条匹配的请求 */
  find(method: string, pattern: RegExp) {
    return this.requests.find((r) => r.method === method && pattern.test(r.path))
  }

  index(method: string, pattern: RegExp) {
    return this.requests.findIndex((r) => r.method === method && pattern.test(r.path))
  }

  emit(container: FakeContainer, stream: 'stdout' | 'stderr', text: string | Buffer) {
    const chunk = frame(stream, text)
    container.frames.push(chunk)
    for (const res of container.logSubscribers) res.write(chunk)
  }

  exit(container: FakeContainer, code: number, oom = false) {
    if (container.state === 'exited') return
    container.state = 'exited'
    container.exitCode = code
    container.oom = oom
    for (const res of container.waiters.splice(0)) this.reply(res, 200, { StatusCode: code, Error: null })
    for (const res of container.logSubscribers.splice(0)) res.end()
  }

  /** 预置一个容器（reap 用） */
  seed(id: string, labels: Record<string, string>, state: FakeContainer['state'] = 'running') {
    const container: FakeContainer = { id, name: `seed-${id}`, config: {}, labels, state, exitCode: 0, oom: false, frames: [], waiters: [], logSubscribers: [] }
    this.containers.set(id, container)
    return container
  }

  private reply(res: ServerResponse, status: number, body?: unknown) {
    if (body === undefined) {
      res.writeHead(status).end()
      return
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined
    const url = new URL(req.url!, 'http://engine')
    this.requests.push({ method: req.method!, path: url.pathname + url.search, body })
    const parts = url.pathname.split('/').filter(Boolean)

    if (url.pathname === '/_ping') return this.reply(res, 200)
    if (url.pathname === '/version') return this.reply(res, 200, { Version: '9.9', ApiVersion: '1.44', Components: [{ Name: 'Fake Engine' }] })
    if (parts[0] === 'images') {
      const name = decodeURIComponent(parts.slice(1, -1).join('/'))
      return this.images.has(name) ? this.reply(res, 200, { Id: 'img' }) : this.reply(res, 404, { message: `no such image: ${name}` })
    }
    if (parts[0] === 'networks') {
      const net = this.networks.get(decodeURIComponent(parts[1]!))
      return net ? this.reply(res, 200, { ...net, Driver: 'bridge' }) : this.reply(res, 404, { message: 'network not found' })
    }
    if (url.pathname === '/containers/create') {
      const image = String(body?.Image)
      if (!this.images.has(image)) return this.reply(res, 404, { message: `no such image: ${image}: image not known` })
      const id = `${'c'.repeat(56)}${String((this.seq += 1)).padStart(8, '0')}`
      const container: FakeContainer = {
        id,
        name: url.searchParams.get('name') ?? '',
        config: body!,
        labels: (body!.Labels as Record<string, string>) ?? {},
        state: 'created',
        exitCode: 0,
        oom: false,
        frames: [],
        waiters: [],
        logSubscribers: [],
      }
      this.containers.set(id, container)
      return this.reply(res, 201, { Id: id, Warnings: [] })
    }
    if (url.pathname === '/containers/json') {
      const wanted = (JSON.parse(url.searchParams.get('filters') ?? '{}') as { label?: string[] }).label ?? []
      const list = [...this.containers.values()]
        .filter((c) => wanted.every((pair) => {
          const [key, value] = pair.split('=')
          return c.labels[key!] === value
        }))
        .map((c) => ({ Id: c.id, Names: [`/${c.name}`], State: c.state, Labels: c.labels }))
      return this.reply(res, 200, list)
    }
    const container = parts[0] === 'containers' ? this.containers.get(parts[1]!) : undefined
    const action = parts[2] ?? ''
    if (req.method === 'DELETE') {
      if (this.fail.delete) return this.reply(res, this.fail.delete, { message: 'delete failed' })
      if (!container) return this.reply(res, 404, { message: 'no such container' })
      this.exit(container, 137)
      this.containers.delete(container.id)
      return this.reply(res, 204)
    }
    if (!container) return this.reply(res, 404, { message: 'no such container' })
    switch (action) {
      case 'start':
        if (this.fail.start) return this.reply(res, this.fail.start, { message: 'start failed' })
        container.state = 'running'
        this.reply(res, 204)
        setTimeout(() => this.onStart(container), 10)
        return
      case 'wait':
        if (this.fail.wait) return this.reply(res, this.fail.wait, { message: 'wait failed' })
        if (this.hangWait) return
        if (container.state !== 'running') return this.reply(res, 200, { StatusCode: container.exitCode, Error: null })
        container.waiters.push(res)
        return
      case 'json':
        return this.reply(res, 200, { State: { Running: container.state === 'running', ExitCode: container.exitCode, OOMKilled: container.oom } })
      case 'kill':
        if (this.fail.kill) return this.reply(res, this.fail.kill, { message: 'kill failed' })
        if (container.state !== 'running') return this.reply(res, 409, { message: 'can only kill running containers' })
        this.reply(res, 204)
        this.exit(container, 137)
        return
      case 'logs':
        res.writeHead(200, { 'content-type': 'application/vnd.docker.multiplexed-stream' })
        for (const chunk of container.frames) res.write(chunk)
        if (container.state === 'running') container.logSubscribers.push(res)
        else res.end()
        return
      default:
        return this.reply(res, 404, { message: `unknown ${url.pathname}` })
    }
  }
}

let dir = ''
let engine: FakeEngine | null = null

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await engine?.close()
  engine = null
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function fakeEngine() {
  dir = await mkdtemp(path.join(tmpdir(), 'oci-'))
  engine = new FakeEngine(path.join(dir, 'engine.sock'))
  await engine.listen()
  return engine
}

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    runId: 'run_1',
    flowId: 'flow_1',
    ownerId: 'u1',
    grantId: 'g1',
    image: 'sandbox:test',
    resources: { cpu: 1.5, memoryMiB: 256, pids: 32, diskMiB: 64, deadlineMs: 30_000 },
    gatewayUrl: 'http://host.docker.internal:3100/api/agent-gateway',
    credential: { kind: 'bootstrap', token: 'one-time-token' },
    ...overrides,
  }
}

function driverOn(fake: FakeEngine, extra: Partial<OciDriverOptions> = {}) {
  const lines: { stream: string; line: string }[] = []
  const driver = createOciDriver({
    engine: createEngineClient(fake.socketPath),
    image: 'sandbox:test',
    instance: 'inst-a',
    onOutput: (_runId, stream, line) => lines.push({ stream, line }),
    ...extra,
  })
  return { driver, lines }
}

const created = (fake: FakeEngine) => fake.find('POST', /^\/containers\/create/)!.body as Record<string, any>

describe('oci 驱动：容器配置', () => {
  it('安全选项：非 root、只读根文件系统、noexec tmpfs、CapDrop ALL、no-new-privileges（seccomp 用引擎默认）、不挂卷不挂 socket；资源上限换算；label', async () => {
    const fake = await fakeEngine()
    fake.onStart = (c) => fake.exit(c, 0)
    const { driver } = driverOn(fake)
    const handle = (await driver.start(spec())) as OciSandboxHandle
    await handle.wait()

    expect(fake.find('POST', /^\/containers\/create\?name=shadecn-agent-run_1$/)).toBeTruthy()
    const config = created(fake)
    expect(config).toMatchObject({
      Image: 'sandbox:test',
      User: '10001:10001',
      WorkingDir: '/work',
      Tty: false,
      OpenStdin: false,
      Labels: {
        [OCI_LABELS.managed]: 'true',
        [OCI_LABELS.run]: 'run_1',
        [OCI_LABELS.flow]: 'flow_1',
        [OCI_LABELS.grant]: 'g1',
        [OCI_LABELS.instance]: 'inst-a',
      },
    })
    // 没指定入口：用镜像的 ENTRYPOINT（runner）
    expect(config).not.toHaveProperty('Entrypoint')
    expect(config).not.toHaveProperty('Cmd')
    const host = config.HostConfig as Record<string, unknown>
    expect(host).toEqual({
      ReadonlyRootfs: true,
      Tmpfs: {
        '/work': 'rw,noexec,nosuid,nodev,size=64m,mode=1777',
        '/tmp': 'rw,noexec,nosuid,nodev,size=64m,mode=1777',
      },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Privileged: false,
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      NanoCpus: 1_500_000_000,
      PidsLimit: 32,
      NetworkMode: 'bridge',
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
    })
    // 上面是 toEqual：没有 Binds / Mounts / Devices / CapAdd / seccomp=unconfined / Runtime 之类的东西
  })

  it('环境变量只有网关地址、一次性 token、工作目录三个（PATH 由镜像给）；服务端进程里的密钥一个都不进请求', async () => {
    vi.stubEnv('AGENT_API_KEY', 'sk-should-not-leak')
    vi.stubEnv('DATABASE_URL', 'postgresql://secret@db/app')
    vi.stubEnv('SESSION_SECRET', 'session-secret')
    vi.stubEnv('REDIS_URL', 'redis://:pw@redis:6379')
    const fake = await fakeEngine()
    fake.onStart = (c) => fake.exit(c, 0)
    const { driver } = driverOn(fake)
    await (await driver.start(spec())).wait()

    const env = created(fake).Env as string[]
    expect(env.map((pair) => pair.split('=')[0]).sort()).toEqual(['SHADECN_BOOTSTRAP_TOKEN', 'SHADECN_GATEWAY_URL', 'SHADECN_WORKDIR'])
    expect(env).toEqual(ociRunnerEnv(spec()))
    expect(env).toContain(`SHADECN_WORKDIR=${OCI_RUN_WORKDIR}`)
    const everything = JSON.stringify(fake.requests)
    expect(everything).not.toMatch(/sk-should-not-leak|secret@db|session-secret|redis:/)
  })

  it('可选项：runtime（gVisor 的 runsc）、自定义网络、覆盖入口；host / none 网络拒绝', async () => {
    const fake = await fakeEngine()
    fake.onStart = (c) => fake.exit(c, 0)
    const { driver } = driverOn(fake, { runtime: 'runsc', network: 'agent-internal', command: ['node', '-e', '0'] })
    await (await driver.start(spec())).wait()
    expect(created(fake)).toMatchObject({
      Entrypoint: ['node', '-e', '0'],
      Cmd: [],
      HostConfig: { Runtime: 'runsc', NetworkMode: 'agent-internal' },
    })

    expect(() => driverOn(fake, { network: 'host' })).toThrow('host 网络')
    expect(() => driverOn(fake, { network: 'none' })).toThrow('none 网络')
  })
})

describe('oci 驱动：生命周期', () => {
  it('正常退出：日志逐行转发（行跨帧、stdout / stderr 分开），退出码原样；wait() 在容器删掉之后才兑现', async () => {
    const fake = await fakeEngine()
    fake.onStart = (c) => {
      fake.emit(c, 'stdout', 'hel')
      fake.emit(c, 'stdout', 'lo\nwor')
      fake.emit(c, 'stderr', 'oops\n')
      fake.emit(c, 'stdout', 'ld\n')
      setTimeout(() => fake.exit(c, 0), 20)
    }
    const { driver, lines } = driverOn(fake)
    const handle = (await driver.start(spec())) as OciSandboxHandle
    expect(handle.id).toBe(`oci:${handle.containerId.slice(0, 12)}`)
    expect(await handle.wait()).toEqual({ exitCode: 0 })

    expect(fake.containers.has(handle.containerId)).toBe(false)
    const create = fake.index('POST', /^\/containers\/create/)
    const start = fake.index('POST', /\/start$/)
    const wait = fake.index('POST', /\/wait\?condition=not-running$/)
    const remove = fake.index('DELETE', /\/containers\//)
    expect(start).toBeGreaterThan(create)
    expect(fake.index('GET', /\/logs\?follow=true&stdout=true&stderr=true$/)).toBeGreaterThan(start)
    expect(wait).toBeGreaterThan(start)
    expect(remove).toBeGreaterThan(wait)
    expect(fake.requests[remove]!.path).toMatch(/\?force=true&v=true$/)
    expect(lines).toEqual([
      { stream: 'stdout', line: 'hello' },
      { stream: 'stderr', line: 'oops' },
      { stream: 'stdout', line: 'world' },
    ])
  })

  it('kill：先 SIGKILL 再删除，返回时容器已删；结局带原因；幂等', async () => {
    const fake = await fakeEngine()
    const { driver } = driverOn(fake)
    const handle = (await driver.start(spec())) as OciSandboxHandle
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fake.containers.get(handle.containerId)?.state).toBe('running')

    await handle.kill('已中止')
    expect(fake.containers.has(handle.containerId)).toBe(false)
    const kill = fake.index('POST', /\/kill\?signal=SIGKILL$/)
    expect(kill).toBeGreaterThanOrEqual(0)
    expect(fake.index('DELETE', /\/containers\//)).toBeGreaterThan(kill)
    expect(await handle.wait()).toEqual({ exitCode: null, reason: '已中止' })
    // 第二次：容器已经不在（404）也不报错，原因保留第一次的
    await handle.kill('又一次')
    expect(await handle.wait()).toEqual({ exitCode: null, reason: '已中止' })
  })

  it('超过 deadlineMs 兜底杀掉，原因写明', async () => {
    const fake = await fakeEngine()
    const { driver } = driverOn(fake)
    const handle = await driver.start(spec({ resources: { ...spec().resources, deadlineMs: 150 } }))
    const exit = await handle.wait()
    expect(exit.exitCode).toBeNull()
    expect(exit.reason).toContain('时长上限')
    expect(fake.find('POST', /\/kill\?signal=SIGKILL$/)).toBeTruthy()
  })

  it('OOM：退出码 137 + 原因写明内存上限；被别人用信号结束：exitCode null + 信号', async () => {
    const fake = await fakeEngine()
    fake.onStart = (c) => fake.exit(c, 137, true)
    const { driver } = driverOn(fake)
    expect(await (await driver.start(spec())).wait()).toEqual({ exitCode: 137, reason: '内存超过上限 256 MiB，被 OOM 结束' })

    fake.onStart = (c) => fake.exit(c, 143)
    expect(await (await driver.start(spec({ runId: 'run_2' }))).wait()).toEqual({ exitCode: null, reason: '被信号 15 结束（退出码 143）' })
  })

  it('输出限行：第 500 行换成提示，之后的不再转发；超长的行截断', async () => {
    const fake = await fakeEngine()
    fake.onStart = (c) => {
      fake.emit(c, 'stdout', `${'x'.repeat(5000)}\n`)
      fake.emit(c, 'stdout', Array.from({ length: 600 }, (_, i) => `line ${i}\n`).join(''))
      setTimeout(() => fake.exit(c, 0), 20)
    }
    const { driver, lines } = driverOn(fake)
    await (await driver.start(spec())).wait()
    expect(lines).toHaveLength(500)
    expect(lines[0]!.line).toHaveLength(2000)
    expect(lines.at(-1)!.line).toContain('输出太多')
  })

  it('引擎失联：杀不掉、等不到退出 —— 最多等 killConfirmMs 就放弃确认（留给 reap），一轮不卡死', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = await fakeEngine()
    const { driver } = driverOn(fake, { killConfirmMs: 200 })
    const handle = await driver.start(spec())
    fake.hangWait = true
    fake.fail = { kill: 500, delete: 500 }
    const at = Date.now()
    await handle.kill('已中止')
    expect(Date.now() - at).toBeLessThan(5000)
    expect(await handle.wait()).toEqual({ exitCode: null, reason: '已中止' })
    expect(warn.mock.calls.flat().join('\n')).toMatch(/状态未知（容器引擎不可达，没能确认容器已退出（留给孤儿清理））/)
    // 不再归这个驱动管：之后的 reap 会去删它
    fake.fail = {}
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await driver.reap(new Set())
    expect(fake.containers.size).toBe(0)
  })

  it('杀完删除失败：结局照常，容器交给之后的 reap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = await fakeEngine()
    const { driver } = driverOn(fake)
    const handle = await driver.start(spec())
    fake.fail = { delete: 500 }
    await handle.kill('已中止')
    expect(await handle.wait()).toEqual({ exitCode: null, reason: '已中止' })
    expect(warn.mock.calls.flat().join('\n')).toMatch(/没能删除（留给孤儿清理）/)
    fake.fail = {}
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await driver.reap(new Set())
    expect(fake.containers.size).toBe(0)
  })
})

describe('oci 驱动：起不来', () => {
  it('镜像不存在：错误提示构建命令和配置项，不留容器', async () => {
    const fake = await fakeEngine()
    const { driver } = driverOn(fake, { image: 'missing:1' })
    await expect(driver.start(spec())).rejects.toThrow(/沙箱镜像 missing:1 不存在.*pnpm build:sandbox-image.*AGENT_SANDBOX_IMAGE/)
    expect(fake.containers.size).toBe(0)
  })

  it('建好了但起不来：删掉那个容器再报错', async () => {
    const fake = await fakeEngine()
    fake.fail = { start: 500 }
    const { driver } = driverOn(fake)
    await expect(driver.start(spec())).rejects.toThrow('沙箱容器起不来')
    expect(fake.containers.size).toBe(0)
    expect(fake.find('DELETE', /\/containers\//)).toBeTruthy()
  })

  it('引擎连不上：start / check / reap 的错误都写明 socket 路径和该配的 AGENT_SANDBOX_OCI_SOCKET', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'oci-'))
    const socket = path.join(dir, 'nobody-home.sock')
    const driver = createOciDriver({ engine: createEngineClient(socket), image: 'sandbox:test', instance: 'inst-a' })
    const failure = (await driver.start(spec()).then(
      () => new Error('不该起得来'),
      (err: unknown) => err as Error,
    ))
    expect(failure.message).toContain(`连不上容器引擎（${socket}：ENOENT）`)
    expect(failure.message).toContain('AGENT_SANDBOX_OCI_SOCKET')
    await expect(driver.check()).rejects.toThrow('连不上容器引擎')
    await expect(driver.reap(new Set())).rejects.toThrow('连不上容器引擎')
  })

  it('id 不能做容器名的拒绝', async () => {
    const fake = await fakeEngine()
    const { driver } = driverOn(fake)
    await expect(driver.start(spec({ runId: '../escape' }))).rejects.toThrow('容器名')
    expect(fake.requests).toHaveLength(0)
  })
})

describe('oci 驱动：reap 与自检', () => {
  it('reap：只删本实例的、不在 liveRunIds 里的、也不是本驱动正在管的容器', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const fake = await fakeEngine()
    const managed = { [OCI_LABELS.managed]: 'true' }
    fake.seed('orphan-running', { ...managed, [OCI_LABELS.instance]: 'inst-a', [OCI_LABELS.run]: 'run_dead' })
    fake.seed('orphan-exited', { ...managed, [OCI_LABELS.instance]: 'inst-a', [OCI_LABELS.run]: 'run_dead2' }, 'exited')
    fake.seed('live', { ...managed, [OCI_LABELS.instance]: 'inst-a', [OCI_LABELS.run]: 'run_live' })
    fake.seed('other-instance', { ...managed, [OCI_LABELS.instance]: 'inst-b', [OCI_LABELS.run]: 'run_x' })
    fake.seed('not-ours', { [OCI_LABELS.instance]: 'inst-a', [OCI_LABELS.run]: 'run_y' })
    const { driver } = driverOn(fake)
    // 本驱动正在跑的一轮：调用方的 liveRunIds 漏了它也不能删
    const mine = (await driver.start(spec({ runId: 'run_mine' }))) as OciSandboxHandle

    await driver.reap(new Set(['run_live']))
    expect([...fake.containers.keys()].sort()).toEqual(['live', 'not-ours', 'other-instance', mine.containerId].sort())
    // 在跑的孤儿先 SIGKILL 再删（Podman 的强制删除会先 SIGTERM 等 10 秒）；已停的直接删
    const kill = fake.index('POST', /^\/containers\/orphan-running\/kill\?signal=SIGKILL$/)
    expect(kill).toBeGreaterThanOrEqual(0)
    expect(fake.index('DELETE', /^\/containers\/orphan-running\?/)).toBeGreaterThan(kill)
    expect(fake.find('POST', /^\/containers\/orphan-exited\/kill/)).toBeUndefined()
    expect(fake.find('DELETE', /^\/containers\/orphan-exited\?/)).toBeTruthy()
    const list = fake.find('GET', /^\/containers\/json/)!
    expect(decodeURIComponent(list.path)).toContain(`"label":["${OCI_LABELS.managed}=true","${OCI_LABELS.instance}=inst-a"]`)
    expect(list.path).toContain('all=true')

    await mine.kill('收尾')
  })

  it('check：引擎版本、镜像在不在、网络是不是 internal / 存不存在', async () => {
    const fake = await fakeEngine()
    expect(await driverOn(fake).driver.check()).toEqual({
      socketPath: fake.socketPath,
      engine: { name: 'Fake Engine', version: '9.9', apiVersion: '1.44' },
      image: { name: 'sandbox:test', present: true },
      network: { name: 'bridge', exists: true, internal: false },
    })
    expect((await driverOn(fake, { network: 'agent-internal', image: 'nope:1' }).driver.check())).toMatchObject({
      image: { present: false },
      network: { name: 'agent-internal', exists: true, internal: true },
    })
    expect((await driverOn(fake, { network: 'typo' }).driver.check()).network).toEqual({ name: 'typo', exists: false, internal: false })
  })
})

describe('Engine API 的零件', () => {
  it('日志多路流：8 字节帧头被拆在任意位置、UTF-8 字符跨帧，照样拼对', () => {
    const lines: string[] = []
    const demux = createLogDemuxer((stream, line) => lines.push(`${stream}:${line}`))
    const all = Buffer.concat([frame('stdout', Buffer.from('你好\r\n世')), frame('stderr', '错\n'), frame('stdout', Buffer.from('界\n尾巴'))])
    for (let i = 0; i < all.length; i += 3) demux.push(all.subarray(i, i + 3))
    demux.end()
    expect(lines).toEqual(['stdout:你好', 'stderr:错', 'stdout:世界', 'stdout:尾巴'])
  })

  it('socket 在哪：显式配置优先（不是 socket 就报错）；DOCKER_HOST 只认 unix://；默认候选含 podman machine 的位置', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'oci-'))
    const machineDir = path.join(dir, 'podman')
    await mkdir(machineDir, { recursive: true })
    const machineSocket = path.join(machineDir, 'podman-machine-default-api.sock')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(machineSocket, resolve))
    try {
      const notSocket = path.join(dir, 'plain-file')
      await writeFile(notSocket, '')
      expect(findEngineSocket(notSocket, {})).toEqual({ ok: false, reason: expect.stringContaining('不是一个可用的 unix socket') })
      expect(findEngineSocket(`unix://${machineSocket}`, {})).toEqual({ ok: true, path: machineSocket })

      expect(engineSocketCandidates({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' })).toEqual({ ok: true, candidates: ['/run/user/1000/docker.sock'] })
      expect(engineSocketCandidates({ DOCKER_HOST: 'tcp://10.0.0.1:2375' })).toEqual({ ok: false, reason: expect.stringContaining('AGENT_SANDBOX_OCI_SOCKET') })
      const listed = engineSocketCandidates({ HOME: '/Users/me', TMPDIR: dir, XDG_RUNTIME_DIR: '/run/user/1000' })
      expect(listed.ok && listed.candidates).toEqual([
        '/var/run/docker.sock',
        '/run/user/1000/podman/podman.sock',
        '/run/podman/podman.sock',
        '/Users/me/.local/share/containers/podman/machine/podman.sock',
        machineSocket,
        '/Users/me/.docker/run/docker.sock',
      ])
      // 没配：按候选顺序找第一个真的 socket（这里 /var/run/docker.sock 可能存在于开发机上，所以只用 TMPDIR 那一条验证「能找到」）
      const found = findEngineSocket('', { DOCKER_HOST: `unix://${machineSocket}` })
      expect(found).toEqual({ ok: true, path: machineSocket })
      expect(findEngineSocket('', { DOCKER_HOST: `unix://${path.join(dir, 'gone.sock')}` })).toEqual({
        ok: false,
        reason: expect.stringContaining('找不到容器引擎的 socket'),
      })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
