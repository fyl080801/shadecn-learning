import { appOrigin, authConfig, authEnabled } from '../config.ts'
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
 * 这次握手的 `Origin` 可不可信 —— 挡的是 CSWSH（跨站 WebSocket 劫持）。
 *
 * **WebSocket 不受同源策略保护**：任何站点都能 `new WebSocket('wss://我们/ws/collaboration')`，
 * 而我们用 cookie 认身份，浏览器会照常把 `sid` 带上，于是对面拿到的是一条
 * 以受害者身份登录的协同连接 —— 能读画布内容，也能改。
 *
 * HTTP 那边由 `app.ts` 的 CORS 挡着，但 upgrade 走的是裸的 `server.on('upgrade')`，
 * 整条 Hono 中间件链（CORS、页面守卫）都绕过去了，所以这一道得自己判。
 * `sid` 是 `SameSite=Lax`，现代浏览器本来就不会给跨站的 WS 握手带上它 ——
 * 但那是浏览器替我们兜的底，不是我们自己的判断，当不了一道防线。
 *
 * 三条放行规则：
 * - **没有 `Origin`**：非浏览器客户端（探针、脚本、测试）。浏览器发起的握手一定带
 *   `Origin`，所以放它过去并不给 CSWSH 开口子；一律拒绝倒会把这些客户端全挡死。
 * - **等于 `APP_ORIGIN`**：正常情况。
 * - **`Origin` 的 host 和请求的 `Host` 头相同**：这也是同源，只是 `APP_ORIGIN` 没配对
 *   （dev 下它默认是 `http://127.0.0.1:3000`，而人从 `localhost:3000` 打开页面），
 *   或者反代换过对外域名。跨站攻击够不着这一条 —— 攻击页面的 `Origin` 是它自己的域名，
 *   而 `Host` 是我们的，两者必然不等。
 */
export function isAllowedCollabOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin) return true
  if (origin === appOrigin) return true
  try {
    return Boolean(host) && new URL(origin).host === host
  } catch {
    // `Origin` 不是个合法 URL（沙箱 iframe 会发字面量 "null"，也可能是被改过的头）：认不出就是不放
    return false
  }
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

/**
 * 拒绝的原因 —— **必须区分**，因为两者的出路完全不同：
 * - `unauthorized`：会话没了（过期、登出、被踢）。重新登录就能回来。
 * - `forbidden`：人是登着的，只是不该进这个房间（不是项目成员、画布已删）。
 *   让他去登录毫无意义，登了还是进不来。
 *
 * 以前这里只答「不行」，于是一个只看不编辑、会话空闲超时的人被复验踢下线时，
 * 界面告诉他「你已不是这个项目的成员」—— 完全错误的提示。
 */
export type CollabDenialReason = 'unauthorized' | 'forbidden'

/** 放行时带上是谁；没启用登录时 identity 为 null */
export type CollabAuthorization =
  | { ok: false; reason: CollabDenialReason }
  | { ok: true; identity: CollabIdentity | null }

const UNAUTHORIZED: CollabAuthorization = { ok: false, reason: 'unauthorized' }
const FORBIDDEN: CollabAuthorization = { ok: false, reason: 'forbidden' }

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
  if (!session) return UNAUTHORIZED

  const identity: CollabIdentity = {
    id: session.user.id,
    name: displayNameOf(session.user),
    avatarUrl: session.user.avatarUrl,
  }

  if (!room.startsWith(FLOW_ROOM_PREFIX)) return { ok: true, identity }

  const flowId = room.slice(FLOW_ROOM_PREFIX.length)
  // 画布不存在 / 已删也算 forbidden：登录态没问题，是这个房间进不去。
  // 和 `requireFlowMember` 一样不区分「不存在」和「没权限」，免得给出探测的机会
  const target = await flows.locate(flowId)
  if (!target) return FORBIDDEN

  /*
   * **个人画布没有房间**（REQ-SOLO）：它的内容走 HTTP 增量推拉，不进协同层。
   *
   * 这道拒绝不是多余的 —— `mode` 是服务端算的、前端照着分流，但前端的分流拦不住
   * 任何人手搓一个 provider 直接连过来。少了这一句，别人的个人画布上就会冒出
   * 光标和在场头像，而那正是「个人」这个词要排除的东西。
   */
  if (target.kind === 'personal') return FORBIDDEN

  const role = await projects.roleOf(target.projectId, session.user.id)
  return role ? { ok: true, identity } : FORBIDDEN
}
