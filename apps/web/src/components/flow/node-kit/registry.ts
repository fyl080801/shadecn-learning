import {
  ORDER_FEATURE,
  ORDER_TYPE,
  type AnyNodeHandlerDef,
  type FlowNodeEventMap,
  type NodeActionDef,
  type NodeActionSlot,
  type NodeEventName,
  type NodeEventSource,
  type NodeFeatureDef,
  type NodeHandlerDef,
  type NodeKitTypeDef,
  type NodeMatch,
  type NodeModeDef,
  type NodePartDef,
  type NodeSlot,
  type NodeTypeInfo,
  type NodeTypeView
} from "./protocol"
import { parseShortcut } from "./shortcut"

/**
 * 节点扩展协议的注册表（REQ-NODEKIT，`docs/21-node-kit.md` §4.3–§4.9）：
 * 能力 / 类型 / 部件 / 动作 / 处理函数在这里登记，宿主按节点类型问「某个区域最终挂哪些」，
 * 事件在这里分发。
 *
 * **不是模块级单例**：`createNodeKit()` 每调一次是一份干净的注册表。编辑器里装一份默认的、provide 下去；
 * 组件测试各建各的，只装要测的那几条，不会被别的测试装进去的东西污染。
 *
 * 解析规则（一个节点类型的某类条目最终有哪些）：
 * 1. **收集**：启用了的能力里的条目（能力自带 `match` 的再收窄一次）+ 单独注册且 `match` 命中的 +
 *    类型声明里自带的；
 * 2. **剔除**：所有候选里 `replaces` / `hides` 点名的条目去掉（顶替者自己留着）；
 * 3. **排序**：按 `order`，相同的按注册顺序。
 *
 * `match` 只看类型声明，所以结果按类型缓存，任何一次注册都清空缓存；`when` / `enabled` 是动态的，
 * 不在这里算，宿主每次渲染自己算。
 */

/** 条目是谁带进来的 —— 决定它默认对哪些节点生效、默认排在哪一段 */
type Owner =
  | { kind: "feature"; id: string }
  | { kind: "type"; type: string }
  | { kind: "standalone" }

interface Registered<T> {
  def: T
  owner: Owner
  /** 注册顺序，排序的第二关键字 */
  seq: number
}

interface ResolvedType {
  rootClasses: NonNullable<NodeFeatureDef["rootClass"]>[]
  parts: NodePartDef[]
  actions: NodeActionDef[]
  modes: Map<string, NodeModeDef>
  partsBySlot: Map<NodeSlot, NodePartDef[]>
  actionsBySlot: Map<NodeActionSlot, NodeActionDef[]>
}

/** 事件处理函数互相 emit 时的最大嵌套深度 —— 超过就是两个处理函数在互相触发，掐断它 */
const MAX_EMIT_DEPTH = 32

const NO_FEATURES: readonly string[] = Object.freeze([])
const NO_VIEW: NodeTypeView = Object.freeze({})

/** `match` 命中判定：`types` 命中其一、`features` 全部具备、`not` 一项都不沾 */
export function matchesNode(match: NodeMatch, info: NodeTypeInfo): boolean {
  if (match.types && !match.types.includes(info.type)) return false
  if (match.features && !match.features.every((feature) => info.features.includes(feature))) {
    return false
  }
  if (match.not?.types?.includes(info.type)) return false
  if (match.not?.features?.some((feature) => info.features.includes(feature))) return false
  return true
}

function appliesTo(entry: { match?: NodeMatch }, owner: Owner, info: NodeTypeInfo): boolean {
  if (owner.kind === "feature" && !info.features.includes(owner.id)) return false
  if (owner.kind === "type" && owner.type !== info.type) return false
  // 单独注册的条目在登记时就保证了有 match
  return entry.match ? matchesNode(entry.match, info) : true
}

function defaultOrder(owner: Owner): number {
  return owner.kind === "type" ? ORDER_TYPE : ORDER_FEATURE
}

/** 收集 → 剔除 → 排序（见文件头） */
function resolveEntries<T extends NodePartDef | NodeActionDef>(
  entries: readonly Registered<T>[],
  info: NodeTypeInfo
): T[] {
  const candidates = entries.filter((entry) => appliesTo(entry.def, entry.owner, info))
  const removed = new Set<string>()
  for (const { def } of candidates) {
    if (def.replaces) removed.add(def.replaces)
    for (const id of def.hides ?? []) removed.add(id)
  }
  return candidates
    .filter((entry) => !removed.has(entry.def.id))
    .map((entry) => ({ entry, order: entry.def.order ?? defaultOrder(entry.owner) }))
    .sort((a, b) => a.order - b.order || a.entry.seq - b.entry.seq)
    .map(({ entry }) => entry.def)
}

function groupBySlot<S extends string, T extends { slot: S }>(list: readonly T[]): Map<S, T[]> {
  const grouped = new Map<S, T[]>()
  for (const item of list) {
    const bucket = grouped.get(item.slot)
    if (bucket) bucket.push(item)
    else grouped.set(item.slot, [item])
  }
  return grouped
}

export function createNodeKit() {
  const features = new Map<string, NodeFeatureDef>()
  const types = new Map<string, NodeTypeInfo>()
  const views = new Map<string, NodeTypeView>()
  const parts: Registered<NodePartDef>[] = []
  const actions: Registered<NodeActionDef>[] = []
  const modes = new Map<string, { def: NodeModeDef; owner: Owner }>()
  const handlers = new Map<NodeEventName, Set<Registered<AnyNodeHandlerDef>>>()
  const partIds = new Set<string>()
  const actionIds = new Set<string>()

  let seq = 0
  const cache = new Map<string, ResolvedType>()
  let emitDepth = 0

  function addPart(def: NodePartDef, owner: Owner) {
    if (partIds.has(def.id)) throw new Error(`[node-kit] 部件 id 重复：${def.id}`)
    partIds.add(def.id)
    parts.push({ def, owner, seq: seq++ })
    cache.clear()
  }

  function addAction(def: NodeActionDef, owner: Owner) {
    if (actionIds.has(def.id)) throw new Error(`[node-kit] 动作 id 重复：${def.id}`)
    actionIds.add(def.id)
    actions.push({ def, owner, seq: seq++ })
    cache.clear()
  }

  /** 登记一个处理函数，返回注销函数 */
  function addHandler(def: AnyNodeHandlerDef, owner: Owner): () => void {
    const entry: Registered<AnyNodeHandlerDef> = { def, owner, seq: seq++ }
    let bucket = handlers.get(def.event)
    if (!bucket) {
      bucket = new Set()
      handlers.set(def.event, bucket)
    }
    bucket.add(entry)
    return () => {
      handlers.get(def.event)?.delete(entry)
    }
  }

  function requireMatch(kind: string, entry: { id?: string; match?: NodeMatch }) {
    if (!entry.match) {
      throw new Error(
        `[node-kit] 单独注册的${kind}必须写 match（写 {} 表示对所有节点生效）：${entry.id ?? ""}`
      )
    }
  }

  /** 登记一个能力。它的条目默认只对启用了它的节点生效 */
  function registerFeature(def: NodeFeatureDef) {
    if (features.has(def.id)) throw new Error(`[node-kit] 能力 id 重复：${def.id}`)
    for (const mode of def.modes ?? []) {
      if (modes.has(mode.id)) throw new Error(`[node-kit] 模式 id 重复：${mode.id}`)
    }
    features.set(def.id, def)
    const owner: Owner = { kind: "feature", id: def.id }
    for (const part of def.parts ?? []) addPart(part, owner)
    for (const action of def.actions ?? []) addAction(action, owner)
    for (const mode of def.modes ?? []) modes.set(mode.id, { def: mode, owner })
    for (const handler of def.handlers ?? []) addHandler(handler, owner)
    cache.clear()
  }

  /** 登记一个节点类型。能力按名字引用，必须**先**登记过 —— 写错名字在装配时就报错，而不是悄悄少一块 */
  function registerType(def: NodeKitTypeDef) {
    if (types.has(def.type)) throw new Error(`[node-kit] 节点类型重复：${def.type}`)
    for (const mode of def.modes ?? []) {
      if (modes.has(mode.id)) throw new Error(`[node-kit] 模式 id 重复：${mode.id}`)
    }
    const unknown = def.features.filter((feature) => !features.has(feature))
    if (unknown.length > 0) {
      throw new Error(`[node-kit] 节点类型 ${def.type} 引用了没登记的能力：${unknown.join(", ")}`)
    }
    types.set(def.type, { type: def.type, features: Object.freeze([...new Set(def.features)]) })
    if (def.view) views.set(def.type, def.view)
    const owner: Owner = { kind: "type", type: def.type }
    for (const part of def.parts ?? []) addPart(part, owner)
    for (const action of def.actions ?? []) addAction(action, owner)
    for (const mode of def.modes ?? []) modes.set(mode.id, { def: mode, owner })
    cache.clear()
  }

  /** 单独登记一个部件（按 `match` 挂到若干类型上，比如 `match: { types: [...] }`） */
  function registerPart(def: NodePartDef) {
    requireMatch("部件", def)
    addPart(def, { kind: "standalone" })
  }

  function registerAction(def: NodeActionDef) {
    requireMatch("动作", def)
    addAction(def, { kind: "standalone" })
  }

  /**
   * 编辑器级的订阅（`useFlowAgent` 之类在 setup 里接入节点行为的方式）。
   * `match` 不给 = 所有节点发出的都收；返回注销函数，调用方在卸载时调。
   */
  function on<K extends NodeEventName>(
    event: K,
    handle: NodeHandlerDef<K>["handle"],
    options: { match?: NodeMatch } = {}
  ): () => void {
    const def = { event, handle, match: options.match ?? {} } as unknown as AnyNodeHandlerDef
    return addHandler(def, { kind: "standalone" })
  }

  /** 没登记的类型当作「什么能力都没有」：只有单独注册、`match` 恰好命中它的条目 */
  function typeInfo(type: string): NodeTypeInfo {
    return types.get(type) ?? { type, features: NO_FEATURES }
  }

  function resolve(type: string): ResolvedType {
    const cached = cache.get(type)
    if (cached) return cached
    const info = typeInfo(type)
    const resolvedParts = resolveEntries(parts, info)
    const resolvedActions = resolveEntries(actions, info)
    const resolvedModes = new Map<string, NodeModeDef>()
    for (const [id, { def, owner }] of modes) {
      if (appliesTo({}, owner, info)) resolvedModes.set(id, def)
    }
    const resolved: ResolvedType = {
      rootClasses: info.features.flatMap((id) => {
        const rootClass = features.get(id)?.rootClass
        return rootClass ? [rootClass] : []
      }),
      parts: resolvedParts,
      actions: resolvedActions,
      modes: resolvedModes,
      partsBySlot: groupBySlot(resolvedParts),
      actionsBySlot: groupBySlot(resolvedActions)
    }
    cache.set(type, resolved)
    return resolved
  }

  const EMPTY: readonly never[] = Object.freeze([])

  /** 某类型在某区域最终挂的部件（已排序）。没有就是空数组 —— 宿主据此决定挂不挂这个区域 */
  function partsFor(type: string, slot: NodeSlot): readonly NodePartDef[] {
    return resolve(type).partsBySlot.get(slot) ?? EMPTY
  }

  function actionsFor(type: string, slot: NodeActionSlot): readonly NodeActionDef[] {
    return resolve(type).actionsBySlot.get(slot) ?? EMPTY
  }

  /** 某类型所有区域的动作 —— 快捷键分发用 */
  function allActionsFor(type: string): readonly NodeActionDef[] {
    return resolve(type).actions
  }

  /** 这个类型能不能进某个模式（模式来自它启用的能力） */
  function findMode(type: string, mode: string): NodeModeDef | null {
    return resolve(type).modes.get(mode) ?? null
  }

  /** 启用的能力给根元素加 class 的函数（按类型声明里能力的顺序） */
  function rootClassesFor(type: string): readonly NonNullable<NodeFeatureDef["rootClass"]>[] {
    return resolve(type).rootClasses
  }

  /** 类型的外观；没登记的类型（或没写外观的）是空对象 —— 宿主就画一张空卡片 */
  function viewOf(type: string): NodeTypeView {
    return views.get(type) ?? NO_VIEW
  }

  function featuresOf(type: string): readonly string[] {
    return typeInfo(type).features
  }

  function hasFeature(type: string, feature: string): boolean {
    return typeInfo(type).features.includes(feature)
  }

  /**
   * 发一个事件：同步、广播、无返回值。
   *
   * 每个处理函数单独 try/catch，一个抛错只记日志，不影响别的，也不往发出方抛。
   * 遍历的是快照，处理函数里注销自己（或别人）不影响这一轮。
   */
  function emit<K extends NodeEventName>(
    event: K,
    payload: FlowNodeEventMap[K],
    source: NodeEventSource
  ) {
    const bucket = handlers.get(event)
    if (!bucket || bucket.size === 0) return
    if (emitDepth >= MAX_EMIT_DEPTH) {
      console.error(`[node-kit] 事件 ${event} 嵌套超过 ${MAX_EMIT_DEPTH} 层，疑似处理函数互相触发，已丢弃`)
      return
    }
    const info = typeInfo(source.type)
    emitDepth++
    try {
      for (const entry of [...bucket]) {
        if (!appliesTo(entry.def, entry.owner, info)) continue
        try {
          // 桶是按事件名分的，这里的处理函数一定是这个事件的；联合类型收不窄，只能断言
          ;(entry.def as unknown as NodeHandlerDef<K>).handle(payload, source)
        } catch (error) {
          console.error(`[node-kit] 事件 ${event} 的处理函数出错（节点 ${source.id}）`, error)
        }
      }
    } finally {
      emitDepth--
    }
  }

  /**
   * 检查跨条目的引用：`replaces` / `hides` 点名的条目得存在；动作的快捷键得写得对。
   *
   * 不放在登记时查：被点名的那条可能还没登记（登记顺序是 `install.ts` 定的，不该成为约束）。
   * 装配完调一次，返回问题列表；`assertValid()` 有问题就抛。
   */
  function validate(): string[] {
    const problems: string[] = []
    const check = (kind: string, known: Set<string>, list: readonly Registered<NodePartDef | NodeActionDef>[]) => {
      for (const { def } of list) {
        for (const target of [...(def.replaces ? [def.replaces] : []), ...(def.hides ?? [])]) {
          if (!known.has(target)) problems.push(`${kind} ${def.id} 点名了不存在的${kind}：${target}`)
        }
      }
    }
    check("部件", partIds, parts)
    check("动作", actionIds, actions)
    for (const { def } of actions) {
      if (!def.shortcut) continue
      try {
        parseShortcut(def.shortcut)
      } catch (error) {
        problems.push(`动作 ${def.id} 的${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return problems
  }

  function assertValid() {
    const problems = validate()
    if (problems.length > 0) throw new Error(`[node-kit] 注册表有问题：\n${problems.join("\n")}`)
  }

  return {
    registerFeature,
    registerType,
    registerPart,
    registerAction,
    on,
    emit,
    partsFor,
    actionsFor,
    allActionsFor,
    findMode,
    rootClassesFor,
    viewOf,
    featuresOf,
    hasFeature,
    validate,
    assertValid
  }
}

export type NodeKit = ReturnType<typeof createNodeKit>
