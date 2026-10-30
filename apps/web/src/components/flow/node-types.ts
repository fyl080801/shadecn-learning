import { markRaw, type Component } from "vue"
import { Box, Clapperboard, Film, Frame, Image, Type } from "@lucide/vue"

import { definePromptComposerPart } from "@/components/flow/composer/composer-part"
import DirectorBody from "@/components/flow/DirectorBody.vue"
import ImageBody from "@/components/flow/ImageBody.vue"
import { mediaNodeStyle } from "@/components/flow/media-fit"
import NodeHost from "@/components/flow/node-kit/NodeHost.vue"
import {
  defineNodePart,
  ORDER_TYPE,
  type NodeModeDef,
  type NodePartDef,
  type NodeTypeView
} from "@/components/flow/node-kit/protocol"
import NodeUploadBadge from "@/components/flow/NodeUploadBadge.vue"
import { nodeUploadOf } from "@/components/flow/node-upload"
import TextBody from "@/components/flow/TextBody.vue"
import VideoBody from "@/components/flow/VideoBody.vue"
import type { FlowNodeRecord } from "@shadecn/shared/flow-graph"
import {
  buildNodeRecord,
  CREATABLE_NODE_TYPES,
  FLOW_NODE_TYPE_DEFAULTS,
  hasNodeResource,
  nodeFormOf,
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
 * 每一项就是这里的 `label` + `icon`；拉线到空白处 / 点出口加号弹出的候选菜单也用这两样。
 *
 * 能新建的只有四种：`text` / `image` / `video` / `director`（顺序在 shared 的 `CREATABLE_NODE_TYPES`）。
 * 另外两条不可新建：`process` 是认不出的 `type` 的兜底外观，`group` 由「打组」围出来。
 *
 * 每种类型往 `body` 区登记自己的内容展示（`view.body`），往 `composer` 区登记自己的底部输入框
 * （`parts`，按类型注册）—— 宿主 `NodeHost` 不认识任何类型。
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
   * 只属于这个类型的部件 / 模式（REQ-NODEKIT §4.1）—— 比如图片 / 视频节点的底部输入框：
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
 * 底部输入框（按类型注册）。文本**有了正文就收起**（`hasNodeResource`）：输入框是「还没有内容时描述想要什么」用的。
 * 图片 / 视频看**形态**（`nodeFormOf`）：generate 一直有（哪怕已经放了一张图），asset（独立素材）没有。导演台一直有。
 *
 * 眼下只到「写进 `data.prompt`、回车发 `composer:submit`」为止 —— 没有谁接这个事件，提交不会触发任何运行。
 */
const whenEmpty = (part: Parameters<typeof definePromptComposerPart>[0]) =>
  definePromptComposerPart({ ...part, when: (ctx) => !hasNodeResource(ctx.type, ctx.node.data.value) })

const whenGenerate = (part: Parameters<typeof definePromptComposerPart>[0]) =>
  definePromptComposerPart({ ...part, when: (ctx) => nodeFormOf(ctx.type, ctx.node.data.value) === "generate" })

/**
 * 图片 / 视频上传中的「上传中」角标。上传状态是本地的（`node-upload.ts`），不是 `runtime.status`，
 * 所以不归 `status` 能力管，按类型登记。
 */
const uploadingBadge = (type: string) =>
  defineNodePart({
    id: `${type}.uploading`,
    slot: "badge",
    order: ORDER_TYPE,
    component: NodeUploadBadge,
    when: (ctx) => nodeUploadOf(ctx) !== undefined
  })

/**
 * 带底部输入框的类型多启用 `edit-prompt`（写字时露出输入框、整张画布只有一个节点在编辑）。
 * 模式 id 全局唯一，所以它是一个能力（`composer/prompt.ts`），不是每个类型各登记一份模式。
 */
const COMPOSER_FEATURES = [...STANDARD_NODE_FEATURES, "edit-prompt"] as const

export const FLOW_NODE_TYPES: Record<string, FlowNodeTypeDef> = {
  /**
   * 文本 —— body 是一个输入框样子的正文区（`TextBody`，双击进入编辑，失焦提交一次），正文在 `data.text`。
   * 只有输出：文本是源头。
   */
  text: defineNodeType("text", {
    label: "文本",
    icon: Type,
    view: { body: TextBody, class: "flex min-h-[120px] w-[320px] flex-col", fallbackLabel: "文本" },
    features: [...COMPOSER_FEATURES, "edit-body"],
    parts: [whenEmpty({ id: "text.composer", placeholder: "描述想写的内容（Shift+回车换行）" })]
  }),
  /**
   * 图片 —— body 画 `data.src` 那张图，没有就是空占位。generate 形态接受文本 / 图片 / 视频拖线连入，asset 形态不接受。
   * 尺寸按图的高宽比（竖图定宽、横图定高），量过一次就记在布局里（`media-fit.ts`）
   */
  image: defineNodeType("image", {
    label: "图片",
    icon: Image,
    view: { body: ImageBody, class: "flex flex-col", style: mediaNodeStyle, fallbackLabel: "图片" },
    parts: [
      whenGenerate({ id: "image.composer", placeholder: "描述想要的画面（Shift+回车换行）" }),
      uploadingBadge("image")
    ],
    features: COMPOSER_FEATURES
  }),
  /** 视频 —— body 只画预览图 `data.poster`（不放 `<video>`），没有就是空占位。连入规则、尺寸规则同图片 */
  video: defineNodeType("video", {
    label: "视频",
    icon: Film,
    view: { body: VideoBody, class: "flex flex-col", style: mediaNodeStyle, fallbackLabel: "视频" },
    parts: [
      whenGenerate({ id: "video.composer", placeholder: "描述想要的视频（Shift+回车换行）" }),
      uploadingBadge("video")
    ],
    features: COMPOSER_FEATURES
  }),
  /**
   * 导演台 —— body 是一个「打开导演台」按钮，点了全屏打开导演台（`FlowDirectorOverlay`）。底部输入框一直在，
   * 回车把这段话交给绑定这个节点的会话（能力 `director-chat`）。
   * 固定 240 × 240 的正方形（与方图同尺寸）：方块是 body（`aspect-square`），报错行接在它下面，方块不变形
   */
  director: defineNodeType("director", {
    label: "导演台",
    icon: Clapperboard,
    view: { body: DirectorBody, class: "flex w-[240px] flex-col", fallbackLabel: "导演台" },
    parts: [definePromptComposerPart({ id: "director.composer", placeholder: "让助手搭场景、编排镜头（回车发送）" })],
    // director-chat：输入框回车 = 打开导演台、在绑定这个节点的会话里发出去（docs/07 §7.4）
    features: [...COMPOSER_FEATURES, "director-chat"]
  }),
  /**
   * 兜底 —— 认不出的 `type`（老画布里的 `process`、已经下线的旧业务类型）都按它画：一张空卡片，只有名字，
   * 没有端口所以和谁都能连。**不可新建**，不在任何菜单里。
   *
   * 宽度固定 360，高度下限按 16:9 给到 202.5（= 360 × 9 / 16），内容更高就自然撑开。
   * 写成 `min-h` 而不是 `aspect-video`：aspect-ratio 只在高度自动、且内容装得下时才成立，
   * 内容一旦超出，块级盒子是溢出而不是长高 —— 那正好和「内容高就撑开」相反。
   */
  [FALLBACK_NODE_TYPE]: defineNodeType(FALLBACK_NODE_TYPE, {
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
  })
}

/**
 * 工具栏「添加节点」菜单里列出的类型：text / image / video / director，顺序是 shared 的 `CREATABLE_NODE_TYPES`
 * （agent 能建的也是这几种）。
 *
 * 分组不在里面：分组是**把已经选中的一片节点圈起来**，入口在 `FlowSelectionToolbar`，
 * 凭空建一个空框再把节点拖进去是反的。兜底类型也不在：它只是认不出的老节点的外观。
 */
export const ADDABLE_NODE_TYPES: readonly FlowNodeTypeDef[] = CREATABLE_NODE_TYPES.map((type) => FLOW_NODE_TYPES[type]!)

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
