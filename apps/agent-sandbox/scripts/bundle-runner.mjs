/**
 * 打包沙箱镜像里的 runner：单入口、单文件（不开 splitting，不和服务端共用 chunk），只进内存，
 * 边界判定（runner-boundary.mjs）通过才把结果交出去 —— 越界的 runner 连临时文件都不会留在磁盘上。
 *
 * 入口按包解析（`@shadecn/agent/runner/main`，和 mod-agent 的 runner-command.ts 一样），不靠目录结构。
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { build } from 'esbuild'
import { externalPackagesOf, nodeBundleOptions } from '../../../scripts/bundle-common.mjs'
import { findBoundaryViolations } from './runner-boundary.mjs'

/** 沙箱镜像包目录（apps/agent-sandbox）：依赖清单和已装的包都在这儿 */
export const sandboxDir = path.resolve(import.meta.dirname, '..')
/** 仓库根：output/ 落在这里，metafile 的键也相对它 */
export const rootDir = path.resolve(sandboxDir, '..', '..')

/**
 * @param {{ buildId: string }} options
 * @returns {Promise<{ code: string, dependencies: string[] }>} runner 的代码，和产物真正 import 的第三方包
 */
export async function bundleRunner({ buildId }) {
  const manifest = JSON.parse(await readFile(path.join(sandboxDir, 'package.json'), 'utf8'))
  const entry = createRequire(import.meta.url).resolve('@shadecn/agent/runner/main')

  const result = await build({
    ...nodeBundleOptions,
    absWorkingDir: rootDir,
    entryPoints: { 'agent-runner': entry },
    outdir: 'output/agent-sandbox/runner',
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
