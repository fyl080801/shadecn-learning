import { describe, expect, it } from 'vitest'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import { agentProviderApiKey, resolveProviderModel, type ProviderTable } from '../src/llm-providers.ts'

/** 语言服务提供方 + 模型 id → 模型：agent 和应用表的 `llm` 驱动共用这条路（docs/26 §3.4） */

const env = (values: Record<string, string> = {}) => (name: string) => values[name]
const resolve = (table: ProviderTable, provider: string, model: string, values: Record<string, string> = {}) =>
  resolveProviderModel({ table, provider, model, envVar: env(values) })

describe('表里有这个提供方', () => {
  const table: ProviderTable = {
    selfhost: {
      baseUrl: 'http://llm.internal/v1',
      api: 'openai-completions',
      apiKeyEnv: 'SELFHOST_KEY',
      models: [
        { id: 'vision', name: '多模态', input: ['text', 'image'], reasoning: true, contextWindow: 32768, maxTokens: 4096 },
        { id: 'plain' },
      ],
    },
  }

  it('连接信息和模型能力都照表里的', () => {
    expect(resolve(table, 'selfhost', 'vision', { SELFHOST_KEY: ' k ' })).toMatchObject({
      ok: true,
      value: {
        apiKey: 'k',
        label: '多模态',
        model: { id: 'vision', provider: 'selfhost', baseUrl: 'http://llm.internal/v1', api: 'openai-completions', input: ['text', 'image'], reasoning: true, contextWindow: 32768, maxTokens: 4096 },
      },
    })
    expect(resolve(table, 'selfhost', 'plain', { SELFHOST_KEY: 'k' })).toMatchObject({
      ok: true,
      value: { label: 'plain', model: { input: ['text'], reasoning: false } },
    })
  })

  it('apiKey 引用的变量没设 / 空白：不可用，不退回', () => {
    expect(resolve(table, 'selfhost', 'plain')).toEqual({ ok: false, reason: '语言服务提供方 selfhost 的 apiKey 引用的环境变量 SELFHOST_KEY 没有设置' })
    expect(resolve(table, 'selfhost', 'plain', { SELFHOST_KEY: '  ' })).toMatchObject({ ok: false })
    const anthropic: ProviderTable = { anthropic: { apiKeyEnv: 'MY_KEY', models: [] } }
    expect(resolve(anthropic, 'anthropic', 'claude-sonnet-4-6', { ANTHROPIC_API_KEY: 'sk' })).toMatchObject({ ok: false, reason: expect.stringContaining('MY_KEY') })
  })

  it('没写 apiKey：按提供方退回；表外的提供方没有可退回的 = 没有 key', () => {
    const noKey: ProviderTable = { anthropic: { baseUrl: 'https://proxy.example', models: [] }, proxy: { baseUrl: 'https://proxy.example', models: [] } }
    expect(resolve(noKey, 'anthropic', 'claude-sonnet-4-6', { ANTHROPIC_API_KEY: 'sk' })).toMatchObject({ ok: true, value: { apiKey: 'sk', model: { baseUrl: 'https://proxy.example' } } })
    expect(resolve(noKey, 'proxy', 'm')).toEqual({ ok: false, reason: '没有 proxy 的 API key' })
  })

  it('models 非空、模型不在列表：pi 注册表认得的放行（用注册表的元数据），否则不可用并写明', () => {
    const registered: ProviderTable = { anthropic: { baseUrl: 'https://proxy.example', apiKeyEnv: 'K', models: [{ id: 'mine' }] } }
    expect(resolve(registered, 'anthropic', 'claude-sonnet-4-6', { K: 'k' })).toMatchObject({ ok: true, value: { model: { id: 'claude-sonnet-4-6', baseUrl: 'https://proxy.example' } } })
    const miss = resolve(registered, 'anthropic', 'no-such-model', { K: 'k' })
    expect(miss).toMatchObject({ ok: false, reason: expect.stringContaining('models 里没有 no-such-model') })
    expect(miss).toMatchObject({ reason: expect.stringContaining('mine') })
  })

  it('models 为空：不限模型 id', () => {
    const open: ProviderTable = { proxy: { baseUrl: 'https://proxy.example', apiKeyEnv: 'K', models: [] } }
    expect(resolve(open, 'proxy', 'whatever', { K: 'k' })).toMatchObject({ ok: true, value: { model: { id: 'whatever' } } })
  })

  it('线协议不认识 = 不可用；ollama 在表里仍然用预设的占位 key 和兼容开关', () => {
    expect(resolve({ p: { baseUrl: 'http://x/v1', api: 'grpc', apiKeyEnv: 'K', models: [] } }, 'p', 'm', { K: 'k' })).toMatchObject({ ok: false, reason: expect.stringContaining('不支持的线协议 grpc') })
    expect(resolve({ ollama: { baseUrl: 'http://gpu:11434/v1', models: [{ id: 'qwen3' }] } }, 'ollama', 'qwen3')).toMatchObject({
      ok: true,
      value: { apiKey: 'ollama', model: { baseUrl: 'http://gpu:11434/v1', compat: { supportsDeveloperRole: false } } },
    })
  })

  it('thinking、imageInput：thinking 交给解析；调用方的 imageInput 盖过模型定义', () => {
    const resolved = resolveProviderModel({ table, provider: 'selfhost', model: 'plain', envVar: env({ SELFHOST_KEY: 'k' }), thinking: 'low', imageInput: true })
    expect(resolved).toMatchObject({ ok: true, value: { thinking: 'low', model: { reasoning: true, input: ['text', 'image'] } } })
  })

  it('覆盖模型能力不改 pi 的注册表（对象是共享的）', () => {
    const before = getBuiltinModel('anthropic' as never, 'claude-sonnet-4-6' as never) as { name: string; input: string[]; reasoning: boolean }
    const snapshot = { name: before.name, input: [...before.input], reasoning: before.reasoning }
    resolve({ anthropic: { apiKeyEnv: 'K', models: [{ id: 'claude-sonnet-4-6', name: '改名', input: ['text'], reasoning: false, contextWindow: 1000, maxTokens: 10 }] } }, 'anthropic', 'claude-sonnet-4-6', { K: 'k' })
    expect({ name: before.name, input: before.input, reasoning: before.reasoning }).toEqual(snapshot)
  })
})

describe('表里没有：同 pi 的内置提供方', () => {
  it('注册表 + 按提供方退回 key', () => {
    expect(resolve({}, 'anthropic', 'claude-sonnet-4-6', { ANTHROPIC_API_KEY: 'sk' })).toMatchObject({ ok: true, value: { apiKey: 'sk', model: { api: 'anthropic-messages' } } })
    expect(resolve({}, 'anthropic', 'claude-sonnet-4-6')).toEqual({ ok: false, reason: '没有 anthropic 的 API key' })
  })

  it('预设（ollama）不要 key；注册表里没有的提供方不可用', () => {
    expect(resolve({}, 'ollama', 'qwen3')).toMatchObject({ ok: true, value: { apiKey: 'ollama' } })
    expect(resolve({}, 'nobody', 'm')).toMatchObject({ ok: false, reason: expect.stringContaining('注册表里没有 nobody/m') })
  })

  it('原型链上的名字不算在表里', () => {
    expect(resolve({}, 'constructor', 'm')).toMatchObject({ ok: false })
    expect(agentProviderApiKey('constructor', env())).toBe('')
  })
})
