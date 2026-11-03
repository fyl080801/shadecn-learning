import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fauxAssistantMessage, fauxToolCall, type Context } from '@earendil-works/pi-ai'
import type { AgentRuntime } from '@learning/agent-core/session'
import { gatewayFetch, registerScriptedModel, SCRIPTED_API_KEY, SCRIPTED_UPSTREAM_URL, TEST_GATEWAY_ORIGIN } from '@learning/agent-core/testing'
import { createInlineDriver } from '@learning/agent-core/testing'
import { TITLE_SYSTEM_PROMPT } from '../../agent-core/src/title.js'
import { ConfigService } from '@learning/config'
import { DataAccess } from '@learning/data-access'
import { SessionService } from '@learning/session'
import { AGENT_CONVERSATION_TITLE_EVENT, AgentEventType, type AgentStreamEvent } from '@learning/contracts/agent'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentCanvasAccess } from '../src/canvas-access.js'
import { AGENT_MODELS } from '../src/models.js'
import { AGENT_OPTIONS, resolveAgentOptions, type AgentOptions } from '../src/options.js'
import { AGENT_HOST_OPTIONS } from '../src/runtime.js'
import { AGENT_RUNTIME, SANDBOX_DRIVER } from '../src/sandbox.js'
import { agentTestModule, assertTestDatabase, bootAgentApp, createActor, createFlow, createProject, memoryS3, redisValues, silenceConsole, type BootOptions } from './helpers.js'

/** `AgentModule` 的装配（`docs/31` §7 第 5 步验收）：两种库上同步表结构后 diff 为空；没配也加载；坏配置拒绝启动；`k8s` 不启用；生产那份 runtime 的接线。 */

const TABLES = ['agent_conversation', 'agent_run', 'agent_tool_call', 'agent_grant', 'agent_grant_scope']

async function tableNames(app: NestFastifyApplication, schema?: string): Promise<string[]> {
  const orm = app.get(DataAccess).orm
  const connection = orm.em.getConnection() as unknown as { execute<T>(sql: string): Promise<T> }
  if (schema) return (await connection.execute<{ table_name: string }[]>(`select table_name from information_schema.tables where table_schema = '${schema}'`)).map((row) => row.table_name)
  return (await connection.execute<{ name: string }[]>(`select name from sqlite_master where type = 'table'`)).map((row) => row.name)
}

describe('表结构', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-module-'))

  beforeAll(() => silenceConsole())
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function syncedTwice(databaseUrl: string, schema?: string) {
    const boot: BootOptions = { databaseUrl, s3: null, values: schema ? redisValues() : {} }
    const first = await bootAgentApp(boot)
    try {
      expect(await tableNames(first, schema)).toEqual(expect.arrayContaining(TABLES))
      expect(await first.get(DataAccess).orm.schema.getUpdateSchemaSQL({ dropTables: false })).toBe('')
    } finally {
      await first.close()
    }
    const second = await bootAgentApp(boot)
    try {
      expect(await second.get(DataAccess).orm.schema.getUpdateSchemaSQL({ dropTables: false })).toBe('')
      const registered = [...second.get(DataAccess).orm.getMetadata().getAll().values()].map((meta) => meta.className)
      expect(registered).toEqual(expect.arrayContaining(['AgentConversation', 'AgentRun', 'AgentToolCall', 'AgentGrant', 'AgentGrantScope']))
    } finally {
      if (schema) {
        assertTestDatabase(databaseUrl.split('?')[0]!)
        await second.get(DataAccess).orm.schema.execute(`drop schema if exists ${schema} cascade`)
      }
      await second.close()
    }
  }

  it('SQLite：同步后 diff 为空，再启动一次还是空', async () => {
    await syncedTwice(`file:${path.join(dir, 'twice.db')}`)
  }, 30_000)

  it.skipIf(!process.env.PLATFORM_TEST_DATABASE_URL)('PostgreSQL：同步后 diff 为空，再启动一次还是空', async () => {
    await syncedTwice(`${process.env.PLATFORM_TEST_DATABASE_URL}?schema=agent_module`, 'agent_module')
  }, 30_000)

  it('实体只由 import 模块的进程登记：没 import 的进程没有这些表', async () => {
    const app = await bootAgentApp({ databaseUrl: `file:${path.join(dir, 'without.db')}`, s3: null, withoutAgent: true })
    try {
      const names = await tableNames(app)
      expect(names).toContain('flow')
      for (const table of TABLES) expect(names).not.toContain(table)
    } finally {
      await app.close()
    }
  }, 30_000)

  it('一个进程里 agent 的表和 canvas 的外键对得上：agent_conversation 指向 flow 和 user', async () => {
    const app = await bootAgentApp({ databaseUrl: `file:${path.join(dir, 'fk.db')}`, s3: null })
    try {
      const connection = app.get(DataAccess).orm.em.getConnection() as unknown as { execute<T>(sql: string): Promise<T> }
      const rows = await connection.execute<{ table: string; on_delete: string }[]>(`pragma foreign_key_list('agent_conversation')`)
      expect(rows.map((row) => [row.table, row.on_delete]).sort()).toEqual([
        ['flow', 'CASCADE'],
        ['user', 'CASCADE'],
      ])
    } finally {
      await app.close()
    }
  }, 30_000)
})

describe('启动', () => {
  const dirs: string[] = []
  const apps: NestFastifyApplication[] = []

  function bootOptions(extra: Partial<BootOptions> = {}): BootOptions {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-boot-'))
    dirs.push(dir)
    return { databaseUrl: `file:${path.join(dir, 'test.db')}`, dataDir: dir, s3: null, ...extra }
  }

  async function boot(extra: Partial<BootOptions> = {}) {
    const app = await bootAgentApp(bootOptions(extra))
    apps.push(app)
    return app
  }

  /** 用定义目录 / 文字技能目录替换后的配置起模块 */
  const withDirs = (dirsOverride: Partial<AgentOptions>): BootOptions['override'] => (builder) => {
    builder.overrideProvider(AGENT_OPTIONS).useFactory({
      inject: [ConfigService, SessionService],
      factory: (config: ConfigService, session: SessionService) => ({ ...resolveAgentOptions(config, session), ...dirsOverride }),
    })
  }

  beforeAll(() => silenceConsole())

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  describe('没配 agent', () => {
    it('照样加载：enabled false，view 回 enabled: false，发消息回 disabled；画布别的功能不受影响', async () => {
      const app = await boot()
      const runtime = app.get<AgentRuntime>(AGENT_RUNTIME, { strict: false })
      expect(runtime.enabled).toBe(false)
      expect(runtime.disabledReason).toBe('没有 anthropic 的 API key')

      const alice = await createActor(app)
      const flowId = await createFlow(alice, await createProject(alice))
      expect(await runtime.view(flowId, alice.userId)).toMatchObject({ enabled: false })
      const started = await runtime.start({ flowId, userId: alice.userId, conversationId: null, text: '你好', openCanvas: () => Promise.reject(new Error('不该打开画布')), emit: () => {} })
      expect(started).toMatchObject({ ok: false, reason: 'disabled' })
    })

    it('agent 段写成空也一样', async () => {
      const app = await boot({ values: { agent: null } })
      expect(app.get<AgentRuntime>(AGENT_RUNTIME, { strict: false }).enabled).toBe(false)
    })
  })

  describe('坏配置拒绝启动', () => {
    const rejectsBoot = (extra: Partial<BootOptions>) => agentTestModule(bootOptions(extra)).compile()

    it('模型表文件坏了：不是 JSON、写了 default（启用与否都查）', async () => {
      const options = bootOptions()
      fs.writeFileSync(path.join(options.dataDir!, 'agent-models.json'), '{ not json')
      await expect(agentTestModule(options).compile()).rejects.toThrow(/模型表 .*agent-models\.json：不是合法的 JSON/)

      const other = bootOptions()
      fs.writeFileSync(path.join(other.dataDir!, 'agent-models.json'), '{"default":{}}')
      await expect(agentTestModule(other).compile()).rejects.toThrow(/「default」：default 不能写在文件里/)
    })

    it('模型表里某一项用不了（$ENV 没设）不算坏配置：起得来，到用时才报', async () => {
      const options = bootOptions()
      fs.writeFileSync(path.join(options.dataDir!, 'agent-models.json'), JSON.stringify({ fast: { provider: 'anthropic', model: 'claude-sonnet-4-6' } }))
      const app = await bootAgentApp(options)
      apps.push(app)
      expect(app.get<Record<string, unknown>>(AGENT_MODELS, { strict: false }).fast).toEqual({ ok: false, reason: '没有 anthropic 的 API key' })
    })

    it('agent 定义坏了：不认识的 frontmatter、引用了模型表没有的键、没有 canvas、目录不存在', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-defs-'))
      dirs.push(dir)
      const write = (name: string, frontmatter: string) => fs.writeFileSync(path.join(dir, name), `---\nname: ${name.replace('.md', '')}\ndescription: 测试\n${frontmatter}---\n正文\n`)
      write('canvas.md', 'surprise: yes\n')
      await expect(rejectsBoot({ override: withDirs({ definitionsDir: dir }) })).rejects.toThrow(/surprise/)

      write('canvas.md', 'model: nope\n')
      await expect(rejectsBoot({ override: withDirs({ definitionsDir: dir }) })).rejects.toThrow(/nope/)

      fs.rmSync(path.join(dir, 'canvas.md'))
      write('other.md', '')
      await expect(rejectsBoot({ override: withDirs({ definitionsDir: dir }) })).rejects.toThrow(/canvas/)

      await expect(rejectsBoot({ override: withDirs({ definitionsDir: path.join(dir, 'gone') }) })).rejects.toThrow()
    })

    it('文字技能坏了：缺 description、名字撞内置技能', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-'))
      dirs.push(dir)
      fs.mkdirSync(path.join(dir, 'broken'))
      fs.writeFileSync(path.join(dir, 'broken', 'SKILL.md'), '---\nname: broken\n---\n正文\n')
      await expect(rejectsBoot({ override: withDirs({ textSkillsDir: dir }) })).rejects.toThrow(/description/)

      fs.writeFileSync(path.join(dir, 'broken', 'SKILL.md'), '---\nname: canvas\ndescription: 撞名\n---\n正文\n')
      await expect(rejectsBoot({ override: withDirs({ textSkillsDir: dir }) })).rejects.toThrow(/canvas/)
    })

    it('文字技能目录不存在 = 没有，不是错误', async () => {
      const app = await boot({ override: withDirs({ textSkillsDir: path.join(os.tmpdir(), 'agent-skills-nope') }) })
      expect(app.get<AgentRuntime>(AGENT_RUNTIME, { strict: false }).enabled).toBe(false)
    })

    it('agent 段不认识的字段、llm.providers 写了明文 key（不回显）、titleModel 不在模型表', async () => {
      await expect(rejectsBoot({ values: { agent: { modle: 'qwen3' } } })).rejects.toThrow(/不认识的字段 modle/)
      await expect(rejectsBoot({ values: { agent: 'on' } })).rejects.toThrow(/agent 段必须是映射/)
      const literal = 'sk-real-secret-123'
      const err = await rejectsBoot({ values: { llm: { providers: { selfhost: { apiKey: literal, models: [] } } } } }).then(() => null, (error: Error) => error)
      expect(err?.message).toContain('llm.providers')
      expect(err?.message).not.toContain(literal)
      // 启用与否都查：写错的键不该等到有人配上模型才发现
      await expect(rejectsBoot({ values: { agent: { titleModel: 'nope' } } })).rejects.toThrow(/titleModel「nope」不在模型表里/)
    })
  })

  describe('k8s', () => {
    it('写 driver: k8s：照样加载，agent 不启用，原因写明', async () => {
      const app = await boot({ values: { agent: { provider: 'ollama', model: 'qwen3', sandbox: { driver: 'k8s' } } } })
      const runtime = app.get<AgentRuntime>(AGENT_RUNTIME, { strict: false })
      expect(runtime.enabled).toBe(false)
      expect(runtime.disabledReason).toMatch(/agent\.sandbox\.driver=k8s：这个服务没有 k8s 驱动/)
    })
  })

  describe('生产那份 runtime 的接线（真的 AGENT_RUNTIME，只把驱动换成进程内的）', () => {
    const scriptedProvider = {
      llm: { providers: { scripted: { baseUrl: SCRIPTED_UPSTREAM_URL, api: 'openai-completions', apiKey: '$SCRIPTED_KEY', models: [{ id: 'scripted-model', input: ['text', 'image'] }] } } },
    }

    /** 全局 fetch：发往测试网关的交给网关，发往脚本化上游的交给它（生产的 runtime 没有注入 `upstreamFetch`，走 SDK 默认的全局 fetch） */
    async function production(extra: { agent?: Record<string, unknown>; s3?: BootOptions['s3'] } = {}) {
      const scripted = registerScriptedModel({ imageInput: true })
      const app = await boot({
        values: { ...scriptedProvider, agent: { provider: 'scripted', model: 'scripted-model', gatewayUrl: TEST_GATEWAY_ORIGIN, ...extra.agent } },
        env: { SCRIPTED_KEY: SCRIPTED_API_KEY },
        s3: extra.s3 === undefined ? null : extra.s3,
        override: (builder) => {
          builder.overrideProvider(SANDBOX_DRIVER).useValue({ ok: true, driver: createInlineDriver() })
        },
      })
      const runtime = app.get<AgentRuntime>(AGENT_RUNTIME, { strict: false })
      vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request), scripted.fetch))
      return { app, runtime, scripted }
    }

    async function run(app: NestFastifyApplication, runtime: AgentRuntime) {
      const alice = await createActor(app)
      const flowId = await createFlow(alice, await createProject(alice))
      const events: AgentStreamEvent[] = []
      const access = app.get(AgentCanvasAccess, { strict: false })
      const started = await runtime.start({ flowId, userId: alice.userId, conversationId: null, text: '你好', openCanvas: (runId, authority) => access.open({ flowId, userId: alice.userId, runId, authority }), emit: (event) => events.push(event) })
      if (!started.ok) throw new Error(`应该启动成功：${started.message}`)
      await started.done
      return { events, flowId }
    }

    const isTitle = (context: Context) => context.systemPrompt === TITLE_SYSTEM_PROMPT
    const answer = (title: string) => (context: Context) => (isTitle(context) ? fauxAssistantMessage(title) : fauxAssistantMessage('好的'))

    it('titleModel 只在生产那份 runtime 上：宿主接线里没有，默认按 default 生成标题', async () => {
      const { app, runtime, scripted } = await production()
      expect(app.get<object>(AGENT_HOST_OPTIONS, { strict: false })).not.toHaveProperty('titleModel')
      expect(runtime.enabled).toBe(true)
      scripted.setResponses([answer('生成的标题'), answer('生成的标题')])
      const { events } = await run(app, runtime)
      expect(events.filter((event) => event.type === AgentEventType.CUSTOM && event.name === AGENT_CONVERSATION_TITLE_EVENT)).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    })

    it('titleModel: off：不生成，上游只收到这一轮的请求', async () => {
      const { app, runtime, scripted } = await production({ agent: { titleModel: 'off' } })
      scripted.setResponses([fauxAssistantMessage('好的')])
      const { events } = await run(app, runtime)
      expect(scripted.requests).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ outcome: { type: 'success' } })
    })

    it('thinking 写错了：警告，当没配，agent 照常启用', async () => {
      const warn = vi.mocked(console.warn)
      warn.mockClear()
      const { runtime } = await production({ agent: { thinking: 'extreme', titleModel: 'off' } })
      expect(runtime.enabled).toBe(true)
      expect(warn.mock.calls.flat().join('\n')).toContain('agent.thinking=extreme 不认识')
    })

    it('agent.maxOutputTokens 传到模型请求上', async () => {
      const { app, runtime, scripted } = await production({ agent: { maxOutputTokens: 123, titleModel: 'off' } })
      scripted.setResponses([fauxAssistantMessage('好的')])
      await run(app, runtime)
      const body = scripted.requests[0]!.body as { max_tokens?: number; max_completion_tokens?: number }
      expect(body.max_completion_tokens ?? body.max_tokens).toBe(123)
    })

    /** 看图工具开不开：技能 media-view 加载得上就是开了 */
    const loadMediaView = () => [
      fauxAssistantMessage([fauxToolCall('load_skill', { id: 'media-view' })], { stopReason: 'toolUse' }),
      (context: Context) => {
        const result = context.messages.filter((message) => message.role === 'toolResult').at(-1)
        return fauxAssistantMessage(result && result.role === 'toolResult' ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : '')
      },
    ]

    it('没配 S3 不接 mediaReader：模型吃图也加载不了 media-view', async () => {
      const { app, runtime, scripted } = await production({ agent: { titleModel: 'off' } })
      scripted.setResponses(loadMediaView())
      await run(app, runtime)
      const lastRequest = JSON.stringify(scripted.requests.at(-1)!.body)
      expect(lastRequest).not.toContain('view_node_media')
    })

    it('配了 S3 接上 mediaReader：模型吃图就能加载 media-view', async () => {
      const { app, runtime, scripted } = await production({ agent: { titleModel: 'off' }, s3: memoryS3().client })
      scripted.setResponses(loadMediaView())
      await run(app, runtime)
      expect(JSON.stringify(scripted.requests.at(-1)!.body)).toContain('view_node_media')
    })

  })
})
