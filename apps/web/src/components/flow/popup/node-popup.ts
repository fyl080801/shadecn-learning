import { defineComponent, h, inject, markRaw, provide, type Component, type InjectionKey, type Ref } from "vue"

import {
  defineNodePart,
  ORDER_TYPE,
  type FlowNodeEventMap,
  type NodeEventName,
  type NodeMatch,
  type NodePartContext,
  type NodePartDef
} from "@/components/flow/node-kit/protocol"
import NodePopupOpenButton from "./NodePopupOpenButton.vue"

/**
 * 节点的「弹出编辑」协议（REQ-NODEKIT docs/21 §4.10）—— 从画布上把一个节点弹出来：盖一层半透明 backdrop，
 * 中间一块面板单独编辑它。
 *
 * 和导演台的「全屏占用」（`FlowDirectorOverlay.vue`，不透明、占满整屏、自己画全部控件）是**两种**独立编辑，
 * 这里只管前一种。
 *
 * 为什么要标准化：节点在 Vue Flow 的变换层里，就地弹出来的东西会跟着缩放、被别的节点压住；
 * 而「弹出来」要做的事每次都一样 —— teleport 到 body、遮罩挡住画布的指针、画布快捷键让路、Esc 的分层规则、
 * 焦点离开画布、点遮罩关闭、面板外框和标题栏、节点被删了就收起来。这些全在宿主 `FlowNodePopupHost.vue` 里**只写一次**，
 * 每种弹出编辑只声明：**谁发事件打开它**、**里面放什么**（`component`）。
 *
 * - 节点只发事件（`ctx.emit(def.event, payload)`），不跳路由、不自己弹层；右上角的入口按钮用 `popupOpenPart` 生成；
 * - 整个编辑器同一时刻只开一个；开着时再打开别的，旧的先卸载（内容组件卸载时自己提交草稿）；
 * - 新增一种 = `popups.ts` 里加一条 + 一个内容组件，宿主不认识任何具体弹出编辑。
 */
export interface NodePopupDef<K extends NodeEventName = NodeEventName> {
  /** 全局唯一；也是遮罩根元素的 `data-testid`（`<id>-popup`） */
  id: string
  /** 打开它的节点事件 —— 发出方就是要编辑的那个节点（`ctx.id`），载荷原样交给内容组件 */
  event: K
  /** 只接哪些节点发的（静态，同 node-kit 的 `match`） */
  match: NodeMatch
  /**
   * 内容组件，填满面板标题栏以下的部分。props：`nodeId: string`、`payload: 事件载荷`；emits：`close`。
   * 可选地 `defineExpose` 出 `NodePopupContent` 里的钩子。**卸载 = 关闭，草稿在卸载时提交。**
   */
  component: Component
  /** 标题栏的兜底名（节点没有名字时） */
  fallbackTitle: string
  /**
   * 焦点在输入框里按 Esc：
   * - `close`（默认）：直接关 —— 输入框就是这层的主体（文本编辑），失焦这一步没有意义；
   * - `blur`：先让输入框失焦、不关，再按一次才关 —— 输入框只是面板里的配角时用。
   * 两种都不丢字：关闭 = 内容组件卸载 = 提交草稿。
   */
  escapeFromInput?: "close" | "blur"
}

/** 内容组件可以 `defineExpose` 的钩子（都可选） */
export interface NodePopupContent<P = unknown> {
  /** 已经开着同一个节点的同一个弹出编辑，又收到一次打开事件：不重挂，交给它 */
  reopen?: (payload: P) => void
  /**
   * 弹出编辑自己的快捷键。宿主在 document 冒泡阶段收到按键、排除了 Esc / 正在输入 / 输入法组字之后才调；
   * 返回 `true` = 处理了（宿主 `preventDefault`）
   */
  handleKey?: (event: KeyboardEvent) => boolean
}

/**
 * 标题栏里留给内容组件的按钮位（「完成」左边）。内容组件 `useNodePopupActions()` 拿到这个元素，
 * 用 `<Teleport v-if="actions" :to="actions">` 把自己的按钮（如文本的「预览」开关）放进去 ——
 * 标题栏只有一条，内容不另起一行工具栏。
 */
const POPUP_ACTIONS_KEY: InjectionKey<Readonly<Ref<HTMLElement | null>>> = Symbol("node-popup-actions")

/** 宿主用：把标题栏按钮位的元素交给内容组件 */
export function provideNodePopupActions(target: Readonly<Ref<HTMLElement | null>>) {
  provide(POPUP_ACTIONS_KEY, target)
}

/** 内容组件用：标题栏按钮位的元素（不在弹出编辑里就是 null） */
export function useNodePopupActions(): Readonly<Ref<HTMLElement | null>> | null {
  return inject(POPUP_ACTIONS_KEY, null)
}

export function defineNodePopup<K extends NodeEventName>(def: NodePopupDef<K>): NodePopupDef<K> {
  return def
}

/**
 * 节点右上角（`badge` 区）「弹出编辑」的图标按钮，所有弹出编辑同款（和图片 / 视频的上传按钮同一个位置）。
 * 部件不收 props（node-kit 规则），所以按参数生成一个包好的组件。
 */
export function popupOpenPart<K extends NodeEventName>(options: {
  id: string
  event: K
  /** 悬停提示 / 无障碍名 */
  title: string
  icon: Component
  testId: string
  /** 点了发出去的载荷 */
  payload: FlowNodeEventMap[K]
  when?: (ctx: NodePartContext) => boolean
}): NodePartDef {
  const component = markRaw(
    defineComponent({
      name: "NodePopupOpenPart",
      setup: () => () =>
        h(NodePopupOpenButton, {
          event: options.event,
          payload: options.payload,
          title: options.title,
          icon: options.icon,
          testId: options.testId
        })
    })
  )
  return defineNodePart({ id: options.id, slot: "badge", order: ORDER_TYPE, component, when: options.when })
}
