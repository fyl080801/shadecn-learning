/**
 * 节点类型的**纯常量**——这个文件不 import 任何组件，也不 import 任何 composable。
 *
 * 为什么不直接写在 `node-types.ts` 里：那份注册表要 import 节点的组件
 * （宿主 `NodeHost`、各类型的 body），而组件反过来又要读这里的常量（如 `useFlowCanvas` 读 `NEW_NODE_TYPE`）。
 * 两边写在同一个文件里就成了环：`node-types` → 组件 → `node-types`。
 *
 * 环在 `pnpm dev` 下看不出来（原生 ESM 有 live binding，用到的时候早初始化完了），
 * 但 rollup 打包会把它们摊平进不同 chunk 并**自己挑一个求值顺序**，挑错就是线上那句
 * `ReferenceError: Cannot access 'XX' before initialization` —— 整个画布编辑器白屏。
 * 所以常量单独放一层叶子：谁都可以引它，它只引 `@shadecn/shared` 里的模块 ——
 * 那些也是不 import 任何组件的叶子，环带不进来。
 *
 * 对外仍然从 `node-types.ts` re-export，「加一种节点只动注册表那一个文件」这条不变。
 */

/**
 * 分组框的 `type` / 默认底色 / 默认尺寸 / 层级 —— **定义挪进了 `@shadecn/shared/flow-node-types`**，
 * 这里转出去，组件照旧从本文件取。
 *
 * 挪走的理由：它们是「新建一个分组长什么样」的一部分，而服务端（agent 的画布工具）
 * 也要按同一份默认值建节点（REQ-AGENT §3.2）。shared 那个文件同样是叶子
 * （只引 `./flow-graph.ts`），上面说的环带不进来。
 */
export {
  GROUP_DEFAULT_BACKGROUND,
  GROUP_DEFAULT_SIZE,
  GROUP_NODE_TYPE,
  GROUP_Z_INDEX
} from "@shadecn/shared/flow-node-types"

/**
 * 工具栏那枚加号建出来的节点类型。
 *
 * 工具栏的加号已经是类型菜单（`ADDABLE_NODE_TYPES`），选哪种建哪种；这个常量管的是
 * 「没指定类型时建什么」—— `addNode()` 的默认值、从无端口节点长出来的新节点 —— 目前是文本节点。
 *
 * 注意它和下面的兜底类型是两件事：这个管「新建给什么」，那个管「认不出来的怎么渲染」。
 */
export const NEW_NODE_TYPE = "text"

/**
 * 认不出 `type` 时按哪种节点渲染。
 *
 * 必须和 `fromYNode` 读到缺失 `type` 时给的兜底值是同一个（`process`）—— 老画布里的
 * 节点写的就是它，换成别的会让既有内容换一副样子。所以不在这里另写字面量，
 * 直接转出 shared 里 `fromYNode` 用的那一个。
 */
export { FALLBACK_NODE_TYPE } from "@shadecn/shared/flow-graph"
