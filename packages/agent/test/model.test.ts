import { describe, expect, it } from 'vitest'
import { resolveAgentModel } from '../src/model.ts'

/** 选模型：参数对象进、模型出 —— 本包不读环境变量 */

describe('resolveAgentModel', () => {
  it('注册表里有的模型直接用', () => {
    const resolved = resolveAgentModel({ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'k' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.value.model).toMatchObject({ id: 'claude-sonnet-4-6', api: 'anthropic-messages' })
    expect(resolved.value.apiKey).toBe('k')
  })

  it('给了 baseUrl：构造自定义模型，api 决定线协议', () => {
    const resolved = resolveAgentModel({
      provider: 'my-proxy',
      model: 'qwen-max',
      baseUrl: 'http://llm.internal/v1',
      api: 'openai-completions',
      apiKey: 'k',
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.value.model).toMatchObject({
      id: 'qwen-max',
      provider: 'my-proxy',
      api: 'openai-completions',
      baseUrl: 'http://llm.internal/v1',
    })
  })

  it('吃不吃图片：自定义端点默认只吃文字，imageInput 声明了就覆盖（注册表里的模型也能关掉，且不改注册表本身）', () => {
    const custom = { provider: 'my-proxy', model: 'qwen-vl', baseUrl: 'http://llm.internal/v1', api: 'openai-completions', apiKey: 'k' }
    const plain = resolveAgentModel(custom)
    const vision = resolveAgentModel({ ...custom, imageInput: true })
    expect(plain.ok && plain.value.model.input).toEqual(['text'])
    expect(vision.ok && vision.value.model.input).toEqual(['text', 'image'])

    const registered = resolveAgentModel({ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'k' })
    expect(registered.ok && registered.value.model.input).toContain('image')
    const off = resolveAgentModel({ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'k', imageInput: false })
    expect(off.ok && off.value.model.input).toEqual(['text'])
    const again = resolveAgentModel({ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'k' })
    expect(again.ok && again.value.model.input).toContain('image')
  })

  it('没有 key → 未启用', () => {
    const resolved = resolveAgentModel({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
    expect(resolved).toMatchObject({ ok: false })
  })

  it('注册表里没有、又没给 baseUrl → 未启用并说明原因', () => {
    const resolved = resolveAgentModel({ provider: 'anthropic', model: 'no-such-model', apiKey: 'k' })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toContain('baseUrl')
  })

  it('不支持的线协议 → 未启用', () => {
    const resolved = resolveAgentModel({
      provider: 'x',
      model: 'y',
      baseUrl: 'http://h',
      api: 'google-generative-ai',
      apiKey: 'k',
    })
    expect(resolved.ok).toBe(false)
  })

  it('ollama 预设：不给地址和 key 也能用，走本机 /v1 与保守的兼容开关', () => {
    const resolved = resolveAgentModel({ provider: 'ollama', model: 'deepseek-v4.1-flash:1017-cloud' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.value.model).toMatchObject({
      id: 'deepseek-v4.1-flash:1017-cloud',
      provider: 'ollama',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:11434/v1',
      compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' },
    })
    expect(resolved.value.apiKey).toBe('ollama')
  })

  it('ollama 预设：显式给的地址和 key 优先', () => {
    const resolved = resolveAgentModel({
      provider: 'ollama',
      model: 'qwen3',
      baseUrl: 'http://gpu-box:11434/v1',
      apiKey: 'secret',
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.value.model.baseUrl).toBe('http://gpu-box:11434/v1')
    expect(resolved.value.apiKey).toBe('secret')
  })
})
