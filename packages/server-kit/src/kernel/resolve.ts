import type { ServerModule } from './module.ts'
import type { ServerRole } from './roles.ts'

/** 一个没加载的模块和原因（进启动日志和 `/api/features`） */
export interface SkippedModule<App = unknown> {
  readonly module: ServerModule<App>
  readonly reason: 'disabled' | 'role'
  /** `enabled()` 给的原因；`role` 时为空 */
  readonly detail: string
}

export interface ResolvedModules<App = unknown> {
  /** 按装配顺序（依赖在前）排好的模块 */
  readonly ordered: readonly ServerModule<App>[]
  readonly skipped: readonly SkippedModule<App>[]
}

/**
 * 从声明的模块里选出要加载的，并按依赖排序（docs/28 §3.1.3 第 1 步）。纯函数，不碰环境。
 *
 * 规则：
 * 1. 名字不能重复；
 * 2. `enabled()` 给 `false` / 原因 → 不加载（`disabled`）；角色集和 `roles` 没交集 → 不加载（`role`）；
 * 3. 加载的模块硬依赖（`dependsOn`）的必须也加载，否则抛错并说明缺谁、为什么缺；
 * 4. 软依赖（`optional`）只影响顺序：加载了就排在前面，没加载当没有；
 * 5. 依赖成环抛错。
 *
 * 排序是稳定的：同一层的模块按声明顺序。
 */
export function resolveModules<App>(
  modules: readonly ServerModule<App>[],
  options: { roles: ReadonlySet<ServerRole> },
): ResolvedModules<App> {
  const byName = new Map<string, ServerModule<App>>()
  for (const module of modules) {
    if (byName.has(module.name)) throw new Error(`[kernel] 模块名重复：${module.name}`)
    byName.set(module.name, module)
  }

  const skipped: SkippedModule<App>[] = []
  const selected = new Map<string, ServerModule<App>>()
  for (const module of modules) {
    const verdict = module.enabled?.() ?? true
    if (verdict !== true) {
      skipped.push({ module, reason: 'disabled', detail: typeof verdict === 'string' ? verdict : '' })
      continue
    }
    if (!module.roles.some((role) => options.roles.has(role))) {
      skipped.push({ module, reason: 'role', detail: '' })
      continue
    }
    selected.set(module.name, module)
  }

  for (const module of selected.values()) {
    for (const dep of module.dependsOn ?? []) {
      if (selected.has(dep)) continue
      throw new Error(`[kernel] 模块 ${module.name} 依赖 ${dep}，但 ${describeMissing(dep, byName, skipped)}`)
    }
  }

  return { ordered: topologicalOrder(selected), skipped }
}

function describeMissing<App>(
  name: string,
  byName: Map<string, ServerModule<App>>,
  skipped: readonly SkippedModule<App>[],
): string {
  if (!byName.has(name)) return `没有这个模块`
  const entry = skipped.find((item) => item.module.name === name)
  if (!entry) return `它没有加载`
  if (entry.reason === 'role') return `它不随当前角色启动（${name} 的角色：${entry.module.roles.join(' / ')}）`
  return entry.detail ? `它被关掉了：${entry.detail}` : `它被关掉了`
}

/** Kahn 算法，每一层按声明顺序取，所以顺序稳定；剩下取不完的就是环 */
function topologicalOrder<App>(selected: Map<string, ServerModule<App>>): ServerModule<App>[] {
  const edges = (module: ServerModule<App>) =>
    [...(module.dependsOn ?? []), ...(module.optional ?? [])].filter((dep) => selected.has(dep))

  const remaining = new Map(selected)
  const ordered: ServerModule<App>[] = []
  const done = new Set<string>()

  while (remaining.size > 0) {
    const layer = [...remaining.values()].filter((module) => edges(module).every((dep) => done.has(dep)))
    if (layer.length === 0) {
      throw new Error(`[kernel] 模块依赖成环：${[...remaining.keys()].join(' → ')}`)
    }
    for (const module of layer) {
      ordered.push(module)
      done.add(module.name)
      remaining.delete(module.name)
    }
  }
  return ordered
}
