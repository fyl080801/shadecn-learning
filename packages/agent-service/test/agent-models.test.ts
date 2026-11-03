import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { LlmProviderDef } from '@learning/llm/llm-config'
import { afterAll, describe, expect, it } from 'vitest'
import { loadAgentModelTable, parseAgentModelTable, resolveAgentModelTable } from '../src/models.js'

/**
 * 模型表文件（docs/26 §3.4）：`<dataDir>/agent-models.json`，每项只选「哪个提供方的哪个模型」。
 * 文件本身不对 → 启动失败（抛）；某一项用不了（`$ENV` 没设、注册表里没有）→ 不抛，解析结果记成不可用，到用时才报。
 * 从 `apps/server/test/agent/agent-models.test.ts` 移植。
 */

const parse = (value: unknown) => () => parseAgentModelTable(typeof value === 'string' ? value : JSON.stringify(value), '/data/agent-models.json')

describe('解析模型表文件（形状不对 → 启动失败）', () => {
  it('合法的文件：只有 provider / model / thinking', () => {
    expect(
      parse({
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        vision: { provider: 'my-proxy', model: 'qwen-vl', thinking: 'low' },
      })(),
    ).toEqual({
      fast: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      vision: { provider: 'my-proxy', model: 'qwen-vl', thinking: 'low' },
    })
    expect(parse({})()).toEqual({})
  })

  it('不是 JSON、顶层不是对象、一项不是对象 → 抛错，指出文件', () => {
    expect(parse('{ fast: ')).toThrow(/模型表 \/data\/agent-models\.json：不是合法的 JSON/)
    expect(parse([])).toThrow(/顶层必须是对象/)
    expect(parse({ fast: 'claude' })).toThrow(/「fast」：必须是对象/)
  })

  it('写了 default、key 不合法 → 抛错', () => {
    expect(parse({ default: { provider: 'anthropic', model: 'x' } })).toThrow(/「default」：default 不能写在文件里，它来自 config\.yaml 的 agent\.provider/)
    expect(parse({ Fast: { provider: 'anthropic', model: 'x' } })).toThrow(/「Fast」：key 不合法/)
    expect(parse({ 'fast model': { provider: 'anthropic', model: 'x' } })).toThrow(/key 不合法/)
  })

  it('不认识的字段、字段类型不对、缺 provider / model → 抛错', () => {
    expect(parse({ fast: { provider: 'anthropic', model: 'x', apikey: '$K' } })).toThrow(/「fast」：不认识的字段 apikey/)
    expect(parse({ fast: { provider: 'anthropic', model: 3 } })).toThrow(/model 必须是字符串/)
    expect(parse({ fast: { model: 'x' } })).toThrow(/缺少 provider/)
    expect(parse({ fast: { provider: 'anthropic', model: '  ' } })).toThrow(/缺少 model/)
  })

  it.each(['baseUrl', 'api', 'apiKey', 'imageInput', 'contextWindow', 'maxTokens'])('连接信息 %s 写回模型表 → 启动失败，提示它在 llm.providers', (field) => {
    expect(parse({ fast: { provider: 'anthropic', model: 'x', [field]: 'x' } })).toThrow(`「fast」：${field} 不写在模型表里 —— 连接信息在 llm.providers`)
  })

  it('apiKey 写了明文 → 抛错，且报错里不带那串值（它可能就是一把 key）', () => {
    const literal = 'sk-ant-real-secret-123'
    let message = ''
    try {
      parse({ fast: { provider: 'anthropic', model: 'x', apiKey: literal } })()
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('连接信息在 llm.providers')
    expect(message).not.toContain(literal)
  })
})

describe('解析每一项（用不了 → 不可用，不抛）', () => {
  const reader = (env: Record<string, string>) => (name: string) => env[name]
  const resolve = (specs: Parameters<typeof resolveAgentModelTable>[0], table: Record<string, LlmProviderDef>, env: Record<string, string> = {}) => resolveAgentModelTable(specs, { table, envVar: reader(env) })

  it('provider 引用 llm.providers：地址、key、模型能力都从那边来', () => {
    const table = resolve(
      { vision: { provider: 'proxy', model: 'qwen-vl' } },
      {
        proxy: {
          baseUrl: 'https://llm.internal/v1',
          api: 'openai-completions',
          apiKeyEnv: 'PROXY_KEY',
          models: [{ id: 'qwen-vl', input: ['text', 'image'], contextWindow: 32768, maxTokens: 4096 }],
        },
      },
      { PROXY_KEY: ' sk-proxy ' },
    )
    expect(table.vision).toMatchObject({
      ok: true,
      value: { apiKey: 'sk-proxy', model: { baseUrl: 'https://llm.internal/v1', input: ['text', 'image'], contextWindow: 32768, maxTokens: 4096 } },
    })
  })

  it('表里没有的提供方：同 pi 的内置提供方，按提供方自己的环境变量退回；都没有就不可用', () => {
    const specs = { fast: { provider: 'anthropic', model: 'claude-sonnet-4-6' } }
    expect(resolve(specs, {}, { ANTHROPIC_API_KEY: 'sk-provider' }).fast).toMatchObject({ ok: true, value: { apiKey: 'sk-provider' } })
    expect(resolve(specs, {}).fast).toEqual({ ok: false, reason: '没有 anthropic 的 API key' })
    // ollama 不要 key（预设补占位）
    expect(resolve({ local: { provider: 'ollama', model: 'qwen3' } }, {}).local).toMatchObject({ ok: true })
  })

  it('apiKey 引用的变量没设：不可用（不退回提供方的变量 —— 写了引用就只认它）', () => {
    const table = { anthropic: { apiKeyEnv: 'AGENT_FAST_KEY', models: [] } }
    const specs = { fast: { provider: 'anthropic', model: 'claude-sonnet-4-6' } }
    expect(resolve(specs, table, { ANTHROPIC_API_KEY: 'sk-provider' }).fast).toMatchObject({
      ok: false,
      reason: expect.stringContaining('引用的环境变量 AGENT_FAST_KEY 没有设置'),
    })
  })

  it('thinking：合法的等级原样留下并交给解析（模型标成支持思考）；不认识的等级 → 启动失败', () => {
    const table = parseAgentModelTable(JSON.stringify({ deep: { provider: 'ollama', model: 'qwen3', thinking: 'low' } }), '/data/agent-models.json')
    expect(table.deep).toEqual({ provider: 'ollama', model: 'qwen3', thinking: 'low' })
    expect(resolve(table, {}).deep).toMatchObject({ ok: true, value: { thinking: 'low', model: { reasoning: true } } })
    expect(parse({ deep: { provider: 'ollama', model: 'qwen3', thinking: 'max' } })).toThrow(/thinking 只能是 minimal \/ low/)
    expect(parse({ deep: { provider: 'ollama', model: 'qwen3', thinking: true } })).toThrow(/thinking 只能是/)
  })

  it('pi 注册表里没有、线协议不支持：不可用，带原因', () => {
    const table = resolve(
      { ghost: { provider: 'anthropic', model: 'no-such-model' }, bad: { provider: 'p', model: 'm' } },
      { p: { baseUrl: 'http://x/v1', api: 'grpc', apiKeyEnv: 'K', models: [] } },
      { K: 'k', ANTHROPIC_API_KEY: 'k' },
    )
    expect(table.ghost).toMatchObject({ ok: false, reason: expect.stringContaining('注册表里没有 anthropic/no-such-model') })
    expect(table.bad).toMatchObject({ ok: false, reason: expect.stringContaining('不支持的线协议 grpc') })
  })
})

describe('读文件', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-models-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('文件不存在 = 空表（模型表只有 default），不是错误', () => {
    expect(loadAgentModelTable(path.join(dir, 'missing.json'))).toEqual({})
  })

  it('读得到就校验：合法的照常返回，坏的抛', () => {
    const good = path.join(dir, 'good.json')
    writeFileSync(good, JSON.stringify({ fast: { provider: 'anthropic', model: 'x' } }))
    expect(loadAgentModelTable(good)).toEqual({ fast: { provider: 'anthropic', model: 'x' } })
    const bad = path.join(dir, 'bad.json')
    writeFileSync(bad, '{"default": {}}')
    expect(() => loadAgentModelTable(bad)).toThrow(`模型表 ${bad} 的「default」`)
  })

  it('路径是目录（读不了，不是「不存在」）→ 抛', () => {
    expect(() => loadAgentModelTable(dir)).toThrow(/读不到模型表/)
  })
})
