import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_ENV, cfg, coreConfigSchema, resolveFullConfig, serverConfigSchema } from '@shadecn/server-core/config-source'
import { rootDir } from '@shadecn/server-core/config'
import { AGENT_PROVIDER_KEY_ENV, agentConfig, agentEnv } from '@shadecn/mod-agent/config'
import { envNameOf, resolveConfig, setting, type ConfigSchema, type Setting } from '@shadecn/server-kit/config'
import { modules } from '../modules.ts'

/**
 * 环境变量名只由配置路径推导（docs/28 §3.3）。名字写错不会报错，只是悄悄不生效 —— 所以这里把
 * 「仓库里提到的配置变量」（清单、`.env.example`、文档、`packages/agent` 手写在报错里的）都对到真实的 schema 上。
 */
const schema = serverConfigSchema(modules)

function leaves(node: ConfigSchema, at: string[] = []): { path: string; type: Setting['type'] }[] {
  return Object.entries(node).flatMap(([key, child]) =>
    child.kind === 'setting' ? [{ path: [...at, key].join('.'), type: (child as Setting).type }] : leaves(child as ConfigSchema, [...at, key]),
  )
}

const allLeaves = leaves(schema)
const derived = new Set(allLeaves.map((leaf) => envNameOf(leaf.path)))
const empty = { files: [], data: {} }

/** 只认环境变量、不在 schema 里的：引导变量、Downward API、按提供方退回的 key、开发和测试工具 */
const NOT_IN_SCHEMA = new Set<string>([
  ...BOOTSTRAP_ENV,
  'POD_IP',
  ...Object.values(AGENT_PROVIDER_KEY_ENV).flat(),
  'DEV_CLUSTER_ROLES',
  'DEV_CLUSTER_PORTS',
  'DEV_ALLOWED_HOSTS',
  'TEST_DATABASE_URL',
  'TEST_REDIS_URL',
  // 示例里应用表 / 语言服务提供方 `$变量` 引用的名字：写表的人自己定的
  'ARK_API_KEY',
  'MY_LLM_API_KEY',
  'LLM_PROXY', // 不是配置：docs/22 的迁移记录里提到的旧代码常量
  'MODULES_AGENT_API_KEY', // 线上 Secret 的键名没改，LLM_PROVIDERS 里 `$MODULES_AGENT_API_KEY` 引用它（docs/12 §3.3）；它已经不是配置项
])

/** 配置变量的前缀：这些前缀下的大写词都应该是推导出来的名字 */
const CONFIG_TOKEN = /(?<![A-Za-z0-9_$])(?:MODULES|SERVER|DATABASE|CLUSTER|LOG|LLM)_[A-Z0-9_]+\*?/g

const read = (file: string) => readFileSync(path.join(rootDir, file), 'utf8')

function filesUnder(dir: string, match: RegExp): string[] {
  return readdirSync(path.join(rootDir, dir)).flatMap((name) => {
    const file = path.join(dir, name)
    if (statSync(path.join(rootDir, file)).isDirectory()) return filesUnder(file, match)
    return match.test(name) ? [file] : []
  })
}

/** 一个词对不上任何推导出的名字：`MODULES_STORAGE_*` 这种通配写法要至少能匹配上一个 */
function isKnownToken(token: string): boolean {
  if (token.endsWith('*') || token.endsWith('_')) {
    const prefix = token.replace(/\*$/, '')
    return [...derived].some((name) => name.startsWith(prefix))
  }
  return derived.has(token) || NOT_IN_SCHEMA.has(token)
}

describe('环境变量名由配置路径推导', () => {
  it.each([
    ['server.port', 'SERVER_PORT'],
    ['server.origin', 'SERVER_ORIGIN'],
    ['server.instanceId', 'SERVER_INSTANCE_ID'],
    ['database.provider', 'DATABASE_PROVIDER'],
    ['database.url', 'DATABASE_URL'],
    ['cluster.redisUrl', 'CLUSTER_REDIS_URL'],
    ['log.slowMs', 'LOG_SLOW_MS'],
    ['modules.agent.enabled', 'MODULES_AGENT_ENABLED'],
    ['modules.agent.sandbox.driver', 'MODULES_AGENT_SANDBOX_DRIVER'],
    ['modules.agent.sandbox.k8s.apiUrl', 'MODULES_AGENT_SANDBOX_K8S_API_URL'],
    ['modules.auth.sessionSecret', 'MODULES_AUTH_SESSION_SECRET'],
    ['modules.auth.keycloak.issuer', 'MODULES_AUTH_KEYCLOAK_ISSUER'],
    ['modules.storage.bucket', 'MODULES_STORAGE_BUCKET'],
    ['modules.storage.maxUploadMb', 'MODULES_STORAGE_MAX_UPLOAD_MB'],
    ['llm.providers', 'LLM_PROVIDERS'],
  ])('真实的 schema：%s 由 %s 配置', (leaf, name) => {
    const source = resolveConfig(schema, empty, { [name]: 'from-env' })
    expect(source.get(leaf)).toBe('from-env')
    expect(source.origin(leaf)).toBe('env')
  })

  it('schema 的每一项都同时能从环境变量和文件配（环境变量优先）', () => {
    const fileValue = { string: 'x', number: 1, boolean: true, list: ['a'], map: { a: 'b' }, json: { a: { b: 1 } } } as const
    expect(allLeaves.length).toBeGreaterThan(70)
    for (const leaf of allLeaves) {
      const data: Record<string, unknown> = {}
      const segments = leaf.path.split('.')
      let cursor = data
      for (const segment of segments.slice(0, -1)) cursor = (cursor[segment] = {}) as Record<string, unknown>
      cursor[segments.at(-1)!] = fileValue[leaf.type]

      const files = { files: ['server.config.yaml'], data }
      expect(resolveConfig(schema, files, {}).origin(leaf.path), leaf.path).toBe('file')
      const fromEnv = resolveConfig(schema, files, { [envNameOf(leaf.path)]: 'from-env' })
      expect(fromEnv.get(leaf.path), leaf.path).toBe('from-env')
    }
  })

  it('真实的 schema 没有撞名，也不碰引导变量', () => {
    expect(derived.size).toBe(allLeaves.length)
    for (const name of BOOTSTRAP_ENV) expect(derived.has(name), name).toBe(false)
    expect(() => resolveFullConfig(modules)).not.toThrow()
  })

  it('底座的 cfg、模块的 read 和文案帮手：路径按真实的 schema 收窄，拼错过不了编译，运行时也抛', () => {
    // @ts-expect-error 没有这一项
    expect(() => cfg('server.prot')).toThrow(/不在配置 schema 里/)
    expect(() => cfg('server.port')).not.toThrow()
    const read: Parameters<typeof agentConfig.parse>[0] = () => undefined
    // @ts-expect-error 没有这一项（路径相对 modules.agent）
    expect(read('sandbox.k8s.namepsace')).toBeUndefined()
    expect(read('sandbox.k8s.namespace')).toBeUndefined()
    // @ts-expect-error 没有这一项
    expect(agentEnv('sandbox.drvier')).toBe('MODULES_AGENT_SANDBOX_DRVIER')
    expect(agentEnv('sandbox.driver')).toBe('MODULES_AGENT_SANDBOX_DRIVER')
  })

  it('schema 的叶子推导出引导变量 → 启动失败（将来加 server.config 这种键）', () => {
    const clash = { ...coreConfigSchema, server: { ...coreConfigSchema.server, config: setting('string') } }
    expect(() => resolveConfig(clash, empty, {}, { reservedEnv: BOOTSTRAP_ENV })).toThrow(/server\.config 推导出的环境变量 SERVER_CONFIG 另有用途/)
  })
})

describe('仓库里提到的配置变量都对得上 schema（写错了不报错，只是悄悄不生效）', () => {
  const deployments = [
    'k8s/deployment.yaml',
    'k8s/variants/deployment.cluster.yaml',
    'k8s/variants/roles/deployment.web.yaml',
    'k8s/variants/roles/deployment.collab.yaml',
    'k8s/variants/roles/deployment.agent.yaml',
  ]

  it.each(deployments)('%s：env 的 name 和 --from-literal 的键（含注释里的）', (file) => {
    const text = read(file)
    const names = [
      ...[...text.matchAll(/^\s*#?\s*- name: ([A-Z][A-Z0-9_]+)\s*$/gm)].map((match) => match[1]),
      ...[...text.matchAll(/--from-literal=([A-Z][A-Z0-9_]+)=/g)].map((match) => match[1]),
    ]
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => !isKnownToken(name))).toEqual([])
  })

  it('.env.example 里每个变量（含注释掉的）', () => {
    const names = [...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1])
    expect(names.length).toBeGreaterThan(50)
    expect(names.filter((name) => !isKnownToken(name))).toEqual([])
  })

  it('配置路径前缀下的词：镜像、清单、文档、规则、agent 包手写的报错、测试的固定环境', () => {
    const files = [
      'Dockerfile',
      'apps/server/scripts/output-image/Dockerfile',
      'apps/server/scripts/output-image/README.md',
      'apps/server/scripts/dev-cluster.mjs',
      'apps/agent-sandbox/scripts/build-image.mjs',
      'apps/server/vitest.config.ts',
      'apps/server/test/global-setup.ts',
      'sample/server.config.example.yaml',
      '.env.example',
      'apps/web/src/login/LoginPage.vue',
      ...filesUnder('k8s', /\.yaml$/),
      ...filesUnder('ci', /\.yaml$/),
      ...filesUnder('docs', /\.md$/),
      ...filesUnder('.claude/rules', /\.md$/),
    ]
    const unknownIn = (file: string, pattern: RegExp) =>
      [...read(file).matchAll(pattern)].map((match) => match[0]).filter((token) => !isKnownToken(token)).map((token) => `${file}: ${token}`)
    const unknown = [
      ...files.flatMap((file) => unknownIn(file, CONFIG_TOKEN)),
      // agent 包不认识配置层，报错里的变量名是手写的；它的代码常量里有 `LOG_*`，所以只看 `MODULES_`
      ...filesUnder('packages/agent/src', /\.ts$/).flatMap((file) => unknownIn(file, /(?<![A-Za-z0-9_$])MODULES_[A-Z0-9_]+\*?/g)),
    ]
    expect([...new Set(unknown)]).toEqual([])
  })
})
