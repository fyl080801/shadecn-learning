import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createFrontProxy } from '../scripts/front-proxy.mjs'

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
