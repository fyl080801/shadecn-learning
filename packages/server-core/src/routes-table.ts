import { buildRouteTable, type AnyServerModule, type OwnedRoute, type RouteTable, type ServerRole } from '@shadecn/server-kit/kernel'

/**
 * 路由归属表（docs/28 §3.2 / §3.9）：底座自己的入口 + 模块清单里**每个**模块声明的入口（不论本进程加没加载它 ——
 * 不归本进程的请求要能说出它归谁）。
 *
 * 读它的地方：`app.ts` 的角色闸门和登录闸门、`apps/server/scripts/dev-cluster.mjs` 的前置代理；`k8s/variants/roles/ingress.yaml`
 * 由测试核对与它一致（`apps/server/test/k8s/roles-manifests.test.ts`）。所以**加一个入口只在声明它的地方加**，别处都跟着变。
 *
 * 这个文件不读配置（dev:cluster 的代理进程也 import 它）。
 */

/** 底座自己的入口。`/api/*` 里没被任何声明覆盖的路径按 `web` + 要登录处理 */
export const coreRoutes: readonly OwnedRoute[] = [
  { owner: 'core', path: '/api/health', role: 'any', access: 'public' },
  { owner: 'core', path: '/api/features', role: 'web', access: 'user' },
]

/** 按模块清单建表 */
export function buildServerRouteTable(modules: readonly AnyServerModule[]): RouteTable {
  return buildRouteTable([
    ...coreRoutes,
    ...modules.flatMap((module) => (module.routes ?? []).map((route) => ({ ...route, owner: module.name }))),
  ])
}

let current: RouteTable = buildServerRouteTable([])

/** `prepare(modules)` 交进来的那张表；没 prepare 过 = 只有底座的入口 */
export function routeTable(): RouteTable {
  return current
}

export function setRouteTable(table: RouteTable): void {
  current = table
}

/** 这条路径归哪个角色；没有任何声明覆盖的（页面、静态资源）归 web */
export function routeRoleIn(table: RouteTable, pathname: string): ServerRole | 'any' {
  return table.match(pathname)?.role ?? 'web'
}
