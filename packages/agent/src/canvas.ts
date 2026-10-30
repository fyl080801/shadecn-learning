import * as Y from 'yjs'
import { isAgentOrigin, type AgentTransactionOrigin } from '@shadecn/shared/agent'
import { edgesMap, nodesMap } from '@shadecn/shared/flow-doc'

/**
 * 画布工具够得着的那张画布 —— **工具只认这个抽象，不认识 Hocuspocus**。
 *
 * 实现由宿主给：apps/server 的 `agent/canvas-access.ts` 用 direct connection 打开活房间、
 * 每次读写前重查发起人权限和配额；测试用下面的 {@link createDocCanvasHandle} 直接包一个
 * 内存里的 `Y.Doc`。两种实现对工具来说没有区别，工具逻辑因此能脱离数据库和 WebSocket 单测。
 *
 * ## 写的规矩：先校验、后动手
 *
 * `write(fn)` 的 `fn` 跑在一个 Y 事务里，但 **Yjs 的事务不会回滚**：`fn` 抛异常时，
 * 抛之前已经 `set` / `delete` 的那些照样生效、照样广播。所以每个工具的 `fn` 都按
 * 「读出现状 → 校验全部前提 → 一口气改」的顺序写，异常只允许出现在第一次改动之前。
 * `fn` 是同步的，JS 单线程，校验和改动之间不会插进别人的更新。
 */
export interface CanvasHandle {
  readonly flowId: string
  /** 只读访问。实现在调 `fn` 之前做权限复核 */
  read<T>(fn: (doc: Y.Doc) => T): Promise<T>
  /**
   * 一次写 = 一个 Y 事务，origin 是 {@link agentOrigin}。
   * 实现在开事务之前做权限复核与配额检查，不过就抛 —— 一个字节都不写。
   */
  write<T>(fn: (doc: Y.Doc) => T): Promise<T>
  /**
   * 常驻观察（docs/20 §3.10.2）：这张画布上每个**动了节点 / 连线**的事务回调一次，返回取消函数。
   * 回调是同步的、跑在别人的事务收尾时 —— **只许记下「谁动了哪些元素」，不许读内容**：
   * 读内容要走 {@link read}（那里才重查发起人权限），由编排层在合并窗口到点时做。
   * 实现必须把回调包在 try/catch 里（抛出去会打断别人的事务处理，见 {@link observeDocTransactions}）。
   * 不实现 = 不观察（这一轮看不到别人的改动，只有跨轮差异）。
   */
  observe?(listener: (change: CanvasTransaction) => void): () => void
}

/**
 * 一个事务是谁做的 —— 由宿主按事务 origin 认（本包不认识 Hocuspocus）：
 * - `agent`：某一轮 agent 的写入（`{ source: 'agent', runId }`）；是不是本轮由编排层判；
 * - `user`：某个人的连接（服务端握手时认定的身份，客户端伪造不了）；
 * - `unknown`：认不出是谁（别的副本经 redis 转发来的、库里合并回来的……），显示成「其他协作者」。
 */
export type CanvasActor =
  | { kind: 'agent'; runId: string }
  | { kind: 'user'; id: string | null; name: string }
  | { kind: 'unknown' }

/** 一个事务动了哪些元素（只有 id，没有内容） */
export interface CanvasTransaction {
  actor: CanvasActor
  nodeIds: ReadonlySet<string>
  edgeIds: ReadonlySet<string>
  /**
   * 其中动了 **`data` 组**的节点（docs/20 §3.10.8「改过」检查只看它）：`data` 里的键（含导演台的 `dc.*`、嵌套类型）变了、
   * `data` 这一组整个被换掉、节点被新建或删除。只动了位置尺寸（顶层字段）、`metadata`、`runtime` 的不在里面。
   * 和 {@link nodeIds} 一样只看结构、不读内容。
   */
  dataNodeIds: ReadonlySet<string>
}

/** 宿主的 origin 分类：返回 null = 这类事务不算谁的改动（清理悬空连线、迁移老数据这种内务） */
export type OriginClassifier = (origin: unknown) => CanvasActor | null

/**
 * 一个事务改到的节点 / 连线 id：顺着 `transaction.changed` 里每个被改的类型往上找，
 * 找到 `nodes` / `edges` 那一层就是元素 id（节点自己的 Y.Map、它的 metadata / data / runtime 组都算这个节点）。
 * 不读任何内容，只看结构。
 */
export function touchedElements(
  transaction: Y.Transaction,
  doc: Y.Doc,
): { nodeIds: Set<string>; edgeIds: Set<string>; dataNodeIds: Set<string> } {
  // 只拿来比引用：放宽成 AbstractType，和 transaction.changed 的键同一个类型
  type AnyType = Y.AbstractType<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const nodes: AnyType = nodesMap(doc)
  const edges: AnyType = edgesMap(doc)
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()
  const dataNodeIds = new Set<string>()
  for (const [type, keys] of transaction.changed) {
    if (type === nodes || type === edges) {
      const target = type === nodes ? nodeIds : edgeIds
      for (const key of keys) {
        if (!key) continue
        target.add(key)
        // 节点本身被新建 / 删除 / 整个换掉：它的 data 跟着变了
        if (type === nodes) dataNodeIds.add(key)
      }
      continue
    }
    let child: AnyType = type
    /** 走到节点那一层之前的上一层在节点里的键（`data` / `metadata` / `runtime`）；改的就是节点自己的 Y.Map 时为 null */
    let groupKey: string | null = null
    // 嵌套最多三层（nodes → 节点 → 组），多走几步只是防御
    for (let depth = 0; depth < 8; depth += 1) {
      const item = child._item
      const parent = item?.parent
      if (!item || !(parent instanceof Y.AbstractType)) break
      if (parent === nodes || parent === edges) {
        if (item.parentSub) {
          const id = item.parentSub
          ;(parent === nodes ? nodeIds : edgeIds).add(id)
          // 改的是节点自己的 Y.Map（顶层字段）：只有 `data` 这个键本身变了（整组换掉）才算；
          // 改的是节点下面的某一组（或组里的嵌套类型）：那一组是 data 才算
          if (parent === nodes && (groupKey === null ? keys.has('data') : groupKey === 'data')) dataNodeIds.add(id)
        }
        break
      }
      groupKey = item.parentSub ?? null
      child = parent as AnyType
    }
  }
  return { nodeIds, edgeIds, dataNodeIds }
}

/**
 * 在一个 `Y.Doc` 上挂常驻观察：两种 {@link CanvasHandle} 实现共用。
 *
 * 挂在 `afterTransaction` 上 —— 它带着事务的 origin，Hocuspocus 应用客户端更新、redis 转发、
 * 我们自己的写入都是一个事务。**回调里的异常一律吞掉、记一笔**：这里跑在别人的事务收尾阶段
 * （比如 Hocuspocus 正在处理某个客户端的 update），抛出去会打断那条消息的处理。
 */
export function observeDocTransactions(
  doc: Y.Doc,
  classify: OriginClassifier,
  listener: (change: CanvasTransaction) => void,
): () => void {
  const handler = (transaction: Y.Transaction) => {
    try {
      const actor = classify(transaction.origin)
      if (!actor) return
      const { nodeIds, edgeIds, dataNodeIds } = touchedElements(transaction, doc)
      if (nodeIds.size === 0 && edgeIds.size === 0) return
      listener({ actor, nodeIds, edgeIds, dataNodeIds })
    } catch (err) {
      console.error('[agent] 画布观察回调出错（已忽略）', err)
    }
  }
  /*
   * 先把两张根表按 Y.Map 定义出来。远端 update 先到、本地还没人 `getMap` 过的根类型，Yjs 会先挂一个
   * 占位的 AbstractType；之后第一次 `getMap` 换成新的 Y.Map 实例 —— 那之前的事务里 `changed` 的键是占位对象，
   * {@link touchedElements} 按引用比对就认不出来。定义一下只是建实例，不产生事务、不写文档。
   */
  nodesMap(doc)
  edgesMap(doc)
  doc.on('afterTransaction', handler)
  return () => doc.off('afterTransaction', handler)
}

/** 缺省的 origin 分类：agent 的认出来，其余一律「其他协作者」。测试用 / 宿主没给分类时的兜底 */
export const defaultOriginClassifier: OriginClassifier = (origin) =>
  isAgentOrigin(origin) ? { kind: 'agent', runId: origin.runId } : { kind: 'unknown' }

/**
 * agent 写入的事务 origin（形状定义在 `@shadecn/shared/agent`）。
 *
 * 不是 `LOCAL_ORIGIN`，所以不进任何人的撤销栈；也不是 Hocuspocus 认识的
 * `connection` / `redis` / `local` 三种 —— Hocuspocus 对认不出的 origin 按「普通改动」处理：
 * 照常广播、照常进 `onChange`（配额记账、redis 转发）和防抖落库。
 */
export function agentOrigin(runId: string): AgentTransactionOrigin {
  return { source: 'agent', runId }
}

export interface DocCanvasHandleOptions {
  flowId: string
  runId: string
  /** 每次读写之前调；抛异常即拒绝。用来在测试里模拟「发起人失权」 */
  guard?: (kind: 'read' | 'write') => void | Promise<void>
  /** 常驻观察时怎么认 origin；不给用 {@link defaultOriginClassifier} */
  classifyOrigin?: OriginClassifier
}

/** 直接包一个 `Y.Doc` 的实现 —— 测试用，也是「实现长什么样」的最小参照 */
export function createDocCanvasHandle(doc: Y.Doc, options: DocCanvasHandleOptions): CanvasHandle {
  const origin = agentOrigin(options.runId)
  return {
    flowId: options.flowId,
    async read(fn) {
      await options.guard?.('read')
      return fn(doc)
    },
    async write(fn) {
      await options.guard?.('write')
      let result!: ReturnType<typeof fn>
      doc.transact(() => {
        result = fn(doc)
      }, origin)
      return result
    },
    observe(listener) {
      return observeDocTransactions(doc, options.classifyOrigin ?? defaultOriginClassifier, listener)
    },
  }
}
