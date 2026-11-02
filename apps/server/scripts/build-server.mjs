/**
 * 把后端打包进 output/，并把 output/ 补成一个「完整可运行的 app 目录」：
 * 拷完就能 `npm install --omit=dev && npm start`，也能直接 `docker build ./output`。
 *
 * 产出（前端由 `vite build` 落到 output/public）：
 *   output/package.json        运行时依赖（版本锁死）+ start / db:push 脚本
 *   output/server/index.js     打包后的后端入口（ESM，node 22）
 *   output/server/db-sync.js   表结构同步入口（apps/server/db-sync.ts），容器启动先跑它
 *   output/server/agent-runner.js  画布 agent 的 runner（packages/agent/src/runner/main.ts）：
 *                              `process` 沙箱驱动 spawn 的就是它（docs/22 §7），环境变量只有网关地址 + 一次性凭证
 *   output/server/agents/      agent 定义（packages/agent/agents/*.md，docs/26 §3.1）：服务端启动时读、校验
 *                              （packages/server-core/src/config.ts 的 agentDefinitionsDir）。只给服务端，不进沙箱镜像
 *   output/server/skills/      文字技能（packages/agent/skills/ 里的 *.md，保留子目录，docs/26 §3.8）：服务端启动时读、校验
 *                              （config.ts 的 agentTextSkillsDir；源目录不存在就不拷 = 没有文字技能）。只给服务端，不进沙箱镜像
 *   output/Dockerfile          构建上下文就是 output/ 本身
 *   output/.dockerignore、output/README.md
 *
 * `oci` 沙箱镜像的构建上下文 output/agent-sandbox/ 不归这里，归 apps/agent-sandbox（`pnpm build:sandbox`）：
 * 这个脚本不读也不删它，`pnpm build` 把两边都跑一遍。服务端镜像里没有那个目录，所以 `process` 驱动的 runner 留在上面这份产物里。
 *
 * **一个产物两种库**：实体定义和库无关，驱动在运行时按 DATABASE_PROVIDER 动态 import
 * （packages/server-core/src/db/orm.ts），所以构建不再按库裁剪 —— `@mikro-orm/sqlite`（连带 better-sqlite3）
 * 和 `@mikro-orm/postgresql`（连带 pg）都进运行时依赖，构建时也不用关心 DATABASE_PROVIDER。
 *
 * 打包要点：
 * - 内联仓库里的相对导入和 workspace 包（`@shadecn/*`，见 scripts/bundle-common.mjs 的 externalizePackages），
 *   其余 node_modules 里的包全部 external，运行时依赖清单就是从这些 external 反推出来的；
 * - 三个入口共用一次构建：共享的模块（config、实体、ORM 工厂、agent 的工具定义）切成公共 chunk，各入口只是薄薄一层；
 *   runner 只 import packages/agent 里沙箱那一侧的模块，不会把服务端的 config / 数据库拖进它的进程；
 * - splitting: true —— 三个入口共享的模块切成公共 chunk（见上一条）；
 * - **产物里不能有 Vite**（docs/28 §3.8）：开发用的中间件只在 `apps/server/dev.ts` 入口里，生产入口 `index.ts`
 *   不引用它；下面的 assertNoDevCode 对着 metafile 断言，谁要是把它引回 index.ts 的依赖图，构建直接失败；
 * - define __APP_BUNDLE__ —— packages/server-core/src/runtime.ts 靠它区分「源码运行」和「产物运行」；
 * - define __AGENT_BUILD_ID__ —— 本次构建的 id（packages/agent/src/build-id.ts）：`AGENT_BUILD_ID` 给了就用，`pnpm build` 靠它
 *   让沙箱构建拿到同一个；网关据此发现「沙箱镜像和服务端不是同一次构建」（只打 warn；真正拦截不兼容的是协议版本，protocol.ts）。
 *
 * 两个基准目录（monorepo 之后分开了）：
 *   serverDir = apps/server  —— 入口、产物模板、依赖清单和已装的包都从这里取；
 *   rootDir   = 仓库根       —— output/ 落在这里，output/package.json 的 name / version 也取根的，
 *                              好让产物和迁移前逐字节一致。
 */
import { existsSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { externalPackagesOf, installedVersion, nodeBundleOptions, packageName, resolveBuildId } from '../../../scripts/bundle-common.mjs'

/** 后端包目录（apps/server）：入口、产物模板、依赖清单和已装的包都在这儿 */
const serverDir = path.resolve(import.meta.dirname, '..')
/** 仓库根：output/ 落在这里 */
const rootDir = path.resolve(serverDir, '..', '..')

const outDir = path.join(rootDir, 'output')
const serverOutDir = path.join(outDir, 'server')
const templateDir = path.join(serverDir, 'scripts/output-image')
/** agent 定义的源目录：原样拷到 output/server/agents/（只拷 *.md） */
const agentDefinitionsDir = path.join(rootDir, 'packages/agent/agents')
/** 文字技能的源目录：拷到 output/server/skills/（目录结构不变，只拷 *.md） */
const agentTextSkillsDir = path.join(rootDir, 'packages/agent/skills')
/** runner 入口（esbuild 的第三个入口） */
const RUNNER_ENTRY = 'packages/agent/src/runner/main.ts'

/** 本次构建的 id（见文件头）；同一次 `build:server` 里是常量 */
const buildId = resolveBuildId()

await rm(serverOutDir, { recursive: true, force: true })
await mkdir(serverOutDir, { recursive: true })

const result = await build({
  // 产物里的文件名：server/index.js（服务）、server/db-sync.js（结构同步，容器 CMD 先跑它）、
  // server/agent-runner.js（沙箱里的 runner，由服务端的 process 驱动起）
  entryPoints: {
    index: path.join(serverDir, 'index.ts'),
    'db-sync': path.join(serverDir, 'db-sync.ts'),
    'agent-runner': path.join(rootDir, RUNNER_ENTRY),
  },
  ...nodeBundleOptions,
  outdir: serverOutDir,
  splitting: true,
  sourcemap: true,
  logLevel: 'info',
  define: { __APP_BUNDLE__: 'true', __AGENT_BUILD_ID__: JSON.stringify(buildId) },
})

assertNoDevCode(result.metafile)
await writeOutputPackageJson(externalPackagesOf(result.metafile.outputs))
// agent 定义随产物发布：服务端从 index.js 旁边的 agents/ 读（源码运行时读 packages/agent/agents/）
await cp(agentDefinitionsDir, path.join(serverOutDir, 'agents'), {
  recursive: true,
  filter: (source) => source === agentDefinitionsDir || source.endsWith('.md'),
})
// 文字技能同样随产物发布（服务端从 index.js 旁边的 skills/ 读）。子目录要进（<name>/SKILL.md），技能目录里别的文件不读、不拷
if (existsSync(agentTextSkillsDir)) {
  await cp(agentTextSkillsDir, path.join(serverOutDir, 'skills'), {
    recursive: true,
    filter: (source) => source.endsWith('.md') || statSync(source).isDirectory(),
  })
}

// 老产物（Prisma 时代）留下的 schema 和 CLI 配置：现在的产物用不上，留着只会误导人
await rm(path.join(outDir, 'prisma'), { recursive: true, force: true })
await rm(path.join(outDir, 'prisma.config.js'), { force: true })

for (const file of ['Dockerfile', '.dockerignore', 'README.md']) {
  await cp(path.join(templateDir, file), path.join(outDir, file))
}

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0)
console.log(`[build:server] 构建 id ${buildId}`)
console.log(`[build:server] output/server → ${(bytes / 1024).toFixed(1)} kB（SQLite / PostgreSQL 通用）`)

/**
 * 产物里不能有开发用的东西（docs/28 §3.8）：`apps/server/dev.ts`、`@shadecn/server-core` 的 `frontend/dev.ts`
 * 这几个文件，以及 `vite` 这个包。它们只在 dev 入口的依赖图里；出现在这里 = 有人从 index.ts 那边引到了它们。
 * 以前靠「动态 import + 运行时 isDev 判断」把 vite 挡在生产之外，但 chunk 仍然在产物里；现在是打包时就不存在。
 */
function assertNoDevCode(metafile) {
  const devFiles = Object.keys(metafile.inputs)
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => /(^|\/)(dev|frontend\/dev)\.ts$/.test(file))
  const externals = new Set()
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external) externals.add(packageName(imported.path))
    }
  }
  const problems = [...devFiles, ...(externals.has('vite') ? ['vite（包）'] : [])]
  if (problems.length > 0) {
    throw new Error(`产物里混进了开发用的代码：${problems.join(', ')} —— 生产入口 index.ts 不能引用它们（docs/28 §3.8）`)
  }
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
    dependencies[name] = await installedVersion(serverDir, name)
  }

  const pkg = {
    name: identity.name,
    version: identity.version,
    private: true,
    type: 'module',
    engines: { node: '>=22.19' },
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
