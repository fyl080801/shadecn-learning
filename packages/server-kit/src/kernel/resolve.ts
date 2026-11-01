import type { AnyServerModule, ModuleDependency } from './module.ts'
import type { ServerRole } from './roles.ts'

/** 一个没加载的模块和原因（进启动日志和 `/api/features`） */
export interface SkippedModule {
  readonly module: AnyServerModule
  readonly reason: 'disabled' | 'role'
  /** `enabled()` 给的原因；`role` 时为空 */
  readonly detail: string
}

export interface ResolvedModules {
  /** 按装配顺序（依赖在前）排好的模块 */
  readonly ordered: readonly AnyServerModule[]
  readonly skipped: readonly SkippedModule[]
}

/**
 * 从声明的模块里选出要加载的，并按依赖排序（docs/28 §3.1.3 第 1 步）。纯函数，不碰环境。
 *
 * 规则：
 * 1. 名字不能重复；
 * 2. 配置里关掉的（`switchedOff`，模块名 → 原因）→ 不加载（`disabled`），不再问模块自己；
 *    `enabled()` 给 `false` / 原因 → 不加载（`disabled`）；角色集和 `roles` 没交集 → 不加载（`role`）；
 * 3. 加载的模块硬依赖（`dependsOn`）的必须也加载，否则抛错并说明缺谁、为什么缺；
 *    带 `roles` 的依赖只在本进程扮演其中某个角色时才要求（也只在那时参与排序）；
 * 4. 软依赖（`optional`）只影响顺序：加载了就排在前面，没加载当没有；
 * 5. 依赖成环抛错。
 *
 * 排序是稳定的：同一层的模块按声明顺序。
 */
export function resolveModules(
  modules: readonly AnyServerModule[],
  options: {
    roles: ReadonlySet<ServerRole>
    /** 配置文件 / 环境变量里显式关掉的模块（`modules.<name>.enabled: false`）：模块名 → 写进启动日志和 `/api/features` 的原因 */
    switchedOff?: ReadonlyMap<string, string>
    /** 各模块解析好的配置（模块名 → 值），交给 `enabled(config)`；没有配置段的模块不在表里 */
    configs?: ReadonlyMap<string, unknown>
  },
): ResolvedModules {
  const byName = new Map<string, AnyServerModule>()
  for (const module of modules) {
    if (byName.has(module.name)) throw new Error(`[kernel] 模块名重复：${module.name}`)
    byName.set(module.name, module)
  }
  for (const name of options.switchedOff?.keys() ?? []) {
    if (!byName.has(name)) throw new Error(`[kernel] 配置里关掉了不存在的模块：${name}`)
  }

  const skipped: SkippedModule[] = []
  const selected = new Map<string, AnyServerModule>()
  for (const module of modules) {
    const off = options.switchedOff?.get(module.name)
    const verdict = off !== undefined ? off : (module.enabled?.(options.configs?.get(module.name)) ?? true)
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
    for (const dep of activeDependencies(module, options.roles)) {
      if (selected.has(dep)) continue
      throw new Error(`[kernel] 模块 ${module.name} 依赖 ${dep}，但 ${describeMissing(dep, byName, skipped)}`)
    }
  }

  return { ordered: topologicalOrder(selected, options.roles), skipped }
}

/** 本进程角色下真正生效的硬依赖名 */
export function activeDependencies(module: AnyServerModule, roles: ReadonlySet<ServerRole>): string[] {
  return (module.dependsOn ?? []).flatMap((dep: ModuleDependency) => {
    if (typeof dep === 'string') return [dep]
    return dep.roles.some((role) => roles.has(role)) ? [dep.module] : []
  })
}

function describeMissing(
  name: string,
  byName: Map<string, AnyServerModule>,
  skipped: readonly SkippedModule[],
): string {
  if (!byName.has(name)) return `没有这个模块`
  const entry = skipped.find((item) => item.module.name === name)
  if (!entry) return `它没有加载`
  if (entry.reason === 'role') return `它不随当前角色启动（${name} 的角色：${entry.module.roles.join(' / ')}）`
  return entry.detail ? `它被关掉了：${entry.detail}` : `它被关掉了`
}

/** Kahn 算法，每一层按声明顺序取，所以顺序稳定；剩下取不完的就是环 */
function topologicalOrder(selected: Map<string, AnyServerModule>, roles: ReadonlySet<ServerRole>): AnyServerModule[] {
  const edges = (module: AnyServerModule) =>
    [...activeDependencies(module, roles), ...(module.optional ?? [])].filter((dep) => selected.has(dep))

  const remaining = new Map(selected)
  const ordered: AnyServerModule[] = []
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
