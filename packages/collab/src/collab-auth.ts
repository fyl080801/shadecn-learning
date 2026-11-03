import { FlowsService, ProjectsService } from '@learning/canvas'
import { FLOW_ROOM_PREFIX } from '@learning/contracts/collab'
import { displayNameOf, normalizeOrigin, readCookie, SessionService } from '@learning/session'
import { Inject, Injectable } from '@nestjs/common'

/** 进房的人是谁。awareness 里客户端自报的 `user` 一律被它覆盖 */
export interface CollabIdentity {
  id: string
  name: string
  avatarUrl: string | null
}

/**
 * 拒绝的原因，**不能合并**，两者出路完全不同：
 * - `unauthorized`：会话没了，重新登录就能回来；
 * - `forbidden`：人是登着的，只是不该进这个房间（不是成员、画布已删），让他去登录毫无意义。合并的话，一个空闲超时的人会被告知「你已不是成员」。
 */
export type CollabDenialReason = 'unauthorized' | 'forbidden'

export type CollabAuthorization =
  | { ok: false; reason: CollabDenialReason }
  | {
      ok: true
      identity: CollabIdentity
      /** 个人画布的房间：没有协作者，awareness 整帧丢弃 */
      personal?: boolean
    }

export interface CollabAuthorizeOptions {
  /** 允不允许顺手续期。握手是真实请求，默认 true；复验和写闸门传 false，否则开着标签页就永不登出 */
  refresh?: boolean
}

const UNAUTHORIZED: CollabAuthorization = { ok: false, reason: 'unauthorized' }
const FORBIDDEN: CollabAuthorization = { ok: false, reason: 'forbidden' }

/**
 * 这次握手的 `Origin` 可不可信，挡 CSWSH：WebSocket 不受同源策略保护，而身份靠 cookie。upgrade 走裸的 `server.on('upgrade')`，Nest 的守卫和 Fastify 的钩子都管不到，要手工查。
 * - 没有 `Origin`：非浏览器客户端。浏览器发起的握手一定带，放行不给 CSWSH 开口子。
 * - 在 `server.origins` 白名单里。
 * - `Origin` 的 host 和请求的 `Host` 相同：也是同源，只是白名单没配对（或反代换了域名）。攻击页面的 `Origin` 是它自己的域名，够不着这一条。
 */
export function isAllowedCollabOrigin(origin: string | undefined, host: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return true
  const normalized = normalizeOrigin(origin)
  if (normalized && allowed.includes(normalized)) return true
  try {
    return Boolean(host) && new URL(origin).host === host
  } catch {
    // 沙箱 iframe 的字面量 "null"、被改过的头：认不出就是不放
    return false
  }
}

/**
 * 协同连接的鉴权。入参只要 cookie 头：握手、复验、写闸门都能调。
 * 房间即资源：`flow:<id>` 还要判项目成员身份，个人画布只认所有者。画布不存在也算 `forbidden`，和 `FlowMemberGuard` 一样不给探测的机会。其余房间登录即可。
 */
@Injectable()
export class CollabAuth {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(FlowsService) private readonly flows: FlowsService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  async authorize(cookieHeader: string | null | undefined, room: string, options: CollabAuthorizeOptions = {}): Promise<CollabAuthorization> {
    const session = await this.sessions.load(readCookie(cookieHeader, this.sessions.cookieName), { refresh: options.refresh })
    if (!session) return UNAUTHORIZED
    const { user } = session
    const identity: CollabIdentity = { id: user.id, name: displayNameOf(user), avatarUrl: user.avatarUrl }

    if (!room.startsWith(FLOW_ROOM_PREFIX)) return { ok: true, identity }

    const target = await this.flows.locate(room.slice(FLOW_ROOM_PREFIX.length))
    if (!target) return FORBIDDEN

    // 个人画布只对所有者开放，认 `personalOwner` 列不认成员表。前端按 mode 分流拦不住手搓的 provider
    if (target.kind === 'personal') return target.personalOwnerId === identity.id ? { ok: true, identity, personal: true } : FORBIDDEN

    return (await this.projects.roleOf(target.projectId, identity.id)) ? { ok: true, identity } : FORBIDDEN
  }
}
