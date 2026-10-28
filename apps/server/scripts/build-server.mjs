/**
 * 把后端打包进 output/，并把 output/ 补成一个「完整可运行的 app 目录」：
 * 拷完就能 `npm install --omit=dev && npm start`，也能直接 `docker build ./output`。
 *
 * 产出（前端由 `vite build` 落到 output/public）：
 *   output/package.json        运行时依赖（版本锁死）+ start / db:push 脚本
 *   output/server/index.js     打包后的后端入口（ESM，node 22）
 *   output/server/db-sync.js   表结构同步入口（apps/server/db/sync-cli.ts），容器启动先跑它
 *   output/Dockerfile          构建上下文就是 output/ 本身
 *   output/.dockerignore、output/README.md
 *
 * **一个产物两种库**：实体定义和库无关，驱动在运行时按 DB_PROVIDER 动态 import
 * （apps/server/db/orm.ts），所以构建不再按库裁剪 —— `@mikro-orm/sqlite`（连带 better-sqlite3）
 * 和 `@mikro-orm/postgresql`（连带 pg）都进运行时依赖，构建时也不用关心 DB_PROVIDER。
 *
 * 打包要点：
 * - 内联仓库里的相对导入和 workspace 包（`@shadecn/*`，见下面的 externalizePackages），
 *   其余 node_modules 里的包全部 external，运行时依赖清单就是从这些 external 反推出来的；
 * - 两个入口共用一次构建：共享的模块（config、实体、ORM 工厂）切成公共 chunk，两个入口各自只是薄薄一层；
 * - splitting: true —— frontend/index.ts 里那句 `await import('./dev.ts')` 必须留成
 *   真正的动态 import 切到独立 chunk，否则 vite 会被提升成顶层静态依赖，
 *   生产环境根本没装 vite，一启动就崩；
 * - define __APP_BUNDLE__ —— apps/server/runtime.ts 靠它区分「源码运行」和「产物运行」。
 *
 * 两个基准目录（monorepo 之后分开了）：
 *   serverDir = apps/server  —— 入口、产物模板、依赖清单和已装的包都从这里取；
 *   rootDir   = 仓库根       —— output/ 落在这里，output/package.json 的 name / version 也取根的，
 *                              好让产物和迁移前逐字节一致。
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

/** 后端包目录（apps/server）：入口、产物模板、依赖清单和已装的包都在这儿 */
const serverDir = path.resolve(import.meta.dirname, '..')
/** 仓库根：output/ 落在这里 */
const rootDir = path.resolve(serverDir, '..', '..')

const outDir = path.join(rootDir, 'output')
const serverOutDir = path.join(outDir, 'server')
const templateDir = path.join(serverDir, 'scripts/output-image')

/**
 * 只在 dev 分支（output/server/dev-*.js）里用到的包，不进运行时依赖。
 * 那个 chunk 在生产永远不会被 import —— isDev 为 false 时压根走不到那句动态 import。
 */
const DEV_ONLY = new Set(['vite'])

/**
 * workspace 里的包（packages/*）。它们是 **source-only 的 TS**：没有构建产物、不发 npm，
 * 产物目录里也装不上 —— 所以必须内联进 bundle，不能 external。
 */
const WORKSPACE_SCOPE = '@shadecn/'

/**
 * 「包路径一律 external」，workspace 包除外。
 *
 * 等价于 esbuild 的 `packages: 'external'`（判据一样：不以 `.` / `/` 开头的导入路径），
 * 只是给 `@shadecn/*` 开了个口子 —— `packages: 'external'` 本身没有例外可配，
 * 用它的话 `@shadecn/shared` 会被留成一句运行时 import，产物一启动就找不到模块。
 *
 * workspace 包里再 import 的第三方包（比如 shared 里的 yjs）走回这条规则，照样 external，
 * 也就照样进下面那份运行时依赖清单。
 */
const externalizePackages = {
  name: 'externalize-packages',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith(WORKSPACE_SCOPE)) return undefined
      return { path: args.path, external: true }
    })
  },
}

await rm(serverOutDir, { recursive: true, force: true })
await mkdir(serverOutDir, { recursive: true })

const result = await build({
  // 产物里的文件名：server/index.js（服务）、server/db-sync.js（结构同步，容器 CMD 先跑它）
  entryPoints: {
    index: path.join(serverDir, 'index.ts'),
    'db-sync': path.join(serverDir, 'db/sync-cli.ts'),
  },
  outdir: serverOutDir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  plugins: [externalizePackages],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  define: { __APP_BUNDLE__: 'true' },
  metafile: true,
})

await writeOutputPackageJson(collectRuntimeDeps(result.metafile))

// 老产物（Prisma 时代）留下的 schema 和 CLI 配置：现在的产物用不上，留着只会误导人
await rm(path.join(outDir, 'prisma'), { recursive: true, force: true })
await rm(path.join(outDir, 'prisma.config.js'), { force: true })

for (const file of ['Dockerfile', '.dockerignore', 'README.md']) {
  await cp(path.join(templateDir, file), path.join(outDir, file))
}

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0)
console.log(`[build:server] output/server → ${(bytes / 1024).toFixed(1)} kB（SQLite / PostgreSQL 通用）`)

/** 从 esbuild 的 external import 反推运行时依赖：'y-protocols/sync' → 'y-protocols' */
function collectRuntimeDeps(metafile) {
  const names = new Set()

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
  const source = JSON.parse(await readFile(path.join(serverDir, 'package.json'), 'utf8'))
  // 产物的 name / version 沿用仓库根的 —— 产物身份不随 monorepo 改造变化
  const identity = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'))

  /**
   * 后端包（apps/server）的 dependencies 就该正好是「运行时要的东西」，devDependencies 是构建期的。
   * 打包反推出来的依赖如果跑到 devDependencies 里去了（或者根本没在后端包里声明），
   * 说明这条约定被破坏了，直接构建失败 —— 否则产物的 package.json 会悄悄多出一个
   * 没人当它是运行时依赖的包。
   */
  const misplaced = deps.filter((name) => !source.dependencies?.[name])
  if (misplaced.length > 0) {
    throw new Error(
      `这些包是运行时依赖，请挪到 apps/server/package.json 的 dependencies：${misplaced.join(', ')}`,
    )
  }

  // 版本锁到本次构建实际装的那一个：产物是构建结果，不该在部署时再漂
  const dependencies = {}
  for (const name of deps) {
    dependencies[name] = await installedVersion(name)
  }

  const pkg = {
    name: identity.name,
    version: identity.version,
    private: true,
    type: 'module',
    engines: { node: '>=22' },
    scripts: {
      start: 'NODE_ENV=production node server/index.js',
      /**
       * 结构同步：把库对齐到实体定义，没有迁移历史（见 docs/05）。
       *
       * **默认不放行有损变更**：真遇到要删列删表改类型的变更时，宁可启动失败、
       * 让人来看一眼，也不要在生产库上静默丢数据。确认过之后人工执行一次
       * `npm run db:push:force` 即可。
       */
      'db:push': 'node server/db-sync.js',
      'db:push:force': 'node server/db-sync.js --force',
    },
    dependencies,
  }

  await writeFile(path.join(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

async function installedVersion(name) {
  // pnpm workspace 下包装在声明它的那个包的 node_modules 里（符号链接进 .pnpm），不是仓库根
  const manifest = path.join(serverDir, 'node_modules', name, 'package.json')
  const { version } = JSON.parse(await readFile(manifest, 'utf8'))
  return version
}
