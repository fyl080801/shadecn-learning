import type { ResolvedModules } from './resolve.ts'

/**
 * 「这个进程开了哪些能力」—— `GET /api/features` 读它（docs/28 §3.3），前端据此隐藏关掉的入口。
 *
 * 这是「显示什么」，不是权限：关掉的模块的路由本来就不存在。`app.ts` 是静态建的、测试直接 import 它，
 * 所以这张表由 boot 在装配完之后填，没 boot 过（测试）就是空表。
 */
export type FeatureTable = Readonly<Record<string, boolean>>

let features: FeatureTable = {}

export function recordFeatures(resolved: ResolvedModules): void {
  const table: Record<string, boolean> = {}
  for (const module of resolved.ordered) table[module.name] = true
  for (const { module } of resolved.skipped) table[module.name] = false
  features = table
}

export function loadedFeatures(): FeatureTable {
  return features
}
