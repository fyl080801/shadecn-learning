import { buildServerRouteTable, routeRoleIn } from '@shadecn/server-core/routes-table'
import { modules } from '../../modules.ts'

/** 这个产物的路由归属表（底座的入口 + 模块清单里的声明）：和 `prepare(modules)` 交给角色闸门的是同一张 */
export const routeTable = buildServerRouteTable(modules)

/** 这条路径归哪个角色 */
export function routeRole(pathname: string) {
  return routeRoleIn(routeTable, pathname)
}
