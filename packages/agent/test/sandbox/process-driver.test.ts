import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SandboxSpec } from '../../src/sandbox/driver.ts'
import {
  createProcessDriver,
  PROCESS_DRIVER_REFUSED_IN_PRODUCTION,
  runnerEnv,
  type ProcessSandboxHandle,
} from '../../src/sandbox/drivers/process.ts'

/**
 * `process` 驱动（docs/22 §7）：真的 spawn 子进程。runner 本身换成几行探针脚本（这里只测驱动：
 * 环境从零造、整组杀、时长兜底、工作目录清理、生产拒绝）；真的 runner 经它跑完一轮在 apps/server 的用例里。
 */

let root = ''

afterEach(async () => {
  vi.unstubAllEnvs()
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    runId: 'run_1',
    flowId: 'flow_1',
    ownerId: 'u1',
    grantId: 'g1',
    image: '',
    resources: { cpu: 1, memoryMiB: 256, pids: 32, diskMiB: 64, deadlineMs: 30_000 },
    gatewayUrl: 'http://127.0.0.1:1/api/agent-gateway',
    credential: { kind: 'bootstrap', token: 'one-time-token' },
    ...overrides,
  }
}

async function driverWith(script: string, extra: Partial<Parameters<typeof createProcessDriver>[0]> = {}) {
  root = await mkdtemp(path.join(tmpdir(), 'agent-driver-'))
  const lines: string[] = []
  const driver = createProcessDriver({
    command: [process.execPath, '-e', script],
    rootDir: root,
    pathEnv: '/usr/bin:/bin',
    production: false,
    onOutput: (_runId, _stream, line) => lines.push(line),
    ...extra,
  })
  return { driver, lines }
}

const gone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function until(check: () => boolean, ms = 5000) {
  for (const started = Date.now(); !check(); ) {
    if (Date.now() - started > ms) throw new Error('等不到')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('process 驱动', () => {
  it('runner 的环境从零造：只有 PATH + 网关地址 + 一次性 token + 工作目录；服务端的密钥一个都不继承', async () => {
    vi.stubEnv('AGENT_API_KEY', 'sk-should-not-leak')
    vi.stubEnv('DATABASE_URL', 'postgresql://secret@db/app')
    vi.stubEnv('SESSION_SECRET', 'session-secret')
    vi.stubEnv('REDIS_URL', 'redis://:pw@redis:6379')
    const { driver, lines } = await driverWith('console.log(JSON.stringify({ env: process.env, cwd: process.cwd() }))')
    const handle = (await driver.start(spec())) as ProcessSandboxHandle
    expect(await handle.wait()).toEqual({ exitCode: 0 })

    const report = JSON.parse(lines[0]!) as { env: Record<string, string>; cwd: string }
    // macOS 的 libSystem 给每个新进程注入 __CF_USER_TEXT_ENCODING（CoreFoundation 的文本编码）：系统加的，不是继承来的
    const env = Object.fromEntries(Object.entries(report.env).filter(([key]) => key !== '__CF_USER_TEXT_ENCODING'))
    expect(Object.keys(env).sort()).toEqual(['PATH', 'SHADECN_BOOTSTRAP_TOKEN', 'SHADECN_GATEWAY_URL', 'SHADECN_WORKDIR'])
    expect(env).toEqual(runnerEnv(spec(), handle.workdir, '/usr/bin:/bin'))
    expect(JSON.stringify(report.env)).not.toMatch(/sk-should-not-leak|secret@db|session-secret|redis:/)
    expect(report.cwd).toBe(handle.workdir)
    // 退出之后工作目录清掉
    await expect(stat(handle.workdir)).rejects.toThrow()
  })

  it('kill 整组杀：runner 和它起的子进程（ffmpeg 那种）都立即没了，工作目录清理', async () => {
    const script = [
      "const { spawn } = require('node:child_process')",
      "const child = spawn('sleep', ['30'], { stdio: 'ignore' })",
      'console.log(JSON.stringify({ runner: process.pid, child: child.pid }))',
      'setInterval(() => {}, 1000)',
    ].join(';')
    const { driver, lines } = await driverWith(script)
    const handle = (await driver.start(spec())) as ProcessSandboxHandle
    await until(() => lines.length > 0)
    const pids = JSON.parse(lines[0]!) as { runner: number; child: number }
    expect(pids.runner).toBe(handle.pid)
    expect(gone(pids.child)).toBe(false)

    const at = Date.now()
    await handle.kill('已中止')
    expect(Date.now() - at).toBeLessThan(3000)
    expect(await handle.wait()).toEqual({ exitCode: null, reason: '已中止' })
    expect(gone(pids.runner)).toBe(true)
    await until(() => gone(pids.child))
    await expect(stat(handle.workdir)).rejects.toThrow()
  })

  it('超过 deadlineMs 兜底杀掉，原因写明', async () => {
    const { driver } = await driverWith('setInterval(() => {}, 1000)')
    const handle = await driver.start(spec({ resources: { ...spec().resources, deadlineMs: 200 } }))
    const exit = await handle.wait()
    expect(exit.exitCode).toBeNull()
    expect(exit.reason).toContain('时长上限')
  })

  it('生产环境拒绝，除非显式放行；id 不能做目录名的拒绝', async () => {
    expect(() => createProcessDriver({ command: [process.execPath], rootDir: '/tmp', production: true })).toThrow(
      PROCESS_DRIVER_REFUSED_IN_PRODUCTION,
    )
    expect(() => createProcessDriver({ command: [process.execPath], rootDir: '/tmp', production: true, allowInProduction: true })).not.toThrow()
    const { driver } = await driverWith('0')
    await expect(driver.start(spec({ runId: '../escape' }))).rejects.toThrow('目录名')
  })

  it('进程起不来（命令不存在）→ start 失败，工作目录不留', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'agent-driver-'))
    const driver = createProcessDriver({ command: ['/definitely/not/here'], rootDir: root, production: false })
    await expect(driver.start(spec())).rejects.toThrow('沙箱进程起不来')
    await expect(stat(path.join(root, 'flow_1', 'run_1'))).rejects.toThrow()
  })
})
