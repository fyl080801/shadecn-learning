const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const ANY_ADDRESS = new Set(['0.0.0.0', '::'])
/** `oci` 驱动的默认网关主机名（packages/agent-service/src/options.ts） */
const ENGINE_HOST = 'host.docker.internal'
const ENGINE_HOST_ON_LINUX = `Linux 上 ${ENGINE_HOST} 不会转回本机回环（Docker 要显式配主机名，Podman 指向宿主的网卡地址）：server.host 写网卡地址或 0.0.0.0，再配 agent.gatewayUrl（docs/31 §6.4）`

/**
 * 平台的 `server` 和 `agent.gatewayUrl` 配不配得上（docs/31 §6.2）：runner 直连平台的端口，不经前置代理（代理是给浏览器的，它一重启正在跑的轮次不该跟着断）。
 * 不写 `gatewayUrl` 时平台按 `server.port` 和 `server.host` 自己推出来，`process` 驱动总是对的；`oci` 驱动推出来的是 {@link ENGINE_HOST}，Linux 上配只听本机的平台连不上。
 * 配错了不会启动失败，要到第一轮 runner 连不上才报，所以脚本启动时就说清楚。
 *
 * @param {{ server?: { port?: number, host?: string }, agent?: { gatewayUrl?: unknown, sandbox?: { driver?: unknown } } } | null | undefined} config 平台的 config.yaml
 * @param {number} frontPort 前置代理的端口
 * @param {NodeJS.Platform} [platform] 这台机器的系统：脚本和引擎在同一台机器上
 * @returns {string | null} 哪里配错了，没错是 null
 */
export function platformGatewayProblem(config, frontPort, platform = process.platform) {
  const written = config?.agent?.gatewayUrl
  const listen = config?.server?.host
  const loopbackOnly = listen === undefined || LOOPBACK.has(listen)
  const oci = config?.agent?.sandbox?.driver === 'oci'
  if (written === undefined || written === null) {
    return oci && loopbackOnly && platform === 'linux' ? ENGINE_HOST_ON_LINUX : null
  }
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
  if (oci && LOOPBACK.has(url.hostname)) return `agent.sandbox.driver 是 oci，agent.gatewayUrl 却指向回环 ${url.hostname}：容器里的回环是容器自己，runner 连不上`
  // 不写 host 就是只听本机。podman machine 实测 `host.docker.internal` 经 gvproxy 转回 Mac 的回环，只听本机也够得着；Linux 上没有这一层
  if (loopbackOnly && !LOOPBACK.has(url.hostname)) {
    if (url.hostname !== ENGINE_HOST) return `平台只听本机（server.host: ${listen ?? '没写'}），agent.gatewayUrl 却指向 ${url.hostname}：runner 连不上`
    if (platform === 'linux') return ENGINE_HOST_ON_LINUX
  }
  if (listen !== undefined && !LOOPBACK.has(listen) && !ANY_ADDRESS.has(listen) && LOOPBACK.has(url.hostname)) {
    return `平台只听 ${listen}（server.host），agent.gatewayUrl 却指向本机回环：runner 连不上`
  }
  return null
}
