import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readConfigFiles, resolveConfig, setting, type ConfigSchema } from '../src/config.ts'

const schema = {
  server: {
    port: setting('PORT', 'number'),
    roles: setting('SERVER_ROLES', 'list'),
  },
  modules: {
    agent: {
      enabled: setting('AGENT_ENABLED', 'boolean'),
      apiKey: setting('AGENT_API_KEY', 'string'),
      nodeSelector: setting('AGENT_NODE_SELECTOR', 'map'),
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
    expect(source.get('PORT')).toBe('8080')
    expect(source.get('SERVER_ROLES')).toBe('web,collab')
    expect(source.get('AGENT_ENABLED')).toBe('false')
    expect(source.get('AGENT_API_KEY')).toBe('123')
    expect(source.get('AGENT_NODE_SELECTOR')).toBe('kubernetes.io/arch=arm64,gpu=true')
    expect(source.origin('PORT')).toBe('file')
  })

  it('环境变量优先于文件，空串也算设了；都没有 = undefined', () => {
    const source = resolveConfig(schema, files({ server: { port: 8080 }, modules: { agent: { apiKey: 'file' } } }), {
      PORT: '9090',
      AGENT_API_KEY: '',
    })
    expect(source.get('PORT')).toBe('9090')
    expect(source.origin('PORT')).toBe('env')
    expect(source.get('AGENT_API_KEY')).toBe('')
    expect(source.get('SERVER_ROLES')).toBeUndefined()
    expect(source.origin('SERVER_ROLES')).toBe('default')
  })

  it('YAML 里写了键没写值（null）当没配', () => {
    const source = resolveConfig(schema, files({ modules: { agent: { apiKey: null } } }), {})
    expect(source.get('AGENT_API_KEY')).toBeUndefined()
  })

  it('拼错的键、类型不对的值一次全报出来，带路径和对应的环境变量', () => {
    const run = () =>
      resolveConfig(
        schema,
        files({ server: { prot: 1, port: 'abc', roles: [1] }, modules: { agnet: {}, agent: { enabled: 'no', nodeSelector: { a: [] } } } }),
        {},
      )
    expect(run).toThrow(/server\.prot 不是认得的配置项/)
    expect(run).toThrow(/server\.port 应该是 数字（对应环境变量 PORT）/)
    expect(run).toThrow(/server\.roles 应该是 字符串数组/)
    expect(run).toThrow(/modules\.agnet 不是认得的配置项/)
    expect(run).toThrow(/modules\.agent\.enabled 应该是 true \/ false/)
    expect(run).toThrow(/modules\.agent\.nodeSelector 应该是 键值对象/)
  })

  it('分组写成了标量 → 报错', () => {
    expect(() => resolveConfig(schema, files({ modules: 'x' }), {})).toThrow(/modules 应该是对象/)
  })

  it('取一个 schema 里没声明的名字 → 抛错', () => {
    const source = resolveConfig(schema, files({}), { NOPE: '1' })
    expect(() => source.get('NOPE')).toThrow(/NOPE 不在配置 schema 里/)
  })

  it('两项共用一个环境变量名 → 抛错', () => {
    const clash = { a: setting('X', 'string'), b: { c: setting('X', 'number') } } satisfies ConfigSchema
    expect(() => resolveConfig(clash, files({}), {})).toThrow(/a 和 b\.c 用了同一个环境变量 X/)
  })
})

describe('先不校验的段（deferred）', () => {
  it('顶层 deferred 的段原样放过，其余照常校验', () => {
    const schema = { server: { port: setting('PORT', 'number') } }
    const files = { files: [], data: { server: { port: 1 }, modules: { whatever: { x: 1 } } } }
    expect(() => resolveConfig(schema, files, {})).toThrow('modules 不是认得的配置项')
    expect(resolveConfig(schema, files, {}, { deferred: ['modules'] }).get('PORT')).toBe('1')
  })
})
