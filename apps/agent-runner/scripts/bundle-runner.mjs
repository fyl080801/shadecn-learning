/**
 * 打包镜像里的 runner：单入口、单文件（不开 splitting），只进内存，
 * 边界判定（runner-boundary.mjs）通过才把结果交出去 —— 越界的 runner 连临时文件都不会留在磁盘上。
 *
 * 入口按包解析（`@learning/agent-core/runner/main` 的 `source` 导出），不靠目录结构。
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { build } from 'esbuild'
import { externalPackagesOf, nodeBundleOptions } from './bundle-config.mjs'
import { findBoundaryViolations } from './runner-boundary.mjs'

/** runner 镜像包目录（apps/agent-runner）：依赖清单和已装的包都在这儿 */
export const runnerDir = path.resolve(import.meta.dirname, '..')
/** 仓库根：metafile 的键相对它 */
export const rootDir = path.resolve(runnerDir, '..', '..')
/**
 * 镜像的构建上下文。**不放 output/**：`pnpm build` 之后 `docker build ./output` 是旧服务的镜像路径，
 * output/.dockerignore 只排除了 agent-sandbox，这边放进去就混进旧服务的应用镜像了。
 */
export const contextDir = path.join(runnerDir, 'dist')

/** agent-core 的 runner 入口源码，从包的 `exports` 读（`require.resolve` 走 `default`，那是 tsc 产物） */
async function runnerEntry() {
  const manifestPath = createRequire(import.meta.url).resolve('@learning/agent-core/package.json')
  const { exports: exported } = JSON.parse(await readFile(manifestPath, 'utf8'))
  return path.join(path.dirname(manifestPath), exported['./runner/main'].source)
}

/**
 * @param {{ buildId: string }} options
 * @returns {Promise<{ code: string, dependencies: string[] }>} runner 的代码，和产物真正 import 的第三方包
 */
export async function bundleRunner({ buildId }) {
  const manifest = JSON.parse(await readFile(path.join(runnerDir, 'package.json'), 'utf8'))

  const result = await build({
    ...nodeBundleOptions,
    absWorkingDir: rootDir,
    entryPoints: { 'agent-runner': await runnerEntry() },
    outdir: 'apps/agent-runner/dist/runner',
    write: false,
    logLevel: 'warning',
    define: { __AGENT_BUILD_ID__: JSON.stringify(buildId) },
  })

  const violations = findBoundaryViolations(result.metafile, Object.keys(manifest.dependencies ?? {}))
  if (violations.length > 0) {
    throw new Error(`runner 越界了，沙箱里不能有服务端的东西（.claude/rules/agent.md）：\n  - ${violations.join('\n  - ')}`)
  }
  return { code: result.outputFiles[0].text, dependencies: externalPackagesOf(result.metafile.outputs) }
}
