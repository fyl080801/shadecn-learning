import { spawn } from 'node:child_process'

/**
 * 本地起多个实例，验证多副本。
 *
 * **这个脚本不含任何配置**：数据库、Redis、Keycloak 全从 `.env` 读（每个子进程
 * 自己 `process.loadEnvFile()`），这里只覆盖两样每实例必须不同的东西 ——
 * 端口和实例 id。依赖服务（Redis / PostgreSQL）也不代劳，自己起，
 * 命令写在 `.env.example` 里。
 *
 * 端口列表来自 `DEV_CLUSTER_PORTS`（默认 `3000,3001`），同样是配置，不是参数。
 */

const ports = (process.env.DEV_CLUSTER_PORTS ?? '3000,3001')
  .split(',')
  .map((port) => port.trim())
  .filter(Boolean)

if (ports.length === 0) {
  console.error('[dev:cluster] DEV_CLUSTER_PORTS 是空的，没有实例可起')
  process.exit(1)
}

console.log(`[dev:cluster] 拉起 ${ports.length} 个实例：${ports.join(', ')}`)
console.log('[dev:cluster] 其余配置全部来自 .env —— 记得配好 REDIS_URL 和 PostgreSQL 的 DATABASE_URL')

/** 子进程的日志前缀，颜色只是为了两路输出别混在一起 */
const COLORS = ['[36m', '[35m', '[33m', '[32m']
const RESET = '[0m'

const children = ports.map((port, index) => {
  const label = `${COLORS[index % COLORS.length]}[:${port}]${RESET}`

  const child = spawn('pnpm', ['exec', 'tsx', 'watch', 'server/index.ts'], {
    env: {
      ...process.env,
      // 真实环境变量压过 .env（server/env.ts 用的 loadEnvFile 不覆盖已存在的变量），
      // 所以这两行就是「每个实例各自不同」的全部内容
      PORT: port,
      INSTANCE_ID: `dev-${port}`,
      // APP_ORIGIN 不在这里定：.env 里没设的话 config.ts 会按各自的 host:port 推导，
      // 设了就是所有实例共用一个对外地址（前面挂了负载均衡时才该那么配）
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

let stopping = false

function stopAll() {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
}

process.on('SIGINT', stopAll)
process.on('SIGTERM', stopAll)
