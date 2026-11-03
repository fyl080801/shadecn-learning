/**
 * 打包 runner 用的配置（docs/31 §3.3）。这个服务和 `@shadecn/*` 没有代码或构建上的联系，所以不用 scripts/bundle-common.mjs：
 * 那边的公共选项只内联 `@shadecn/`，这边要内联的是 `@learning/contracts` 和 `@learning/agent-core`，不去改它。
 * 这个文件只用 Node 内置模块（esbuild 也不 import，插件只是个普通对象）。
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 要内联进 bundle 的 workspace 包。runner 的闭包里只该有这两个：`@learning/llm`、Nest、ORM 都不该出现，
 * 它们留成 external 之后会被边界判定拦下（runner-boundary.mjs），不会悄悄进镜像。
 */
const INLINED_PACKAGES = ['@learning/contracts', '@learning/agent-core']

const isInlined = (specifier) => INLINED_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))

/**
 * 「包路径一律 external」，上面两个包除外。
 *
 * 等价于 esbuild 的 `packages: 'external'`（判据一样：不以 `.` / `/` 开头的导入路径），只是开了个口子：
 * contracts 和 agent-core 在镜像里没有装，留成运行时 import 的话 runner 一启动就找不到模块。
 * 它们里面再 import 的第三方包（比如 contracts 里的 yjs）走回这条规则，照样 external，也就照样进依赖清单。
 */
export const externalizePackages = {
  name: 'externalize-packages',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
      if (isInlined(args.path)) return undefined
      return { path: args.path, external: true }
    })
  },
}

/**
 * esbuild 选项。`conditions: ['source']`：contracts 和 agent-core 都发布 `source` 导出条件，打包走源码，
 * 这样边界判定看到的是两个包 `src/` 下的文件，也不用先跑它们的 tsc。
 */
export const nodeBundleOptions = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  conditions: ['source'],
  plugins: [externalizePackages],
  minify: false,
  metafile: true,
}

/** 'y-protocols/sync' → 'y-protocols'，'@scope/pkg/sub' → '@scope/pkg'；Node 内置模块和相对路径 → undefined */
export function packageName(specifier) {
  if (specifier.startsWith('node:') || specifier.startsWith('.')) return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * 从 esbuild 的 external import 反推第三方包，排好序。传 `metafile.outputs` 得到产物真正 import 的；
 * 传 `metafile.inputs` 得到打包时走到过的（含被 tree-shaking 摇掉的，范围更大）。
 */
export function externalPackagesOf(entries) {
  const names = new Set()
  for (const entry of Object.values(entries)) {
    for (const imported of entry.imports) {
      if (!imported.external) continue
      const name = packageName(imported.path)
      if (name) names.add(name)
    }
  }
  return [...names].sort()
}

/** 版本锁到本次构建实际装的那一个。pnpm workspace 下包装在声明它的那个包的 node_modules 里（符号链接进 .pnpm），不是仓库根 */
export async function installedVersion(packageDir, name) {
  const manifest = path.join(packageDir, 'node_modules', name, 'package.json')
  const { version } = JSON.parse(await readFile(manifest, 'utf8'))
  return version
}

/** 和 packages/agent-core/src/build-id.ts 的 SOURCE_BUILD_ID 同值：它表示「源码运行」，构建不能用 */
const SOURCE_BUILD_ID = 'source'
const BUILD_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * 本次构建的 id（packages/agent-core/src/build-id.ts）：`AGENT_BUILD_ID` 给了就用；没给就生成一个，单独构建就是单独的一次构建。
 *
 * 生成的是时间戳（base36）+ 随机数。不用输出内容的哈希：id 本身要写进产物（define），内容哈希在打包之前算不出来，
 * 不同次构建（哪怕源码没变）也该不同。
 *
 * 给错了直接失败：网关对报上来的 id 只做长度校验，超长的会被当成没报，`source` 会被当成源码运行，
 * 两种都是软提示悄悄失效。
 */
export function resolveBuildId(env = process.env) {
  const given = env.AGENT_BUILD_ID?.trim()
  if (!given) return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  if (given === SOURCE_BUILD_ID || !BUILD_ID_SHAPE.test(given)) {
    throw new Error(`AGENT_BUILD_ID 不合法：${given}（要求 ${BUILD_ID_SHAPE}，且不能是 ${SOURCE_BUILD_ID}）`)
  }
  return given
}
