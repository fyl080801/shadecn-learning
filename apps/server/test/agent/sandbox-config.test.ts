import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OCI_LABELS, PROCESS_DRIVER_REFUSED_IN_PRODUCTION } from '@shadecn/agent/sandbox/drivers'
import { forwardedImports, runnerCommand } from '../../agent/runner-command.ts'

/**
 * 沙箱相关的配置与装配（docs/22 §7）：`AGENT_SANDBOX` 的取值、生产环境拒绝 process 驱动（除非显式放行）、
 * `oci` 驱动的 socket / 网关地址 / 资源上限、启动自检与清孤儿、令牌密钥的来路、runner 的启动命令。
 * config.ts / agent/index.ts 的值在模块加载时算定，所以每个用例 resetModules 重新 import。
 */

let engineServer: Server | null = null
let engineDir = ''

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  if (engineServer) {
    engineServer.closeAllConnections()
    await new Promise((resolve) => engineServer!.close(resolve))
  }
  engineServer = null
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

  it('还没实现的驱动 / 不认识的驱动：未启用，原因写明', async () => {
    expect((await runtimeWith({ ...ollama, AGENT_SANDBOX: 'k8s' })).disabledReason).toContain('还没实现')
    expect((await runtimeWith({ ...ollama, AGENT_SANDBOX: 'docker' })).disabledReason).toContain('AGENT_SANDBOX=docker')
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
