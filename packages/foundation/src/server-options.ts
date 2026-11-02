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
