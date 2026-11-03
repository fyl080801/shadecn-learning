import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { createFrontProxy } from './front-proxy.mjs'

/**
 * 本地起「一个平台 + 若干协同副本 + 前置代理」（docs/30 §3）。先 `pnpm dev:front` 或 `pnpm build:platform` + `pnpm build:collab-service`，这里跑的是产物。
 *
 * **这个脚本不含配置**。`DEV_FRONT_ROOT`（默认 `<仓库>/data/dev-front`）下放：
 * - `.env`：大家共用的密钥（运行目录就是这里）；
 * - `platform/config.yaml`、`collab-*\/config.yaml`：每个进程的 `DATA_DIR`，端口从这里读。
 *
 * `NODE_ENV` 原样传给子进程：不设是开发模式（平台挂 Vite，HMR 的 WebSocket 也经代理），`production` 用 `output/public`。
 * Redis 和 PostgreSQL 不代劳，自己起。依赖先后：平台 `apply` 建表，就绪了才起副本（`off` 不建表），都就绪了代理才开门。
 *
 * 平台退出就整组收摊。副本退出只是摘掉它，这样才能 `kill -TERM` 一个副本看客户端切到另一个；最后一个副本也退出了才收摊。
 */

const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m', '\x1b[31m']
const RESET = '\x1b[0m'
const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 200

const scriptDir = import.meta.dirname
const repoRoot = path.resolve(scriptDir, '../../..')
const root = path.resolve(process.env.DEV_FRONT_ROOT ?? path.join(repoRoot, 'data/dev-front'))
const frontPort = Number(process.env.DEV_FRONT_PORT ?? 3000)
const frontOrigin = `http://127.0.0.1:${frontPort}`

function fail(message) {
  console.error(`[dev-front] ${message}`)
  process.exit(1)
}

/** 配错的地方在这里就说清楚，否则要等到浏览器的握手 403 才看得出来 */
function readInstance(dir, entry) {
  const file = path.join(dir, 'config.yaml')
  if (!fs.existsSync(file)) fail(`缺 ${file}（示例见 apps/collab/config.example.yaml）`)
  const server = parse(fs.readFileSync(file, 'utf8'))?.server ?? {}
  if (!Number.isInteger(server.port) || server.port === 0) fail(`${file} 要写明 server.port：代理要知道往哪转`)
  if (server.port === frontPort) fail(`${file} 的 server.port 和前置代理（DEV_FRONT_PORT=${frontPort}）撞了`)
  if (!server.origins?.includes(frontOrigin)) fail(`${file} 的 server.origins 要包含前置代理的地址 ${frontOrigin}`)
  if (!fs.existsSync(entry)) fail(`缺 ${entry}，先构建（pnpm build:platform && pnpm build:collab-service）`)
  return { name: path.basename(dir), dir, entry, port: server.port }
}

const collabEntry = path.join(repoRoot, 'apps/collab/dist/main.js')
const collabDirs = fs.existsSync(root)
  ? fs
      .readdirSync(root, { withFileTypes: true })
      .filter((item) => item.isDirectory() && item.name.startsWith('collab-'))
      .map((item) => path.join(root, item.name))
      .sort()
  : []
if (collabDirs.length === 0) fail(`${root} 下没有 collab-* 目录`)

const platform = readInstance(path.join(root, 'platform'), path.join(repoRoot, 'apps/platform/dist/main-without-collab.js'))
const replicas = collabDirs.map((dir) => readInstance(dir, collabEntry))
const proxy = createFrontProxy({ platformPort: platform.port, replicaPorts: replicas.map((replica) => replica.port) })

const children = new Map()
let stopping = false
/** 代理开门之前任何一个进程退出都是启动失败，不用等到就绪超时 */
let opened = false

async function stopAll(exitCode = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode
  await proxy.close()
  // 副本先走：它们退出时还要落库，平台要留到最后（表和登录都在它那边）
  const exited = (child) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve)))
  const collabChildren = [...children.entries()].filter(([instance]) => instance !== platform).map(([, child]) => child)
  for (const child of collabChildren) child.kill('SIGTERM')
  await Promise.all(collabChildren.map(exited))
  const platformChild = children.get(platform)
  platformChild?.kill('SIGTERM')
  if (platformChild) await exited(platformChild)
}

function start(instance, index, onExit) {
  const label = `${COLORS[index % COLORS.length]}[${instance.name}:${instance.port}]${RESET}`
  // 运行目录是 root：.env 大家共用。DATA_DIR 每个进程一个
  const child = spawn(process.execPath, [instance.entry], {
    cwd: root,
    env: { ...process.env, DATA_DIR: instance.dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.set(instance, child)
  const prefix = (stream, chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) stream.write(`${label} ${line}\n`)
    }
  }
  child.stdout.on('data', (chunk) => prefix(process.stdout, chunk))
  child.stderr.on('data', (chunk) => prefix(process.stderr, chunk))
  child.on('exit', (code, signal) => {
    console.log(`${label} 退出（code=${code ?? '-'} signal=${signal ?? '-'}）`)
    if (!stopping) onExit(code)
  })
  return child
}

async function waitReady(instance) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (stopping) return
    const status = await fetch(`http://127.0.0.1:${instance.port}/api/health/ready`).then(
      (res) => res.status,
      () => 0,
    )
    if (status === 200) return
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }
  console.error(`[dev-front] ${instance.name} 在 ${READY_TIMEOUT_MS} 毫秒内没有就绪`)
  await stopAll(1)
}

process.on('SIGINT', () => void stopAll())
process.on('SIGTERM', () => void stopAll())

start(platform, 0, (code) => void stopAll(code === 0 ? 0 : 1))
await waitReady(platform)

if (!stopping) {
  replicas.forEach((replica, index) =>
    start(replica, index + 1, (code) => {
      if (!opened) {
        void stopAll(1)
        return
      }
      const left = proxy.removeReplica(replica.port)
      console.log(`[dev-front] ${replica.name} 已摘除，还剩 ${left} 个副本`)
      if (left === 0) void stopAll(code === 0 ? 0 : 1)
    }),
  )
  await Promise.all(replicas.map(waitReady))
}

if (!stopping) {
  opened = true
  proxy.server.listen(frontPort, '127.0.0.1', () => {
    console.log(`[dev-front] 前置代理 ${frontOrigin} → 平台 ${platform.port}，协同副本 ${replicas.map((replica) => replica.port).join(', ')}`)
  })
}
