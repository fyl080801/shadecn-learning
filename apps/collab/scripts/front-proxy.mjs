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
 * HTTP 的响应是流（agent 面板的 SSE）：响应头和每一帧都不缓冲，两头谁断了都要传给另一头。
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
      // SSE 的响应头要马上到：不然 fetch 等到第一帧才返回，而接回时第一帧可能很久才有
      res.flushHeaders()
      response.pipe(res)
      // pipe 不传递错误：上游中途断了，不收拾的话客户端的流永远挂着。断开而不是 end：正常结束的流在客户端看来是「这一轮说完了」
      response.once('close', () => {
        if (!response.complete) res.destroy()
      })
    })
    upstream.on('error', (err) => {
      // 响应头发出去之后不能再改状态码，也不能往流里写错误文字（响应还在发的时候断，走的是上面的 close）
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`[dev-front] 转发到 ${port} 失败：${err.message}`)
    })
    // 客户端断开要传给上游：平台靠这条连接的 close 退订 SSE（「断开只退订」，docs/31 §4.3），pipe 不会替你断
    res.once('close', () => {
      if (!res.writableFinished) upstream.destroy()
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
