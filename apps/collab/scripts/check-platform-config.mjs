const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const ANY_ADDRESS = new Set(['0.0.0.0', '::'])

/**
 * 平台的 `server` 和 `agent.gatewayUrl` 配不配得上（docs/31 §6.2）：runner 直连平台的端口，不经前置代理（代理是给浏览器的，它一重启正在跑的轮次不该跟着断）。
 * 不写 `gatewayUrl` 时平台按 `server.port` 和 `server.host` 自己推出来，那样总是对的，这里只查写了的。
 * 配错了不会启动失败，要到第一轮 runner 连不上才报，所以脚本启动时就说清楚。
 *
 * @param {{ server?: { port?: number, host?: string }, agent?: { gatewayUrl?: unknown } } | null | undefined} config 平台的 config.yaml
 * @param {number} frontPort 前置代理的端口
 * @returns {string | null} 哪里配错了，没错是 null
 */
export function platformGatewayProblem(config, frontPort) {
  const written = config?.agent?.gatewayUrl
  if (written === undefined || written === null) return null
  const port = config?.server?.port
  let url
  try {
    url = new URL(String(written))
  } catch {
    return 'agent.gatewayUrl 不是一个完整的地址（要带 http://）'
  }
  const urlPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (urlPort === frontPort) return `agent.gatewayUrl 指向了前置代理（端口 ${frontPort}）：网关不经代理，runner 要直连平台的端口 ${port}`
  if (urlPort !== port) return `agent.gatewayUrl 的端口是 ${urlPort}，和平台的 server.port ${port} 对不上：runner 要直连平台`
  const listen = config?.server?.host
  // 不写 host 就是只听本机。`host.docker.internal` 是 oci 驱动的默认地址，引擎自己转回本机，这里判断不了，放行
  if ((listen === undefined || LOOPBACK.has(listen)) && !LOOPBACK.has(url.hostname) && url.hostname !== 'host.docker.internal') {
    return `平台只听本机（server.host: ${listen ?? '没写'}），agent.gatewayUrl 却指向 ${url.hostname}：runner 连不上`
  }
  if (listen !== undefined && !LOOPBACK.has(listen) && !ANY_ADDRESS.has(listen) && LOOPBACK.has(url.hostname)) {
    return `平台只听 ${listen}（server.host），agent.gatewayUrl 却指向本机回环：runner 连不上`
  }
  return null
}
