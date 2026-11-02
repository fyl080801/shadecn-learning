/**
 * 生成 `oci` 沙箱镜像的构建上下文 output/agent-sandbox/（docs/22 §7.2，`pnpm build:sandbox`）：
 *   runner/agent-runner.js  runner（packages/agent/src/runner/main.ts）打成一个文件，见 bundle-runner.mjs
 *   package.json            只含 runner 真正 import 的第三方包，版本锁到本次构建装的那一个
 *                           （pi 的两个包、yjs、dagre —— 不含服务端的 hono / MikroORM / 数据库驱动）
 *   Dockerfile              本包的 Dockerfile
 *
 * 只动 output/agent-sandbox/，别的产物一概不碰（服务端的 output/server/ 归 apps/server/scripts/build-server.mjs）。
 * 上下文开头就清掉，这样构建失败时留下的是「没有上下文」，而不是一份上一次的旧 runner。
 *
 * 构建 id：`AGENT_BUILD_ID` 给了就用（`pnpm build` 靠它和服务端保持一致），没给就自己生成（scripts/bundle-common.mjs）。
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { installedVersion, resolveBuildId } from '../../../scripts/bundle-common.mjs'
import { bundleRunner, rootDir, sandboxDir } from './bundle-runner.mjs'

const contextDir = path.join(rootDir, 'output', 'agent-sandbox')
const buildId = resolveBuildId()

await rm(contextDir, { recursive: true, force: true })

const { code, dependencies: names } = await bundleRunner({ buildId })

const dependencies = {}
for (const name of names) dependencies[name] = await installedVersion(sandboxDir, name)
const { version } = JSON.parse(await readFile(path.join(sandboxDir, 'package.json'), 'utf8'))
const pkg = {
  name: 'shadecn-agent-sandbox',
  version,
  private: true,
  type: 'module',
  engines: { node: '>=22.19' },
  dependencies,
}

await mkdir(path.join(contextDir, 'runner'), { recursive: true })
await writeFile(path.join(contextDir, 'runner', 'agent-runner.js'), code)
await writeFile(path.join(contextDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
await cp(path.join(sandboxDir, 'Dockerfile'), path.join(contextDir, 'Dockerfile'))

console.log(`[build:sandbox] 构建 id ${buildId}`)
console.log(`[build:sandbox] output/agent-sandbox → runner ${(code.length / 1024).toFixed(1)} kB，依赖 ${names.join(', ')}`)
