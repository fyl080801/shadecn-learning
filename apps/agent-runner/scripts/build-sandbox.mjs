/**
 * 生成 `oci` runner 镜像的构建上下文 apps/agent-runner/dist/（docs/31 §3.3，`pnpm build:agent-runner`）：
 *   runner/agent-runner.js  runner（packages/agent-core/src/runner/main.ts）打成一个文件，见 bundle-runner.mjs
 *   package.json            只含 runner 真正 import 的第三方包，版本锁到本次构建装的那一个
 *                           （pi 的两个包、yjs、dagre —— 不含 Nest / MikroORM / 数据库驱动）
 *   Dockerfile              本包的 Dockerfile
 *
 * 上下文开头就清掉，这样构建失败时留下的是「没有上下文」，而不是一份上一次的旧 runner。
 *
 * 构建 id：`AGENT_BUILD_ID` 给了就用，没给就自己生成（bundle-config.mjs）。平台的 `process` 驱动跑 tsc 产物，没有注入构建 id，
 * 所以这边的 id 不会和平台比出「不是同一次构建」的软提示（`buildsDiffer` 见到 `source` 不提示）。
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { installedVersion, resolveBuildId } from './bundle-config.mjs'
import { bundleRunner, contextDir, runnerDir } from './bundle-runner.mjs'

const buildId = resolveBuildId()

await rm(contextDir, { recursive: true, force: true })

const { code, dependencies: names } = await bundleRunner({ buildId })

const dependencies = {}
for (const name of names) dependencies[name] = await installedVersion(runnerDir, name)
const { version } = JSON.parse(await readFile(path.join(runnerDir, 'package.json'), 'utf8'))
const pkg = {
  name: 'learning-agent-runner',
  version,
  private: true,
  type: 'module',
  engines: { node: '>=22.19' },
  dependencies,
}

await mkdir(path.join(contextDir, 'runner'), { recursive: true })
await writeFile(path.join(contextDir, 'runner', 'agent-runner.js'), code)
await writeFile(path.join(contextDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
await cp(path.join(runnerDir, 'Dockerfile'), path.join(contextDir, 'Dockerfile'))

console.log(`[build:agent-runner] 构建 id ${buildId}`)
console.log(`[build:agent-runner] apps/agent-runner/dist → runner ${(code.length / 1024).toFixed(1)} kB，依赖 ${names.join(', ')}`)
