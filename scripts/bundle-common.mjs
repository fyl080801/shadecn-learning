/**
 * 服务端（apps/server/scripts/build-server.mjs）和沙箱（apps/agent-sandbox/scripts/bundle-runner.mjs）两个 esbuild 构建
 * 共用的部分：哪些 import 留成 external、怎么从 metafile 反推第三方依赖、版本锁到哪、构建 id 怎么定。
 *
 * 放在仓库根而不是某个 app 里：两个 app 不互相依赖。这个文件只用 Node 内置模块（包括 esbuild 也不 import，
 * 插件只是个普通对象），所以不必做成 workspace 包，也就不多一份 package.json / Dockerfile 的 COPY 行。
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

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
 * 也就照样进依赖清单。
 */
export const externalizePackages = {
  name: 'externalize-packages',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith(WORKSPACE_SCOPE)) return undefined
      return { path: args.path, external: true }
    })
  },
}

/** 两个构建都要的 esbuild 选项：runner 被构建两次（服务端的 `process` 驱动一份、沙箱镜像一份），运行环境不能各写各的 */
export const nodeBundleOptions = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
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

/** 和 packages/agent/src/build-id.ts 的 SOURCE_BUILD_ID 同值：它表示「源码运行」，构建不能用 */
const SOURCE_BUILD_ID = 'source'
const BUILD_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * 本次构建的 id（packages/agent/src/build-id.ts）：`AGENT_BUILD_ID` 给了就用，这样 `pnpm build`（scripts/build-all.mjs）
 * 能让服务端和沙箱拿到同一个；没给就生成一个 —— 单独构建就是单独的一次构建，网关的软提示如实触发。
 *
 * 生成的是时间戳（base36）+ 随机数。不用输出内容的哈希：id 本身要写进产物（define），内容哈希在打包之前算不出来，
 * 不同次构建（哪怕源码没变）也该不同 —— 正是「镜像是不是跟着这次产物重建的」要的粒度。
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
