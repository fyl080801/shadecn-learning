import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { platformGatewayProblem } from '../scripts/check-platform-config.mjs'
import { createFrontProxy, isCollabPath } from '../scripts/front-proxy.mjs'

interface Upstream {
  name: string
  port: number
  server: http.Server
  /** 收到的每条 upgrade 连接 */
  sockets: Duplex[]
}

/** 假的上游：HTTP 回自己的名字和看到的 Host，WebSocket 握手回一行带自己名字的 101 */
async function upstream(name: string): Promise<Upstream> {
  const server = http.createServer((req, res) => {
    req.resume()
    res.setHeader('x-upstream', name)
    res.end(JSON.stringify({ name, host: req.headers.host, url: req.url }))
  })
  const sockets: Duplex[] = []
  server.on('upgrade', (req, socket) => {
    sockets.push(socket)
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nx-upstream: ${name}\r\nx-host: ${req.headers.host}\r\n\r\n`)
    socket.on('data', (data) => socket.write(data))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { name, server, sockets, port: (server.address() as AddressInfo).port }
}

describe('前置代理', () => {
  const cleanup: (() => unknown)[] = []
  afterEach(async () => {
    for (const task of cleanup.splice(0)) await task()
  })

  async function setup() {
    const [platform, a, b] = await Promise.all([upstream('platform'), upstream('a'), upstream('b')])
    const proxy = createFrontProxy({ platformPort: platform.port, replicaPorts: [a.port, b.port] })
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve))
    const port = (proxy.server.address() as AddressInfo).port
    cleanup.push(
      () => proxy.close(),
      () => {
        for (const item of [platform, a, b]) {
          item.server.closeAllConnections()
          item.server.close()
        }
      },
    )
    const get = async (target: string) => (await fetch(`http://127.0.0.1:${port}${target}`)).json() as Promise<{ name: string; host: string; url: string }>
    const handshake = (target: string) =>
      new Promise<{ status: number; upstream: string | undefined; host: string | undefined; echo: () => Promise<string>; closed: () => Promise<void> }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: target, headers: { connection: 'Upgrade', upgrade: 'websocket' } })
        req.on('upgrade', (res, socket) => {
          cleanup.push(() => socket.destroy())
          resolve({
            status: res.statusCode ?? 0,
            upstream: res.headers['x-upstream'] as string | undefined,
            host: res.headers['x-host'] as string | undefined,
            echo: () =>
              new Promise((done) => {
                socket.once('data', (data) => done(String(data)))
                socket.write('ping')
              }),
            closed: () => new Promise((done) => socket.once('close', () => done())),
          })
        })
        req.on('response', (res) => {
          res.resume()
          resolve({ status: res.statusCode ?? 0, upstream: undefined, host: undefined, echo: () => Promise.resolve(''), closed: () => Promise.resolve() })
        })
        req.on('error', reject)
        req.end()
      })
    return { proxy, a, b, port, get, handshake }
  }

  it('协同的路径在副本之间轮流分，其余给平台', async () => {
    const { get } = await setup()
    expect((await get('/')).name).toBe('platform')
    expect((await get('/api/projects')).name).toBe('platform')
    expect((await get('/api/flows/f1/duplicate')).name).toBe('platform')

    const names = [(await get('/api/collab/rooms')).name, (await get('/api/flows/f1/doc?sv=abc')).name, (await get('/api/collab/health')).name]
    expect(names).toEqual(['a', 'b', 'a'])
  })

  it('不改 Host：登录回调和 WebSocket 的 Origin 校验要看到浏览器打开的地址', async () => {
    const { get, handshake, port } = await setup()
    expect((await get('/api/projects')).host).toBe(`127.0.0.1:${port}`)
    expect((await handshake('/ws/collaboration')).host).toBe(`127.0.0.1:${port}`)
  })

  it('WebSocket：协同的轮流分到副本，字节双向透传；别的路径（Vite HMR）给平台', async () => {
    const { handshake } = await setup()
    const first = await handshake('/ws/collaboration')
    const second = await handshake('/ws/collaboration')
    expect(first.status).toBe(101)
    expect([first.upstream, second.upstream]).toEqual(['a', 'b'])
    expect(await first.echo()).toBe('ping')
    expect((await handshake('/?token=hmr')).upstream).toBe('platform')
  })

  it('副本摘掉之后不再分给它，全摘完回 503', async () => {
    const { proxy, a, b, get, handshake } = await setup()
    expect(proxy.removeReplica(a.port)).toBe(1)
    expect((await get('/api/collab/rooms')).name).toBe('b')
    expect((await handshake('/ws/collaboration')).upstream).toBe('b')

    expect(proxy.removeReplica(b.port)).toBe(0)
    expect((await fetch(`http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}/api/collab/rooms`)).status).toBe(503)
    expect((await handshake('/ws/collaboration')).status).toBe(503)
    // 平台不受影响
    expect((await get('/')).name).toBe('platform')
  })

  it('上游断开，客户端这条连接也断，不留半开的 socket', async () => {
    const { a, handshake } = await setup()
    const hs = await handshake('/ws/collaboration')
    expect(hs.upstream).toBe('a')
    const closed = hs.closed()
    a.sockets[0].destroy()
    await closed
  })
})

/** 一条经代理的流：逐帧攒下来，`ended` 是正常结束，`broken` 是连接在响应完整之前断了 */
function openStream(port: number, target: string, init: { method?: string; headers?: http.OutgoingHttpHeaders } = {}) {
  const state = { status: 0, headers: {} as http.IncomingHttpHeaders, body: '', ended: false, broken: false }
  let onResponse!: () => void
  const responded = new Promise<void>((resolve) => (onResponse = resolve))
  let onDone!: () => void
  const done = new Promise<void>((resolve) => (onDone = resolve))
  const req = http.request({ host: '127.0.0.1', port, path: target, method: init.method ?? 'GET', headers: init.headers }, (res) => {
    state.status = res.statusCode ?? 0
    state.headers = res.headers
    onResponse()
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => (state.body += chunk))
    res.on('end', () => {
      state.ended = true
      onDone()
    })
    res.on('error', () => undefined)
    res.on('close', () => {
      state.broken = !state.ended
      onDone()
    })
  })
  req.on('error', () => {
    state.broken = true
    onResponse()
    onDone()
  })
  return { req, state, responded, done }
}

async function waitFor(check: () => boolean, what: string, ms = 3_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('前置代理：经它转发的流（agent 面板的 SSE）', () => {
  const cleanup: (() => unknown)[] = []
  afterEach(async () => {
    for (const task of cleanup.splice(0)) await task()
  })

  /** 真代理 + 真上游。`handler` 就是平台那边的路由，`requests` 记下它收到的每个请求和它们的断开 */
  async function setup(handler: http.RequestListener) {
    const platform = http.createServer(handler)
    await new Promise<void>((resolve) => platform.listen(0, '127.0.0.1', resolve))
    const proxy = createFrontProxy({ platformPort: (platform.address() as AddressInfo).port, replicaPorts: [] })
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve))
    cleanup.push(
      () => proxy.close(),
      () => {
        platform.closeAllConnections()
        platform.close()
      },
    )
    return { proxy, port: (proxy.server.address() as AddressInfo).port, platformPort: (platform.address() as AddressInfo).port }
  }

  const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' }

  it('浏览器断开：上游马上看到 close，这是「断开只退订」经代理成立的前提', async () => {
    let upstream: http.ServerResponse | undefined
    let upstreamClosed = false
    const { port } = await setup((_req, res) => {
      upstream = res
      res.on('close', () => (upstreamClosed = true))
      res.writeHead(200, SSE_HEADERS)
      res.write('data: 第一帧\n\n')
    })
    const stream = openStream(port, '/api/flows/f1/agent/runs/r1/events')
    stream.req.end()
    await waitFor(() => stream.state.body.includes('第一帧'), '第一帧到达')
    expect(upstreamClosed).toBe(false)

    stream.req.destroy()
    await waitFor(() => upstreamClosed, '上游看到断开')
    expect(upstream?.writableFinished).toBe(false)
  })

  it('请求体还没发完就断开：上游也看到 close，不会等一个永远不来的结尾', async () => {
    let requestClosed = false
    let received = ''
    const { port } = await setup((req, res) => {
      req.on('data', (chunk) => (received += String(chunk)))
      res.on('close', () => (requestClosed = true))
    })
    const stream = openStream(port, '/api/flows/f1/agent/messages', { method: 'POST', headers: { 'content-length': '100000' } })
    stream.req.write('半截')
    await waitFor(() => received === '半截', '半截请求体到达')

    stream.req.destroy()
    await waitFor(() => requestClosed, '上游看到断开')
  })

  it('正常结束不算断开：响应完整到达，上游的响应是写完的，同一个代理还能接着转发', async () => {
    const finished: boolean[] = []
    const { port } = await setup((req, res) => {
      req.resume()
      res.on('close', () => finished.push(res.writableFinished))
      res.writeHead(200, SSE_HEADERS)
      res.write('data: 一\n\n')
      res.end('data: 二\n\n')
    })
    for (let round = 1; round <= 2; round += 1) {
      const stream = openStream(port, '/api/flows/f1/agent/messages', { method: 'POST' })
      stream.req.end()
      await stream.done
      expect(stream.state).toMatchObject({ status: 200, body: 'data: 一\n\ndata: 二\n\n', ended: true, broken: false })
    }
    expect(finished[0]).toBe(true)
  })

  it('响应头已发、上游中途断了：客户端的流是断开，不是正常结束，也不会混进一行错误文字', async () => {
    let upstream: http.ServerResponse | undefined
    const { port } = await setup((_req, res) => {
      upstream = res
      res.writeHead(200, SSE_HEADERS)
      res.write('data: 第一帧\n\n')
    })
    const stream = openStream(port, '/api/flows/f1/agent/runs/r1/events')
    stream.req.end()
    await waitFor(() => stream.state.body.includes('第一帧'), '第一帧到达')

    upstream?.socket?.destroy()
    await stream.done
    expect(stream.state).toMatchObject({ status: 200, body: 'data: 第一帧\n\n', ended: false, broken: true })
  })

  it('响应头还没发上游就断了、或者上游根本连不上：回 502', async () => {
    const { port } = await setup((req) => {
      req.socket.destroy()
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`)
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('转发到')

    const dead = http.createServer()
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadPort = (dead.address() as AddressInfo).port
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    const proxy = createFrontProxy({ platformPort: deadPort, replicaPorts: [] })
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => proxy.close())
    expect((await fetch(`http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}/`)).status).toBe(502)
  })

  it('SSE 不缓冲：上游一发响应头客户端就拿到，之后每帧都不用等下一帧', async () => {
    let upstream: http.ServerResponse | undefined
    const { port } = await setup((_req, res) => {
      upstream = res
      // 和 AgentSseStreams.open 一样：先把响应头推出去，帧后面才有
      res.writeHead(200, SSE_HEADERS)
      res.flushHeaders()
    })
    const stream = openStream(port, '/api/flows/f1/agent/runs/r1/events')
    stream.req.end()
    await stream.responded
    expect(stream.state.status).toBe(200)
    expect(stream.state.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(stream.state.headers['cache-control']).toBe('no-cache')
    expect(stream.state.body).toBe('')

    for (const frame of ['data: 一\n\n', ': ping\n\n', 'data: 二\n\n']) {
      const before = stream.state.body
      upstream?.write(frame)
      await waitFor(() => stream.state.body === before + frame, `${frame.trim()} 单独到达`)
    }
    stream.req.destroy()
  })

  it('代理关闭：转发中的流都断开，上游都看到 close', async () => {
    let upstreamClosed = false
    const { proxy, port } = await setup((_req, res) => {
      res.on('close', () => (upstreamClosed = true))
      res.writeHead(200, SSE_HEADERS)
      res.write('data: 一\n\n')
    })
    const stream = openStream(port, '/api/flows/f1/agent/runs/r1/events')
    stream.req.end()
    await waitFor(() => stream.state.body.includes('一'), '第一帧到达')
    await proxy.close()
    await waitFor(() => upstreamClosed, '上游看到断开')
    expect(stream.state.ended).toBe(false)
  })

  it('agent 的面板和网关都给平台，不分给副本', () => {
    for (const pathname of ['/api/flows/f1/agent', '/api/flows/f1/agent/messages', '/api/flows/f1/agent/runs/r1/events', '/api/flows/f1/agent/runs/r1/abort', '/api/agent-gateway/sts', '/api/agent-gateway/model/entry/api/stream']) {
      expect(isCollabPath(pathname), pathname).toBe(false)
    }
  })
})

describe('dev-front 的配对检查：agent.gatewayUrl 和平台的 server', () => {
  const FRONT = 3000

  it('不写 gatewayUrl 不用查：平台按 server.port 和 server.host 自己推', () => {
    expect(platformGatewayProblem({ server: { port: 3001 } }, FRONT)).toBeNull()
    expect(platformGatewayProblem({ server: { port: 3001, host: '0.0.0.0' }, agent: {} }, FRONT)).toBeNull()
    expect(platformGatewayProblem(null, FRONT)).toBeNull()
  })

  it('配对的地址放行：直连平台端口', () => {
    expect(platformGatewayProblem({ server: { port: 3001, host: '127.0.0.1' }, agent: { gatewayUrl: 'http://127.0.0.1:3001' } }, FRONT)).toBeNull()
    expect(platformGatewayProblem({ server: { port: 3001 }, agent: { gatewayUrl: 'http://localhost:3001/' } }, FRONT)).toBeNull()
    expect(platformGatewayProblem({ server: { port: 3001, host: '0.0.0.0' }, agent: { gatewayUrl: 'http://10.0.0.5:3001' } }, FRONT)).toBeNull()
    expect(platformGatewayProblem({ server: { port: 3001 }, agent: { gatewayUrl: 'http://host.docker.internal:3001' } }, FRONT, 'darwin')).toBeNull()
  })

  it('host.docker.internal：macOS 的引擎转回回环，只听本机也放行；Linux 上只听本机连不上，写不写 gatewayUrl 都报', () => {
    const written = { server: { port: 3001 }, agent: { gatewayUrl: 'http://host.docker.internal:3001' } }
    expect(platformGatewayProblem(written, FRONT, 'darwin')).toBeNull()
    expect(platformGatewayProblem(written, FRONT, 'linux')).toContain('docs/31 §6.4')
    const inferred = { server: { port: 3001, host: '127.0.0.1' }, agent: { sandbox: { driver: 'oci' } } }
    expect(platformGatewayProblem(inferred, FRONT, 'darwin')).toBeNull()
    expect(platformGatewayProblem(inferred, FRONT, 'linux')).toContain('docs/31 §6.4')
    // 听全部地址时 Linux 上也够得着；process 驱动不走这个主机名
    expect(platformGatewayProblem({ server: { port: 3001, host: '0.0.0.0' }, agent: { sandbox: { driver: 'oci' } } }, FRONT, 'linux')).toBeNull()
    expect(platformGatewayProblem({ server: { port: 3001, host: '0.0.0.0' }, agent: { gatewayUrl: 'http://host.docker.internal:3001' } }, FRONT, 'linux')).toBeNull()
    expect(platformGatewayProblem({ server: { port: 3001 }, agent: { sandbox: { driver: 'process' } } }, FRONT, 'linux')).toBeNull()
  })

  it('oci 的 gatewayUrl 写回环：容器里的回环是容器自己；process 驱动写回环是对的', () => {
    expect(platformGatewayProblem({ server: { port: 3001 }, agent: { gatewayUrl: 'http://127.0.0.1:3001', sandbox: { driver: 'oci' } } }, FRONT, 'darwin')).toContain('容器里的回环')
    expect(platformGatewayProblem({ server: { port: 3001 }, agent: { gatewayUrl: 'http://127.0.0.1:3001', sandbox: { driver: 'process' } } }, FRONT, 'darwin')).toBeNull()
  })

  it('指向前置代理、端口对不上、平台听不到那个地址：都报出来', () => {
    expect(platformGatewayProblem({ server: { port: 3001 }, agent: { gatewayUrl: 'http://127.0.0.1:3000' } }, FRONT)).toContain('网关不经代理')
    expect(platformGatewayProblem({ server: { port: 3001 }, agent: { gatewayUrl: 'http://127.0.0.1:3002' } }, FRONT)).toContain('对不上')
    expect(platformGatewayProblem({ server: { port: 3001 }, agent: { gatewayUrl: 'http://10.0.0.5:3001' } }, FRONT)).toContain('只听本机')
    expect(platformGatewayProblem({ server: { port: 3001, host: '10.0.0.5' }, agent: { gatewayUrl: 'http://127.0.0.1:3001' } }, FRONT)).toContain('只听 10.0.0.5')
    expect(platformGatewayProblem({ server: { port: 3001 }, agent: { gatewayUrl: '127.0.0.1:3001' } }, FRONT)).toContain('完整的地址')
  })
})
