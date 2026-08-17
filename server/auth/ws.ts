import { authConfig, authEnabled } from '../config.ts'
import { flows } from '../store/flows.ts'
import { projects } from '../store/projects.ts'
import { loadSession } from './session.ts'

/** 画布房间名的前缀：`flow:<flowId>`，前端 `useFlowCollab` 拼的就是它 */
const FLOW_ROOM_PREFIX = 'flow:'

function cookieValue(header: string | null | undefined, name: string) {
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
 * 服务端认定的身份。
 *
 * 两个用途，都要求它**不能由客户端提供**：
 * - 审计日志的 `actorId`（Yjs 自己只认 clientID，不知道那是哪个登录用户）；
 * - 覆盖 awareness 里客户端自报的 `user` 字段，杜绝同房间内冒名。
 *
 * 字段和前端 `PresenceUser` 对齐（少一个 `color` —— 那个由 id 在本地哈希出来，
 * 不走网络，也就没法伪造）。
 */
export interface CollabIdentity {
  id: string
  name: string
  avatarUrl: string | null
}

/** 放行时带上是谁；没启用登录时 identity 为 null */
export type CollabAuthorization =
  | { ok: false }
  | { ok: true; identity: CollabIdentity | null }

const DENIED: CollabAuthorization = { ok: false }

export interface CollabAuthorizeOptions {
  /**
   * 允不允许顺手续期会话。默认 true —— 握手本身就是一次真实的 HTTP 请求，
   * 和调接口一样该给会话续命。
   *
   * 定期复验传 `false`：那趟检查背后没有任何用户动作，让它续期等于
   * 「标签页开着就永不登出」。细节见 `session.ts` 的 `LoadSessionOptions`。
   */
  refresh?: boolean
}

/** 显示名的取值顺序要和前端 `useAuth().displayName` 一致，否则改写前后名字会跳 */
function displayNameOf(user: {
  name: string | null
  username: string | null
  email: string | null
}): string {
  return user.name ?? user.username ?? user.email ?? '匿名用户'
}

/**
 * 协同连接的鉴权。
 *
 * 入参只要一个 cookie 头 —— 不是 node 的 `IncomingMessage`，也不是 web 的 `Request`。
 * 我们需要的只有 `sid` 这一个值，收窄到字符串之后，无论上层是 crossws、
 * 原始 http server 还是测试里手拼的，都能直接调。
 *
 * 握手就是一次普通 HTTP GET，同源下浏览器会自动带上 sid cookie，
 * 所以这里跟接口用的是同一套会话（握手会顺带续期，定期复验则不会 ——
 * 见 `CollabAuthorizeOptions.refresh`）。
 *
 * 房间即资源：`flow:<flowId>` 这类画布房间还要再判一次**项目成员身份**，
 * 规则和 `auth/project.ts` 的 `requireFlowMember` 一致 —— 否则任何登录用户
 * 都能连进别人项目的画布，看见在场的人和他们的光标。
 * 其余房间（演示用）保持「登录即可」。
 */
export async function authorizeCollab(
  cookieHeader: string | null | undefined,
  room: string,
  options: CollabAuthorizeOptions = {},
): Promise<CollabAuthorization> {
  // 没配 Keycloak 时整站放行，本地裸跑也要能开协同（此时没有可认的用户）
  if (!authEnabled) return { ok: true, identity: null }

  const token = cookieValue(cookieHeader, authConfig.cookieName)
  const session = await loadSession(token, { refresh: options.refresh })
  if (!session) return DENIED

  const identity: CollabIdentity = {
    id: session.user.id,
    name: displayNameOf(session.user),
    avatarUrl: session.user.avatarUrl,
  }

  if (!room.startsWith(FLOW_ROOM_PREFIX)) return { ok: true, identity }

  const flowId = room.slice(FLOW_ROOM_PREFIX.length)
  const projectId = await flows.projectIdOf(flowId)
  if (!projectId) return DENIED

  const role = await projects.roleOf(projectId, session.user.id)
  return role ? { ok: true, identity } : DENIED
}
