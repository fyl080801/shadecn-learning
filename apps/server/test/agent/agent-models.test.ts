import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadAgentModelTable, parseAgentModelTable, resolveAgentModelTable } from '../../agent/models.ts'

/**
 * 模型表文件（docs/26 §3.4）：`<dataDir>/agent-models.json` / `AGENT_MODELS_FILE`。文件本身不对 → 启动失败（抛）；
 * 某一项用不了（`$ENV` 没设、注册表里没有）→ 不抛，解析结果记成不可用，到用时才报。
 */

const parse = (value: unknown) => () => parseAgentModelTable(typeof value === 'string' ? value : JSON.stringify(value), '/data/agent-models.json')

describe('解析模型表文件（形状不对 → 启动失败）', () => {
  it('合法的文件：字段原样留下，apiKey 只记环境变量名', () => {
    expect(
      parse({
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: '$AGENT_FAST_KEY' },
        vision: { provider: 'my-proxy', model: 'qwen-vl', baseUrl: 'https://llm.internal/v1', api: 'openai-completions', imageInput: true },
      })(),
    ).toEqual({
      fast: { provider: 'anthropic', model: 'claude-haiku-4-5', apiKeyEnv: 'AGENT_FAST_KEY' },
      vision: { provider: 'my-proxy', model: 'qwen-vl', baseUrl: 'https://llm.internal/v1', api: 'openai-completions', imageInput: true },
    })
    expect(parse({})()).toEqual({})
  })

  it('不是 JSON、顶层不是对象、一项不是对象 → 抛错，指出文件', () => {
    expect(parse('{ fast: ')).toThrow(/模型表 \/data\/agent-models\.json：不是合法的 JSON/)
    expect(parse([])).toThrow(/顶层必须是对象/)
    expect(parse({ fast: 'claude' })).toThrow(/「fast」：必须是对象/)
  })

  it('写了 default、key 不合法 → 抛错', () => {
    expect(parse({ default: { provider: 'anthropic', model: 'x' } })).toThrow(/「default」：default 不能写在文件里，它来自 AGENT_PROVIDER/)
    expect(parse({ Fast: { provider: 'anthropic', model: 'x' } })).toThrow(/「Fast」：key 不合法/)
    expect(parse({ 'fast model': { provider: 'anthropic', model: 'x' } })).toThrow(/key 不合法/)
  })

  it('不认识的字段、字段类型不对、缺 provider / model → 抛错', () => {
    expect(parse({ fast: { provider: 'anthropic', model: 'x', apikey: '$K' } })).toThrow(/「fast」：不认识的字段 apikey/)
    expect(parse({ fast: { provider: 'anthropic', model: 'x', imageInput: 'yes' } })).toThrow(/imageInput 必须是 true \/ false/)
    expect(parse({ fast: { provider: 'anthropic', model: 3 } })).toThrow(/model 必须是字符串/)
    expect(parse({ fast: { model: 'x' } })).toThrow(/缺少 provider/)
    expect(parse({ fast: { provider: 'anthropic', model: '  ' } })).toThrow(/缺少 model/)
  })

  it('apiKey 写了明文 → 抛错，且报错里不带那串值（它可能就是一把 key）', () => {
    const literal = 'sk-ant-real-secret-123'
    let message = ''
    try {
      parse({ fast: { provider: 'anthropic', model: 'x', apiKey: literal } })()
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('apiKey 只能写成 "$环境变量名"')
    expect(message).not.toContain(literal)
    expect(parse({ fast: { provider: 'anthropic', model: 'x', apiKey: '$' } })).toThrow(/apiKey 只能写成/)
    expect(parse({ fast: { provider: 'anthropic', model: 'x', apiKey: '$1BAD' } })).toThrow(/apiKey 只能写成/)
  })
})

describe('解析每一项（用不了 → 不可用，不抛）', () => {
  it('$ENV 引用换成环境变量的值', () => {
    const table = resolveAgentModelTable(
      { fast: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKeyEnv: 'AGENT_FAST_KEY' } },
      { AGENT_FAST_KEY: ' sk-fast ', ANTHROPIC_API_KEY: 'sk-provider' },
    )
    expect(table.fast).toMatchObject({ ok: true, value: { apiKey: 'sk-fast', model: { provider: 'anthropic', id: 'claude-sonnet-4-6' } } })
  })

  it('引用的环境变量没设 / 为空：不可用（不退回提供方的变量 —— 写了引用就只认它）', () => {
    const specs = { fast: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKeyEnv: 'AGENT_FAST_KEY' } }
    expect(resolveAgentModelTable(specs, { ANTHROPIC_API_KEY: 'sk-provider' }).fast).toEqual({
      ok: false,
      reason: 'apiKey 引用的环境变量 AGENT_FAST_KEY 没有设置',
    })
    expect(resolveAgentModelTable(specs, { AGENT_FAST_KEY: '  ' }).fast).toMatchObject({ ok: false })
  })

  it('不写 apiKey：同 default 的退回规则，按提供方自己的环境变量；都没有就不可用', () => {
    const specs = { fast: { provider: 'anthropic', model: 'claude-sonnet-4-6' } }
    expect(resolveAgentModelTable(specs, { ANTHROPIC_API_KEY: 'sk-provider' }).fast).toMatchObject({ ok: true, value: { apiKey: 'sk-provider' } })
    expect(resolveAgentModelTable(specs, {}).fast).toEqual({ ok: false, reason: '没有 anthropic 的 API key' })
    // ollama 不要 key（预设补占位）
    expect(resolveAgentModelTable({ local: { provider: 'ollama', model: 'qwen3' } }, {}).local).toMatchObject({ ok: true })
  })

  it('pi 注册表里没有、线协议不支持：不可用，带原因；imageInput 照样覆盖', () => {
    const table = resolveAgentModelTable(
      {
        ghost: { provider: 'anthropic', model: 'no-such-model', apiKeyEnv: 'K' },
        bad: { provider: 'p', model: 'm', baseUrl: 'http://x/v1', api: 'grpc', apiKeyEnv: 'K' },
        vision: { provider: 'p', model: 'm', baseUrl: 'http://x/v1', api: 'openai-completions', apiKeyEnv: 'K', imageInput: true },
      },
      { K: 'k' },
    )
    expect(table.ghost).toMatchObject({ ok: false, reason: expect.stringContaining('注册表里没有 anthropic/no-such-model') })
    expect(table.bad).toMatchObject({ ok: false, reason: expect.stringContaining('不支持的线协议 grpc') })
    expect(table.vision).toMatchObject({ ok: true, value: { model: { input: ['text', 'image'], baseUrl: 'http://x/v1' } } })
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
    writeFileSync(good, JSON.stringify({ fast: { provider: 'anthropic', model: 'x', apiKey: '$AGENT_FAST_KEY' } }))
    expect(loadAgentModelTable(good)).toEqual({ fast: { provider: 'anthropic', model: 'x', apiKeyEnv: 'AGENT_FAST_KEY' } })
    const bad = path.join(dir, 'bad.json')
    writeFileSync(bad, '{"default": {}}')
    expect(() => loadAgentModelTable(bad)).toThrow(`模型表 ${bad} 的「default」`)
  })

  it('路径是目录（读不了，不是「不存在」）→ 抛', () => {
    expect(() => loadAgentModelTable(dir)).toThrow(/读不到模型表/)
  })
})
