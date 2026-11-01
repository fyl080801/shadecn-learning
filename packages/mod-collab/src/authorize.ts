import type { CanvasService } from '@shadecn/mod-canvas/contract'
import { platform } from '@shadecn/server-kit/platform'
import { FLOW_ROOM_PREFIX } from '@shadecn/shared/collab'
import type { CollabAuthorization, CollabAuthorizeOptions, CollabAuthPort } from './ports.ts'

/**
 * 这次握手的 `Origin` 可不可信 —— 挡的是 CSWSH（跨站 WebSocket 劫持）。
 *
 * **WebSocket 不受同源策略保护**：任何站点都能 `new WebSocket('wss://我们/ws/collaboration')`，
 * 而我们用 cookie 认身份，浏览器会照常把 `sid` 带上，于是对面拿到的是一条
 * 以受害者身份登录的协同连接 —— 能读画布内容，也能改。
 *
 * HTTP 那边由底座的 CORS 挡着，但 upgrade 走的是裸的 `server.on('upgrade')`，
 * 整条 Hono 中间件链（CORS、页面守卫）都绕过去了，所以这一道得自己判。
 * `sid` 是 `SameSite=Lax`，现代浏览器本来就不会给跨站的 WS 握手带上它 ——
 * 但那是浏览器替我们兜的底，不是我们自己的判断，当不了一道防线。
 *
 * 三条放行规则：
 * - **没有 `Origin`**：非浏览器客户端（探针、脚本、测试）。浏览器发起的握手一定带
 *   `Origin`，所以放它过去并不给 CSWSH 开口子；一律拒绝倒会把这些客户端全挡死。
 * - **在 `APP_ORIGINS` 白名单里**（`APP_ORIGIN` 永远是其中一员）：正常情况。
 *   一套部署挂多个对外域名时，每个域名的协同连接都得放行。
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
  if (platform().origins.isAllowed(origin)) return true
  try {
    return Boolean(host) && new URL(origin).host === host
  } catch {
    // `Origin` 不是个合法 URL（沙箱 iframe 会发字面量 "null"，也可能是被改过的头）：认不出就是不放
    return false
  }
}

const UNAUTHORIZED: CollabAuthorization = { ok: false, reason: 'unauthorized' }
const FORBIDDEN: CollabAuthorization = { ok: false, reason: 'forbidden' }


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
 * 规则和画布模块的 `flowGuard` 一致 —— 否则任何登录用户
 * 都能连进别人项目的画布，看见在场的人和他们的光标。个人画布只认所有者本人。
 * 其余房间（演示用）保持「登录即可」。
 */
export async function authorizeCollab(
  canvas: CanvasService,
  cookieHeader: string | null | undefined,
  room: string,
  options: CollabAuthorizeOptions = {},
): Promise<CollabAuthorization> {
  const { auth } = platform()
  // 没配登录时整站放行，本地裸跑也要能开协同（此时没有可认的用户）
  if (!auth.enabled) return { ok: true, identity: null }

  // 会话经平台认：cookie 名、续期规则都是底座的事
  const identity = await auth.identify(cookieHeader, { refresh: options.refresh })
  if (!identity) return UNAUTHORIZED

  if (!room.startsWith(FLOW_ROOM_PREFIX)) return { ok: true, identity }

  const flowId = room.slice(FLOW_ROOM_PREFIX.length)
  // 画布不存在 / 已删也算 forbidden：登录态没问题，是这个房间进不去。
  // 和 `flowGuard` 一样不区分「不存在」和「没权限」，免得给出探测的机会
  const target = await canvas.locate(flowId)
  if (!target) return FORBIDDEN

  /*
   * **个人画布的房间只对所有者本人开放**（REQ-AGENT §3.3.2）。
   *
   * 个人画布的内容也走 WebSocket（打开即连，见 docs/20 §3.3.2）—— agent 的改动经活房间
   * 实时推过来。所以所有者得进得来；但这不是协作：放行结果带 `personal`，`hocuspocus.ts`
   * 据此把这个房间的 awareness 整帧丢弃。
   *
   * **除所有者以外的人一律拒**，这一句仍然不是多余的：`mode` 是服务端算的、前端照着分流，
   * 但前端的分流拦不住任何人手搓一个 provider 直接连过来。少了它，别人的个人画布上就会
   * 冒出光标和在场头像，而那正是「个人」这个词要排除的东西。所有者认 `personalOwner` 列，
   * 不认成员表：个人空间不该有第二个成员，但万一有了（手工改库、将来的 bug），也进不来。
   *
   * 写入闸门（`write-gate.ts` 的 `collabWriteAuthorize`）走的就是这个函数，所以
   * 所有者能写、画布被删之后写不了，两条都自然成立。
   */
  if (target.kind === 'personal') {
    return target.personalOwnerId === identity.id
      ? { ok: true, identity, personal: true }
      : FORBIDDEN
  }

  const role = await canvas.roleOf(target.projectId, identity.id)
  return role ? { ok: true, identity } : FORBIDDEN
}

/** 协同的鉴权端口：画布成员判定来自 `canvas` 服务，会话与 Origin 白名单来自平台 */
export function createCollabAuth(canvas: CanvasService): CollabAuthPort {
  return {
    authorize: (cookieHeader, room, options) => authorizeCollab(canvas, cookieHeader, room, options),
    isAllowedOrigin: isAllowedCollabOrigin,
  }
}
