import { nextTick, ref, type Ref } from "vue"
import { useFlowStore } from "@/stores/flow"

/**
 * 「本地草稿 + 一次提交」—— 连续变化的值统一走这里（见 docs/13 §3.7.2）。
 *
 * 一次编辑会产生几十上百个中间值（每敲一个键、每拖一帧），而**只有落点是数据**。
 * 所以草稿全程由本地 ref 接管画面，文档只在编辑结束时写一次，
 * 前后用 `separateUndo()` 夹住 —— 这三件事就是这个 composable 要吃掉的样板。
 *
 * 两个细节是纪律，不是风格：
 *
 * - **提交必须显式一次**，不能指望 `Y.UndoManager` 的 400ms 捕获窗口去合并 ——
 *   中间停顿超过 400ms 就会裂成两条撤销。
 * - **不要每次变化都写文档**。代价不在文档体积（Yjs 对 Map key 覆盖回收得很干净），
 *   而在广播和落库；更要紧的是语义：编到一半的值不该活过刷新、不该能被撤销到。
 *
 * ```ts
 * const title = useDraftField({
 *   current: () => props.label,
 *   normalize: (raw) => raw.trim() || null,      // 空标题 = 放弃这次提交
 *   commit: (next) => store.updateNodeData(props.nodeId, { label: next }, "修改节点标题"),
 *   focus: () => inputRef.value?.select()
 * })
 * ```
 * ```vue
 * <input v-if="title.editing.value" v-model="title.draft.value"
 *        @blur="title.commit()" @keydown.esc.prevent="title.cancel()" />
 * ```
 *
 * **连续手势（拖滑杆、拖关键帧）也是这个形状**，只是多一步：把 `draft` 节流发到
 * awareness，别人才看得到值在动而不是松手一瞬间跳过去。那一步没有做进来 ——
 * 它需要一个新的 awareness 反馈字段（现有的 `transform` 只装 `{x, y}`），
 * 而目前还没有这样的消费者。真要接的时候，在组件里 `watch(draft, useThrottleFn(publish, 40))`
 * 即可，`start` / `commit` / `cancel` 这三段不用改。
 */

export interface DraftFieldOptions<T> {
  /** 当前**已落库**的值。写成 getter，因为它是响应式的（props / store 投影） */
  current: () => T
  /**
   * 提交一次。**已经被包在两次 `separateUndo()` 之间**，函数体里直接写 store 就行。
   *
   * 走 store 而不是直接改 Y.Map：只有这样改动才进撤销栈、才同步给别人、才落库。
   */
  commit: (next: T) => void
  /**
   * 规范化草稿；**返回 `null` 表示这次不提交**（例如标题被清空，那不是一次改名，
   * 是一次误操作）。不给就原样提交。
   */
  normalize?: (draft: T) => T | null
  /** 值有没有变，默认 `Object.is`。没变就不写文档，省一次广播和一条撤销 */
  equals?: (a: T, b: T) => boolean
  /**
   * 进入编辑态、DOM 更新之后调一次，用来聚焦。
   *
   * 光标要落在哪是各家自己的事（标题全选重写、正文接着往下写），
   * 所以只给时机不给行为 —— `start()` 里的 `nextTick` 已经等过了。
   */
  focus?: () => void
}

export interface DraftField<T> {
  /** 在不在编辑态 */
  editing: Ref<boolean>
  /** 草稿值，直接 `v-model` 到输入控件上 */
  draft: Ref<T>
  /** 进入编辑：草稿从当前值起步，DOM 更新后调 `focus` */
  start: () => Promise<void>
  /** 结束编辑并提交。不在编辑态、被 `normalize` 拒了、或值没变都不会写文档 */
  commit: () => void
  /** 放弃这次编辑，草稿丢掉，什么都不写 */
  cancel: () => void
}

export function useDraftField<T>(options: DraftFieldOptions<T>): DraftField<T> {
  const store = useFlowStore()

  const editing = ref(false)
  const draft = ref(options.current()) as Ref<T>

  const equals = options.equals ?? Object.is

  async function start() {
    draft.value = options.current()
    editing.value = true
    await nextTick()
    options.focus?.()
  }

  function commit() {
    // 先退出编辑态：blur 和回车常常一起触发，不挡住的话会提交两次
    if (!editing.value) return
    editing.value = false

    const next = options.normalize ? options.normalize(draft.value) : draft.value
    if (next === null) return
    if (equals(next, options.current())) return

    // 一次编辑 = 一条撤销，别和刚才的拖动之类并进同一条
    store.separateUndo()
    options.commit(next)
    store.separateUndo()
  }

  function cancel() {
    editing.value = false
  }

  return { editing, draft, start, commit, cancel }
}
