import type { Context } from 'hono'

/**
 * 能力包的路由向底座要的东西（REQ-MODULES，docs/28 §3.1.4）。
 *
 * 能力的 HTTP 接口在各自的包里（`createXxxRoutes(ports)`），宿主把它们挂到自己的应用上 ——
 * 挂在画布路由下的那些（`/api/flows/:flowId/…`）排在宿主的成员判定之后，**进到包里的请求已经判过权**。
 * 包不认识宿主的会话变量，所以「这个请求是谁、在这张画布上是什么身份」经这个端口问宿主。
 */
export interface FlowRequestPort {
  /** 当前请求者；未登录 = null（没启用登录时宿主给本地开发用户） */
  userId(c: Context): Promise<string | null>
  /**
   * 宿主的成员判定这次请求刚查到的身份（不缓存）：项目里的角色、项目是团队还是个人空间。
   * 没经过成员判定的请求 = null。
   */
  membership(c: Context): FlowMembership | null
}

export interface FlowMembership {
  role: 'admin' | 'member'
  kind: 'team' | 'personal'
}

/** 请求体读取：非法 JSON 统一给同一句话（宿主的底座路由也用这一份） */
export async function readJson<T>(request: { json: () => Promise<unknown> }): Promise<T | null> {
  return (await request.json().catch(() => null)) as T | null
}

export const INVALID_JSON = '请求体不是合法 JSON'

export const UNAUTHORIZED = { error: 'Unauthorized', message: '需要登录' } as const
