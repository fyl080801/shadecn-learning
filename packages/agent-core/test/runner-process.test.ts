import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { nodesMap } from '@learning/contracts/flow-doc'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createMemoryAuthorityProvider } from '../src/authority.js'
import { createDocCanvasHandle } from '../src/canvas.js'
import { AGENT_GATEWAY_PATH } from '../src/protocol.js'
import { createProcessDriver } from '../src/sandbox/drivers/process.js'
import { createAgentRuntime } from '../src/session.js'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.js'
import { AGENT_DEFINITIONS_DIR, registerScriptedModel, TEST_TOKEN_SECRET } from '../src/testing.js'

const packageDir = path.resolve(import.meta.dirname, '..')
// 本包自己的 dist/（`pnpm build` 的产物，这里重新构建一次保证是最新的）：产物里的 external 从这里往上解析到本包声明的依赖（pi、yaml、@learning/*）
const outdir = path.join(packageDir, 'dist')
const tsc = createRequire(path.join(packageDir, 'package.json')).resolve('typescript/bin/tsc')

/**
 * 真实的 tsc 产物起真子进程。源码测试走的是 vitest 的 alias，看不出 ESM 解析、依赖声明够不够、runner 的闭包有没有漏文件。
 * 这里 runner 是 `node <产物>/runner/main.js`（`process` 驱动，docs/31 §3.3 的 R1），经真实 HTTP 连回网关；
 * 上游是脚本化的（不调真实模型），节点写进内存里的 Y.Doc。
 */
describe('tsc 产物的 runner（process 驱动，真子进程）', () => {
  let server: Server | undefined
  let workspaces = ''

  beforeAll(() => {
    // 产物 import 的是 @learning/contracts、@learning/llm 的 dist（Node 解析，不走 vitest 的 alias），所以要先有它们
    for (const dir of ['../contracts', '../llm']) {
      execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: path.resolve(packageDir, dir), stdio: 'pipe' })
    }
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: packageDir, stdio: 'pipe' })
    workspaces = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-runner-'))
  }, 120_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    fs.rmSync(workspaces, { recursive: true, force: true })
  })

  it('缺环境变量时退出码 2，不启动', () => {
    let code: number | null = null
    try {
      execFileSync(process.execPath, [path.join(outdir, 'runner/main.js')], { env: { PATH: process.env.PATH ?? '' }, stdio: 'pipe' })
    } catch (error) {
      code = (error as { status: number }).status
    }
    expect(code).toBe(2)
  })

  it('跑完一轮：节点写进 Y.Doc，事件从 RUN_STARTED 到 RUN_FINISHED', async () => {
    const scripted = registerScriptedModel()
    scripted.setResponses([
      fauxAssistantMessage([fauxText('我来加'), fauxToolCall('add_node', { type: 'text', metadata: { label: '探针' }, data: { text: '内容' } })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('加好了'),
    ])

    // 网关：Fastify / Nest 之外的最小宿主，把 Node 的请求换成 Request → Response 处理函数（同宿主要做的事）
    let handle: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 })
    server = createServer(async (req, res) => {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
      } as RequestInit)
      const response = await handle(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (!response.body) return void res.end()
      const reader = response.body.getReader()
      res.on('close', () => void reader.cancel().catch(() => {}))
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
      res.end()
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    const output: string[] = []
    const driver = createProcessDriver({
      command: [process.execPath, path.join(outdir, 'runner/main.js')],
      rootDir: workspaces,
      pathEnv: process.env.PATH ?? '/usr/bin:/bin',
      production: false,
      onOutput: (_runId, _stream, line) => output.push(line),
    })
    const runtime = createAgentRuntime({
      ...scripted.runtimeOptions(driver),
      driver,
      gateway: { url: `http://127.0.0.1:${port}${AGENT_GATEWAY_PATH}`, secret: TEST_TOKEN_SECRET, upstreamFetch: scripted.fetch },
      store: createMemoryConversationStore(),
      runLog: createMemoryRunLog(),
      authorities: createMemoryAuthorityProvider(),
      userProfiles: async (ids: string[]) => new Map(ids.map((id) => [id, { id, name: id, avatarUrl: null }])),
    })
    handle = (request) => runtime.gateway.handle(request)

    const doc = new Y.Doc()
    const events: { type: string }[] = []
    const started = await runtime.start({
      flowId: 'flow-1',
      userId: 'u1',
      conversationId: null,
      text: '加一个节点',
      openCanvas: async (runId) => ({ ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }), async close() {} }),
      emit: (event) => events.push(event as { type: string }),
    })
    expect(started.ok).toBe(true)
    if (started.ok) await started.done

    const types = events.map((event) => event.type)
    expect(output.join('\n')).not.toMatch(/Cannot find|ERR_MODULE_NOT_FOUND|ERR_PACKAGE/)
    expect(types[0]).toBe('RUN_STARTED')
    expect(types.at(-1)).toBe('RUN_FINISHED')
    expect(types).not.toContain('RUN_ERROR')
    const nodes = [...nodesMap(doc).values()]
    expect(nodes).toHaveLength(1)
  }, 60_000)

  it('agent 定义目录：源码路径、产物路径、包路径都指向同一份，随包的资源文件都在', async () => {
    const dist = (await import(/* @vite-ignore */ pathToFileURL(path.join(outdir, 'testing.js')).href)) as { AGENT_DEFINITIONS_DIR: string }
    expect(fs.realpathSync(dist.AGENT_DEFINITIONS_DIR)).toBe(fs.realpathSync(AGENT_DEFINITIONS_DIR))

    // 宿主按包路径定位：包自引用 + `./package.json` 导出
    const root = path.dirname(createRequire(path.join(packageDir, 'package.json')).resolve('@learning/agent-core/package.json'))
    expect(fs.realpathSync(path.join(root, 'agents'))).toBe(fs.realpathSync(AGENT_DEFINITIONS_DIR))
    for (const file of ['agents/canvas.md', 'agents/reviewer.md', 'skills/README.md']) expect(fs.existsSync(path.join(root, file)), file).toBe(true)
  })
})
