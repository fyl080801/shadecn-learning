/**
 * 构建画布 agent 的 oci 沙箱镜像（docs/22 §7.2）：`pnpm build:sandbox-image [额外的 build 参数…]`。
 *
 * 构建上下文是 `pnpm build:server` 产出的 output/agent-sandbox/（runner + 它的 4 个第三方包 + Dockerfile，模板在本目录）。
 * 用哪个 CLI：`CONTAINER_CLI`，不给就先找 podman、再找 docker。镜像名：`AGENT_SANDBOX_IMAGE`（环境变量优先，
 * 其次仓库根 .env 里的同名项 —— 只读这一项），都没有就是 `shadecn-agent-sandbox:latest`（和 apps/server/config.ts 的默认值一致）。
 *
 * 命令行上多给的参数原样交给 `<cli> build`，例如走镜像代理拉基础镜像、给构建容器配出网代理：
 *   pnpm build:sandbox-image --build-arg NODE_IMAGE=<代理>/docker.io/library/node:22-alpine
 *   pnpm build:sandbox-image --build-arg HTTPS_PROXY=http://host.containers.internal:3128
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'

const serverDir = path.resolve(import.meta.dirname, '..', '..')
const rootDir = path.resolve(serverDir, '..', '..')
const contextDir = path.join(rootDir, 'output', 'agent-sandbox')
const DEFAULT_IMAGE = 'shadecn-agent-sandbox:latest'

function fail(message) {
  console.error(`[build:sandbox-image] ${message}`)
  process.exit(1)
}

function has(cli) {
  return spawnSync(cli, ['--version'], { stdio: 'ignore' }).status === 0
}

/** 镜像名：环境变量 > 仓库根 .env 里的 AGENT_SANDBOX_IMAGE（只取这一项，别的变量不进这个进程） > 默认 */
function imageName() {
  const fromEnv = process.env.AGENT_SANDBOX_IMAGE?.trim()
  if (fromEnv) return fromEnv
  const envFile = path.join(rootDir, '.env')
  if (existsSync(envFile)) {
    const value = parseEnv(readFileSync(envFile, 'utf8')).AGENT_SANDBOX_IMAGE?.trim()
    if (value) return value
  }
  return DEFAULT_IMAGE
}

if (!existsSync(path.join(contextDir, 'Dockerfile'))) {
  fail('output/agent-sandbox/ 不存在：先 pnpm build:server（pnpm build:sandbox-image 会先跑它）')
}

const cli = process.env.CONTAINER_CLI?.trim() || (has('podman') ? 'podman' : has('docker') ? 'docker' : '')
if (!cli) fail('找不到 podman 或 docker（或用 CONTAINER_CLI 指定）')

const image = imageName()
const args = ['build', '-t', image, ...process.argv.slice(2), contextDir]
console.log(`[build:sandbox-image] ${cli} ${args.join(' ')}`)
const built = spawnSync(cli, args, { stdio: 'inherit' })
if (built.status !== 0) fail(`构建失败（退出码 ${built.status ?? built.signal}）`)

const size = spawnSync(cli, ['image', 'inspect', image, '--format', '{{.Size}}'], { encoding: 'utf8' })
const mb = Number(size.stdout?.trim())
console.log(`[build:sandbox-image] 已构建 ${image}${Number.isFinite(mb) && mb > 0 ? `（${(mb / 1e6).toFixed(0)} MB）` : ''}`)
console.log('[build:sandbox-image] 服务端用它：AGENT_SANDBOX=oci（镜像名不是默认值时另配 AGENT_SANDBOX_IMAGE）')
