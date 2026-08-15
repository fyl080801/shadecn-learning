import type { IncomingMessage } from 'node:http'
import { authConfig, authEnabled } from '../config.ts'
import { loadSession } from './session.ts'

function cookieValue(header: string | undefined, name: string) {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

/**
 * WebSocket 握手时的登录校验。
 * 握手就是一次普通 HTTP GET，同源下浏览器会带上 sid cookie，
 * 所以这里跟接口用的是同一套会话（顺带也会触发 token 刷新）。
 */
export async function authorizeUpgrade(req: IncomingMessage): Promise<boolean> {
  if (!authEnabled) return true
  const token = cookieValue(req.headers.cookie, authConfig.cookieName)
  return Boolean(await loadSession(token))
}
