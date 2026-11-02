import type { RuntimeInfo } from '@shadecn/server-kit/platform'
import { describe, expect, it } from 'vitest'
import { appsConfig } from '../src/config.ts'

/** 配置段 `modules.apps`（docs/29 §3.3）：`providers` / `apps` 是 JSON 叶子，`read` 交来的是和环境变量同形的字符串 */
const runtime = { envVar: () => undefined, appRoot: '/', dataDir: '/data', llmProviders: {} } as unknown as RuntimeInfo

const parse = (values: Partial<Record<'timeoutMs' | 'providers' | 'apps', string>>) =>
  appsConfig.parse((path: string) => values[path as keyof typeof values], runtime)

const providers = JSON.stringify({ local: { type: 'ollama' } })
const apps = JSON.stringify([{ provider: 'local', type: 'text', model: 'qwen3', timeoutMs: 5 }, { provider: 'local', type: 'text', model: 'llama3' }])

describe('modules.apps 配置', () => {
  it('JSON 解析成应用表；timeoutMs 是条目没写时的时限，默认 10 分钟', () => {
    const { catalog } = parse({ providers, apps })
    expect([...catalog.apps.keys()]).toEqual(['local:qwen3', 'local:llama3'])
    expect(catalog.apps.get('local:qwen3')!.timeoutMs).toBe(5)
    expect(catalog.apps.get('local:llama3')!.timeoutMs).toBe(600_000)
    expect(parse({ providers, apps, timeoutMs: '1000' }).catalog.apps.get('local:llama3')!.timeoutMs).toBe(1000)
  })

  it('什么都没配 / 空串 = 没有应用，不是错误', () => {
    expect(parse({}).catalog.apps.size).toBe(0)
    expect(parse({ providers: '', apps: '  ' }).catalog.apps.size).toBe(0)
  })

  it('JSON 不合法 → 启动失败，报位置和变量名，不回显内容（里面可能有密钥）', () => {
    const secret = 'sk-real-secret'
    expect(() => parse({ providers: `{ "x": "${secret}"` })).toThrow(/modules\.apps\.providers（环境变量 MODULES_APPS_PROVIDERS）不是合法的 JSON/)
    expect(() => parse({ apps: 'nope' })).toThrow(/modules\.apps\.apps（环境变量 MODULES_APPS_APPS）不是合法的 JSON/)
    let message = ''
    try {
      parse({ providers: `{ "x": "${secret}"` })
    } catch (err) {
      message = JSON.stringify([String(err), (err as Error).cause ?? null])
    }
    expect(message).not.toContain(secret)
  })

  it('形状不对 → 启动失败，位置写 modules.apps…', () => {
    expect(() => parse({ apps: '{"a":{}}' })).toThrow(/modules\.apps\.apps 必须是数组/)
    expect(() => parse({ providers: '[]' })).toThrow(/modules\.apps：providers 必须是对象/)
    expect(() => parse({ timeoutMs: '-1' })).toThrow(/MODULES_APPS_TIMEOUT_MS 必须是正整数/)
  })

  it('明文密钥的报错不回显值', () => {
    const secret = 'sk-real-secret'
    let message = ''
    try {
      parse({ providers: JSON.stringify({ ark: { type: 'ark', apiKey: secret } }) })
    } catch (err) {
      message = String(err)
    }
    expect(message).toContain('modules.apps.providers.ark')
    expect(message).not.toContain(secret)
  })

  it('schema 只有 timeoutMs / providers / apps', () => {
    expect(Object.keys(appsConfig.schema).sort()).toEqual(['apps', 'providers', 'timeoutMs'])
  })
})
