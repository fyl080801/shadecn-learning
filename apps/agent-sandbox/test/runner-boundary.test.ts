import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundleRunner } from '../scripts/bundle-runner.mjs'
import { findBoundaryViolations, isServerOnlyPackage, RUNNER_ENTRY } from '../scripts/runner-boundary.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const manifest = (dir: string) =>
  JSON.parse(readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }

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
      'output/agent-sandbox/runner/agent-runner.js': { bytes: 1, inputs: {}, exports: [], imports: externals.map(external) },
    },
  }
}

describe('runner 的边界判定', () => {
  it('runner 侧的源码和声明过的第三方包 → 干净', () => {
    const clean = metafile({
      inputs: [
        'packages/agent/src/runner/client.ts',
        'packages/agent/src/protocol.ts',
        'packages/agent/src/tools.ts',
        'packages/agent/src/media.ts',
        'packages/agent/src/build-id.ts',
        'packages/agent/src/skills/canvas/index.ts',
        'packages/agent/src/sandbox/local.ts',
        'packages/agent/src/sandbox/media-tool.ts',
        'packages/shared/src/flow-doc.ts',
      ],
      externals: ['yjs', 'node:path'],
    })
    expect(findBoundaryViolations(clean, DECLARED)).toEqual([])
  })

  it.each([
    // rules/agent.md 点名的
    'session', 'gateway', 'store', 'canvas-changes',
    // 其余服务端模块：令牌签发、定义加载、上游调用、转录、事件映射、占用……
    'agents', 'authority', 'canvas', 'events', 'frontmatter', 'llm-providers', 'model', 'model-stream',
    'occupancy', 'prompt', 'run-registry', 'testing', 'text-skills', 'title', 'token', 'transcript',
  ])('agent 包的服务端模块 %s 进了闭包 → 越界', (name) => {
    const file = `packages/agent/src/${name}.ts`
    expect(findBoundaryViolations(metafile({ inputs: [file] }), DECLARED)).toEqual([`源码 ${file} 不属于 runner 侧`])
  })

  it.each([
    'packages/agent/src/sandbox/index.ts',
    'packages/agent/src/sandbox/driver.ts',
    'packages/agent/src/sandbox/drivers/oci.ts',
    'packages/agent/src/sandbox/drivers/k8s.ts',
    'packages/server-core/src/config.ts',
    'packages/server-kit/src/platform.ts',
    'packages/mod-agent/src/index.ts',
    'apps/server/modules.ts',
    'node_modules/.pnpm/hono@4.13.2/node_modules/hono/dist/index.js',
  ])('其它不属于 runner 侧的文件 %s → 越界（默认拒绝）', (file) => {
    expect(findBoundaryViolations(metafile({ inputs: [file] }), DECLARED)).toEqual([`源码 ${file} 不属于 runner 侧`])
  })

  it('Windows 风格的路径分隔符不会让越界漏过去', () => {
    const [violation] = findBoundaryViolations(metafile({ inputs: ['packages\\agent\\src\\session.ts'] }), DECLARED)
    expect(violation).toContain('packages/agent/src/session.ts')
  })

  it.each(['hono', '@hono/node-server', '@mikro-orm/core', 'better-sqlite3', 'pg', 'ioredis', '@hocuspocus/server', 'yaml', 'winston'])(
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
      '第三方包 left-pad 没有声明在 apps/agent-sandbox/package.json 的 dependencies 里',
    ])
    expect(findBoundaryViolations(metafile({ shaken: ['left-pad'] }), DECLARED)).toEqual([])
  })

  it('metafile 里没有 runner 入口（键不是相对仓库根）→ 失败，不能空转成通过', () => {
    const relocated = { inputs: { '../../packages/agent/src/runner/main.ts': { bytes: 1, imports: [] } }, outputs: {} }
    expect(findBoundaryViolations(relocated, DECLARED)).toHaveLength(1)
    expect(findBoundaryViolations(relocated, DECLARED)[0]).toContain(RUNNER_ENTRY)
  })
})

describe('沙箱的依赖声明', () => {
  it('服务端的每个运行时依赖，要么沙箱也声明了，要么在服务端专属清单里（服务端新增依赖时这里提醒补清单）', () => {
    const sandbox = manifest('apps/agent-sandbox').dependencies
    const unclassified = Object.keys(manifest('apps/server').dependencies).filter(
      (name) => !sandbox[name] && !isServerOnlyPackage(name),
    )
    expect(unclassified).toEqual([])
  })

  it('沙箱声明的包不在服务端专属清单里', () => {
    expect(Object.keys(manifest('apps/agent-sandbox').dependencies).filter(isServerOnlyPackage)).toEqual([])
  })

  it('和服务端共有的依赖版本范围一字不差：同一份 runner 构建两次，process 驱动和镜像不能跑在不同版本上', () => {
    const server = manifest('apps/server').dependencies
    for (const [name, range] of Object.entries(manifest('apps/agent-sandbox').dependencies)) {
      expect(server[name], name).toBe(range)
    }
  })
})

describe('真实打包 runner', () => {
  it('现有闭包干净；依赖正好是沙箱声明的那几个；构建 id 注入进去', async () => {
    const { code, dependencies } = await bundleRunner({ buildId: 'test-build-id' })
    expect(dependencies).toEqual(Object.keys(manifest('apps/agent-sandbox').dependencies).sort())
    expect(code).toContain('"test-build-id"')
    expect(code).not.toContain('__AGENT_BUILD_ID__')
  })
})
