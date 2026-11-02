import type { ConfigService } from '@learning/config'

// 3000 是 apps/server 的端口，两个服务要能同时跑
const DEFAULT_PORT = 3001

/** config.yaml 的 `server.port`。0 是「随便挑一个空闲端口」，合法 */
export function serverPort(config: ConfigService): number {
  const port = config.mapping('server').port ?? DEFAULT_PORT
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('[foundation] server.port 必须是 0 到 65535 的整数')
  }
  return port
}

/**
 * config.yaml 的 `server.host`。不写是 undefined：Fastify 默认只听本机（localhost），容器里要写 `0.0.0.0` 才接得到外面的流量。
 * 写了别的类型或空白就拒绝启动：不能悄悄回到默认值，那样服务起来了却没人连得上，只有探针超时这一个线索。
 */
export function serverHost(config: ConfigService): string | undefined {
  const host = config.mapping('server').host
  if (host === undefined || host === null) return undefined
  if (typeof host !== 'string' || !host.trim()) throw new Error('[foundation] server.host 必须是非空字符串')
  return host.trim()
}
