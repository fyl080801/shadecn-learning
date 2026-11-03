import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundleRunner } from '../scripts/bundle-runner.mjs'
import { findBoundaryViolations, isServerOnlyPackage, RUNNER_ENTRY } from '../scripts/runner-boundary.mjs'

interface Manifest {
  dependencies: Record<string, string>
  peerDependencies?: Record<string, string>
}

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const manifest = (dir: string) => JSON.parse(readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8')) as Manifest

const DECLARED = ['yjs']

/** 拼一个 metafile：入口总在，`imports` 是入口 import 的第三方包（既走到过也进了产物） */
function metafile({ inputs = [], externals = [], shaken = [] }: { inputs?: string[]; externals?: string[]; shaken?: string[] }) {
  const external = (name: string) => ({ path: name, kind: 'import-statement', external: true })
  return {
    inputs: {
      [RUNNER_ENTRY]: { bytes: 1, imports: [...externals, ...shaken].map(external) },
      ...Object.fromEntries(inputs.map((file) => [file, { bytes: 1, imports: [] }])),
    },
    outputs: {
      'apps/agent-runner/dist/runner/agent-runner.js': { bytes: 1, inputs: {}, exports: [], imports: externals.map(external) },
    },
  }
}

describe('runner 的边界判定', () => {
  it('runner 侧的源码和声明过的第三方包 → 干净', () => {
    const clean = metafile({
      inputs: [
        'packages/agent-core/src/runner/client.ts',
        'packages/agent-core/src/protocol.ts',
        'packages/agent-core/src/tools.ts',
        'packages/agent-core/src/media.ts',
        'packages/agent-core/src/build-id.ts',
        'packages/agent-core/src/skills/canvas/index.ts',
        'packages/agent-core/src/sandbox/local.ts',
        'packages/agent-core/src/sandbox/media-tool.ts',
        'packages/contracts/src/flow-doc.ts',
      ],
      externals: ['yjs', 'node:path'],
    })
    expect(findBoundaryViolations(clean, DECLARED)).toEqual([])
  })

  it.each([
    // rules/agent.md 点名的
    'session', 'gateway', 'store', 'canvas-changes',
    // 其余服务端模块：令牌签发、定义加载、上游调用、转录、事件映射、占用……（`llm-providers`、`model` 这份副本里没有了，算一个不存在的文件也要拦）
    'agents', 'authority', 'canvas', 'events', 'frontmatter', 'llm-providers', 'model', 'model-stream',
    'occupancy', 'prompt', 'run-registry', 'testing', 'text-skills', 'title', 'token', 'transcript',
  ])('agent-core 的服务端模块 %s 进了闭包 → 越界', (name) => {
    const file = `packages/agent-core/src/${name}.ts`
    expect(findBoundaryViolations(metafile({ inputs: [file] }), DECLARED)).toEqual([`源码 ${file} 不属于 runner 侧`])
  })

  it.each([
    'packages/agent-core/src/sandbox/index.ts',
    'packages/agent-core/src/sandbox/driver.ts',
    'packages/agent-core/src/sandbox/drivers/oci.ts',
    'packages/agent-core/src/sandbox/drivers/process.ts',
    'packages/agent-core/dist/protocol.js',
    'packages/llm/src/model.ts',
    'packages/llm/src/llm-providers.ts',
    'packages/agent-service/src/runtime.ts',
    'packages/config/src/index.ts',
    'packages/data-access/src/index.ts',
    'apps/platform/src/app.module.ts',
    // 旧服务那份同名文件：路径换成 agent-core 之后它们不该再算 runner 侧
    'packages/agent/src/protocol.ts',
    'packages/agent/src/runner/main.ts',
    'packages/shared/src/flow-doc.ts',
    'node_modules/.pnpm/@nestjs+core@12.3.2/node_modules/@nestjs/core/index.js',
  ])('其它不属于 runner 侧的文件 %s → 越界（默认拒绝）', (file) => {
    expect(findBoundaryViolations(metafile({ inputs: [file] }), DECLARED)).toEqual([`源码 ${file} 不属于 runner 侧`])
  })

  it('Windows 风格的路径分隔符不会让越界漏过去', () => {
    const [violation] = findBoundaryViolations(metafile({ inputs: ['packages\\agent-core\\src\\session.ts'] }), DECLARED)
    expect(violation).toContain('packages/agent-core/src/session.ts')
  })

  it.each(['@nestjs/core', 'fastify', '@fastify/static', 'reflect-metadata', '@mikro-orm/core', 'better-sqlite3', 'pg', 'ioredis', '@hocuspocus/server', 'yaml', '@learning/llm', '@learning/agent', '@shadecn/shared'])(
    '服务端专属的包 %s → 越界，即使它被声明在了 dependencies 里',
    (name) => {
      expect(findBoundaryViolations(metafile({ externals: [name] }), [...DECLARED, name])).toEqual([`第三方包 ${name} 是服务端专属的`])
    },
  )

  it('服务端专属的包被 tree-shaking 摇掉了（只在 inputs 里）也算越界', () => {
    expect(findBoundaryViolations(metafile({ shaken: ['@mikro-orm/core/subpath'] }), DECLARED)).toEqual([
      '第三方包 @mikro-orm/core 是服务端专属的',
    ])
  })

  it('产物 import 了没声明的包 → 越界；只在 inputs 里、没进产物的不用声明', () => {
    expect(findBoundaryViolations(metafile({ externals: ['left-pad'] }), DECLARED)).toEqual([
      '第三方包 left-pad 没有声明在 apps/agent-runner/package.json 的 dependencies 里',
    ])
    expect(findBoundaryViolations(metafile({ shaken: ['left-pad'] }), DECLARED)).toEqual([])
  })

  it('metafile 里没有 runner 入口（键不是相对仓库根）→ 失败，不能空转成通过', () => {
    const relocated = { inputs: { '../../packages/agent-core/src/runner/main.ts': { bytes: 1, imports: [] } }, outputs: {} }
    expect(findBoundaryViolations(relocated, DECLARED)).toHaveLength(1)
    expect(findBoundaryViolations(relocated, DECLARED)[0]).toContain(RUNNER_ENTRY)
  })
})

describe('镜像的依赖声明', () => {
  const runner = () => manifest('apps/agent-runner').dependencies

  it('正好是 4 个包：pi 的两个、yjs、dagre', () => {
    expect(Object.keys(runner()).sort()).toEqual(['@dagrejs/dagre', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'yjs'])
  })

  it('平台和 agent-core 的每个运行时依赖，要么镜像也声明了，要么在服务端专属清单里（服务端新增依赖时这里提醒补清单）', () => {
    const declaredByServerSide = ['apps/platform', 'packages/agent-service', 'packages/agent-core'].flatMap((dir) => {
      const { dependencies, peerDependencies } = manifest(dir)
      return Object.keys({ ...dependencies, ...peerDependencies })
    })
    expect(declaredByServerSide.length).toBeGreaterThan(0)
    expect(declaredByServerSide.filter((name) => !runner()[name] && !isServerOnlyPackage(name))).toEqual([])
  })

  it('镜像声明的包不在服务端专属清单里', () => {
    expect(Object.keys(runner()).filter(isServerOnlyPackage)).toEqual([])
  })

  it('和 agent-core 的版本范围一字不差：同一份 runner，process 驱动和镜像不能跑在不同版本上', () => {
    const { dependencies, peerDependencies } = manifest('packages/agent-core')
    const core = { ...peerDependencies, ...dependencies }
    for (const [name, range] of Object.entries(runner())) {
      expect(core[name], name).toBe(range)
    }
  })
})

describe('真实打包 runner', () => {
  it('现有闭包干净；依赖正好是镜像声明的那几个；构建 id 注入进去', async () => {
    const { code, dependencies } = await bundleRunner({ buildId: 'test-build-id' })
    expect(dependencies).toEqual(Object.keys(manifest('apps/agent-runner').dependencies).sort())
    expect(code).toContain('"test-build-id"')
    expect(code).not.toContain('__AGENT_BUILD_ID__')
  })

  it('contracts 和 agent-core 内联进去了，产物里没有留下任何 workspace 包的 import', async () => {
    const { code } = await bundleRunner({ buildId: 'test-build-id' })
    expect(code).not.toMatch(/from\s+"@(learning|shadecn)\//)
    expect(code).not.toMatch(/import\(\s*"@(learning|shadecn)\//)
    // 协议版本就是 agent-core 这一份：产物里有它，说明不是外部解析的
    const { RUNNER_PROTOCOL_VERSION } = await import('../../../packages/agent-core/src/protocol.ts')
    expect(code).toContain(`RUNNER_PROTOCOL_VERSION = ${RUNNER_PROTOCOL_VERSION}`)
  })

  it('闭包到不了服务端：令牌签发、编排、模型通路的代码都不在产物里', async () => {
    const { code } = await bundleRunner({ buildId: 'test-build-id' })
    for (const marker of ['createAgentRuntime', 'createAgentGateway', 'signRunToken', 'resolveAgentModel', 'streamUpstream']) {
      expect(code, marker).not.toContain(marker)
    }
  })
})
