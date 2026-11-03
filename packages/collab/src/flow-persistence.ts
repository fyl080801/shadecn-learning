import { type FlowDocRow, FlowDocStore } from '@learning/canvas'
import { bytesCodec, Cluster, type SharedMap } from '@learning/cluster'
import { FLOW_ROOM_PREFIX } from '@learning/contracts/collab'
import { applyGraphToDoc } from '@learning/contracts/flow-doc'
import { Inject, Injectable } from '@nestjs/common'
import * as Y from 'yjs'
import { readGraphFromDoc } from './flow-doc.js'

/** 房间名 → 画布 id；不是画布房间返回 null（别的房间不落库） */
export function flowIdOf(documentName: string): string | null {
  return documentName.startsWith(FLOW_ROOM_PREFIX) ? documentName.slice(FLOW_ROOM_PREFIX.length) : null
}

export function roomOf(flowId: string): string {
  return `${FLOW_ROOM_PREFIX}${flowId}`
}

/** 两段字节一不一样 */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(a, b) === 0
}

/**
 * 一行 `Flow` → 它的 Yjs 状态；内容为空返回 null。
 * `ydoc` 为空而 graph 有内容时现场灌一份：这个函数只给「打开房间」和个人画布的 REST 通道用，**落库的合并不能走这里**（新文档的 clientID 全新，合进活文档会重复内容）。
 */
export function stateFromRow(row: Pick<FlowDocRow, 'ydoc' | 'legacy'>): Uint8Array | null {
  if (row.ydoc && row.ydoc.length > 0) return row.ydoc

  const graph = row.legacy
  if (!graph || (graph.nodes.length === 0 && graph.edges.length === 0 && Object.keys(graph.meta).length === 0)) return null

  const migrated = new Y.Doc()
  applyGraphToDoc(migrated, graph)
  const state = Y.encodeStateAsUpdate(migrated)
  migrated.destroy()
  return state
}

export interface StoreOptions {
  /**
   * 连派生投影（`graph` + 计数）一起写。平时不写：它要把整张图序列化成 JSON，和写 `ydoc` 同一个量级；散场时写一次就够。
   * 带上它时不走「状态向量没变就跳过」：内容没变但投影可能还是旧的。
   */
  projection?: boolean
}

export interface StoreStats {
  /** 真正写成功的次数 */
  completed: number
  /** 写失败的次数，进程启动以来累计 */
  failed: number
  /** 最近一次写成功的时刻 */
  lastOkAt: number | null
}

/** 「这张画布的落库状态变了」：只在翻转时叫一次 */
export type StoreStateListener = (documentName: string, ok: boolean) => void

/** 落库撞车时最多重来几次。进程内的并发已被写队列排开，撞车只发生在多副本恰好同时落同一张画布 */
const MAX_STORE_ATTEMPTS = 3
/** 合并库里那份时用的事务 origin。不是 `local`，不进任何人的撤销栈 */
const MERGE_ORIGIN = 'persistence'
/** 排空写队列的轮数上限：队列执行中还可能追加，但不能无限等 */
const DRAIN_ROUNDS = 10

/**
 * 把画布房间的 Yjs 状态落到 `Flow` 表。时机归 Hocuspocus（防抖）和 {@link CollabServer}，这里只管存什么、怎么存。
 *
 * **落库失败必须往外抛**：Hocuspocus 的两道数据保护都靠钩子抛错触发：`onStoreDocument` 抛错文档留在内存，`beforeUnloadDocument` 抛错跳过卸载。
 * 这里写 `catch` 吞掉，数据库抖一下内容就真丢了。没有任何东西会自动再试，所以失败进 {@link failedStores}，由定时器调 {@link retryFailed}。
 */
@Injectable()
export class FlowPersistence {
  /** 按房间串行化写库：同一张画布的两次读-合并-写并发跑，后写的会盖掉先写的 */
  private readonly queues = new Map<string, Promise<unknown>>()
  /** 上一次落库失败、还欠着的房间 → 那份文档 */
  private readonly failedStores = new Map<string, Y.Doc>()
  /** 上一次写进库的状态向量。多副本下别的实例写过之后本进程的就过期了，所以放共享层。只是缓存：读写失败最多多写一次库 */
  private readonly storedVersions: SharedMap<Uint8Array>
  private stateListener: StoreStateListener | null = null
  /**
   * 这些数在这里，也就是真正写库的地方数，**不照抄 mod-collab 的「开始 − 完成」**：
   * 实测两副本撞 redlock 时那个差值会把正常跳过记成失败，`/api/collab/health` 一直 503（docs/30 §5）。
   */
  private readonly stats: StoreStats = { completed: 0, failed: 0, lastOkAt: null }

  constructor(
    @Inject(FlowDocStore) private readonly docs: FlowDocStore,
    @Inject(Cluster) cluster: Cluster,
  ) {
    this.storedVersions = cluster.createMap('flow-state-vector', bytesCodec)
  }

  storeStats(): Readonly<StoreStats> {
    return { ...this.stats }
  }

  /** 现在有几张画布的写还排着队。持续不为 0 = 数据库跟不上 */
  pendingWriteCount(): number {
    return this.queues.size
  }

  /** 有几张画布欠着落库 */
  failedStoreCount(): number {
    return this.failedStores.size
  }

  /** 这个房间此刻欠着落库吗：新连接接进来时要补发一次通知 */
  isStoreFailing(documentName: string): boolean {
    return this.failedStores.has(documentName)
  }

  /** 落库状态的观察者（只有一个）。放成注册点：持久化不该知道上面坐着什么传输层 */
  onStoreStateChange(listener: StoreStateListener | null): void {
    this.stateListener = listener
  }

  private notify(documentName: string, ok: boolean): void {
    try {
      this.stateListener?.(documentName, ok)
    } catch (err) {
      // 观察者是旁观者，不是写入路径的一环
      console.warn(`[collab] ${documentName} 的落库状态通知失败`, err)
    }
  }

  /**
   * 排到某张画布的写队列后面。个人画布的 REST 写入和协同落库写的是同一行，共用这一条队。失败照实往外抛：
   * `previous.then(task, task)` 让前一个失败不堵后一个；清理那一步先 `.catch` 再 `.finally`，否则留下一个没人处理的 rejection。
   */
  enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(key, next)
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key)
      })
    return next
  }

  /** 第一个人进房时读状态。画布或所属项目已删 = null，房间就是空的 */
  async load(documentName: string): Promise<Uint8Array | null> {
    const flowId = flowIdOf(documentName)
    if (!flowId) return null
    const row = await this.docs.read(flowId, { liveProject: true, legacy: true })
    return row ? stateFromRow(row) : null
  }

  /** 把文档当前状态写回库。写失败往外抛，并先把房间记进欠账表 */
  async store(documentName: string, doc: Y.Doc, options: StoreOptions = {}): Promise<void> {
    const flowId = flowIdOf(documentName)
    if (!flowId) return
    // 共享层读不出来就当没存过，多写一次不丢东西（fail-open）
    if (!options.projection && (await this.sameAsStored(documentName, doc).catch(() => false))) return

    try {
      await this.enqueueWrite(documentName, () => this.write(documentName, flowId, doc, options))
    } catch (error) {
      this.stats.failed += 1
      const firstFailure = !this.failedStores.has(documentName)
      this.failedStores.set(documentName, doc)
      if (firstFailure) this.notify(documentName, false)
      throw error
    }
    this.stats.completed += 1
    this.stats.lastOkAt = Date.now()
    if (this.failedStores.delete(documentName)) this.notify(documentName, true)
  }

  /**
   * 读 → 合并 → CAS 写回。
   * - 不能只写不读：`encodeStateAsUpdate` 是整段覆盖，两个副本分叉后，后写的盖掉先写的。
   * - 只加 CAS 不够：CAS 只证明读到之后没人插队，证明不了手里的内容是库里内容的超集。
   * 合并是幂等的：单副本下读回来的是子集，`applyUpdate` 不产生新内容；真有分叉时才产生一次更新，那正该广播给本实例的客户端。
   */
  private async write(documentName: string, flowId: string, doc: Y.Doc, options: StoreOptions): Promise<void> {
    for (let attempt = 1; attempt <= MAX_STORE_ATTEMPTS; attempt += 1) {
      // legacy: false：要合并的是库里那份字节本身。liveProject: false：项目刚删时房间里那份照样写进去
      const row = await this.docs.read(flowId, { liveProject: false, legacy: false })
      // 画布已被删：没什么可写的，也不算失败
      if (!row) return

      // 必须在 encodeStateAsUpdate 之前，否则写回去的还是没合并过的那份
      if (row.ydoc) Y.applyUpdate(doc, row.ydoc, MERGE_ORIGIN)

      const written = await this.docs.compareAndWrite(flowId, row.revision, {
        ydoc: Y.encodeStateAsUpdate(doc),
        ...(options.projection ? { projection: readGraphFromDoc(doc) } : {}),
      })
      // 被抢先了（或画布刚被删）：重读重来。重放同一份内容是幂等的
      if (!written) continue

      // 写的是缓存，失败不等于落库失败：抛出去会让调用方重试同样的字节
      await this.rememberStoredVersion(documentName, doc).catch((err: unknown) => {
        console.warn(`[collab] ${documentName} 的状态向量没记住，下一轮会多写一次库`, err)
      })
      return
    }
    // 内容还在内存里，交给欠账重试
    throw new Error(`[collab] ${documentName} 连续 ${MAX_STORE_ATTEMPTS} 次落库都被抢先写入`)
  }

  private async sameAsStored(documentName: string, doc: Y.Doc): Promise<boolean> {
    const previous = await this.storedVersions.get(documentName)
    return previous !== undefined && sameBytes(Y.encodeStateVector(doc), previous)
  }

  /** 记下「库里现在是这个版本」。个人画布的 REST 通道写完也要记，否则之后开出房间时会用过期的向量误判「没变」 */
  async rememberStoredVersion(documentName: string, doc: Y.Doc): Promise<void> {
    await this.storedVersions.set(documentName, Y.encodeStateVector(doc))
  }

  /** 把欠账重试一遍，失败的留到下一轮，返回这一轮补上的房间。逐个串行：数据库正不舒服时别一口气砸过去 */
  async retryFailed(): Promise<string[]> {
    if (this.failedStores.size === 0) return []
    console.warn(`[collab] 重试 ${this.failedStores.size} 张画布的落库`)
    const recovered: string[] = []
    for (const [documentName, doc] of [...this.failedStores]) {
      await this.store(documentName, doc, { projection: true })
        .then(() => recovered.push(documentName))
        .catch(() => undefined)
    }
    return recovered
  }

  /**
   * 等写队列排空，退出前用。每轮先让出一拍再采样：触发方到真正入队隔着一段微任务链，同步读会在它入队之前看到空队列。
   * 这也是退出路径不能用 Hocuspocus `flushPendingStores()` 的原因。
   */
  async drain(): Promise<void> {
    for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      if (this.queues.size === 0) return
      await Promise.allSettled([...this.queues.values()])
    }
  }

  /** 房间散场后清掉状态向量：不清的话下一轮会误判「和上次一样」跳过第一次落库。纯缓存，别的副本开着同一个房间也没事 */
  async forget(documentName: string): Promise<void> {
    await this.storedVersions.delete(documentName).catch(() => undefined)
  }
}
