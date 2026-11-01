import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
// 分流表就是服务端的路由归属表（底座的入口 + 模块清单里的声明推出来的）：这个脚本经 tsx 跑，直接 import TS
import { buildServerRouteTable, routeRoleIn } from '@shadecn/server-core/routes-table'
import { modules } from '../modules.ts'

const table = buildServerRouteTable(modules)
const routeRole = (pathname) => routeRoleIn(table, pathname)

/**
 * 本地起多个实例，验证多副本 / 按角色拆分（docs/14、docs/28 §3.9）。
 *
 * **这个脚本不含任何配置**：数据库、Redis、Keycloak 全从 `.env` 读（每个子进程自己 `process.loadEnvFile()`），
 * 这里只覆盖每实例必须不同的东西 —— 端口、实例 id、角色。依赖服务（Redis / PostgreSQL）也不代劳，自己起，命令写在 `.env.example` 里。
 *
 * 两种形态，都是配置不是参数：
 *
 * - `DEV_CLUSTER_ROLES="web:3001,collab:3002,collab:3003,agent:3004"` —— **按角色拆分**。每项一个进程（`SERVER_ROLES` 就是那个角色），
 *   前面再起一个**前置代理**听 `PORT`（默认 3000），按路径分流到对应角色（`@shadecn/server-core/routes-table` 按模块清单建的表，服务端的角色闸门、ingress 都是这一份），
 *   同一角色多个进程时轮流分。浏览器只认代理那一个地址：子进程的 `APP_ORIGIN` 都设成它（登录回跳、cookie、WebSocket Origin 校验都按它）。
 *   agent 沙箱回连的网关地址按 agent 进程自己的端口算（不经代理）。
 * - 没配它就用 `DEV_CLUSTER_PORTS`（默认 `3000,3001`）—— 每个端口一个**全角色**进程，没有代理（原来的多副本验证方式）。
 */

const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m', '\x1b[31m']
const RESET = '\x1b[0m'

/** @typedef {{ role: string | null, port: number }} Instance */

/** @returns {Instance[]} */
function plan() {
  const roles = process.env.DEV_CLUSTER_ROLES?.trim()
  if (roles) {
    return roles
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [role, port] = item.split(':')
        if (!['web', 'collab', 'agent'].includes(role ?? '') || !Number(port)) {
          console.error(`[dev:cluster] DEV_CLUSTER_ROLES 里的 "${item}" 不是 <web|collab|agent>:<端口>`)
          process.exit(1)
        }
        return { role: /** @type {string} */ (role), port: Number(port) }
      })
  }
  return (process.env.DEV_CLUSTER_PORTS ?? '3000,3001')
    .split(',')
    .map((port) => port.trim())
    .filter(Boolean)
    .map((port) => ({ role: null, port: Number(port) }))
}

const instances = plan()
if (instances.length === 0) {
  console.error('[dev:cluster] 没有实例可起（DEV_CLUSTER_ROLES / DEV_CLUSTER_PORTS 是空的）')
  process.exit(1)
}

const byRole = instances.some((instance) => instance.role !== null)
const frontPort = Number(process.env.PORT ?? 3000)
const frontHost = process.env.HOST ?? '127.0.0.1'
const frontOrigin = `http://${frontHost === '0.0.0.0' ? '127.0.0.1' : frontHost}:${frontPort}`

if (byRole) {
  for (const role of ['web', 'collab', 'agent']) {
    if (!instances.some((instance) => instance.role === role)) {
      console.error(`[dev:cluster] DEV_CLUSTER_ROLES 里没有 ${role} 角色：这样跑不起完整的应用`)
      process.exit(1)
    }
  }
  if (instances.some((instance) => instance.port === frontPort)) {
    console.error(`[dev:cluster] 前置代理占用 PORT=${frontPort}，角色进程换别的端口`)
    process.exit(1)
  }
}

console.log(
  `[dev:cluster] 拉起 ${instances.length} 个实例：${instances.map((i) => (i.role ? `${i.role}:${i.port}` : i.port)).join(', ')}` +
    (byRole ? `，前置代理 ${frontOrigin}` : ''),
)
console.log('[dev:cluster] 其余配置全部来自 .env —— 记得配好 REDIS_URL 和 PostgreSQL 的 DATABASE_URL')

const children = instances.map((instance, index) => {
  const label = `${COLORS[index % COLORS.length]}[${instance.role ? `${instance.role}:` : ':'}${instance.port}]${RESET}`

  // cwd 继承自 `pnpm --filter @shadecn/server dev:cluster`，也就是 apps/server。
  // --exclude 和 package.json 里 dev 脚本那条同理：Vite 把 apps/web/vite.config.ts 打包成
  // ../web/node_modules/.vite-temp/*.mjs 再 import、随后删掉；tsx 默认的 node_modules 忽略规则
  // 是相对 cwd 的，管不到 ../web 下面，不排掉的话每次启动都会被这次删除触发重启，无限循环
  const child = spawn('pnpm', ['exec', 'tsx', 'watch', '--exclude', '../web/node_modules/.vite-temp/**', 'dev.ts'], {
    env: {
      ...process.env,
      // 真实环境变量压过 .env（packages/server-core/src/env.ts 用的 loadEnvFile 不覆盖已存在的变量）
      PORT: String(instance.port),
      INSTANCE_ID: `dev-${instance.role ?? 'all'}-${instance.port}`,
      ...(instance.role
        ? {
            SERVER_ROLES: instance.role,
            // 浏览器只认前置代理的地址：登录回跳、cookie、WebSocket 的 Origin 校验都按它
            APP_ORIGIN: frontOrigin,
          }
        : {}),
      // 全角色形态下 APP_ORIGIN 不在这里定：.env 里没设的话 config.ts 会按各自的 host:port 推导
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const prefix = (stream, chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) stream.write(`${label} ${line}\n`)
    }
  }
  child.stdout.on('data', (chunk) => prefix(process.stdout, chunk))
  child.stderr.on('data', (chunk) => prefix(process.stderr, chunk))

  child.on('exit', (code, signal) => {
    console.log(`${label} 退出（code=${code ?? '-'} signal=${signal ?? '-'}）`)
    // 一个实例挂了就整组收摊：留着半组跑着只会让人以为多副本是好的
    stopAll()
  })

  return child
})

// ---------------------------------------------------------------- 前置代理（只在按角色拆分时）

/** 每个角色轮流分；`any`（健康检查）给 web */
const cursors = new Map()
function pick(role) {
  const target = role === 'any' ? 'web' : role
  const pool = instances.filter((instance) => instance.role === target)
  const next = ((cursors.get(target) ?? -1) + 1) % pool.length
  cursors.set(target, next)
  return pool[next]
}

const pathOf = (url) => new URL(url ?? '/', 'http://localhost').pathname

const proxy = byRole
  ? http.createServer((req, res) => {
      const target = pick(routeRole(pathOf(req.url)))
      const upstream = http.request(
        { host: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers: req.headers },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(res)
        },
      )
      upstream.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`[dev:cluster] 转发到 ${target.role}:${target.port} 失败：${err.message}`)
      })
      req.pipe(upstream)
    })
  : null

if (proxy) {
  // WebSocket（协同、Vite HMR）：原样把握手和之后的字节转给目标进程
  proxy.on('upgrade', (req, socket, head) => {
    const target = pick(routeRole(pathOf(req.url)))
    const upstream = net.connect(target.port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const close = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', close)
    socket.on('error', close)
  })
  proxy.listen(frontPort, frontHost, () => {
    console.log(`[dev:cluster] 前置代理 ${frontOrigin} → 按路径分流（入口声明推出的路由归属表）`)
  })
}

let stopping = false

function stopAll() {
  if (stopping) return
  stopping = true
  proxy?.close()
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
}

process.on('SIGINT', stopAll)
process.on('SIGTERM', stopAll)
