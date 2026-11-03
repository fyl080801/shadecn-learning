/**
 * runner 的边界判定（.claude/rules/agent.md，docs/31 §3.3）：runner 跑在不可信的沙箱里，闭包里不能有服务端的东西 ——
 * 否则令牌签发、持久化、上游调用这些代码（连同它们的依赖）就进了沙箱镜像。
 *
 * 这里是纯函数，只看 esbuild 的 metafile，由 bundle-runner.mjs 在打包后调用。
 * metafile 的键要相对仓库根（打包时 `absWorkingDir` = 仓库根）。
 *
 * **仓库内的文件默认拒绝**：沙箱这一侧的文件是少数、而且很少变，服务端这一侧才是多数、一直在长；
 * 用黑名单的话，新加的服务端模块进了闭包也没人拦。新增的 runner 侧模块写进下面的清单，就是一次有意识的决定。
 */
import { externalPackagesOf } from './bundle-config.mjs'

/** runner 的入口 */
export const RUNNER_ENTRY = 'packages/agent-core/src/runner/main.ts'

/** 允许进 runner 闭包的源码：`@learning/contracts`，和 `@learning/agent-core` 里沙箱这一侧 + 两侧共用的模块 */
const RUNNER_SIDE_SOURCES = [
  /^packages\/contracts\/src\//,
  /^packages\/agent-core\/src\/runner\//,
  /^packages\/agent-core\/src\/skills\//,
  /^packages\/agent-core\/src\/(protocol|tools|media|build-id)\.ts$/,
  /^packages\/agent-core\/src\/sandbox\/(local|media-tool)\.ts$/,
]

/**
 * 服务端专属的第三方包，和不该留成 external 的 workspace 包。「没声明就失败」已经挡住了误 import，
 * 这一条防的是有人顺手把它们加进镜像的 dependencies。
 * 测试核对平台和 agent-core 的运行时依赖全部落在这里或镜像自己的依赖里，所以服务端新增依赖时不会漏。
 */
const SERVER_ONLY_PACKAGES = [
  /^@learning\//,
  /^@shadecn\//,
  /^@nestjs\//,
  /^fastify$/,
  /^@fastify\//,
  /^reflect-metadata$/,
  /^rxjs$/,
  /^crossws$/,
  /^@mikro-orm\//,
  /^better-sqlite3$/,
  /^pg$/,
  /^ioredis$/,
  /^@hocuspocus\//,
  /^sharp$/,
  /^minidenticons$/,
  /^yaml$/,
  /^vite$/,
]

export const isRunnerSideSource = (file) => RUNNER_SIDE_SOURCES.some((pattern) => pattern.test(file))
export const isServerOnlyPackage = (name) => SERVER_ONLY_PACKAGES.some((pattern) => pattern.test(name))

/**
 * 找出 runner 闭包里所有越界的东西，返回给人看的说明；空数组 = 干净。
 *
 * @param metafile esbuild 的 metafile（键相对仓库根）
 * @param declaredDependencies apps/agent-runner/package.json 的 dependencies 里的包名
 * @returns {string[]}
 */
export function findBoundaryViolations(metafile, declaredDependencies) {
  // 入口都不在 = 键不是相对仓库根（或者根本打错了东西）。这时下面的判定全是空转，不能算过
  if (!metafile.inputs[RUNNER_ENTRY]) {
    return [`metafile 里没有 runner 入口 ${RUNNER_ENTRY}，判定不成立`]
  }
  const declared = new Set(declaredDependencies)
  const sources = Object.keys(metafile.inputs)
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => !isRunnerSideSource(file))
    .map((file) => `源码 ${file} 不属于 runner 侧`)
  // 服务端的包：打包时走到过就算，被 tree-shaking 摇掉也不行 —— 下一次改动它就真进镜像了
  const serverOnly = externalPackagesOf(metafile.inputs)
    .filter(isServerOnlyPackage)
    .map((name) => `第三方包 ${name} 是服务端专属的`)
  // 没声明的包：只看产物真正 import 的，它们就是要进镜像的依赖清单
  const undeclared = externalPackagesOf(metafile.outputs)
    .filter((name) => !declared.has(name) && !isServerOnlyPackage(name))
    .map((name) => `第三方包 ${name} 没有声明在 apps/agent-runner/package.json 的 dependencies 里`)
  return [...sources, ...serverOnly, ...undeclared]
}
