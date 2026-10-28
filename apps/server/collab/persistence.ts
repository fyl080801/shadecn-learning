import * as Y from 'yjs'
import { bytesCodec, sharedMap } from '../cluster/index.ts'
import { prisma } from '../db.ts'
import { GRAPH_LIMITS, readGraph } from '../store/flow-types.ts'
import { applyGraphToDoc, readGraphFromDoc } from './flow-doc.ts'

/**
 * 把画布房间的 Yjs 状态落到应用自己的库里（SQLite / PostgreSQL 都行）。
 *
 * **不用 y-leveldb**（连带 leveldown 这个原生模块，node 22 / arm64 没有预编译产物），
 * 也不用 `@hocuspocus/extension-database`（它只是 onLoadDocument / onStoreDocument
 * 的一层薄封装，我们直接实现这两个 hook 反而更直白）。
 *
 * 落库的**时机**已经不归我们管了 —— Hocuspocus 的 `onStoreDocument` 自带防抖，
 * 且在最后一个人离开、服务器 `destroy()` 时都会保证再存一次。
 * 我们只负责「存什么、怎么存」。
 */

/** 画布房间的前缀；别的房间（演示用）不落库 */
const FLOW_ROOM_PREFIX = 'flow:'

/** 房间名 → 画布 id；不是画布房间返回 null */
export function flowIdOf(documentName: string): string | null {
  return documentName.startsWith(FLOW_ROOM_PREFIX)
    ? documentName.slice(FLOW_ROOM_PREFIX.length)
    : null
}

export function roomOf(flowId: string): string {
  return `${FLOW_ROOM_PREFIX}${flowId}`
}

/**
 * 按房间串行化写库。
 *
 * 同一张画布的两次「读-合并-写回」并发跑，后写的会把先写的整段盖掉；
 * 排成一条队之后，进程内就只剩一个写者（跨副本那道是 `flow-writer.ts` 里的 CAS）。
 */
const queues = new Map<string, Promise<unknown>>()

/**
 * 排到某张画布的写队列后面。
 *
 * 个人画布的 REST 写入（`flow-writer.ts`）和协同的落库共用这一条队列 ——
 * 两者写的是同一行，各排各的队等于没排。
 */
export function enqueueFlowWrite(key: string, task: () => Promise<void>): Promise<void> {
  return enqueue(key, task)
}

/**
 * 现在有几张画布的写还排着队 —— 监控端点读它。
 *
 * 这个数正常情况下贴着 0：写是 2–10 秒防抖一次、几毫秒就完事。
 * **它持续不为 0 就是数据库跟不上了**，而那正是内容还只在内存里的时候。
 */
export function pendingWriteCount(): number {
  return queues.size
}

/**
 * 排队本身，**失败照实往外抛**。
 *
 * 这里曾经把异常吞成一句 `console.error` 然后返回一个已 resolve 的 promise，
 * 那是最贵的一个 bug：调用方（`storeFlowState`）于是永远「成功」，
 * Hocuspocus 认为存好了，紧接着就把文档卸载出内存 —— 而它自带的
 * *"Document stays in memory to avoid data loss"* 保护**恰恰是靠 hook 抛异常触发的**。
 * 我们把那道保护自己关掉了，代价是数据库抖一下就真丢内容（见 docs/19 §4.1）。
 *
 * 两个细节保证「抛」不会带来新问题：
 * - `previous.then(task, task)` —— 前一个任务失败，后一个照样跑，队列不会断在半路；
 * - 清理那一步先 `.catch()` 再 `.finally()` —— 直接对可能 rejected 的 promise 挂
 *   `finally` 会产生一个没人处理的 rejection，把整个进程的 `unhandledRejection` 打脏。
 */
function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  queues.set(key, next)
  void next
    .catch(() => undefined)
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key)
    })
  return next
}

/**
 * 读出这张画布的 Yjs 状态。
 *
 * `ydoc` 为空 = 还没被 Yjs 接管过（老数据）。这时**现场从 graph JSON 构建**一份 ——
 * 这就是迁移：不需要单独的迁移脚本，每张画布在第一次被打开时各自完成，
 * 没打开过的原样躺着。
 */
export async function loadFlowState(documentName: string): Promise<Uint8Array | null> {
  const flowId = flowIdOf(documentName)
  if (!flowId) return null

  const row = await prisma.flow.findFirst({
    where: { id: flowId, deletedAt: null, project: { deletedAt: null } },
    select: { ydoc: true, graph: true },
  })
  if (!row) return null

  return stateFromRow(row)
}

/**
 * 一行 `Flow` → 它的 Yjs 状态；内容为空返回 `null`。
 *
 * 单独拎出来是因为个人画布的 REST 写入（`flow-writer.ts`）也要走这一步，而它已经
 * 自己查过那一行了 —— 老数据的迁移规则只能有一份，不然两条通道打开同一张老画布
 * 会得到不一样的东西。
 */
export function stateFromRow(row: { ydoc: Uint8Array | null; graph: string }): Uint8Array | null {
  if (row.ydoc && row.ydoc.length > 0) return new Uint8Array(row.ydoc)

  const graph = readGraph(row.graph)
  if (graph.nodes.length === 0 && graph.edges.length === 0 && Object.keys(graph.meta).length === 0) {
    return null
  }

  const migrated = new Y.Doc()
  applyGraphToDoc(migrated, graph)
  const state = Y.encodeStateAsUpdate(migrated)
  migrated.destroy()
  return state
}

/**
 * 上一次写进库的状态向量，按房间存。
 *
 * 用来回答「自上次落库以来，文档到底变没变」—— 状态向量只有几十字节，
 * 比把整个文档序列化一遍再比对便宜得多。
 *
 * 多副本下必须共享：别的实例写过之后，本进程手里那份就过期了，
 * 拿它判「和上次一样」会把该写的一次跳掉。
 */
const storedVersions = sharedMap<Uint8Array>('flow-state-vector', bytesCodec)

async function sameAsStored(documentName: string, doc: Y.Doc): Promise<boolean> {
  const previous = await storedVersions.get(documentName)
  if (!previous) return false
  return sameBytes(Y.encodeStateVector(doc), previous)
}

/** 两段字节一不一样。状态向量的比较到处都要用，别各写各的 */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- 下标是循环变量，不是外部输入
    if (a[i] !== b[i]) return false
  }
  return true
}

export interface StoreOptions {
  /**
   * 连**派生投影**（`graph` JSON + 节点/边计数）也一起写。
   *
   * 平时不写：投影是给列表页和缩略图用的，没人会在别人编辑的同一秒去看列表，
   * 而它要把整张图序列化成 JSON —— 和写 `ydoc` 是同一个量级的开销，等于每次落库都花两份。
   * 散场时写一次就够，那时的内容才是这一轮编辑的最终态。
   */
  projection?: boolean
}

/**
 * 上一次落库失败、还欠着的房间：房间名 → 那份文档。
 *
 * **登记它是为了能重试**。异常抛给 Hocuspocus 之后文档会留在内存（这正是目的），
 * 但没有任何东西会主动再试一次：`onStoreDocument` 由防抖触发，
 * 而房间里已经没人编辑了；`beforeUnloadDocument` 抛异常之后 Hocuspocus 直接 `return`，
 * 也不会重来。于是内容就一直悬在内存里，直到进程退出 —— 那要是一次 SIGKILL 就全没了。
 *
 * 所以失败要留个痕，由 {@link retryFailedStores} 定期收拾。
 * 正常情况下这张表是空的，重试那一趟什么也不做。
 */
const failedStores = new Map<string, Y.Doc>()

/** 有几张画布欠着落库 —— 监控端点读它，`GET /api/collab/health` 里的 `owed` */
export function failedStoreCount(): number {
  return failedStores.size
}

/** 这个房间此刻欠着落库吗 —— 新连接接进来时要补发一次通知（见 `hocuspocus.ts`） */
export function isStoreFailing(documentName: string): boolean {
  return failedStores.has(documentName)
}

/**
 * 「这张画布的落库状态变了」。
 *
 * **只在状态翻转时叫一次**（好→坏、坏→好），不是每次落库都叫 ——
 * 正常情况下落库是 2–10 秒一次，逐次通知等于往房间里灌噪音。
 */
export type StoreStateListener = (documentName: string, ok: boolean) => void

let storeStateListener: StoreStateListener | null = null

/**
 * 注册落库状态的观察者。由 `hocuspocus.ts` 挂上，用来把「服务器现在存不进去」
 * 广播给房间里的人 —— 不然界面会一直写着「已同步」，而用户照着继续画。
 *
 * 放成一个注册点而不是让这里直接去拿 Hocuspocus 实例：持久化不该知道
 * 上面坐着什么传输层，它只负责说「状态变了」。
 */
export function onStoreStateChange(listener: StoreStateListener | null): void {
  storeStateListener = listener
}

/** 通知观察者。**绝不让它的异常影响落库** —— 那是个旁观者，不是写入路径的一环 */
function notifyStoreState(documentName: string, ok: boolean): void {
  try {
    storeStateListener?.(documentName, ok)
  } catch (err) {
    console.warn(`[collab] ${documentName} 的落库状态通知失败`, err)
  }
}

/**
 * 把还欠着的房间重试一遍。失败的留在表里，等下一轮。
 *
 * 由 `hocuspocus.ts` 的定时器调用。**逐个串行**：数据库正不舒服的时候，
 * 一口气并发把所有欠账砸过去只会让它更起不来。
 */
export async function retryFailedStores(): Promise<void> {
  if (failedStores.size === 0) return

  console.warn(`[collab] 重试 ${failedStores.size} 张画布的落库`)
  for (const [documentName, doc] of [...failedStores]) {
    // storeFlowState 自己会在成功时销账、失败时续上，这里只管挨个叫一遍
    await storeFlowState(documentName, doc, { projection: true }).catch(() => undefined)
  }
}

/**
 * 把文档当前状态写回库。
 *
 * 两处省法：
 * - 状态向量和上次一样 → 整个跳过（Hocuspocus 的防抖窗口里可能没有真正的内容变更，
 *   比如这一轮只有 awareness 在动）；
 * - 平时只写 `ydoc`，派生投影留到散场时（见 `StoreOptions.projection`）。
 *
 * **写失败会往外抛**，而且必须往外抛：`onStoreDocument` 抛异常 → Hocuspocus 保留文档在内存
 * （`storeDocumentHooks` 的 catch，"Document stays in memory to avoid data loss"）；
 * `beforeUnloadDocument` 抛异常 → `unloadDocument` 直接 `return`，文档既不 delete 也不 destroy。
 * 两条卸载路径都被堵住，内容才不会跟着一次数据库抖动消失（docs/19 §4.1）。
 * 抛之前先把房间记进 {@link failedStores}，好让 {@link retryFailedStores} 收拾。
 */
export async function storeFlowState(
  documentName: string,
  doc: Y.Doc,
  options: StoreOptions = {},
): Promise<void> {
  const flowId = flowIdOf(documentName)
  if (!flowId) return
  /*
   * 状态向量和上次一样 → 没有新内容要写。
   *
   * 读的是共享层（多副本下是 Redis），而它只是**缓存**：读不出来就当没存过、
   * 照写一次即可 —— 多写一次不会丢任何东西，而把这次异常放过去会让整轮落库停摆
   * （docs/19 §4.2 a）。
   */
  if (!options.projection && (await sameAsStored(documentName, doc).catch(() => false))) return

  try {
    await enqueue(documentName, storeTask(documentName, flowId, doc, options))
  } catch (error) {
    // 留个痕给重试；异常照抛，Hocuspocus 那两道保护就靠它
    const firstFailure = !failedStores.has(documentName)
    failedStores.set(documentName, doc)
    // 只在**翻转**的那一次通知：这张画布从「存得进去」变成了「存不进去」
    if (firstFailure) notifyStoreState(documentName, false)
    throw error
  }
  // 同理，只有从欠账里销掉的那一次才通知「恢复了」
  if (failedStores.delete(documentName)) notifyStoreState(documentName, true)
}

/**
 * 落库撞车时最多重来几次。
 *
 * 撞车只发生在**多副本**下（进程内的并发早被写队列排开了），而且是两个实例
 * 恰好在同一个防抖窗口里落同一张画布 —— 罕见，一次重试基本就成。
 */
const MAX_STORE_ATTEMPTS = 3

/** 合并库里那份时用的事务 origin。不是 `local`，所以不进任何人的撤销栈 */
const MERGE_ORIGIN = 'persistence'

/**
 * 读 → 合并 → CAS 写回。
 *
 * **为什么不能只写不读**（原来就是那样）：`Y.encodeStateAsUpdate(doc)` 是把内存里
 * 这一份**整个盖**进 `ydoc` 那一列。单副本下这没问题 —— 这个进程是唯一的写者，
 * 内存那份一定是库里那份的超集。多副本下就不成立了：Redis pub/sub 断一下，
 * 两个实例的文档就此分叉，各自把自己那份整段盖上去，后写的赢，先写的那些编辑没了。
 *
 * **为什么光加 CAS 也不够**：`where: { revision }` 保证的是「我读到之后没人插过队」，
 * 而不是「我手里的内容是库里内容的超集」。别的实例在我读 revision **之前**写完的话，
 * 我读到的是新 revision，CAS 会顺利通过，然后我照样用一份缺内容的文档盖上去。
 * 所以必须**把库里那份读回来合并进内存文档**，两件事一起做才成立：
 * 合并保证内容不丢，CAS 保证合并到写回这一段没人插队。
 *
 * 合并用 Yjs 自己的语义，所以是幂等的：单副本下读回来的是子集，`applyUpdate`
 * 不产生任何新内容、也就不触发 update 事件，零副作用；真有分叉时它才会产生一次更新，
 * 而那一次正该广播给本实例的客户端 —— 他们本来就缺着那部分内容。
 */
function storeTask(
  documentName: string,
  flowId: string,
  doc: Y.Doc,
  options: StoreOptions,
): () => Promise<void> {
  return async () => {
    for (let attempt = 1; attempt <= MAX_STORE_ATTEMPTS; attempt += 1) {
      const row = await prisma.flow.findFirst({
        where: { id: flowId, deletedAt: null },
        select: { ydoc: true, revision: true },
      })
      // 画布已经被删了：没什么可写的，也不算失败
      if (!row) return

      /*
       * 把库里那份合并进内存文档。**顺序要紧** —— 必须在 `encodeStateAsUpdate` 之前，
       * 否则写回去的还是没合并过的那份。
       */
      if (row.ydoc && row.ydoc.length > 0) {
        Y.applyUpdate(doc, new Uint8Array(row.ydoc), MERGE_ORIGIN)
      }

      const data: Record<string, unknown> = {
        ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)),
        // CAS 要求显式给出新值，不能再用 `increment`
        revision: row.revision + 1,
      }

      if (options.projection) Object.assign(data, deriveProjection(doc, documentName) ?? {})

      const { count } = await prisma.flow.updateMany({
        where: { id: flowId, deletedAt: null, revision: row.revision },
        data,
      })

      // 被别的实例抢先写了（或这张画布刚被删）—— 重读重来。
      // 重放同一份内容是幂等的，所以重试永远安全
      if (count === 0) continue

      /*
       * 记下「库里现在是这个版本」。这一步写的是**共享层缓存**，失败不影响
       * 上面那次真正的写入已经成功的事实 —— 抛出去会让调用方误判成落库失败，
       * 于是重试、于是又写一遍同样的字节。所以这里咽掉，最多下一轮多写一次。
       */
      await rememberStoredVersion(documentName, doc).catch((err: unknown) => {
        console.warn(`[collab] ${documentName} 的状态向量没记住，下一轮会多写一次库`, err)
      })
      return
    }

    // 连着几轮都被抢先：抛出去，交给欠账重试（内容还在内存里，一点没丢）
    throw new Error(`[collab] ${documentName} 连续 ${MAX_STORE_ATTEMPTS} 次落库都被抢先写入`)
  }
}

/** 写库时能直接铺进 `data` 的那几个派生字段 */
export interface FlowProjection {
  graph: string
  nodeCount: number
  edgeCount: number
}

/**
 * 从文档派生出 `graph` 投影 —— 列表页的计数、缩略图、将来的只读预览读它，编辑器不读。
 *
 * 超过 `readGraph` 那道字节关的投影**不写**（返回 `null`）：写了也会在读的那头降级成空图，
 * 反而把「detail 空图、复制出空画布」这种坑埋进去。留着上一份还能看。
 */
export function deriveProjection(doc: Y.Doc, label: string): FlowProjection | null {
  const graph = readGraphFromDoc(doc)
  const serialized = JSON.stringify(graph)
  const bytes = Buffer.byteLength(serialized)

  if (bytes > GRAPH_LIMITS.bytes) {
    console.warn(
      `[collab] ${label} 的投影 ${bytes} 字节超过 GRAPH_LIMITS.bytes，跳过本次投影写入`,
    )
    return null
  }

  return { graph: serialized, nodeCount: graph.nodes.length, edgeCount: graph.edges.length }
}

/**
 * 记下「库里现在是这个版本」。
 *
 * 个人画布那条 REST 通道写完也要记一笔：这张画布哪天被移进项目、开出房间来，
 * 第一次落库才不会拿一个过期的状态向量误判成「和上次一样」而整个跳过。
 *
 * **必须是 `async`**，哪怕函数体只有一句 return。共享层的懒代理是在**第一次调用时**
 * 才去解析实现的（`cluster/index.ts` 的 `LazyMap`），Redis 连不上时那一步会**同步抛出** ——
 * 普通函数里同步抛出的异常，调用方挂的 `.catch()` 根本接不到，会一路炸穿。
 * `async` 把同步抛也转成 rejection，`.catch()` 才拦得住。
 */
export async function rememberStoredVersion(documentName: string, doc: Y.Doc): Promise<void> {
  await storedVersions.set(documentName, Y.encodeStateVector(doc))
}

/**
 * 等所有房间的写库排空 —— 退出前用。
 *
 * 写是排队跑的，进程直接退会把最后一次落库截断。队列执行过程中还可能追加，
 * 所以循环等到真的空为止。
 *
 * 每轮先让出一拍再采样：触发方（Hocuspocus 的 store 链路）到真正 `enqueue` 之间
 * 隔着一段微任务链，同步读 `queues.size` 会在它入队**之前**看到空队列然后直接放行 ——
 * 这正是「SIGTERM 时丢掉最后一个防抖窗口」的形状。
 */
export async function flushCollabWrites(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    if (queues.size === 0) return
    await Promise.allSettled([...queues.values()])
  }
}

/**
 * 房间彻底散场后清掉缓存，下次开重新对齐。
 *
 * 清的是上次落库的状态向量 —— 不清的话，下一轮开房间时会误判
 * 「和上次一样」而跳过第一次落库。
 *
 * 多副本下这会清掉**共享**的那个键，而别的实例可能还开着同一个房间。
 * 那样也没问题，它是纯缓存：没了最多多写一次库，不会丢内容。
 */
export async function forgetFlow(documentName: string): Promise<void> {
  await storedVersions.delete(documentName)
}
