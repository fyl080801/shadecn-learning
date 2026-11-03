import http from 'node:http'
import net from 'node:net'

/**
 * 分给协同副本的路径，其余都给平台。这是 `CollabGatewayModule` 的入口的手写副本，`apps/collab/test/app.test.ts` 按控制器的声明逐条核对。
 * `/api/flows/:id` 下只有 `/doc` 归协同：复制、重命名这些是画布 REST，在平台上。
 */
const COLLAB_PATHS = [/^\/ws\/collaboration$/, /^\/api\/collab(\/|$)/, /^\/api\/flows\/[^/]+\/doc$/]

export const isCollabPath = (pathname) => COLLAB_PATHS.some((pattern) => pattern.test(pathname))

const pathOf = (url) => new URL(url ?? '/', 'http://front.invalid').pathname

/**
 * 前置代理：浏览器只认这一个地址，WebSocket 也同源。协同的路径在副本之间轮流分，别的给平台；不做粘性，房间同步靠 Redis，副本之间不需要。
 * 转发时不改 `Host`：登录回调的域名、WebSocket 的 `Origin` 校验都要看到浏览器打开的那个地址。
 *
 * @param {{ platformPort: number, replicaPorts: number[] }} options
 */
export function createFrontProxy({ platformPort, replicaPorts }) {
  let replicas = [...replicaPorts]
  let cursor = -1
  const upgraded = new Set()

  /** 没有活着的副本返回 undefined */
  const targetOf = (url) => {
    if (!isCollabPath(pathOf(url))) return platformPort
    if (replicas.length === 0) return undefined
    cursor = (cursor + 1) % replicas.length
    return replicas[cursor]
  }

  const server = http.createServer((req, res) => {
    const port = targetOf(req.url)
    if (port === undefined) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('[dev-front] 没有活着的协同副本')
      return
    }
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`[dev-front] 转发到 ${port} 失败：${err.message}`)
    })
    req.pipe(upstream)
  })

  // WebSocket（协同、Vite HMR）：原样把握手和之后的字节转给目标进程
  server.on('upgrade', (req, socket, head) => {
    const port = targetOf(req.url)
    if (port === undefined) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = net.connect(port, '127.0.0.1', () => {
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
      upgraded.delete(socket)
    }
    upgraded.add(socket)
    upstream.on('error', close)
    upstream.on('close', close)
    socket.on('error', close)
    socket.on('close', close)
  })

  return {
    server,
    /** 副本退出了就别再往那里分。分到正在退出的副本也没事：它回 503，provider 自己重试到下一个 */
    removeReplica(port) {
      replicas = replicas.filter((item) => item !== port)
      cursor = -1
      return replicas.length
    },
    close() {
      for (const socket of upgraded) socket.destroy()
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
