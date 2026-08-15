/**
 * 把后端打包进 output/，并把 output/ 补成一个「完整可运行的 app 目录」：
 * 拷完就能 `npm install --omit=dev && npm start`，也能直接 `docker build ./output`。
 *
 * 产出（前端由 `vite build` 落到 output/public）：
 *   output/package.json      运行时依赖（版本锁死）+ start / migrate 脚本
 *   output/server/index.js   打包后的后端入口（ESM，node 22）
 *   output/prisma/           schema + migrations
 *   output/prisma.config.js  prisma CLI 配置
 *   output/Dockerfile        构建上下文就是 output/ 本身
 *   output/.dockerignore、output/README.md
 *
 * 打包要点：
 * - 只内联仓库里的相对导入（含 server/generated/prisma 那份生成的 client），
 *   node_modules 里的包全部 external，运行时依赖清单就是从这些 external 反推出来的；
 * - splitting: true —— frontend/index.ts 里那句 `await import('./dev.ts')` 必须留成
 *   真正的动态 import 切到独立 chunk，否则 vite 会被提升成顶层静态依赖，
 *   生产环境根本没装 vite，一启动就崩；
 * - define __APP_BUNDLE__ —— server/runtime.ts 靠它区分「源码运行」和「产物运行」。
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const rootDir = path.resolve(import.meta.dirname, '..')
const outDir = path.join(rootDir, 'output')
const serverOutDir = path.join(outDir, 'server')
const templateDir = path.join(rootDir, 'scripts/output-image')

/**
 * 只在 dev 分支（output/server/dev-*.js）里用到的包，不进运行时依赖。
 * 那个 chunk 在生产永远不会被 import —— isDev 为 false 时压根走不到那句动态 import。
 */
const DEV_ONLY = new Set(['vite'])

/** 打包产物本身不 import、但运行时确实要有的包 */
const EXTRA_DEPS = ['prisma'] // 容器启动时跑 `prisma migrate deploy`

await rm(serverOutDir, { recursive: true, force: true })
await mkdir(serverOutDir, { recursive: true })

const result = await build({
  entryPoints: [path.join(rootDir, 'server/index.ts')],
  outdir: serverOutDir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  define: { __APP_BUNDLE__: 'true' },
  metafile: true,
})

await writeOutputPackageJson(collectRuntimeDeps(result.metafile))

// 迁移要跟着产物走，容器启动时 `prisma migrate deploy` 用的就是这份
await cp(path.join(rootDir, 'prisma/schema.prisma'), path.join(outDir, 'prisma/schema.prisma'))
await cp(path.join(rootDir, 'prisma/migrations'), path.join(outDir, 'prisma/migrations'), {
  recursive: true,
})

for (const file of ['prisma.config.js', 'Dockerfile', '.dockerignore', 'README.md']) {
  await cp(path.join(templateDir, file), path.join(outDir, file))
}

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0)
console.log(`[build:server] output/server → ${(bytes / 1024).toFixed(1)} kB`)

/** 从 esbuild 的 external import 反推运行时依赖：'y-protocols/sync' → 'y-protocols' */
function collectRuntimeDeps(metafile) {
  const names = new Set(EXTRA_DEPS)

  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external) continue
      const name = packageName(imported.path)
      if (!name || DEV_ONLY.has(name)) continue
      names.add(name)
    }
  }

  return [...names].sort()
}

function packageName(specifier) {
  if (specifier.startsWith('node:') || specifier.startsWith('.')) return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

async function writeOutputPackageJson(deps) {
  const source = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'))

  /**
   * 仓库根的 dependencies 就该正好是「运行时要的东西」，devDependencies 是构建期的。
   * 打包反推出来的依赖如果跑到 devDependencies 里去了，说明这条约定被破坏了，直接构建失败 ——
   * 否则产物的 package.json 会悄悄多出一个没人当它是运行时依赖的包。
   */
  const misplaced = deps.filter((name) => !source.dependencies?.[name])
  if (misplaced.length > 0) {
    throw new Error(
      `这些包是运行时依赖，请从 devDependencies 挪到 package.json 的 dependencies：${misplaced.join(', ')}`,
    )
  }

  // 版本锁到本次构建实际装的那一个：产物是构建结果，不该在部署时再漂
  const dependencies = {}
  for (const name of deps) {
    dependencies[name] = await installedVersion(name)
  }

  const pkg = {
    name: source.name,
    version: source.version,
    private: true,
    type: 'module',
    engines: { node: '>=22' },
    scripts: {
      start: 'NODE_ENV=production node server/index.js',
      migrate: 'prisma migrate deploy',
    },
    dependencies,
  }

  await writeFile(path.join(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

async function installedVersion(name) {
  const manifest = path.join(rootDir, 'node_modules', name, 'package.json')
  const { version } = JSON.parse(await readFile(manifest, 'utf8'))
  return version
}
