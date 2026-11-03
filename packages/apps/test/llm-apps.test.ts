import { describe, expect, it } from 'vitest'
import type { LlmProviderTable } from '@learning/llm/llm-config'
import { APPS_CONFIG_PATH, catalogFromConfig } from '../src/catalog.js'
import { DRIVERS } from '../src/drivers/index.js'
import { withLlmProviderApps } from '../src/llm-apps.js'
import { scriptedFetch, serviceOf } from './service-helpers.js'

/** 语言服务提供方自动成为 text 类应用（docs/29 §3.3）、`llm` 驱动（§4.3） */

const TABLE: LlmProviderTable = {
  local: {
    name: '本机',
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: 'openai-completions',
    models: [{ id: 'vision', name: '看图', input: ['text', 'image'] }, { id: 'plain' }],
  },
  bare: { baseUrl: 'http://x/v1', api: 'openai-completions', apiKeyEnv: 'BARE_KEY', models: [{ id: 'm' }] },
  // 没有模型：只给 agent 引用，不成为应用
  anthropic: { apiKeyEnv: 'K', models: [] },
}

describe('withLlmProviderApps（合成是纯函数）', () => {
  it('带模型的提供方多一个提供方实例，每个模型一条应用，追加在数组末尾；不吃图的模型只在别的模型吃图时才去掉 images；空表原样', () => {
    const keep = { provider: 'mine', type: 'text', model: 'x' }
    const merged = withLlmProviderApps({ providers: { mine: { type: 'ollama' } }, apps: [keep] }, TABLE, 'modules.apps')
    expect(merged).toEqual({
      providers: { mine: { type: 'ollama' }, 'llm-local': { type: 'llm', provider: 'local' }, 'llm-bare': { type: 'llm', provider: 'bare' } },
      apps: [
        keep,
        { provider: 'llm-local', model: 'vision', type: 'text', title: '看图' },
        { provider: 'llm-local', model: 'plain', type: 'text', title: 'plain', params: { images: null } },
        { provider: 'llm-bare', model: 'm', type: 'text', title: 'm' },
      ],
    })
    const data = { apps: [] }
    expect(withLlmProviderApps(data, {}, 't')).toBe(data)
    expect(withLlmProviderApps(data, { a: { models: [] } }, 't')).toBe(data)
  })

  it('不改入参', () => {
    const data = { providers: {}, apps: [] }
    withLlmProviderApps(data, TABLE, 't')
    expect(data).toEqual({ providers: {}, apps: [] })
  })

  it('提供方 id 撞车 → 启动失败', () => {
    expect(() => withLlmProviderApps({ providers: { 'llm-bare': {} } }, TABLE, 'modules.apps')).toThrow(/modules\.apps\.providers\.llm-bare 和语言服务提供方 bare/)
  })

  it('提供方 id 长到加不下前缀 → 启动失败，说清楚', () => {
    const id = 'a'.repeat(45)
    expect(() => withLlmProviderApps({}, { [id]: { models: [{ id: 'm' }] } }, 't')).toThrow(/id 太长/)
  })

  it('providers / apps 本身形状不对：原样交回去，由 buildCatalog 报', () => {
    const data = { apps: { old: {} } }
    expect(withLlmProviderApps(data, TABLE, 't')).toBe(data)
    const providers = { providers: 'nope' }
    expect(withLlmProviderApps(providers, TABLE, 't')).toBe(providers)
  })
})

describe('catalogFromConfig', () => {
  const load = (section: { providers?: unknown; apps?: unknown }, llmProviders: LlmProviderTable, env: Record<string, string> = {}) =>
    catalogFromConfig(section, { drivers: DRIVERS, env: { envVar: (name) => env[name], appRoot: '/', llmProviders }, defaultTimeoutMs: 1000 })

  it('modules.apps 没写也有这些应用（模块因此启用）；什么都没有 = 空表', () => {
    const catalog = load({}, TABLE)
    expect([...catalog.apps.keys()]).toEqual(['llm-local:vision', 'llm-local:plain', 'llm-bare:m'])
    const vision = catalog.apps.get('llm-local:vision')!.info
    expect(vision).toMatchObject({ title: '看图', category: 'text', driver: 'llm', model: 'vision' })
    expect('images' in vision.params).toBe(true)
    const plain = catalog.apps.get('llm-local:plain')!.info
    expect(plain).toMatchObject({ title: 'plain', model: 'plain' })
    expect('images' in plain.params).toBe(false)
    expect(load({}, {}).apps.size).toBe(0)
  })

  it('和手写的应用并存，手写的在前；手写的照样校验', () => {
    const section = { providers: { mine: { type: 'ollama' } }, apps: [{ provider: 'mine', type: 'text', model: 'qwen3' }] }
    expect([...load(section, TABLE).apps.keys()]).toEqual(['mine:qwen3', 'llm-local:vision', 'llm-local:plain', 'llm-bare:m'])
    expect(() => load({ providers: { 'llm-bare': { type: 'ollama' } } }, TABLE)).toThrow(/撞名/)
    expect(() => load({ apps: { old: {} } }, TABLE)).toThrow(`${APPS_CONFIG_PATH}.apps 必须是数组`)
  })

  it('手写一项引用合成的提供方、同一个模型 → 走通用的重复检查', () => {
    const section = { apps: [{ provider: 'llm-bare', type: 'text', model: 'm', options: { system: '你是诗人' } }] }
    expect(() => load(section, TABLE)).toThrow(/应用 llm-bare:m 和 apps\[0\] 重复/)
  })

  it('apiKey 引用的变量没设：只把这个提供方的应用标成不可用（带原因），不是启动错误', () => {
    const catalog = load({}, TABLE)
    expect(catalog.apps.get('llm-bare:m')!.info.unavailable).toContain('BARE_KEY')
    expect(load({}, TABLE, { BARE_KEY: 'k' }).apps.get('llm-bare:m')!.info.unavailable).toBeUndefined()
  })
})

describe('驱动 llm', () => {
  function sse(...chunks: unknown[]) {
    const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
  const answer = () =>
    sse(
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '你好' } }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    )

  it('手写应用引用提供方：连接信息、key 走 llm.providers，可以带 system', async () => {
    const upstream = scriptedFetch({ 'POST /v1/chat/completions': answer })
    const service = serviceOf(
      { providers: { poet: { type: 'llm', provider: 'bare' } }, apps: [{ provider: 'poet', type: 'text', model: 'm', title: '写诗', options: { system: '你是诗人' } }] },
      { llmProviders: TABLE, env: { BARE_KEY: 'bare-key' }, fetch: upstream.fetch },
    )
    expect(service.get('poet:m')).toMatchObject({ category: 'text', driver: 'llm' })
    expect(Object.keys(service.get('poet:m')!.params)).toEqual(['prompt', 'temperature'])
    const result = await service.executeApp('poet:m', { prompt: '嗨' })
    expect(upstream.requests[0]!.url).toBe('http://x/v1/chat/completions')
    expect(upstream.requests[0]!.headers.get('authorization')).toBe('Bearer bare-key')
    expect(upstream.requests[0]!.body).toMatchObject({ model: 'm', messages: [{ role: 'system', content: '你是诗人' }, { role: 'user' }] })
    expect(result.outputs).toEqual([{ kind: 'text', text: '你好', mimeType: 'text/plain' }])
  })

  it('引用不存在的提供方 → 启动失败；不写 provider → 启动失败；多写字段 → 启动失败', () => {
    const app = { provider: 'p', type: 'text', model: 'm' }
    expect(() => serviceOf({ providers: { p: { type: 'llm', provider: 'ghost' } }, apps: [app] }, { llmProviders: TABLE })).toThrow(/provider ghost 不在 llm\.providers 里（有：local、bare、anthropic）/)
    expect(() => serviceOf({ providers: { p: { type: 'llm', provider: 'ghost' } }, apps: [app] })).toThrow(/那里还是空的/)
    expect(() => serviceOf({ providers: { p: { type: 'llm' } }, apps: [app] }, { llmProviders: TABLE })).toThrow(/缺少 provider/)
    expect(() => serviceOf({ providers: { p: { type: 'llm', provider: 'bare', baseUrl: 'http://x' } }, apps: [app] }, { llmProviders: TABLE })).toThrow(/不认识的字段 baseUrl/)
  })

  it('images 默认 = 提供方任一模型吃图；options.imageInput 写了就盖过，且模型真的按吃图发（pi 不吃图的模型会把图换成占位）', async () => {
    const upstream = scriptedFetch({ 'POST /v1/chat/completions': answer })
    const service = serviceOf(
      {
        providers: {
          vision: { type: 'llm', provider: 'local' },
          visionoff: { type: 'llm', provider: 'local' },
          text: { type: 'llm', provider: 'bare' },
          forced: { type: 'llm', provider: 'bare' },
        },
        apps: [
          { provider: 'vision', type: 'text', model: 'vision' },
          { provider: 'visionoff', type: 'text', model: 'vision', options: { imageInput: false } },
          { provider: 'text', type: 'text', model: 'm' },
          { provider: 'forced', type: 'text', model: 'm', options: { imageInput: true } },
        ],
      },
      { llmProviders: TABLE, env: { BARE_KEY: 'k' }, fetch: upstream.fetch },
    )
    expect('images' in service.get('vision:vision')!.params).toBe(true)
    expect('images' in service.get('visionoff:vision')!.params).toBe(false)
    expect('images' in service.get('text:m')!.params).toBe(false)
    expect('images' in service.get('forced:m')!.params).toBe(true)
    await service.executeApp('forced:m', { prompt: '看图', images: ['data:image/png;base64,AAAA'] })
    expect(JSON.stringify(upstream.requests[0]!.body)).toContain('data:image/png;base64,AAAA')
  })

  it('列表外、pi 注册表也不认得的模型：只把那一个应用标成不可用', () => {
    const service = serviceOf(
      {
        providers: { p: { type: 'llm', provider: 'local' } },
        apps: [
          { provider: 'p', type: 'text', model: 'plain' },
          { provider: 'p', type: 'text', model: 'ghost' },
        ],
      },
      { llmProviders: { local: { ...TABLE.local!, apiKeyEnv: 'LOCAL_KEY' } }, env: { LOCAL_KEY: 'k' } },
    )
    expect(service.get('p:plain')!.unavailable).toBeUndefined()
    expect(service.get('p:ghost')!.unavailable).toContain('models 里没有 ghost')
  })
})
