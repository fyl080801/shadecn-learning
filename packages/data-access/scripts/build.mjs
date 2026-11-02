/**
 * 把 @learning/data-access 打成 dist/index.js：`node scripts/build.mjs [输出目录]`。
 *
 * 用 esbuild 而不是 tsc：`@shadecn/*` 是 source-only 的 TS，tsc 的产物还会在运行时 import 它们，
 * 到 node_modules 底下就是 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING。这里内联进来（scripts/bundle-common.mjs 的规则），
 * 其余第三方包留 external，运行时从本包的 node_modules 解析 —— 所以产物 import 的每个包都必须在 dependencies / peerDependencies 里，下面校验。
 */
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { externalPackagesOf, nodeBundleOptions } from '../../../scripts/bundle-common.mjs'

const packageDir = path.resolve(import.meta.dirname, '..')
const outdir = path.resolve(process.argv[2] ?? path.join(packageDir, 'dist'))

await rm(outdir, { recursive: true, force: true })

const result = await build({
  ...nodeBundleOptions,
  entryPoints: { index: path.join(packageDir, 'src/index.ts') },
  outdir,
  sourcemap: true,
  logLevel: 'warning',
})

const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
const declared = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)])
const undeclared = externalPackagesOf(result.metafile.outputs).filter((name) => !declared.has(name))
if (undeclared.length > 0) {
  throw new Error(`[data-access] 产物 import 了没声明的包：${undeclared.join(', ')}（加到 dependencies，否则运行时解析不到）`)
}
