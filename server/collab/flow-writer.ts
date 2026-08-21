import * as Y from 'yjs'
import { prisma } from '../db.ts'
import { edgesMap, nodesMap, pruneDanglingEdges } from './flow-doc.ts'
import {
  deriveProjection,
  enqueueFlowWrite,
  rememberStoredVersion,
  roomOf,
  sameBytes,
  stateFromRow,
} from './persistence.ts'
import { COLLAB_LIMITS } from './quota.ts'

/**
 * 画布内容的**另一条**写入通道：一次 HTTP 请求送来一段 Yjs 增量（REQ-SOLO）。
 *
 * 个人画布没有房间、没有 WebSocket、没有第二个人，但**内容模型和项目画布一模一样** ——
 * 事实源都是 Y.Doc，库里都是 `Flow.ydoc` 字节。分叉只发生在传输这一层，
 * 所以这里做的事和协同那条路是同一套：合并 → 落库 → 派生投影，
 * 用的也是同一批部件（`persistence.ts` 的写队列、投影，`quota.ts` 的上限）。
 *
 * 和协同那条路的三点不同，都是「只有一个人」带来的：
 *
 * 1. **事实源在库里，不在内存**。协同侧的房间常驻一个 Y.Doc，落库是把它整个写回；
 *    这里每次请求现读现合并现写回 —— 没有房间可以常驻。
 * 2. **可以事前拒绝**。协同的配额只能事后记账（更新一旦应用并广播就收不回来了），
 *    这里超限的请求整个丢掉即可：还没写库、没广播给任何人，等于没发生过。
 * 3. **投影每次都写**。个人画布的推送在客户端已经被防抖收敛成「一串编辑一次」，
 *    多派生一次 JSON 不贵，换来列表页的计数和缩略图始终跟得上（见 docs/16 §4.3）。
 */

/** 本模块写进文档的事务 origin，纯标记 —— 这个 doc 是临时的，没有观察者 */
const REST_ORIGIN = 'rest'

/**
 * 写回时撞上别人先写了，最多重来几次。
 *
 * 正常情况一次就成：同一实例内的并发被写队列排开了，只有**多副本**下同一个人
 * 的两个标签页恰好落到两个实例、又恰好同时推送，才会撞上。
 */
const MAX_WRITE_ATTEMPTS = 3

export interface FlowUpdateAccepted {
  ok: true
  /**
   * 服务端合并之后的状态向量 —— 客户端把它存下来当作下次算增量的基线
   * （`Y.encodeStateAsUpdate(doc, 这个)`）。
   *
   * 协议以状态向量为准，而不是让客户端维护一条「待确认增量」队列：Yjs 的合并是
   * 幂等的，所以重发天然安全 —— 断网重连、请求超时都不用对账，按当前基线重算一次就行。
   */
  stateVector: Uint8Array
  revision: number
  /** 这次推送没带来任何新东西（重发、或只有本地视图动过），库没被碰 */
  noop: boolean
}

export interface FlowUpdateRejected {
  ok: false
  reason: 'not-found' | 'too-large'
  message: string
}

export type FlowUpdateResult = FlowUpdateAccepted | FlowUpdateRejected

/** 合并一段客户端推上来的 Yjs 增量，并落库 */
export async function applyFlowUpdate(
  flowId: string,
  update: Uint8Array,
): Promise<FlowUpdateResult> {
  if (update.byteLength > COLLAB_LIMITS.message) {
    return {
      ok: false,
      reason: 'too-large',
      message: `单次提交 ${update.byteLength} 字节，超过上限 ${COLLAB_LIMITS.message}`,
    }
  }

  /*
   * 和协同的落库排同一条队：写的是同一行、同一张审计表（seq 撞 `@@unique` 就是这么来的）。
   * 队列吞异常（那是给后台落库设计的），所以这里自己接住再往外抛 —— REST 调用方
   * 需要知道写失败了，不能把失败当成功回给客户端。
   */
  const room = roomOf(flowId)
  // 装在对象里：赋值发生在回调内，直接用 let 的话 TS 的控制流分析看不见，会把它收窄成 never
  const box: { outcome: { value: FlowUpdateResult } | { error: unknown } | null } = {
    outcome: null,
  }

  await enqueueFlowWrite(room, async () => {
    try {
      box.outcome = { value: await merge(flowId, room, update) }
    } catch (error) {
      box.outcome = { error }
    }
  })

  const outcome = box.outcome
  if (!outcome) throw new Error(`[flow-writer] ${flowId} 的写入没有产生结果`)
  if ('error' in outcome) throw outcome.error
  return outcome.value
}

/** 读当前状态 → 合并 → 写回，撞车就重来（见 {@link MAX_WRITE_ATTEMPTS}） */
async function merge(
  flowId: string,
  room: string,
  update: Uint8Array,
): Promise<FlowUpdateResult> {
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const row = await prisma.flow.findFirst({
      where: { id: flowId, deletedAt: null, project: { deletedAt: null } },
      select: { ydoc: true, graph: true, revision: true },
    })
    if (!row) return { ok: false, reason: 'not-found', message: '画布不存在' }

    const doc = new Y.Doc()
    try {
      const base = stateFromRow(row)
      if (base) Y.applyUpdate(doc, base, REST_ORIGIN)
      const before = Y.encodeStateVector(doc)

      Y.applyUpdate(doc, update, REST_ORIGIN)

      // 超限的整段丢掉。这里还没写库、没广播，所以拒绝是真的拒绝 ——
      // 协同那边做不到这一点，只能事后记账、下一条消息才生效
      const violation = overQuota(doc)
      if (violation) return { ok: false, reason: 'too-large', message: violation }

      /*
       * 悬空边照样要清：一个人开两个标签页，也能在这边删节点、那边往它连线。
       * 用 'gc' origin（`pruneDanglingEdges` 内部），清理不进任何人的撤销栈。
       */
      const pruned = pruneDanglingEdges(doc)
      const after = Y.encodeStateVector(doc)

      // 这条更新什么也没带来（重发、或客户端只动了视口）：不写库、不记审计。
      // 幂等就落在这里 —— 同一段 update 推一百次，也只有第一次留下痕迹
      if (pruned === 0 && sameBytes(before, after)) {
        return { ok: true, stateVector: after, revision: row.revision, noop: true }
      }

      const data: Record<string, unknown> = {
        ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)),
        revision: row.revision + 1,
        ...(deriveProjection(doc, room) ?? {}),
      }

      /*
       * 写回时把读到的 `revision` 带进 where —— 一次 CAS。
       *
       * 进程内的并发已经被写队列排开了，这道是给**多副本**准备的：两个实例各自
       * 「读-合并-写回」，后写的会把先写的整段盖掉。`revision` 本来就是单调的写计数，
       * 拿来当版本号正好，不用另加字段。
       *
       * 注意这**不是**给客户端的乐观锁：撞车了自己重读重来（CRDT 重放同一段更新是
       * 幂等的，合并两次结果一样），客户端永远看不到 409 —— 那套东西在协同上来之后
       * 就作废了，不要从这里把它复活。
       */
      const { count } = await prisma.flow.updateMany({
        where: { id: flowId, deletedAt: null, revision: row.revision },
        data,
      })

      if (count === 0) {
        // 要么被人抢先写了（重来），要么这张画布刚被删掉（重来时 findFirst 会返回 null）
        continue
      }

      await rememberStoredVersion(room, doc)

      return { ok: true, stateVector: after, revision: row.revision + 1, noop: false }
    } finally {
      doc.destroy()
    }
  }

  throw new Error(`[flow-writer] ${flowId} 连续 ${MAX_WRITE_ATTEMPTS} 次都被抢先写入`)
}

/**
 * 把客户端带来的 `?sv=` 解成状态向量；不是一个就返回 `null`。
 *
 * **必须真的解一次**（`Y.decodeStateVector`），不能只看 base64 解得出字节：
 * `Buffer.from(x, 'base64url')` 对任何输入都能凑出一段字节，垃圾会一路传到
 * lib0 的解码器里才炸成 `Integer out of Range` —— 那时已经是 500 了，
 * 而这明明是一个「参数不合法」的 400。
 */
export function decodeStateVectorParam(raw: string): Uint8Array | null {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(Buffer.from(raw, 'base64url'))
  } catch {
    return null
  }
  if (bytes.byteLength === 0) return null

  try {
    Y.decodeStateVector(bytes)
    return bytes
  } catch {
    return null
  }
}

/**
 * 读出这张画布的 Yjs 状态；带上客户端的状态向量就只给差量。
 *
 * **状态向量一起给**，而且给的是**服务端自己的**那份，不是「客户端合并之后会变成
 * 什么样」。客户端拿它当作下一次算差量的基线，所以它必须精确表示「服务端知道到哪儿了」——
 * 客户端要是拿合并后的本地状态当基线，那些**离线期间攒在本地的改动就再也推不出去了**
 * （差量会算成空）。这正是「断网接着画、恢复后自动补发」能成立的前提。
 *
 * @returns 画布不存在（或已软删）时为 `null`
 */
export async function readFlowUpdate(
  flowId: string,
  since?: Uint8Array,
): Promise<{ update: Uint8Array; stateVector: Uint8Array } | null> {
  const row = await prisma.flow.findFirst({
    where: { id: flowId, deletedAt: null, project: { deletedAt: null } },
    select: { ydoc: true, graph: true },
  })
  if (!row) return null

  const doc = new Y.Doc()
  try {
    const base = stateFromRow(row)
    if (base) Y.applyUpdate(doc, base, REST_ORIGIN)
    return {
      // 空画布也要给出一段合法的（空）更新，让客户端知道「同步完了，它本来就是空的」
      update: Y.encodeStateAsUpdate(doc, since),
      stateVector: Y.encodeStateVector(doc),
    }
  } finally {
    doc.destroy()
  }
}

/**
 * 合并之后的规模还在上限之内吗；超了返回原因。
 *
 * 用的是软限（`COLLAB_LIMITS`）本身，不是协同那边的软/硬两级：两级的存在是因为
 * 协同拦不住已经应用的更新，得留出「删回去」的余量。这里能事前拒，一级就够 ——
 * 而删除照样能通过，因为量的是**合并之后**的规模，删到线内就放行。
 */
function overQuota(doc: Y.Doc): string | null {
  const nodes = nodesMap(doc).size
  if (nodes > COLLAB_LIMITS.nodes) return `节点数 ${nodes} 超过上限 ${COLLAB_LIMITS.nodes}`

  const edges = edgesMap(doc).size
  if (edges > COLLAB_LIMITS.edges) return `连线数 ${edges} 超过上限 ${COLLAB_LIMITS.edges}`

  const bytes = Y.encodeStateAsUpdate(doc).byteLength
  if (bytes > COLLAB_LIMITS.document) {
    return `画布状态 ${bytes} 字节，超过上限 ${COLLAB_LIMITS.document}`
  }
  return null
}
