import type { IncomingMessage } from 'node:http'
import { authConfig, authEnabled } from '../config.ts'
import { flows } from '../store/flows.ts'
import { projects } from '../store/projects.ts'
import { loadSession } from './session.ts'

/** 画布房间名的前缀：`flow:<flowId>`，前端 `useFlowPresence` 拼的就是它 */
const FLOW_ROOM_PREFIX = 'flow:'

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
 * WebSocket 握手时的鉴权。
 *
 * 握手就是一次普通 HTTP GET，同源下浏览器会带上 sid cookie，
 * 所以这里跟接口用的是同一套会话（顺带也会触发 token 刷新）。
 *
 * 房间即资源：`flow:<flowId>` 这类画布房间还要再判一次**项目成员身份**，
 * 规则和 `auth/project.ts` 的 `requireFlowMember` 一致 —— 否则任何登录用户
 * 都能连进别人项目的画布，看见在场的人和他们的光标。
 * 其余房间（演示用）保持「登录即可」。
 */
export async function authorizeUpgrade(req: IncomingMessage, room: string): Promise<boolean> {
  // 没配 Keycloak 时整站放行，本地裸跑也要能开协同
  if (!authEnabled) return true

  const token = cookieValue(req.headers.cookie, authConfig.cookieName)
  const session = await loadSession(token)
  if (!session) return false

  if (!room.startsWith(FLOW_ROOM_PREFIX)) return true

  const flowId = room.slice(FLOW_ROOM_PREFIX.length)
  const projectId = await flows.projectIdOf(flowId)
  if (!projectId) return false

  return (await projects.roleOf(projectId, session.user.id)) !== null
}
