import { markRaw, type Component } from "vue"
import {
  Box,
  Clapperboard,
  FileText,
  Film,
  Frame,
  Image,
  ImagePlus,
  MessageSquareText,
  Type,
  Video
} from "@lucide/vue"

import ImagePromptComposer from "@/components/flow/composer/ImagePromptComposer.vue"
import { editPromptMode } from "@/components/flow/composer/prompt"
import GenericBody from "@/components/flow/GenericBody.vue"
import NodeHost from "@/components/flow/node-kit/NodeHost.vue"
import {
  defineNodePart,
  ORDER_TYPE,
  type NodeModeDef,
  type NodePartDef,
  type NodeTypeView
} from "@/components/flow/node-kit/protocol"
import TextBody from "@/components/flow/TextBody.vue"
import type { FlowNodeRecord } from "@shadecn/shared/flow-graph"
import {
  buildNodeRecord,
  FLOW_NODE_TYPE_DEFAULTS,
  type BuildNodeOptions,
  type FlowNodeTypeDefaults
} from "@shadecn/shared/flow-node-types"
import { FALLBACK_NODE_TYPE, GROUP_DEFAULT_BACKGROUND, GROUP_NODE_TYPE } from "./node-constants"

/**
 * 常量在 `./node-constants.ts` 里定义、从这里 re-export —— 对外仍然「注册表一个文件」。
 * 分开放是为了断环：这个文件 import 各种节点组件，而节点组件要读那些常量，
 * 写在一起 rollup 打包时会挑错求值顺序（详见 node-constants.ts 顶部）。
 */
export {
  FALLBACK_NODE_TYPE,
  GROUP_DEFAULT_BACKGROUND,
  GROUP_DEFAULT_SIZE,
  GROUP_NODE_TYPE,
  GROUP_Z_INDEX,
  NEW_NODE_TYPE
} from "./node-constants"

/**
 * 节点类型注册表 —— **加一种节点只动这一个文件**（有默认值的话，再加
 * `@shadecn/shared/flow-node-types` 里的一条）。
 *
 * **数据那一半在 shared**：`type`、默认业务 `data`、默认布局、**端口声明**由
 * `FLOW_NODE_TYPE_DEFAULTS` 给，这里只补渲染那一半（组件、图标、菜单名）——
 * `defineNodeType(type, 渲染)` 把两半拼起来，一条就是一种节点。
 * 服务端的 agent 画布工具建节点也读 shared 那一份，所以人建的和 agent 建的长得一样
 * （REQ-AGENT §3.2）。
 *
 * 节点的业务种类就是它顶层的 `type`（见 `@shadecn/shared/flow-graph`），
 * 这张表的键即是它：由谁渲染、菜单里叫什么、新建时长什么样、有哪些端口，
 * 全在一处说清楚。画布（`FlowCanvas.vue`）、工具栏（`FlowToolbar.vue`）和
 * 新建逻辑（`useFlowCanvas.addNode`）都从这里取，没有第二处硬编码。
 *
 * 工具栏**不按这张表铺一排按钮**：加号弹出一个类型菜单（`ADDABLE_NODE_TYPES`），
 * 每一项就是这里的 `label` + `icon`。
 *
 * 示例数据（`sample/画布数据参考/`）里有 8 种节点，形状彼此完全不同 ——
 * 这张表就是让它们能共存的地方：`process` 是内容自适应的普通节点，
 * `group` 是带固定尺寸、压在所有节点之下的分组框，两者除了 `type` 之外没有共同点；
 * 七种带端口的业务节点眼下没有专门的界面，都用 `GenericBody`（通用 body）。
 *
 * **键的顺序就是 shared 那张表的顺序**：从带类型的端口「长出」新节点时取第一个兼容的类型
 * （`findGrowType`），顺序在 shared 里定，这里照着排，别各排各的。
 */
export interface FlowNodeTypeDef extends FlowNodeTypeDefaults {
  /** 菜单里显示的名字 */
  label: string
  icon: Component
  /**
   * 长什么样：外壳、body、尺寸、兜底名（REQ-NODEKIT `NodeTypeView`）。
   * **没有 `component` 了** —— 每种节点的根都是同一个宿主 `NodeHost`，它按这一项画外壳、放 body。
   */
  view: NodeTypeView
  /**
   * 启用哪些能力（REQ-NODEKIT），**按名字**写 —— 不 import 能力模块，`node-kit/install.ts`
   * 登记类型时校验名字都存在。名字、工具条按钮、连接点、运行态展示都是从这里来的。
   */
  features: readonly string[]
  /**
   * 只属于这个类型的部件 / 模式（REQ-NODEKIT §4.1）—— 比如生图节点的底部输入框：
   * 哪些类型有、里面放什么都因类型而异，所以就近写在类型声明旁，不做成通用能力。
   */
  parts?: readonly NodePartDef[]
  modes?: readonly NodeModeDef[]
}

/**
 * 普通节点的那套能力：改名、复制、删除、连接点、运行态展示。
 * 只是一个字符串数组，展开后与手写无异 —— 它不是基类，类型之间仍然没有关系。
 */
export const STANDARD_NODE_FEATURES = ["rename", "duplicate", "delete", "connectable", "status"] as const

/**
 * 一种节点 = shared 里的数据那一半 + 这里给的渲染那一半。
 * shared 里没有这个 type 的话只带一个 `type`（没有默认值、没有端口）。
 */
export function defineNodeType(
  type: string,
  render: Pick<FlowNodeTypeDef, "label" | "icon" | "view"> &
    Partial<Pick<FlowNodeTypeDef, "features" | "parts" | "modes">>
): FlowNodeTypeDef {
  return { ...(FLOW_NODE_TYPE_DEFAULTS[type] ?? { type }), features: STANDARD_NODE_FEATURES, ...render }
}

/**
 * 七种带端口的业务节点：同一个通用 body，同一张卡片，都能看产出（`output-preview`）。
 * 兜底名用 type 本身（和 body 里「没起名显示 type」一致）。
 * `extra` 是这个类型多出来的那点东西：多启用的能力、只属于它的部件 / 模式。
 */
function genericType(
  type: string,
  label: string,
  icon: Component,
  extra: { features?: readonly string[]; parts?: readonly NodePartDef[]; modes?: readonly NodeModeDef[] } = {}
): FlowNodeTypeDef {
  return defineNodeType(type, {
    label,
    icon,
    view: { body: GenericBody, class: "flex min-h-[160px] w-[300px] flex-col gap-2", fallbackLabel: type },
    features: [...STANDARD_NODE_FEATURES, "output-preview", ...(extra.features ?? [])],
    parts: extra.parts,
    modes: extra.modes
  })
}

/** 生成类节点：能接受运行请求（眼下只到「发出 `node:run`」，见 `node-kit/features/runnable.ts`） */
const GENERATOR_FEATURES = ["runnable"] as const

export const FLOW_NODE_TYPES: Record<string, FlowNodeTypeDef> = {
  text: defineNodeType("text", {
    label: "文本",
    icon: Type,
    view: { body: TextBody, class: "flex min-h-[120px] w-[320px] flex-col", fallbackLabel: "文本" },
    features: [...STANDARD_NODE_FEATURES, "edit-body"]
  }),
  /**
   * 流程节点 —— 一张空卡片，暂时只有名字，所以没有 body。
   *
   * 宽度固定 360，高度下限按 16:9 给到 202.5（= 360 × 9 / 16），内容更高就自然撑开。
   * 写成 `min-h` 而不是 `aspect-video`：aspect-ratio 只在高度自动、且内容装得下时才成立，
   * 内容一旦超出，块级盒子是溢出而不是长高 —— 那正好和「内容高就撑开」相反。
   */
  process: defineNodeType("process", {
    label: "流程节点",
    icon: Box,
    view: { class: "min-h-[202.5px] w-[360px]", fallbackLabel: "流程节点" }
  }),
  /**
   * 分组框 —— 把一片节点圈在一起的背景板。
   *
   * 它和普通节点除了都是节点之外没有任何共同点：有固定尺寸、可以拉伸、压在所有节点之下（`GROUP_Z_INDEX`）、
   * 而且**不挡住画布**。但外壳和普通节点是同一套：名字贴在框外左上角、双击改名、选中时工具栏浮在正上方居中
   * （分组的名字曾经长在框内部的标题栏上，那让它看着像另一种东西）。
   *
   * 差异全在这份声明里，宿主不认识「分组」：
   * - **能力**：不连线、不复制、不删除（不启用 `connectable` / `duplicate` / `delete`），
   *   工具条上是「解组」（`ungroup`），可拉伸（`resizable`），有顶部拖动把手（`drag-strip`）；
   * - **外观**：`frame` 外壳（不要卡片底）、虚线框、底色来自 `data.background`；
   *   **整块 `pointer-events-none`** —— 分组是一大片背景板，照单全收鼠标事件的话，框选、平移这些画布操作
   *   在分组范围内就全废了。点内部空白穿透到画布，拖顶部那条把手才是拖分组。
   *
   * 「把节点拖进已有分组」（自动 reparent）还没做：数据上 `parentNode` / `extent` 是通的，缺的只是拖动时的命中判定。
   */
  [GROUP_NODE_TYPE]: defineNodeType(GROUP_NODE_TYPE, {
    label: "分组",
    icon: Frame,
    view: {
      shell: "frame",
      class: "pointer-events-none h-full w-full rounded-lg border-2 border-dashed transition-colors",
      selectedClass: "border-primary/70",
      idleClass: "border-muted-foreground/30",
      style: (ctx) => {
        const background = ctx.node.data.value.background
        return { backgroundColor: typeof background === "string" ? background : GROUP_DEFAULT_BACKGROUND }
      },
      fallbackLabel: "分组"
    },
    features: ["rename", "status", "ungroup", "resizable", "drag-strip"]
  }),
  "text-input": genericType("text-input", "文本输入", MessageSquareText),
  /**
   * 生图节点有底部输入框 —— **按类型注册**：它的部件和编辑模式就写在这里，别的类型没有。
   * 视频 / 文本生成将来各注册自己的（框里要的东西不一样），共用 `PromptComposer` 那个外壳。
   */
  "image-config": genericType("image-config", "图片生成", ImagePlus, {
    features: GENERATOR_FEATURES,
    parts: [
      defineNodePart({ id: "image-config.composer", slot: "composer", order: ORDER_TYPE, component: ImagePromptComposer })
    ],
    modes: [editPromptMode]
  }),
  "video-config": genericType("video-config", "视频生成", Film, { features: GENERATOR_FEATURES }),
  "text-config": genericType("text-config", "文本生成", FileText, { features: GENERATOR_FEATURES }),
  "image-source": genericType("image-source", "图片素材", Image),
  "video-source": genericType("video-source", "视频素材", Video),
  "director-console": genericType("director-console", "导演台", Clapperboard)
}

/**
 * 工具栏「添加节点」菜单里列出的类型，顺序即注册表顺序。
 *
 * 分组不在里面：分组是**把已经选中的一片节点圈起来**，入口在 `FlowSelectionToolbar`，
 * 凭空建一个空框再把节点拖进去是反的。
 */
export const ADDABLE_NODE_TYPES: readonly FlowNodeTypeDef[] = Object.values(FLOW_NODE_TYPES).filter(
  (def) => def.type !== GROUP_NODE_TYPE
)

/**
 * 喂给 `<VueFlow :node-types>` 的组件表。
 *
 * 在模块顶层建好并 `markRaw`：写成模板里的字面量的话每次渲染都是新对象，
 * Vue Flow 会把它存进自己的响应式 state，于是组件定义被 `reactive()` 包一层，
 * Vue 报 "received a Component that was made a reactive object"，
 * 节点类型也会白白重新解析一遍。
 *
 * **每个类型都是同一个宿主 `NodeHost`**：它按 type 向注册表要外观（`view`）和能力，类型之间的差异全在声明里。
 */
export const flowNodeComponents = markRaw(
  Object.fromEntries(Object.values(FLOW_NODE_TYPES).map((def) => [def.type, NodeHost]))
)

/** 认不认识这个 type；认不出来的按默认类型渲染 */
export function flowNodeTypeOf(type: string): FlowNodeTypeDef {
  return FLOW_NODE_TYPES[type] ?? FLOW_NODE_TYPES[FALLBACK_NODE_TYPE]!
}

/**
 * 按注册表拼一个新节点（布局、metadata、默认业务 data、空闲的运行态）。
 * 读的是本表（默认值是从 shared 铺进来的那一份），和 agent 用的 shared `buildNodeRecord` 是同一个函数。
 */
export function buildFlowNode(options: BuildNodeOptions): FlowNodeRecord {
  return buildNodeRecord(options, flowNodeTypeOf(options.type))
}
