import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSandboxProvider } from '../../src/sandbox/local.ts'
import { createMediaTool } from '../../src/sandbox/media-tool.ts'
import type { ExecOptions, ExecResult, Sandbox } from '../../src/sandbox/types.ts'

/**
 * 本地沙箱只防两件事：凭据经环境变量泄露、误操作（白名单 / 超时 / 截断 / 路径穿越）。
 * 这里一条条钉住。测试里的白名单换成 `env` / `sleep` / `printf` 这类系统自带命令 ——
 * 不要求开发机装了 ffmpeg，被测的是沙箱本身的规矩，与具体命令无关。
 */

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-sandbox-'))
})

afterEach(async () => {
  delete process.env.AGENT_SANDBOX_TEST_SECRET
  await rm(root, { recursive: true, force: true })
})

const EXEC = { timeoutMs: 5000, maxOutputBytes: 64 * 1024 }

function provider(allowedCommands: string[] = ['env', 'sleep', 'printf', 'cat']) {
  return new LocalSandboxProvider({ rootDir: root, allowedCommands, pathEnv: '/usr/bin:/bin' })
}

describe('环境变量', () => {
  it('子进程拿不到服务端进程的任何变量（LLM key、数据库连接串…），只有 PATH / HOME / TMPDIR', async () => {
    process.env.AGENT_SANDBOX_TEST_SECRET = 'sk-should-never-leak'
    const sandbox = await provider().create('flow1', 'run1')
    const result = await sandbox.exec('env', [], EXEC)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('sk-should-never-leak')
    const keys = result.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('=')[0])
      .filter((name) => name && name !== '__CF_USER_TEXT_ENCODING')
      .sort()
    expect(keys).toEqual(['HOME', 'PATH', 'TMPDIR'])
    expect(result.stdout).toContain(`HOME=${sandbox.workdir}`)
    await sandbox.dispose()
  })
})

describe('命令白名单', () => {
  it('白名单外的命令、带路径的命令一律拒绝', async () => {
    const sandbox = await provider(['printf']).create('flow1', 'run1')
    await expect(sandbox.exec('sh', ['-c', 'echo hi'], EXEC)).rejects.toThrow('白名单')
    await expect(sandbox.exec('/usr/bin/printf', ['x'], EXEC)).rejects.toThrow('白名单')
    await expect(sandbox.exec('./printf', ['x'], EXEC)).rejects.toThrow('白名单')
    await sandbox.dispose()
  })

  it('不经 shell：参数里的 ; 和 $() 只是字面量', async () => {
    const sandbox = await provider(['printf']).create('flow1', 'run1')
    const result = await sandbox.exec('printf', ['%s', 'a; echo pwned $(id)'], EXEC)
    expect(result.stdout).toBe('a; echo pwned $(id)')
    await sandbox.dispose()
  })

  it('参数里的绝对路径、.. 段、URL 一律拒绝', async () => {
    const sandbox = await provider().create('flow1', 'run1')
    await expect(sandbox.exec('cat', ['/etc/passwd'], EXEC)).rejects.toThrow('绝对路径')
    await expect(sandbox.exec('cat', ['../../secret'], EXEC)).rejects.toThrow('..')
    await expect(sandbox.exec('cat', ['http://evil.example/x'], EXEC)).rejects.toThrow('协议')
    await sandbox.dispose()
  })
})

describe('超时与截断', () => {
  it('超时即强杀，timedOut=true', async () => {
    const sandbox = await provider().create('flow1', 'run1')
    const started = Date.now()
    const result = await sandbox.exec('sleep', ['5'], { timeoutMs: 200, maxOutputBytes: 1024 })
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGKILL')
    expect(Date.now() - started).toBeLessThan(3000)
    await sandbox.dispose()
  })

  it('输出超过上限就截断', async () => {
    const sandbox = await provider().create('flow1', 'run1')
    await sandbox.writeFile('big.txt', 'x'.repeat(10_000))
    const result = await sandbox.exec('cat', ['big.txt'], { timeoutMs: 5000, maxOutputBytes: 100 })
    expect(result.stdout).toHaveLength(100)
    expect(result.truncated).toBe(true)
    await sandbox.dispose()
  })
})

describe('路径穿越', () => {
  it('读写只限工作目录：../、绝对路径都拒', async () => {
    const sandbox = await provider().create('flow1', 'run1')
    await expect(sandbox.writeFile('../escape.txt', 'x')).rejects.toThrow('工作目录')
    await expect(sandbox.writeFile('/tmp/escape.txt', 'x')).rejects.toThrow('相对路径')
    await expect(sandbox.readFile('../../etc/passwd')).rejects.toThrow('工作目录')
    expect(await readdir(path.join(root, 'flow1'))).toEqual(['run1'])
    await sandbox.dispose()
  })

  it('符号链接逃逸也挡：链接指向工作目录外的文件读不到，链接指向外部目录写不进', async () => {
    const outside = path.join(root, 'outside')
    await writeFile(outside, 'secret')
    const sandbox = await provider().create('flow1', 'run1')
    await symlink(outside, path.join(sandbox.workdir, 'link.txt'))
    await expect(sandbox.readFile('link.txt')).rejects.toThrow('工作目录')
    await expect(sandbox.writeFile('link.txt', 'overwrite')).rejects.toThrow('符号链接')

    await symlink(root, path.join(sandbox.workdir, 'dir'))
    await expect(sandbox.writeFile('dir/planted.txt', 'x')).rejects.toThrow('工作目录')
    await sandbox.dispose()
  })

  it('正常读写；dispose 删掉整个工作目录', async () => {
    const sandbox = await provider().create('flow1', 'run1')
    await sandbox.writeFile('sub/a.json', '{"ok":true}')
    expect(new TextDecoder().decode(await sandbox.readFile('sub/a.json'))).toBe('{"ok":true}')
    await sandbox.dispose()
    expect(await readdir(path.join(root, 'flow1'))).toEqual([])
    await expect(sandbox.readFile('sub/a.json')).rejects.toThrow('已销毁')
  })

  it('flowId / runId 不能拿来拼出别的目录', async () => {
    await expect(provider().create('../x', 'run1')).rejects.toThrow('目录名')
    await expect(provider().create('flow1', 'a/b')).rejects.toThrow('目录名')
  })
})

describe('中止即杀（docs/22 §10 验收 5）', () => {
  // 测试专用的白名单：`sleep` 当「跑很久的媒体命令」
  it('signal 一掐就 SIGKILL 子进程：不等它跑完，aborted=true', async () => {
    const sandbox = await provider(['sleep']).create('flow1', 'run1')
    const ac = new AbortController()
    const started = Date.now()
    const running = sandbox.exec('sleep', ['30'], { ...EXEC, timeoutMs: 60_000, signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    const result = await running
    expect(result).toMatchObject({ aborted: true, timedOut: false, signal: 'SIGKILL', exitCode: null })
    expect(Date.now() - started).toBeLessThan(3000)
    await sandbox.dispose()
  })

  it('调用前就已掐掉：不启动，直接拒绝', async () => {
    const sandbox = await provider(['sleep']).create('flow1', 'run1')
    const ac = new AbortController()
    ac.abort()
    await expect(sandbox.exec('sleep', ['30'], { ...EXEC, signal: ac.signal })).rejects.toThrow('已中止')
    await sandbox.dispose()
  })

  it('dispose 先杀掉还在跑的子进程、等它退出，再删工作目录', async () => {
    const sandbox = await provider(['sleep']).create('flow1', 'run1')
    const started = Date.now()
    const running = sandbox.exec('sleep', ['30'], { ...EXEC, timeoutMs: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await sandbox.dispose()
    expect(await running).toMatchObject({ signal: 'SIGKILL', exitCode: null })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(await readdir(path.join(root, 'flow1'))).toEqual([])
  })

  it('媒体工具把 pi 的 signal 交给沙箱；被中止的命令回报为错误', async () => {
    let seen: AbortSignal | undefined
    const fake = {
      workdir: '/w',
      writeFile: async () => {},
      readFile: async () => new Uint8Array(),
      async exec(_command: string, _args: readonly string[], options: ExecOptions): Promise<ExecResult> {
        seen = options.signal
        return { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false }
      },
      dispose: async () => {},
    } satisfies Sandbox
    const ac = new AbortController()
    const tool = createMediaTool(fake)
    await expect(tool.execute('call', { command: 'ffmpeg', args: ['-i', 'a.mp4'] } as never, ac.signal)).rejects.toThrow('中止')
    expect(seen).toBe(ac.signal)
  })
})
