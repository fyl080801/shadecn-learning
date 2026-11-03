import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { OCI_LABELS } from '@learning/agent-core/sandbox/drivers/oci'
import { PROCESS_DRIVER_REFUSED_IN_PRODUCTION } from '@learning/agent-core/sandbox/drivers/process'
import type { AgentRuntime } from '@learning/agent-core/session'
import { ConfigService } from '@learning/config'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AGENT_TOKEN_SECRET_ENV, AGENT_OPTIONS, AGENT_TOKEN_SECRET_PURPOSE, type AgentOptions, resolveAgentOptions } from '../src/options.js'
import { runnerCommand } from '../src/runner-command.js'
import { AGENT_RUNTIME, agentGatewayUrl, agentSandboxInstance, buildSandboxDriver } from '../src/sandbox.js'
import { deriveSecretFrom } from '../../session/src/session-token.js'
import { bootAgentApp, ensureRunnerBuilt, memoryS3, SECRET, silenceConsole, until } from './helpers.js'

/**
 * 沙箱相关的配置与装配（docs/22 §7）：`agent.sandbox.driver` 的取值、生产环境拒绝 process 驱动（除非显式放行）、`oci` 驱动的 socket / 网关地址 / 资源上限、
 * 启动自检与清孤儿、令牌密钥的来路、runner 的启动命令。从 `apps/server/test/agent/sandbox-config.test.ts` 移植，去掉 k8s 驱动（`docs/31` §3.2）和一期的 `local` 取值（这个服务没有旧配置）。
 * 环境变量名推导也没有了：配置都在 config.yaml 的 `agent` 段，这里直接给段的值。
 */

function options(section: Record<string, unknown> = {}, extra: { env?: Record<string, string>; values?: Record<string, unknown>; isProduction?: boolean } = {}): AgentOptions {
  const config = new ConfigService({ rootDir: '/tmp/root', dataDir: '/tmp/root/data', isProduction: extra.isProduction ?? false, values: { agent: section, ...extra.values }, env: extra.env ?? {} })
  return resolveAgentOptions(config, { deriveSecret: (purpose) => deriveSecretFrom(SECRET, purpose) })
}

describe('agent.sandbox.driver / 令牌密钥', () => {
  it('不配 = process；oci 原样；不认识的和 k8s 带着原值，由 SANDBOX_DRIVER 写成未启用的原因', () => {
    expect(options()).toMatchObject({ sandbox: 'process', sandboxExec: false })
    expect(options({ sandbox: { exec: true } })).toMatchObject({ sandbox: 'process', sandboxExec: true })
    expect(options({ sandbox: { driver: 'oci' } }).sandbox).toBe('oci')
    expect(options({ sandbox: { driver: 'k8s' } }).sandbox).toEqual({ unknown: 'k8s' })
    expect(options({ sandbox: { driver: 'docker' } }).sandbox).toEqual({ unknown: 'docker' })
  })

  it('令牌密钥：.env 的优先；否则由会话密钥派生（不等于它本身，每个进程得到同一把）；网关地址默认本机回环 + server.port', () => {
    expect(options({}, { env: { [AGENT_TOKEN_SECRET_ENV]: 'explicit' } }).tokenSecret).toBe('explicit')
    const derived = options().tokenSecret
    expect(derived).not.toBe(SECRET)
    expect(derived).toBe(options().tokenSecret)
    // 写死的摘要：换用途串 = 在跑的令牌全部失效，也可能和别的用途撞上
    expect(derived).toBe(createHmac('sha256', SECRET).update('agent:run-token').digest('hex'))
    expect(AGENT_TOKEN_SECRET_PURPOSE).toBe('agent:run-token')
    // .env 里写了空白等于没写
    expect(options({}, { env: { [AGENT_TOKEN_SECRET_ENV]: '   ' } }).tokenSecret).toBe(derived)
    expect(options({}, { values: { server: { host: '0.0.0.0', port: 3100 } } }).gatewayUrl).toBe('http://127.0.0.1:3100')
    expect(options({}, { values: { server: { port: 3100 } } }).gatewayUrl).toBe('http://127.0.0.1:3100')
    expect(options({}, { values: { server: { host: '10.0.0.5', port: 3100 } } }).gatewayUrl).toBe('http://10.0.0.5:3100')
  })

  it('oci：网关地址默认是引擎给容器的宿主名（容器里的回环是它自己）；显式配置优先', () => {
    const server = { server: { port: 3100 } }
    expect(options({ sandbox: { driver: 'oci' } }, { values: server }).gatewayUrl).toBe('http://host.docker.internal:3100')
    expect(options({ sandbox: { driver: 'oci' }, gatewayUrl: 'http://shadecn:3000/' }, { values: server }).gatewayUrl).toBe('http://shadecn:3000')
  })

  it('server.port 是 0 又没配 agent.gatewayUrl：agent 未启用并写明原因，不带着一个连不回来的地址启用；配了地址就照常', () => {
    const zero = { server: { port: 0 } }
    const refused = buildSandboxDriver(options({}, { values: zero }))
    expect(refused).toEqual({ ok: false, reason: expect.stringContaining('agent.gatewayUrl') })
    expect(buildSandboxDriver(options({ sandbox: { driver: 'k8s' } }, { values: zero }))).toEqual({ ok: false, reason: expect.stringContaining('k8s') })
    const explicit = options({ gatewayUrl: 'http://127.0.0.1:4567/' }, { values: zero })
    expect(explicit).toMatchObject({ gatewayUrl: 'http://127.0.0.1:4567', gatewayUnknown: false })
    expect(options({}, { values: { server: { port: 4567 } } }).gatewayUnknown).toBe(false)
  })

  it('沙箱的镜像 / 网络 / 资源上限：有默认值，可配；配坏了（非正数、不是数）退回默认', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(options()).toMatchObject({
      sandboxImage: 'learning-agent-runner:latest',
      ociNetwork: 'bridge',
      sandboxRuntime: '',
      sandboxResources: { cpu: 1, memoryMiB: 512, pids: 128, diskMiB: 512 },
    })
    expect(
      options({ sandbox: { image: 'registry.example/agent-runner:1', runtime: 'runsc', cpus: 0.5, memoryMib: 1024, pids: -1, diskMib: 'lots', oci: { network: 'agent-internal' } } }),
    ).toMatchObject({
      sandboxImage: 'registry.example/agent-runner:1',
      ociNetwork: 'agent-internal',
      sandboxRuntime: 'runsc',
      sandboxResources: { cpu: 0.5, memoryMiB: 1024, pids: 128, diskMiB: 512 },
    })
    vi.restoreAllMocks()
  })

  it('各项时长的默认值和配坏了的退路；titleModel 不写是 default，off / false 是不生成', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(options()).toMatchObject({ grantMarginMs: 60_000, leaseTtlMs: 30_000, runIdleTimeoutMs: 120_000, runTotalTimeoutMs: 1_800_000, maxOutputTokens: undefined, titleModel: 'default', thinking: undefined })
    expect(options({ grantMarginMs: 0, leaseTtlMs: 1000.5, runIdleTimeoutMs: 'x', runTotalTimeoutMs: -1, maxOutputTokens: 100 })).toMatchObject({ grantMarginMs: 0, leaseTtlMs: 1000, runIdleTimeoutMs: 120_000, runTotalTimeoutMs: 1_800_000, maxOutputTokens: 100 })
    expect(options({ maxOutputTokens: 'lots' }).maxOutputTokens).toBeUndefined()
    expect(options({ titleModel: 'fast' }).titleModel).toBe('fast')
    expect(options({ titleModel: 'off' }).titleModel).toBeUndefined()
    expect(options({ titleModel: false }).titleModel).toBeUndefined()
    vi.restoreAllMocks()
  })

  it('路径：模型表和工作目录在 dataDir 下，定义和文字技能按 @learning/agent-core 的包路径找', () => {
    const resolved = options()
    expect(resolved.modelsFile).toBe('/tmp/root/data/agent-models.json')
    expect(resolved.workspaceDir).toBe('/tmp/root/data/agent-workspaces')
    expect(fs.existsSync(path.join(resolved.definitionsDir, 'canvas.md'))).toBe(true)
    expect(fs.existsSync(path.join(resolved.textSkillsDir, 'README.md'))).toBe(true)
  })

  it('段的形状不对拒绝启动：不认识的字段（密钥写错地方也算，不回显值）、类型不对', () => {
    expect(() => options({ modle: 'qwen3' })).toThrow(/agent：不认识的字段 modle/)
    expect(() => options({ sandbox: { drivers: 'oci' } })).toThrow(/agent\.sandbox：不认识的字段 drivers/)
    expect(() => options({ sandbox: { oci: { sock: '/x' } } })).toThrow(/agent\.sandbox\.oci：不认识的字段 sock/)
    expect(() => options({ sandbox: 'process' })).toThrow(/agent\.sandbox 必须是映射/)
    expect(() => options({ provider: 3 })).toThrow(/agent\.provider 必须是字符串/)
    const literal = 'sk-real-secret-123'
    let message = ''
    try {
      options({ tokenSecret: literal })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('不认识的字段 tokenSecret')
    expect(message).not.toContain(literal)
  })
})

let engineServer: Server | null = null
let engineDir = ''

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
    if (req.url!.startsWith('/containers/json')) return json(200, [{ Id: 'orphan', Names: ['/shadecn-agent-run_old'], State: 'running', Labels: orphanLabels() }])
    if (req.method === 'DELETE') return res.writeHead(204).end()
    return json(404, { message: 'not found' })
  })
  await new Promise<void>((resolve) => engineServer!.listen(socketPath, resolve))
  return { socketPath, requests }
}

describe('装配', () => {
  // ollama 预设不要 key：模型这一关一定过，测的是驱动那一关
  const ollama = { provider: 'ollama', model: 'qwen3' }
  const apps: NestFastifyApplication[] = []
  const dirs: string[] = []

  beforeAll(() => {
    ensureRunnerBuilt()
  }, 120_000)

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (engineServer) {
      engineServer.closeAllConnections()
      await new Promise((resolve) => engineServer!.close(resolve))
      engineServer = null
    }
    if (engineDir) await rm(engineDir, { recursive: true, force: true })
    engineDir = ''
  })

  /** 起完整的 `AgentModule`（真工厂），拿生产那个 runtime */
  async function appWith(agent: Record<string, unknown>, extra: { env?: Record<string, string>; values?: Record<string, unknown>; isProduction?: boolean; quiet?: boolean } = {}) {
    if (extra.quiet !== false) silenceConsole()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-'))
    dirs.push(dir)
    const app = await bootAgentApp({ databaseUrl: `file:${path.join(dir, 'test.db')}`, dataDir: dir, values: { agent, ...extra.values }, s3: memoryS3().client, ...(extra.env ? { env: extra.env } : {}), ...(extra.isProduction ? { isProduction: true } : {}) })
    apps.push(app)
    return app
  }

  const runtimeWith = async (...args: Parameters<typeof appWith>) => (await appWith(...args)).get<AgentRuntime>(AGENT_RUNTIME, { strict: false })

  it('key：llm.providers 引用的变量优先；没写引用时退回提供方自己的变量（ANTHROPIC_API_KEY）；都没有 → 未启用并写明', async () => {
    const none = await runtimeWith({ sandbox: { driver: 'process' } })
    expect(none.enabled).toBe(false)
    expect(none.disabledReason).toBe('没有 anthropic 的 API key')

    const fromProvider = await runtimeWith({ sandbox: { driver: 'process' } }, { env: { ANTHROPIC_API_KEY: 'sk-ant-test' } })
    expect(fromProvider.enabled).toBe(true)

    const explicit = await runtimeWith({ sandbox: { driver: 'process' } }, { values: { llm: { providers: { anthropic: { apiKey: '$MY_ANTHROPIC_KEY', models: [] } } } }, env: { MY_ANTHROPIC_KEY: 'sk-explicit' } })
    expect(explicit.enabled).toBe(true)

    // 写了引用就只认它：变量没设 = 未启用，不再退回 ANTHROPIC_API_KEY
    const unset = await runtimeWith({ sandbox: { driver: 'process' } }, { values: { llm: { providers: { anthropic: { apiKey: '$MISSING_KEY', models: [] } } } }, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } })
    expect(unset.enabled).toBe(false)
    expect(unset.disabledReason).toContain('MISSING_KEY')
  })

  it('开发环境：process 驱动，启用', async () => {
    const runtime = await runtimeWith({ ...ollama, sandbox: { driver: 'process' } })
    expect(runtime.enabled).toBe(true)
  })

  it('生产环境：process 驱动不放行就未启用，原因写明；agent.sandbox.allowProcess 才启用', async () => {
    const refused = await runtimeWith({ ...ollama, sandbox: { driver: 'process' } }, { isProduction: true })
    expect(refused.enabled).toBe(false)
    expect(refused.disabledReason).toBe(PROCESS_DRIVER_REFUSED_IN_PRODUCTION)

    const allowed = await runtimeWith({ ...ollama, sandbox: { driver: 'process', allowProcess: true } }, { isProduction: true })
    expect(allowed.enabled).toBe(true)
  })

  it('oci：生产环境照常启用（不受 process 驱动的拒绝限制）；socket 找不到 → 未启用，原因写明该配哪一项', async () => {
    const { socketPath } = await fakeEngine(() => ({}))
    const enabled = await runtimeWith({ ...ollama, sandbox: { driver: 'oci', oci: { socket: socketPath } } }, { isProduction: true })
    expect(enabled.enabled).toBe(true)

    const missing = await runtimeWith({ ...ollama, sandbox: { driver: 'oci', oci: { socket: path.join(engineDir, 'gone.sock') } } }, { isProduction: true })
    expect(missing.enabled).toBe(false)
    expect(missing.disabledReason).toContain('agent.sandbox.oci.socket')
  })

  it('oci 启动：自检告警（镜像不存在、默认网络可以出网），并清掉本实例的孤儿容器（按 instance label 列）', async () => {
    let instance = ''
    const engine = await fakeEngine(() => ({ [OCI_LABELS.managed]: 'true', [OCI_LABELS.instance]: instance, [OCI_LABELS.run]: 'run_old' }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    // 监听一开始自检和清孤儿就开始了；这里算好标识再放假引擎回话
    const resolved = options({ sandbox: { driver: 'oci' } }, { values: { server: { port: 3100 } } })
    instance = agentSandboxInstance(resolved)
    expect(agentGatewayUrl(resolved)).toBe('http://host.docker.internal:3100/api/agent-gateway')

    const app = await appWith({ ...ollama, sandbox: { driver: 'oci', oci: { socket: engine.socketPath } } }, { values: { server: { port: 3100 } }, quiet: false })
    expect(app.get<AgentOptions>(AGENT_OPTIONS, { strict: false }).gatewayUrl).toBe('http://host.docker.internal:3100')
    await until(() => engine.requests.some((request) => request.method === 'DELETE'), '清掉孤儿容器')

    const warnings = warn.mock.calls.flat().join('\n')
    expect(warnings).toContain('镜像 learning-agent-runner:latest 不存在')
    expect(warnings).toMatch(/oci 沙箱可以出网：网络 bridge 不是 internal/)
    const list = engine.requests.find((request) => request.path.startsWith('/containers/json'))!
    expect(list.path).toContain(`"${OCI_LABELS.managed}=true","${OCI_LABELS.instance}=${instance}"`)
    expect(engine.requests.find((request) => request.method === 'DELETE')!.path).toMatch(/^\/containers\/orphan\?force=true/)
  })

  it('process 驱动：启动时不碰任何容器引擎（reap 是空操作）', async () => {
    const engine = await fakeEngine(() => ({}))
    vi.stubEnv('DOCKER_HOST', `unix://${engine.socketPath}`)
    await appWith({ ...ollama, sandbox: { driver: 'process', oci: { socket: engine.socketPath } } })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(engine.requests).toEqual([])
  })

  it('不认识的驱动：未启用，原因写明', async () => {
    const unknown = (await runtimeWith({ ...ollama, sandbox: { driver: 'docker' } })).disabledReason
    expect(unknown).toContain('agent.sandbox.driver=docker')
    expect(unknown).toContain('process / oci')
  })

  it('k8s：这个服务没有这个驱动，不启用，原因写明；生产也一样，不碰任何 API', async () => {
    const runtime = await runtimeWith({ ...ollama, sandbox: { driver: 'k8s' } }, { isProduction: true })
    expect(runtime.enabled).toBe(false)
    expect(runtime.disabledReason).toContain('agent.sandbox.driver=k8s')
    expect(runtime.disabledReason).toContain('没有 k8s 驱动')
  })
})

describe('runner 的启动命令', () => {
  beforeAll(() => {
    ensureRunnerBuilt()
  }, 120_000)

  it('node <agent-core 的 tsc 产物>/runner/main.js，不用 tsx，也不转发 --import', () => {
    const [node, ...rest] = runnerCommand()
    expect(node).toBe(process.execPath)
    expect(rest).toHaveLength(1)
    expect(rest[0]).toMatch(/packages\/agent-core\/dist\/runner\/main\.js$/)
  })

  it('产物真的能起：缺环境变量时退出码 2（不是找不到模块的 1）', () => {
    const [node, main] = runnerCommand()
    let code: number | null = null
    try {
      execFileSync(node, [main!], { env: { PATH: process.env.PATH ?? '' }, stdio: 'pipe' })
    } catch (error) {
      code = (error as { status: number }).status
    }
    expect(code).toBe(2)
  })
})
