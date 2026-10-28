import { computed, toValue, type MaybeRefOrGetter } from "vue"
import type { FlowNodeGroup } from "@shadecn/shared/flow-doc"
import type {
  FlowNode,
  FlowNodeInput,
  FlowNodeMetadata,
  FlowNodeRuntime
} from "@shadecn/shared/flow-graph"
import { useFlowStore } from "@/stores/flow"
import { useDraftField, type DraftField, type DraftFieldOptions } from "./useDraftField"

/**
 * 一个节点的「公共逻辑」—— 每种节点组件都要的那几样：读这个节点的四组数据、按组写回去、
 * 在某个字段上开一个「本地草稿 + 一次提交」。
 *
 * **直接读 store，不读 Vue Flow 塞进组件的 `data` prop**：store 是 Y.Doc 的投影、是唯一的读源；
 * Vue Flow 那份在本地拖动期间是冻结的（`useFlowCanvas` 的 `localDragging`），读它的话，
 * 拖动时别人改的名字要等松手才出现。按 id 取走的是 `store.nodeById`（O(1)），
 * 一个节点变了，其余节点的这些 computed 重算后拿到的还是同一个对象，不会触发重渲染。
 *
 * **写一律走 `store.writeNode(id, 组, {set, remove})`**，也就是 `store.mutate` ——
 * 这样才进撤销栈、才同步给别人、才被服务端落库。layout 不在这里写（拖动 / 拉伸 / 打组各有路径）。
 *
 * 只依赖 store（Pinia），不依赖编辑器上下文 —— 组件测试只装 Pinia 就能用。
 */

const EMPTY_METADATA: FlowNodeMetadata = Object.freeze({ label: "" }) as FlowNodeMetadata
const EMPTY_DATA: Record<string, unknown> = Object.freeze({}) as Record<string, unknown>
const IDLE_RUNTIME: FlowNodeRuntime = Object.freeze({ status: "idle" }) as FlowNodeRuntime
const NO_INPUTS: FlowNodeInput[] = Object.freeze([]) as unknown as FlowNodeInput[]

/** 草稿字段的选项：哪一组的哪个键，怎么从原值读成草稿类型 */
export interface NodeDraftOptions<T> extends Omit<DraftFieldOptions<T>, "current" | "commit"> {
  /** 原值 → 草稿值（原值可能缺、可能类型不对）。不给就要求原值就是 T，缺了用 `fallback` */
  read?: (raw: unknown) => T
  /** 原值缺失时的草稿起点 */
  fallback: T
  /** 撤销 / 日志里的名字 */
  label?: string
}

export function useFlowNode(id: MaybeRefOrGetter<string>) {
  const store = useFlowStore()

  const node = computed<FlowNode | null>(() => store.nodeById.get(toValue(id)) ?? null)
  const type = computed(() => node.value?.type ?? null)
  const metadata = computed(() => node.value?.metadata ?? EMPTY_METADATA)
  const data = computed(() => node.value?.data ?? EMPTY_DATA)
  const runtime = computed(() => node.value?.runtime ?? IDLE_RUNTIME)
  const inputs = computed(() => node.value?.inputs ?? NO_INPUTS)
  const label = computed(() => metadata.value.label)

  /** 按组写：写和删同一个事务（见 `store.writeNode`） */
  function write(
    group: FlowNodeGroup,
    changes: { set?: Record<string, unknown>; remove?: Iterable<string> },
    actionLabel?: string
  ) {
    store.writeNode(toValue(id), group, changes, actionLabel)
  }

  /** 改名 —— 写的是 `metadata.label` */
  function rename(next: string) {
    write("metadata", { set: { label: next } }, "修改节点标题")
  }

  /** 改若干业务字段 */
  function setData(patch: Record<string, unknown>, actionLabel = "修改节点") {
    write("data", { set: patch }, actionLabel)
  }

  /** 读某一组的当前值（原样，可能是 undefined） */
  function readGroup(group: FlowNodeGroup, key: string): unknown {
    const source =
      group === "metadata" ? metadata.value : group === "runtime" ? runtime.value : data.value
    return (source as Record<string, unknown>)[key]
  }

  /**
   * 在某组的某个键上开一个草稿（`useDraftField` 那一套：草稿接管画面、结束时只写一次、
   * 前后夹 `separateUndo`）。改名、就地改正文都是它。
   */
  function draft<T>(group: FlowNodeGroup, key: string, options: NodeDraftOptions<T>): DraftField<T> {
    const { read, fallback, label: actionLabel, ...rest } = options
    return useDraftField<T>({
      ...rest,
      current: () => {
        const raw = readGroup(group, key)
        if (read) return read(raw)
        return raw === undefined ? fallback : (raw as T)
      },
      commit: (next) => write(group, { set: { [key]: next } }, actionLabel)
    })
  }

  return {
    node,
    type,
    metadata,
    data,
    runtime,
    inputs,
    label,
    write,
    rename,
    setData,
    draft
  }
}

export type FlowNodeHandle = ReturnType<typeof useFlowNode>
