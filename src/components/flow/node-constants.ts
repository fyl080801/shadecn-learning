/**
 * 节点类型的**纯常量**——这个文件不 import 任何组件，也不 import 任何 composable。
 *
 * 为什么不直接写在 `node-types.ts` 里：那份注册表要 import 每种节点的组件
 * （`GroupNode.vue` 等），而节点组件反过来又要读这里的常量。两边写在同一个文件里
 * 就成了环：`node-types` → `GroupNode` → `node-types`。
 *
 * 环在 `pnpm dev` 下看不出来（原生 ESM 有 live binding，用到的时候早初始化完了），
 * 但 rollup 打包会把它们摊平进不同 chunk 并**自己挑一个求值顺序**，挑错就是线上那句
 * `ReferenceError: Cannot access 'XX' before initialization` —— 整个画布编辑器白屏。
 * 所以常量单独放一层叶子：谁都可以引它，它谁都不引。
 *
 * 对外仍然从 `node-types.ts` re-export，「加一种节点只动注册表那一个文件」这条不变。
 */

/** 分组框的 `type`。打组（`useFlowCanvas.groupSelection`）建的就是它 */
export const GROUP_NODE_TYPE = "group"

/** 分组框的默认底色。半透明，因为它是背景板不是卡片 */
export const GROUP_DEFAULT_BACKGROUND = "rgba(120, 120, 140, 0.10)"

/** 分组框的默认尺寸：够放下两三个节点，剩下的自己拉 */
export const GROUP_DEFAULT_SIZE = { width: 520, height: 360 }

/**
 * 分组框的层级。
 *
 * 必须是负数：分组是**背景板**，画在所有节点下面。Vue Flow 的节点默认 zIndex 为 0，
 * 给 0 或不给的话，后建的分组会盖住先建的节点，把它们整片挡掉。
 */
export const GROUP_Z_INDEX = -1

/**
 * 工具栏那枚加号建出来的节点类型。
 *
 * 底部工具栏**不再一种节点一个按钮**：类型会越加越多，一整排图标既认不出来也放不下，
 * 所以入口收成一枚加号，「加什么」由这个常量说了算 —— 目前是文本节点。
 * 将来加号要变成一个类型菜单时，改的也还是这一处 + 那个按钮。
 *
 * 注意它和下面的兜底类型是两件事：这个管「新建给什么」，那个管「认不出来的怎么渲染」。
 */
export const NEW_NODE_TYPE = "text"

/**
 * 认不出 `type` 时按哪种节点渲染。
 *
 * 必须和 `fromYNode` 里那个兜底值一致（都是 `process`）—— 老画布里的节点写的就是它，
 * 换成别的会让既有内容换一副样子。
 */
export const FALLBACK_NODE_TYPE = "process"
