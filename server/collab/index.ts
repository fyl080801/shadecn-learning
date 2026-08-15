import type { ServerType } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { docs, setupWSConnection } from './setupWSConnection.ts'

export { docs, getYDoc, WSSharedDoc } from './setupWSConnection.ts'

/** WebSocket 挂载前缀，房间名取其后的路径：/ws/<room> */
export const COLLAB_PATH = '/ws'

/** 统计日志间隔（毫秒），设为 0 关闭 */
const statsInterval = Number(process.env.YWS_STATS_INTERVAL ?? 30000)

export function countConnections() {
  let conns = 0
  for (const doc of docs.values()) conns += doc.conns.size
  return conns
}

function roomNameFromUrl(url: string): string | null {
  const { pathname } = new URL(url, 'http://localhost')
  if (pathname !== COLLAB_PATH && !pathname.startsWith(`${COLLAB_PATH}/`)) return null
  const room = decodeURIComponent(pathname.slice(COLLAB_PATH.length + 1))
  return room === '' ? 'default' : room
}

export type CollabOptions = {
  /**
   * 非 /ws/* 的 upgrade 请求是否直接断开。
   * dev 下必须为 false —— Vite 的 HMR WebSocket 挂在同一个 server 上，
   * 由它自己的 upgrade 监听器处理，这里掐了就没有热更新了。
   */
  destroyUnmatchedUpgrades?: boolean
}

/**
 * 把 y-websocket 服务挂到已有的 HTTP server 上。
 * 用 noServer 模式手动处理 upgrade，这样只有 /ws/* 会被升级成 WebSocket，
 * 其他路径仍然交给 Hono（或 Vite 的 HMR）处理。
 */
export function attachCollabServer(server: ServerType, options: CollabOptions = {}) {
  const { destroyUnmatchedUpgrades = true } = options
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const room = roomNameFromUrl(req.url ?? '/')
    if (room === null) {
      if (destroyUnmatchedUpgrades) socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (conn) => {
      setupWSConnection(conn, req, { docName: room })
      console.log(`[collab] + ${room} (房间连接数 ${docs.get(room)?.conns.size ?? 0})`)
    })
  })

  if (statsInterval > 0) {
    const timer = setInterval(() => {
      const conns = countConnections()
      if (conns === 0 && docs.size === 0) return
      console.log(`[collab] 房间 ${docs.size} 个，连接 ${conns} 条`)
    }, statsInterval)
    // 别因为这个定时器让进程退不出去
    timer.unref()
  }

  return wss
}
