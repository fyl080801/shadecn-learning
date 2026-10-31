import type { Component, CSSProperties, Ref } from "vue"

import type { FlowEditorContext } from "@/composables/flow/editor-context"
import type { FlowNodeHandle } from "@/composables/flow/useFlowNode"

/**
 * 节点扩展协议的**类型与声明工厂**（REQ-NODEKIT，`docs/21-node-kit.md` §4）。
 *
 * 这是条叶子：上面只有 `import type`，编译后一条 import 都不剩 —— 宿主、部件组件、各个能力都要引它，
 * 它一旦反向引到任何组件就会成环（和 `editor-context.ts` / `node-view.ts` 同一个理由，
 * 环只在 rollup 生产构建里炸）。注册表的实现在 `./registry.ts`，模式的状态机在 `./modes.ts`。
 *
 * 四类条目（部件 / 动作 / 模式 / 事件处理函数）是**开放**的，谁都能注册；
 * 区域（`NodeSlot`）是**封闭**的，只有宿主能加 —— 区域是几何，几何由宿主说了算。
 * 条目之间不互相 import，组合全靠这里的匹配规则和事件。
 */

/** 节点上可以挂部件的位置。**封闭集合**：加一个区域就是改宿主，不是注册一条东西 */
export const NODE_SLOTS = [
  "label",
  "label-end",
  "toolbar",
  "badge",
  "header",
  "body",
  "footer",
  "composer",
  "side",
  "overlay",
  "handles"
] as const

export type NodeSlot = (typeof NODE_SLOTS)[number]

/** 动作（工具按钮）能出现在哪些区域。`menu` 是将来的右键菜单，宿主暂不实现 */
export type NodeActionSlot = "toolbar" | "footer" | "composer" | "menu"

/** 模式结束的原因：提交、显式取消（Esc）、被别的模式或别的选中顶掉 */
export type NodeModeExitReason = "commit" | "cancel" | "preempted"

/**
 * 条目对哪些节点生效。**只看类型声明，是静态的** —— 所以解析结果能按类型缓存。
 *
 * 各项之间是「且」：`types` 命中其一、`features` **全部**具备、`not` 里的一项都不沾。
 * 写 `{}` 就是对所有节点生效（得显式写出来，见 `registry.ts` 的 `registerPart`）。
 */
export interface NodeMatch {
  types?: readonly string[]
  features?: readonly string[]
  not?: {
    types?: readonly string[]
    features?: readonly string[]
  }
}

/** 匹配只需要知道这两样 */
export interface NodeTypeInfo {
  type: string
  features: readonly string[]
}

// —— 事件 ——

/**
 * 事件名 → 载荷类型。**用模块扩充往里加**，每个能力在自己的文件里声明自己的事件，没有中心枚举：
 *
 * ```ts
 * declare module "@/components/flow/node-kit/protocol" {
 *   interface FlowNodeEventMap {
 *     "composer:submit": { text: string }
 *   }
 * }
 * ```
 *
 * 事件名没有强制的命名规则（不要求前缀、注册时不校验格式）；两处声明同一个键而载荷类型不一致，编译期就会报错。
 * 下面这几条是宿主自己发的内置事件。
 */
export interface FlowNodeEventMap {
  "node:select": { selected: boolean }
  /** 双击节点本体（框外的名字、工具条是 teleport 出去的，不算）。要拦住冒泡的处理函数自己调 `event.stopPropagation()` */
  "node:dblclick": { event: MouseEvent }
  "mode:enter": { mode: string }
  "mode:exit": { mode: string; reason: NodeModeExitReason }
  "action:invoke": { action: string }
  "action:done": { action: string; error?: unknown }
  "slot:open": { slot: NodeSlot }
  "slot:close": { slot: NodeSlot }
}

export type NodeEventName = keyof FlowNodeEventMap

// —— 节点上下文 ——

/** 模式在**这一个节点**上的视图。模式状态本身是编辑器级的一个值（整张画布同时最多一个节点在编辑） */
export interface NodeModeView {
  /** 这个节点当前处于哪个模式；不在编辑就是 null */
  current: Readonly<Ref<string | null>>
  enter(mode: string): boolean
  exit(reason?: NodeModeExitReason): void
}

/** 「被要求才露出」的区域（`side` / `composer`）由谁要求 */
export interface NodeSlotControl {
  open(slot: NodeSlot): void
  close(slot: NodeSlot): void
  isOpen(slot: NodeSlot): boolean
}

/**
 * 部件、动作、模式钩子、事件处理函数拿到的**唯一入口**。宿主 provide 一次，部件里 `useNodePart()` 取。
 *
 * 读写规则不变：读 `node`（直接读 store，不读 Vue Flow 冻结的 `data` prop），
 * 写走 `node.write` / `node.draft` → `store.writeNode` → `store.mutate`。
 */
export interface NodePartContext {
  id: string
  type: string
  /** 这个类型启用了哪些能力 */
  features: readonly string[]
  node: FlowNodeHandle
  /** 显示的名字：起了名用名字，没起名用兜底（类型给的 fallback） */
  label: Readonly<Ref<string>>
  editor: FlowEditorContext
  selected: Readonly<Ref<boolean>>
  /** 节点此刻是否正被拖着走（Vue Flow 的拖动态，只是本地反馈，不进文档） */
  dragging: Readonly<Ref<boolean>>
  mode: NodeModeView
  slots: NodeSlotControl
  /** 只用来降级（「有 runnable 才显示运行按钮」），不是用来写 if 分支替代注册的 */
  has(feature: string): boolean
  emit<K extends NodeEventName>(event: K, payload: FlowNodeEventMap[K]): void
}

/** 发事件的那个节点 —— 总线只用 `type` 做匹配，其余原样交给处理函数 */
export type NodeEventSource = NodePartContext

// —— 四类条目 ——

/** 排序分段：0–99 宿主 / 框架内置，100–499 通用能力，500+ 类型专属。同 order 按注册顺序 */
export const ORDER_FRAMEWORK = 0
export const ORDER_FEATURE = 100
export const ORDER_TYPE = 500

interface ReplaceableEntry {
  id: string
  /** 能力里的条目可以不写（默认 = 启用了这个能力的节点）；单独注册的必须写 */
  match?: NodeMatch
  order?: number
  /** 顶替另一条（同类条目）的 id：被顶替的那条不再出现，这一条照常出现 */
  replaces?: string
  /** 去掉若干条（同类条目）的 id */
  hides?: readonly string[]
}

export interface NodePartDef extends ReplaceableEntry {
  slot: NodeSlot
  /** 部件组件不收 props，一律 `useNodePart()` 取上下文 */
  component: Component
  /** 动态条件（看数据、选中、模式），只能在宿主的露出规则之上**收窄** */
  when?: (ctx: NodePartContext) => boolean
}

export interface NodeActionDef extends ReplaceableEntry {
  slot: NodeActionSlot
  icon: Component
  label: string
  /** destructive = 删除那种红色按钮：只给真的会让东西没了的动作用 */
  tone?: "default" | "destructive"
  /** 形如 `Mod+D`；只对单独选中的节点、只在非输入态下分发 */
  shortcut?: string
  /** 不满足就不出现 */
  when?: (ctx: NodePartContext) => boolean
  /** 出现但置灰 */
  enabled?: (ctx: NodePartContext) => boolean
  /** 异步的话宿主用 `useAsyncAction` 包，自己不用 try/catch */
  run: (ctx: NodePartContext) => unknown
}

export interface NodeModeDef {
  id: string
  /** 进入时强制露出的区域（节点上没注册部件的区域，露出了也是空的，不会凭空出现） */
  reveal?: readonly NodeSlot[]
  /** 进入时收起的区域 */
  conceal?: readonly NodeSlot[]
  enter?: (ctx: NodePartContext) => void
  exit?: (ctx: NodePartContext, reason: NodeModeExitReason) => void
}

export interface NodeHandlerDef<K extends NodeEventName = NodeEventName> {
  event: K
  /** 能力里的处理函数可以不写（默认 = 启用了这个能力的节点发出的） */
  match?: NodeMatch
  /** 同步、无返回值；抛错只记日志，不影响别的处理函数，也不往发出方抛 */
  handle: (payload: FlowNodeEventMap[K], ctx: NodeEventSource) => void
}

/** 任意一个事件的处理函数（按事件名展开成联合，载荷类型跟着事件走） */
export type AnyNodeHandlerDef = { [K in NodeEventName]: NodeHandlerDef<K> }[NodeEventName]

/** 能力 = 四类条目的打包。不继承别的能力，也不 import 别的能力 */
export interface NodeFeatureDef {
  id: string
  parts?: readonly NodePartDef[]
  actions?: readonly NodeActionDef[]
  modes?: readonly NodeModeDef[]
  handlers?: readonly AnyNodeHandlerDef[]
  /**
   * 给节点根元素加的 class（运行中的一圈高亮、出错的红框）。
   * 部件够不着根元素，而这类外观又确实属于某个能力 —— 由宿主收集各能力的这一项，合到根上。
   */
  rootClass?: (ctx: NodePartContext) => string | false | null | undefined
}

/**
 * 一种节点**长什么样**：宿主按它画外壳、放 body。
 *
 * 这些是类型自己的外观，不是能力 —— 「这种节点多宽多高、是卡片还是一块框」只属于这一个类型。
 */
export interface NodeTypeView {
  /** body 区的组件（不收 props，`useNodePart()` 取上下文）。没有 body 的类型（分组）不写 */
  body?: Component
  /** card = 卡片（底色、边框、阴影、内边距）；frame = 什么都不加，外观全由 `class` / `style` 给 */
  shell?: "card" | "frame"
  /** 根元素的 class：尺寸、布局这类「这种节点多大」的样式 */
  class?: string
  /** 选中时额外加的 class；不给就用卡片那套高亮 */
  selectedClass?: string
  /** 没选中时额外加的 class */
  idleClass?: string
  /** 根元素的内联样式（分组的底色是数据，只能走 style） */
  style?: (ctx: NodePartContext) => CSSProperties | undefined
  /** 没起名时显示什么 */
  fallbackLabel?: string
  /**
   * 类型图标，宿主画在框外名字的左边（和菜单里那枚是同一个）。
   * `node-types.ts` 的 `defineNodeType` 把类型的 `icon` 抄进来；不给就不画
   */
  icon?: Component
  /**
   * 拉伸的约束（能力 `resizable` 读它；没启用 `resizable` 的类型写了也没用）。
   * 不给就是自由拉伸、最小 160 × 120
   */
  resize?: NodeResizeSpec
}

/** 拉伸约束：最小尺寸（画布坐标）和是否锁定宽高比 */
export interface NodeResizeSpec {
  minWidth?: number
  minHeight?: number
  /**
   * 锁定宽高比：`true` = 按拉伸开始时的比例；不给 / `false` = 自由拉伸，**按住 Shift 临时锁定**。
   * 内容有固有比例的类型（图片 / 视频这类）以后启用拉伸时应写 `true`
   */
  keepAspectRatio?: boolean
}

/**
 * 注册表眼里的节点类型：启用哪些能力（按名字）、外观，外加只属于这个类型的部件 / 动作 / 模式
 * （「这种节点的底部输入框里有什么」因类型而异，就按类型注册，不做成人人可选的能力）。
 * 图标、菜单名留在 `node-types.ts`。
 */
export interface NodeKitTypeDef {
  type: string
  features: readonly string[]
  view?: NodeTypeView
  parts?: readonly NodePartDef[]
  actions?: readonly NodeActionDef[]
  modes?: readonly NodeModeDef[]
}

// —— 声明工厂：原样返回，只为了让字面量拿到类型推断 ——

export function defineNodePart(def: NodePartDef): NodePartDef {
  return def
}

export function defineNodeAction(def: NodeActionDef): NodeActionDef {
  return def
}

export function defineNodeMode(def: NodeModeDef): NodeModeDef {
  return def
}

export function defineNodeHandler<K extends NodeEventName>(def: NodeHandlerDef<K>): NodeHandlerDef<K> {
  return def
}

export function defineNodeFeature(def: NodeFeatureDef): NodeFeatureDef {
  return def
}
