import * as Y from 'yjs'
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
 * 审计日志的 seq 是「查最大值 +1」，并发跑会撞 `@@unique([flowId, seq])`；
 * 全量写和审计写也得排在同一条队上，不然「散场落库」可能先于最后一条审计完成。
 */
const queues = new Map<string, Promise<unknown>>()

function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(task, task).catch((err: unknown) => {
    console.error(`[collab] 写库失败 (${key})`, err)
  })
  queues.set(key, next)
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key)
  })
  return next
}

/** flowId -> 下一个 seq。进程内缓存，避免每条审计都查一次最大值 */
const nextSeq = new Map<string, number>()

async function takeSeq(flowId: string): Promise<number> {
  const cached = nextSeq.get(flowId)
  if (cached !== undefined) {
    nextSeq.set(flowId, cached + 1)
    return cached
  }

  const last = await prisma.flowOperation.findFirst({
    where: { flowId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  const seq = (last?.seq ?? 0) + 1
  nextSeq.set(flowId, seq + 1)
  return seq
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
 */
const storedVersions = new Map<string, Uint8Array>()

function sameAsStored(documentName: string, doc: Y.Doc): boolean {
  const previous = storedVersions.get(documentName)
  if (!previous) return false
  const current = Y.encodeStateVector(doc)
  if (current.length !== previous.length) return false
  for (let i = 0; i < current.length; i += 1) {
    if (current[i] !== previous[i]) return false
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
 * 把文档当前状态写回库。
 *
 * 两处省法：
 * - 状态向量和上次一样 → 整个跳过（Hocuspocus 的防抖窗口里可能没有真正的内容变更，
 *   比如这一轮只有 awareness 在动）；
 * - 平时只写 `ydoc`，派生投影留到散场时（见 `StoreOptions.projection`）。
 */
export async function storeFlowState(
  documentName: string,
  doc: Y.Doc,
  options: StoreOptions = {},
): Promise<void> {
  const flowId = flowIdOf(documentName)
  if (!flowId) return
  if (!options.projection && sameAsStored(documentName, doc)) return

  await enqueue(documentName, async () => {
    const update = Y.encodeStateAsUpdate(doc)

    const data: Record<string, unknown> = {
      ydoc: Buffer.from(update),
      revision: { increment: 1 },
    }

    if (options.projection) {
      // 派生投影：列表页的计数、缩略图、将来的只读预览读它，编辑器不读
      const graph = readGraphFromDoc(doc)
      const serialized = JSON.stringify(graph)
      // 超过 readGraph 那道字节关的投影不写：写了也会在读的那头降级成空图，
      // 反而把「detail 空图、复制出空画布」这种坑埋进去。留着上一份还能看
      if (Buffer.byteLength(serialized) > GRAPH_LIMITS.bytes) {
        console.warn(
          `[collab] ${documentName} 的投影 ${Buffer.byteLength(serialized)} 字节超过 GRAPH_LIMITS.bytes，跳过本次投影写入`,
        )
      } else {
        data.graph = serialized
        data.nodeCount = graph.nodes.length
        data.edgeCount = graph.edges.length
      }
    }

    await prisma.flow.updateMany({
      where: { id: flowId, deletedAt: null },
      data,
    })
    storedVersions.set(documentName, Y.encodeStateVector(doc))
  })
}

/** 追加一条审计：这次改了什么（Yjs 增量）、是谁改的 */
export function recordUpdate(
  documentName: string,
  update: Uint8Array,
  actorId: string | null,
): void {
  const flowId = flowIdOf(documentName)
  if (!flowId) return

  // 存 update 的副本：Yjs 给的这块 buffer 之后可能被复用
  const bytes = Buffer.from(update)
  void enqueue(documentName, async () => {
    await prisma.flowOperation.create({
      data: {
        flowId,
        seq: await takeSeq(flowId),
        update: bytes,
        actorId,
        serverTs: BigInt(Date.now()),
      },
    })
  })
}

/**
 * 等所有房间的写库排空 —— 退出前用。
 *
 * 写是排队跑的，进程直接退会把最后一次落库和审计截断。队列执行过程中还可能追加
 * （落库和审计各是一次入队），所以循环等到真的空为止。
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
 * 房间彻底散场后清掉进程内的缓存，下次开重新对齐。
 *
 * 两样都要清：审计的 seq，以及上次落库的状态向量 —— 后者不清的话，
 * 下一轮开房间时会误判「和上次一样」而跳过第一次落库。
 */
export function forgetFlow(documentName: string): void {
  const flowId = flowIdOf(documentName)
  if (flowId) nextSeq.delete(flowId)
  storedVersions.delete(documentName)
}
