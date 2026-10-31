/** `dev-route.mjs` 的类型（测试里拿它和 `routes/ownership.ts` 对比） */
export function routeRole(pathname: string): 'web' | 'collab' | 'agent' | 'any'
