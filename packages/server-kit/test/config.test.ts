import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { envNameOf, readConfigFiles, resolveConfig, setting, type ConfigPath, type ConfigSchema } from '../src/config.ts'

const schema = {
  server: {
    port: setting('number'),
    roles: setting('list'),
  },
  modules: {
    agent: {
      enabled: setting('boolean'),
      apiKey: setting('string'),
      nodeSelector: setting('map'),
    },
  },
} satisfies ConfigSchema

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'server-kit-config-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})
const write = (name: string, text: string) => writeFileSync(path.join(dir, name), text)
const load = (mode = 'development', explicit?: string) =>
  readConfigFiles({ dir, mode, ...(explicit !== undefined ? { explicit } : {}) })

describe('envNameOf：路径 → 环境变量名', () => {
  it.each([
    ['server.port', 'SERVER_PORT'],
    ['server.instanceId', 'SERVER_INSTANCE_ID'],
    ['database.url', 'DATABASE_URL'],
    ['cluster.redisUrl', 'CLUSTER_REDIS_URL'],
    ['log.slowMs', 'LOG_SLOW_MS'],
    ['modules.agent.enabled', 'MODULES_AGENT_ENABLED'],
    ['modules.agent.sandbox.driver', 'MODULES_AGENT_SANDBOX_DRIVER'],
    ['modules.agent.sandbox.k8s.apiUrl', 'MODULES_AGENT_SANDBOX_K8S_API_URL'],
    ['modules.agent.sandbox.memoryMib', 'MODULES_AGENT_SANDBOX_MEMORY_MIB'],
    ['modules.auth.sessionSecret', 'MODULES_AUTH_SESSION_SECRET'],
    ['modules.auth.keycloak.issuer', 'MODULES_AUTH_KEYCLOAK_ISSUER'],
    ['modules.storage.bucket', 'MODULES_STORAGE_BUCKET'],
    ['modules.storage.maxUploadMb', 'MODULES_STORAGE_MAX_UPLOAD_MB'],
  ])('%s → %s', (path, name) => {
    expect(envNameOf(path)).toBe(name)
  })

  it('带数字的词不拆，数字后面的大写才拆；连续大写算一个词；连字符转下划线', () => {
    expect(envNameOf('k8s')).toBe('K8S')
    expect(envNameOf('s3Path')).toBe('S3_PATH')
    expect(envNameOf('oauth2Token')).toBe('OAUTH2_TOKEN')
    expect(envNameOf('apiURL')).toBe('API_URL')
    expect(envNameOf('httpAPIKey')).toBe('HTTP_API_KEY')
    expect(envNameOf('modules.mod-x.enabled')).toBe('MODULES_MOD_X_ENABLED')
  })
})

describe('readConfigFiles：找文件、解析、分层合并', () => {
  it('没有配置文件 = 空', () => {
    expect(load()).toEqual({ files: [], data: {} })
  })

  it('YAML 和 JSON 都认；环境分层文件叠在基础文件上（对象逐键合并，数组整个替换）', () => {
    write('server.config.yaml', 'server:\n  port: 3000\n  roles: [web, collab]\nmodules:\n  agent:\n    apiKey: base\n')
    write('server.config.production.json', JSON.stringify({ server: { roles: ['agent'] }, modules: { agent: { enabled: false } } }))
    const { files, data } = load('production')
    expect(files.map((file) => path.basename(file))).toEqual(['server.config.yaml', 'server.config.production.json'])
    expect(data).toEqual({ server: { port: 3000, roles: ['agent'] }, modules: { agent: { apiKey: 'base', enabled: false } } })
  })

  it('别的环境的分层文件不读', () => {
    write('server.config.yml', 'server:\n  port: 1\n')
    write('server.config.production.yaml', 'server:\n  port: 2\n')
    expect(load('development').data).toEqual({ server: { port: 1 } })
  })

  it('同一层同时有 .yaml 和 .json → 抛错', () => {
    write('server.config.yaml', '{}')
    write('server.config.json', '{}')
    expect(() => load()).toThrow(/同一层有多个配置文件/)
  })

  it('显式指定（逗号分隔）就只读它们、按顺序叠，不再自动找；空串 = 不用配置文件', () => {
    write('server.config.yaml', 'server:\n  port: 1\n')
    write('a.json', '{"server":{"port":2}}')
    write('b.yaml', 'server:\n  port: 3\n')
    expect(load('development', 'a.json, b.yaml').data).toEqual({ server: { port: 3 } })
    expect(load('development', '')).toEqual({ files: [], data: {} })
  })

  it('显式指定的文件不存在 → 抛错', () => {
    expect(() => load('development', 'missing.yaml')).toThrow(/指定的配置文件不存在/)
  })

  it('解析失败 / 顶层不是对象 → 抛错并带文件名；空文件当空对象', () => {
    write('bad.json', '{ nope')
    expect(() => load('development', 'bad.json')).toThrow(/bad\.json 解析失败/)
    write('list.yaml', '- a\n- b\n')
    expect(() => load('development', 'list.yaml')).toThrow(/顶层必须是对象/)
    write('empty.yaml', '')
    expect(load('development', 'empty.yaml').data).toEqual({})
  })
})

describe('resolveConfig：按 schema 校验，和环境变量合层', () => {
  const files = (data: Record<string, unknown>) => ({ files: ['server.config.yaml'], data })

  it('文件里的值转成和环境变量同形的字符串', () => {
    const source = resolveConfig(
      schema,
      files({
        server: { port: 8080, roles: ['web', 'collab'] },
        modules: { agent: { enabled: false, apiKey: 123, nodeSelector: { 'kubernetes.io/arch': 'arm64', gpu: true } } },
      }),
      {},
    )
    expect(source.get('server.port')).toBe('8080')
    expect(source.get('server.roles')).toBe('web,collab')
    expect(source.get('modules.agent.enabled')).toBe('false')
    expect(source.get('modules.agent.apiKey')).toBe('123')
    expect(source.get('modules.agent.nodeSelector')).toBe('kubernetes.io/arch=arm64,gpu=true')
    expect(source.origin('server.port')).toBe('file')
  })

  it('环境变量优先于文件，空串也算设了；都没有 = undefined', () => {
    const source = resolveConfig(schema, files({ server: { port: 8080 }, modules: { agent: { apiKey: 'file' } } }), {
      SERVER_PORT: '9090',
      MODULES_AGENT_API_KEY: '',
    })
    expect(source.get('server.port')).toBe('9090')
    expect(source.origin('server.port')).toBe('env')
    expect(source.get('modules.agent.apiKey')).toBe('')
    expect(source.get('server.roles')).toBeUndefined()
    expect(source.origin('server.roles')).toBe('default')
  })

  it('YAML 里写了键没写值（null）当没配', () => {
    const source = resolveConfig(schema, files({ modules: { agent: { apiKey: null } } }), {})
    expect(source.get('modules.agent.apiKey')).toBeUndefined()
  })

  it('拼错的键、类型不对的值一次全报出来，带路径和对应的环境变量', () => {
    const run = () =>
      resolveConfig(
        schema,
        files({ server: { prot: 1, port: 'abc', roles: [1] }, modules: { agnet: {}, agent: { enabled: 'no', nodeSelector: { a: [] } } } }),
        {},
      )
    expect(run).toThrow(/server\.prot 不是认得的配置项/)
    expect(run).toThrow(/server\.port 应该是 数字（对应环境变量 SERVER_PORT）/)
    expect(run).toThrow(/modules\.agent\.nodeSelector 应该是 键值对象.*对应环境变量 MODULES_AGENT_NODE_SELECTOR/)
    expect(run).toThrow(/server\.roles 应该是 字符串数组/)
    expect(run).toThrow(/modules\.agnet 不是认得的配置项/)
    expect(run).toThrow(/modules\.agent\.enabled 应该是 true \/ false/)
    expect(run).toThrow(/modules\.agent\.nodeSelector 应该是 键值对象/)
  })

  it('分组写成了标量 → 报错', () => {
    expect(() => resolveConfig(schema, files({ modules: 'x' }), {})).toThrow(/modules 应该是对象/)
  })

  it('取一个 schema 里没声明的路径 → 抛错（路径写成环境变量名、或者取到分组，都算没声明）', () => {
    const source = resolveConfig(schema, files({}), { NOPE: '1', SERVER_PORT: '1' })
    const wide: { get(path: string): string | undefined } = source
    expect(() => wide.get('NOPE')).toThrow(/NOPE 不在配置 schema 里/)
    expect(() => wide.get('SERVER_PORT')).toThrow(/SERVER_PORT 不在配置 schema 里/)
    expect(() => wide.get('server')).toThrow(/server 不在配置 schema 里/)
  })

  it('拼错的路径过不了编译', () => {
    const source = resolveConfig(schema, files({}), {})
    // @ts-expect-error 没有这一项
    expect(() => source.get('server.prot')).toThrow(/不在配置 schema 里/)
    // @ts-expect-error 分组不是叶子
    expect(() => source.origin('modules.agent')).toThrow(/不在配置 schema 里/)
    const paths: ConfigPath<typeof schema>[] = ['server.port', 'modules.agent.nodeSelector']
    expect(paths).toHaveLength(2)
  })

  it('schema 加一个叶子，不改别处就同时能从文件和环境变量配', () => {
    const grown = { ...schema, cache: { ttlMs: setting('number'), redis: { keyPrefix: setting('string') } } } satisfies ConfigSchema
    const fromFile = resolveConfig(grown, files({ cache: { ttlMs: 500, redis: { keyPrefix: 'a' } } }), {})
    expect(fromFile.get('cache.ttlMs')).toBe('500')
    expect(fromFile.origin('cache.redis.keyPrefix')).toBe('file')
    const fromEnv = resolveConfig(grown, files({ cache: { ttlMs: 500 } }), { CACHE_TTL_MS: '900', CACHE_REDIS_KEY_PREFIX: 'b' })
    expect(fromEnv.get('cache.ttlMs')).toBe('900')
    expect(fromEnv.get('cache.redis.keyPrefix')).toBe('b')
    expect(fromEnv.origin('cache.ttlMs')).toBe('env')
  })

  it('不同路径推导出同一个环境变量 → 抛错（camelCase 拆词和分级撞上）', () => {
    const clash = { a: { bC: setting('string'), b: { c: setting('number') } } } satisfies ConfigSchema
    expect(() => resolveConfig(clash, files({}), {})).toThrow(/a\.bC 和 a\.b\.c 推导出了同一个环境变量 A_B_C/)
  })

  it('推导出引导变量的名字 → 抛错；没声明 reservedEnv 时不管', () => {
    const clash = { server: { config: setting('string') } } satisfies ConfigSchema
    expect(() => resolveConfig(clash, files({}), {}, { reservedEnv: ['SERVER_CONFIG'] })).toThrow(/server\.config 推导出的环境变量 SERVER_CONFIG 另有用途/)
    expect(resolveConfig(clash, files({}), {}).get('server.config')).toBeUndefined()
  })
})

describe('先不校验的段（deferred）', () => {
  it('顶层 deferred 的段原样放过，其余照常校验', () => {
    const schema = { server: { port: setting('number') } }
    const files = { files: [], data: { server: { port: 1 }, modules: { whatever: { x: 1 } } } }
    expect(() => resolveConfig(schema, files, {})).toThrow('modules 不是认得的配置项')
    expect(resolveConfig(schema, files, {}, { deferred: ['modules'] }).get('server.port')).toBe('1')
  })
})
