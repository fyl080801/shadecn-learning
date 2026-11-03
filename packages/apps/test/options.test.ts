import { ConfigService } from '@learning/config'
import { describe, expect, it } from 'vitest'
import { resolveAppsCatalog } from '../src/options.js'

/** config.yaml 的 `apps` 段和 `llm.providers`（docs/29 §3.3、docs/30 §8）。从 `packages/mod-apps/test/config.test.ts` 移植：配置来自 YAML，不再有 JSON 叶子和 `MODULES_APPS_*` */
const load = (values: Record<string, unknown>, env: Record<string, string> = {}) => resolveAppsCatalog(new ConfigService({ rootDir: '/', dataDir: '/data', isProduction: false, values, env }))

const providers = { local: { type: 'ollama' } }
const apps = [{ provider: 'local', type: 'text', model: 'qwen3', timeoutMs: 5 }, { provider: 'local', type: 'text', model: 'llama3' }]

describe('apps 配置', () => {
  it('解析成应用表；timeoutMs 是条目没写时的时限，默认 10 分钟', () => {
    const catalog = load({ apps: { providers, apps } })
    expect([...catalog.apps.keys()]).toEqual(['local:qwen3', 'local:llama3'])
    expect(catalog.apps.get('local:qwen3')!.timeoutMs).toBe(5)
    expect(catalog.apps.get('local:llama3')!.timeoutMs).toBe(600_000)
    expect(load({ apps: { providers, apps, timeoutMs: 1000 } }).apps.get('local:llama3')!.timeoutMs).toBe(1000)
  })

  it('什么都没配 = 没有应用，不是错误', () => {
    expect(load({}).apps.size).toBe(0)
    expect(load({ apps: null }).apps.size).toBe(0)
    expect(load({ apps: { providers: null, apps: null } }).apps.size).toBe(0)
  })

  it('形状不对 → 拒绝启动，位置写 apps…', () => {
    expect(() => load({ apps: { apps: { a: {} } } })).toThrow(/apps\.apps 必须是数组/)
    expect(() => load({ apps: { providers: [] } })).toThrow(/apps：providers 必须是对象/)
    expect(() => load({ apps: { timeoutMs: -1 } })).toThrow(/apps\.timeoutMs 必须是正整数/)
    expect(() => load({ apps: { timeoutMs: '1000' } })).toThrow(/apps\.timeoutMs 必须是正整数/)
    expect(() => load({ apps: { provider: {} } })).toThrow(/不认识的字段 provider/)
    expect(() => load({ apps: 'x' })).toThrow(/apps 段必须是映射/)
    expect(() => load({ llm: 'x' })).toThrow(/llm 段必须是映射/)
    expect(() => load({ apps: { providers: { 'Bad Id': { type: 'ollama' } } } })).toThrow(/id 不合法/)
  })

  it('明文密钥拒绝启动，报错不回显值', () => {
    const secret = 'sk-real-secret'
    let message = ''
    try {
      load({ apps: { providers: { ark: { type: 'ark', apiKey: secret } } } })
    } catch (err) {
      message = String(err)
    }
    expect(message).toContain('apps.providers.ark')
    expect(message).not.toContain(secret)
  })

  it('llm.providers 的明文 apiKey 拒绝启动，报错不回显值；不认识的字段、重复的模型也拒绝', () => {
    const secret = 'sk-real-secret-in-config'
    let message = ''
    try {
      load({ llm: { providers: { selfhost: { apiKey: secret } } } })
    } catch (err) {
      message = `${String(err)}${JSON.stringify((err as Error).cause ?? null)}`
    }
    expect(message).toContain('llm.providers.selfhost.apiKey 只能写成')
    expect(message).not.toContain(secret)
    expect(() => load({ llm: { providers: { a: { headers: {} } } } })).toThrow(/不认识的字段 headers/)
    expect(() => load({ llm: { providers: { a: { models: [{ id: 'm' }, { id: 'm' }] } } } })).toThrow(/模型 id m 重复/)
    expect(() => load({ llm: { providers: { a: { baseUrl: 'ftp://x' } } } })).toThrow(/http\(s\) 地址/)
    expect(() => load({ llm: { providers: 'x' } })).toThrow(/llm\.providers 必须是对象/)
  })

  it('$ENV 经 ConfigService.env 读：设了可用，没设只标这个应用不可用；不读进程环境', () => {
    const section = { apps: { providers: { ark: { type: 'ark', apiKey: '$MY_ARK_KEY' } }, apps: [{ provider: 'ark', type: 'image', model: 'm' }] } }
    process.env.MY_ARK_KEY = 'from-process-env'
    try {
      expect(load(section).apps.get('ark:m')!.info.unavailable).toMatch(/MY_ARK_KEY/)
    } finally {
      delete process.env.MY_ARK_KEY
    }
    expect(load(section, { MY_ARK_KEY: 'k' }).apps.get('ark:m')!.info.unavailable).toBeUndefined()
  })

  it('带模型的语言服务提供方自动成为 text 应用，$ENV 没设就不可用', () => {
    const llm = { providers: { selfhost: { baseUrl: 'http://x/v1', api: 'openai-completions', apiKey: '$K', models: [{ id: 'm' }] } } }
    expect(load({ llm }).apps.get('llm-selfhost:m')!.info.unavailable).toMatch(/环境变量 K 没有设置/)
    expect(load({ llm }, { K: 'v' }).apps.get('llm-selfhost:m')!.info.unavailable).toBeUndefined()
  })
})
