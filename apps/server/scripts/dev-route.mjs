/**
 * 本地多角色时前置代理用的分流表 —— 和 `apps/server/routes/ownership.ts` 的 `routeRole` 是同一份规则
 * （那边是服务端的「不归我管就 404」，这边是代理的「该发给谁」；生产上做这件事的是 `k8s/ingress.yaml`）。
 * 三处必须一致，`apps/server/test/routes/ownership.test.ts` 把两份 JS / TS 的实现逐条对比。
 *
 * 纯 JS（`.mjs`）：`dev:cluster` 用 node 直接跑，不经 tsx。
 */

const AGENT_GATEWAY_PATH = '/api/agent-gateway'
const COLLAB_PATH = '/ws/collaboration'

/** @param {string} pathname @returns {'web' | 'collab' | 'agent' | 'any'} */
export function routeRole(pathname) {
  if (pathname === '/api/health' || pathname.startsWith('/api/health/')) return 'any'
  if (pathname === AGENT_GATEWAY_PATH || pathname.startsWith(`${AGENT_GATEWAY_PATH}/`)) return 'agent'
  if (pathname === COLLAB_PATH || pathname.startsWith(`${COLLAB_PATH}/`)) return 'collab'
  if (pathname === '/api/collab' || pathname.startsWith('/api/collab/')) return 'collab'
  if (/^\/api\/flows\/[^/]+\/doc\/?$/.test(pathname)) return 'collab'
  return 'web'
}
