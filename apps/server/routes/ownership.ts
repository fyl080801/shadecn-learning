import type { MiddlewareHandler } from 'hono'
import { AGENT_GATEWAY_PATH } from '@shadecn/agent/protocol'
import { COLLAB_PATH } from '@shadecn/shared/collab'
import type { ServerRole } from '@shadecn/server-kit/kernel'

/**
 * 哪条路径归哪个角色（REQ-MODULES，docs/28 §3.2 / §3.9）。
 *
 * 生产上 ingress 按**同一张表**分流（`k8s/ingress.yaml`），本地多角色由 `dev:cluster` 的前置代理分流
 * （`scripts/dev-cluster.mjs`）—— 三处必须一致；改这里要一起改那两处。
 *
 * - `agent`：网关（沙箱里的 runner 回连，**不经 ingress**，直连 Pod IP）；
 * - `collab`：协同 WebSocket、协同的监控接口、直接读写 Y.Doc 的 REST（个人画布 / 离线补推的 `/doc`）；
 * - `web`：其余全部 —— 底座接口、页面、agent 的发起与只读接口（发起经总线派给 agent 副本，docs/28 §3.6）。
 * - 健康检查每个角色都有。
 */
export function routeRole(pathname: string): ServerRole | 'any' {
  if (pathname === '/api/health' || pathname.startsWith('/api/health/')) return 'any'
  if (pathname === AGENT_GATEWAY_PATH || pathname.startsWith(`${AGENT_GATEWAY_PATH}/`)) return 'agent'
  if (pathname === COLLAB_PATH || pathname.startsWith(`${COLLAB_PATH}/`)) return 'collab'
  if (pathname === '/api/collab' || pathname.startsWith('/api/collab/')) return 'collab'
  if (/^\/api\/flows\/[^/]+\/doc\/?$/.test(pathname)) return 'collab'
  return 'web'
}

/**
 * 本进程不扮演的角色的路由一律 404 —— 正常不会走到（ingress / 代理已经分流），走到了说明分流配错了，
 * 回一句说得清的话，比默默返回一个半残的结果好查。全部角色一个进程时什么也不拦。
 */
export function roleGate(roles: ReadonlySet<ServerRole>): MiddlewareHandler {
  return async (c, next) => {
    const owner = routeRole(c.req.path)
    if (owner === 'any' || roles.has(owner)) return next()
    return c.json(
      { error: 'Not Found', message: `本实例（角色 ${[...roles].join(',')}）不提供 ${c.req.path}，它归 ${owner} 角色 —— 检查 ingress 的路径分流` },
      404,
    )
  }
}
