import { describe, expect, it } from 'vitest'
import { parseLlmProviders } from '../src/llm.ts'

/** `llm.providers` 的形状校验（docs/28 §3.3）：形状不对 = 启动失败，报错带路径、不回显值 */
const parse = (value: unknown) => () => parseLlmProviders(typeof value === 'string' ? value : JSON.stringify(value))

describe('parseLlmProviders', () => {
  it('空串 / undefined / 只有空白 = 空表', () => {
    expect(parseLlmProviders(undefined)).toEqual({})
    expect(parseLlmProviders('')).toEqual({})
    expect(parseLlmProviders('  \n')).toEqual({})
    expect(parse({})()).toEqual({})
  })

  it('合法的表：字段原样留下，apiKey 只记环境变量名，models 缺省 = 空表，baseUrl 去掉结尾的 /', () => {
    expect(
      parse({
        ollama: {
          name: '本机 ollama',
          baseUrl: 'http://127.0.0.1:11434/v1/',
          api: 'openai-completions',
          apiKey: '$OLLAMA_API_KEY',
          models: [
            { id: 'deepseek-v4.1-flash:1017-cloud', name: 'DeepSeek', input: ['text', 'image'], reasoning: true, contextWindow: 128000, maxTokens: 8192 },
            { id: 'qwen3' },
          ],
        },
        anthropic: { baseUrl: 'https://proxy.example/anthropic' },
      })(),
    ).toEqual({
      ollama: {
        name: '本机 ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        api: 'openai-completions',
        apiKeyEnv: 'OLLAMA_API_KEY',
        models: [
          { id: 'deepseek-v4.1-flash:1017-cloud', name: 'DeepSeek', input: ['text', 'image'], reasoning: true, contextWindow: 128000, maxTokens: 8192 },
          { id: 'qwen3' },
        ],
      },
      anthropic: { baseUrl: 'https://proxy.example/anthropic', models: [] },
    })
  })

  it('YAML 里写了键没写值（null）当没配', () => {
    expect(parse({ a: { name: null, apiKey: null, models: null } })()).toEqual({ a: { models: [] } })
    expect(parse({ a: { models: [{ id: 'm', input: null, reasoning: null, maxTokens: null }] } })()).toEqual({ a: { models: [{ id: 'm' }] } })
  })

  it('不是合法的 JSON → 抛错，不回显原文（里面可能有密钥）', () => {
    const secret = 'sk-secret-in-broken-json'
    let error: Error | undefined
    try {
      parseLlmProviders(`{"a": {"apiKey": "${secret}"`)
    } catch (err) {
      error = err as Error
    }
    expect(error?.message).toBe('[config] llm.providers（环境变量 LLM_PROVIDERS） 不是合法的 JSON')
    expect(String(error?.cause ?? '')).not.toContain(secret)
  })

  it('顶层不是对象、提供方不是对象 → 抛错', () => {
    expect(parse([])).toThrow(/必须是对象（提供方 id → 提供方配置）/)
    expect(parse({ a: 'x' })).toThrow(/llm\.providers\.a 必须是对象/)
  })

  it.each(['Upper', '1a', 'a_b', 'a'.repeat(49), '__proto__'])('不合法的提供方 id %s → 抛错', (id) => {
    expect(() => parseLlmProviders(`{"${id}": {}}`)).toThrow(/提供方 id 不合法/)
  })

  it.each(['headers', 'compat', 'cost', 'modelOverrides', 'authHeader'])('pi 的 %s 不支持：不认识的字段 → 抛错', (field) => {
    expect(parse({ a: { [field]: {} } })).toThrow(`llm.providers.a：不认识的字段 ${field}`)
  })

  it('模型上不认识的字段 → 抛错，带下标', () => {
    expect(parse({ a: { models: [{ id: 'm' }, { id: 'n', compat: {} }] } })).toThrow(/llm\.providers\.a\.models\[1\]：不认识的字段 compat/)
  })

  it.each([
    ['name', { name: 1 }, /a\.name 必须是字符串/],
    ['baseUrl 类型', { baseUrl: 1 }, /a\.baseUrl 必须是字符串/],
    ['baseUrl 协议', { baseUrl: 'ftp://x' }, /a\.baseUrl 必须是 http\(s\) 地址/],
    ['api', { api: true }, /a\.api 必须是字符串/],
    ['models 不是数组', { models: {} }, /a\.models 必须是数组/],
    ['模型不是对象', { models: ['m'] }, /a\.models\[0\] 必须是对象/],
    ['模型缺 id', { models: [{ name: 'x' }] }, /a\.models\[0\]：缺少 id/],
    ['input 不认识', { models: [{ id: 'm', input: ['audio'] }] }, /a\.models\[0\]\.input 必须是/],
    ['input 空', { models: [{ id: 'm', input: [] }] }, /a\.models\[0\]\.input 必须是/],
    ['reasoning', { models: [{ id: 'm', reasoning: 'yes' }] }, /a\.models\[0\]\.reasoning 必须是 true/],
    ['contextWindow', { models: [{ id: 'm', contextWindow: '1' }] }, /a\.models\[0\]\.contextWindow 必须是正整数/],
    ['maxTokens', { models: [{ id: 'm', maxTokens: -1 }] }, /a\.models\[0\]\.maxTokens 必须是正整数/],
    ['重复的模型 id', { models: [{ id: 'm' }, { id: 'm' }] }, /a\.models\[1\]：模型 id m 重复/],
  ])('%s 不对 → 抛错，带路径', (_name, provider, message) => {
    expect(parse({ a: provider })).toThrow(message)
  })

  it.each(['sk-real-secret', '', '$', '$1BAD', '!command', 3])('apiKey 写成 %j → 抛错，报错里不带那个值', (apiKey) => {
    let message = ''
    try {
      parse({ a: { apiKey } })()
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('llm.providers.a.apiKey 只能写成 "$环境变量名"')
    // `$` 本身是提示语的一部分，不算回显
    if (apiKey && apiKey !== '$') expect(message).not.toContain(String(apiKey))
  })
})
