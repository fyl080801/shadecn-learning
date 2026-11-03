/**
 * 构建画布 agent 的 oci runner 镜像（docs/31 §3.3）：`pnpm build:agent-runner-image [额外的 build 参数…]`。
 *
 * 构建上下文是 `pnpm build:agent-runner` 产出的 apps/agent-runner/dist/（runner + 它的 4 个第三方包 + 本包的 Dockerfile）。
 * 用哪个 CLI：`CONTAINER_CLI`，不给就先找 podman、再找 docker。镜像名：`AGENT_RUNNER_IMAGE`，
 * 不给就是 `learning-agent-runner:latest`（和 packages/agent-service/src/options.ts 的默认值一致；
 * 平台 config.yaml 的 `agent.sandbox.image` 只有平台自己读，这里不去碰）。
 *
 * 命令行上多给的参数原样交给 `<cli> build`，例如走镜像代理拉基础镜像、给构建容器配出网代理：
 *   pnpm build:agent-runner-image --build-arg NODE_IMAGE=<代理>/docker.io/library/node:22-alpine
 *   pnpm build:agent-runner-image --build-arg HTTPS_PROXY=http://host.containers.internal:3128
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const contextDir = path.resolve(import.meta.dirname, '..', 'dist')
const DEFAULT_IMAGE = 'learning-agent-runner:latest'

function fail(message) {
  console.error(`[build:agent-runner-image] ${message}`)
  process.exit(1)
}

function has(cli) {
  return spawnSync(cli, ['--version'], { stdio: 'ignore' }).status === 0
}

if (!existsSync(path.join(contextDir, 'Dockerfile'))) {
  fail('apps/agent-runner/dist/ 不存在：先 pnpm build:agent-runner（pnpm build:agent-runner-image 会先跑它）')
}

const cli = process.env.CONTAINER_CLI?.trim() || (has('podman') ? 'podman' : has('docker') ? 'docker' : '')
if (!cli) fail('找不到 podman 或 docker（或用 CONTAINER_CLI 指定）')

const image = process.env.AGENT_RUNNER_IMAGE?.trim() || DEFAULT_IMAGE
const args = ['build', '-t', image, ...process.argv.slice(2), contextDir]
console.log(`[build:agent-runner-image] ${cli} ${args.join(' ')}`)
const built = spawnSync(cli, args, { stdio: 'inherit' })
if (built.status !== 0) fail(`构建失败（退出码 ${built.status ?? built.signal}）`)

const size = spawnSync(cli, ['image', 'inspect', image, '--format', '{{.Size}}'], { encoding: 'utf8' })
const mb = Number(size.stdout?.trim())
console.log(`[build:agent-runner-image] 已构建 ${image}${Number.isFinite(mb) && mb > 0 ? `（${(mb / 1e6).toFixed(0)} MB）` : ''}`)
console.log('[build:agent-runner-image] 平台用它：config.yaml 写 agent.sandbox.driver: oci（镜像名不是默认值时另配 agent.sandbox.image）')
