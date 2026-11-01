import type { ServerRole } from './roles.ts'

/**
 * 入口声明与路由归属表（docs/28 §3.2 / §3.9）。
 *
 * 每条入口由它的主人（底座或某个模块）**静态声明**：路径、归哪个角色、要不要登录。由此推出三件事，不再各写一份：
 * - 不归本进程角色的请求 → 404 并说明它归谁（宿主的角色闸门）；
 * - `/api/*` 的登录闸门放过哪些路径（`access: 'public'`）；
 * - 前置分流（k8s ingress、`dev:cluster` 的代理）按什么分 —— 导出成一张表（`describeRouteTable`），测试核对 ingress 与它一致。
 *
 * 路径模式：按 `/` 分段，`:name` 匹配任意一段；**一条声明覆盖它自己和它下面的所有子路径**（`/api/collab` 管 `/api/collab/stats`）。
 * 多条都匹配时取最具体的那条（段数多的优先，同段数时字面段多的优先）。
 */
export interface RouteDeclaration {
  readonly path: string
  /** 归哪个角色；`any` = 每个角色都有（健康检查） */
  readonly role: ServerRole | 'any'
  /**
   * `user` = 要登录（宿主的登录闸门拦未登录的 `/api/*`）；`public` = 不经登录闸门，入口自己鉴权或不需要
   * （登录流程本身、健康检查、只认 run 短令牌的 agent 网关、自己读 cookie 判权的 WebSocket）。
   */
  readonly access: 'public' | 'user'
  /** `http`（默认）= Hono 路由；`upgrade` = WebSocket 握手，经宿主的 upgrade 分发 */
  readonly kind?: 'http' | 'upgrade'
}

export interface OwnedRoute extends RouteDeclaration {
  /** 声明它的模块名；底座的叫 `core` */
  readonly owner: string
}

interface CompiledRoute {
  readonly route: OwnedRoute
  readonly segments: readonly string[]
  readonly literals: number
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/** 校验一条声明的路径写法；不合法直接抛（这是写代码时的错，不是运行时输入） */
export function assertRoutePath(path: string): void {
  if (!path.startsWith('/')) throw new Error(`[routes] 路径必须以 / 开头：${path}`)
  if (path.includes('*')) throw new Error(`[routes] 路径不写通配符（一条声明本来就覆盖其下所有子路径）：${path}`)
  if (path.length > 1 && path.endsWith('/')) throw new Error(`[routes] 路径不以 / 结尾：${path}`)
}

/** `pattern` 是否覆盖 `pathname`（自身或其子路径） */
export function routeCovers(pattern: string, pathname: string): boolean {
  return matchSegments(segmentsOf(pattern), segmentsOf(pathname))
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  if (path.length < pattern.length) return false
  return pattern.every((segment, index) => (segment.startsWith(':') ? path[index] !== '' : segment === path[index]))
}

export interface RouteTable {
  readonly routes: readonly OwnedRoute[]
  /** 最具体的那条匹配；没有 = undefined（宿主按「底座的 web 路由 / 前端页面」处理） */
  match(pathname: string): OwnedRoute | undefined
}

/**
 * 建表。同一路径被两处声明 → 抛（两个主人抢一条入口，挂载顺序决定谁生效，这种错不能留到运行时）。
 */
export function buildRouteTable(routes: readonly OwnedRoute[]): RouteTable {
  const seen = new Map<string, OwnedRoute>()
  for (const route of routes) {
    assertRoutePath(route.path)
    const key = `${route.kind ?? 'http'} ${segmentsOf(route.path)
      .map((segment) => (segment.startsWith(':') ? ':' : segment))
      .join('/')}`
    const prev = seen.get(key)
    if (prev) throw new Error(`[routes] ${route.path} 同时被 ${prev.owner} 和 ${route.owner} 声明`)
    seen.set(key, route)
  }

  const compiled: CompiledRoute[] = routes
    .map((route) => {
      const segments = segmentsOf(route.path)
      return { route, segments, literals: segments.filter((segment) => !segment.startsWith(':')).length }
    })
    // 最具体的排前面：段数多的优先，其次字面段多的
    .sort((a, b) => b.segments.length - a.segments.length || b.literals - a.literals)

  return {
    routes,
    match(pathname) {
      const path = segmentsOf(pathname)
      return compiled.find((entry) => matchSegments(entry.segments, path))?.route
    },
  }
}

/** 给前置分流（ingress / dev 代理）看的表：最具体的在前，`role` 为 web 的默认项不列 */
export function describeRouteTable(table: RouteTable): { path: string; role: ServerRole | 'any'; kind: 'http' | 'upgrade' }[] {
  return [...table.routes]
    .sort((a, b) => segmentsOf(b.path).length - segmentsOf(a.path).length || a.path.localeCompare(b.path))
    .filter((route) => route.role !== 'web')
    .map((route) => ({ path: route.path, role: route.role, kind: route.kind ?? 'http' }))
}
