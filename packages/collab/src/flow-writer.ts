import { FlowDocStore } from '@learning/canvas'
import { Inject, Injectable } from '@nestjs/common'
import * as Y from 'yjs'
import { pruneDanglingEdges, readGraphFromDoc } from './flow-doc.js'
import { FlowPersistence, roomOf, sameBytes, stateFromRow } from './flow-persistence.js'
import { COLLAB_LIMITS } from './quota.js'

/** 本模块写进文档的事务 origin。这个 doc 是临时的，没有观察者 */
const REST_ORIGIN = 'rest'
/** 写回时撞上别人先写了，最多重来几次 */
const MAX_WRITE_ATTEMPTS = 3

export interface FlowUpdateAccepted {
  ok: true
  /** 服务端合并之后的状态向量，客户端拿它当下次算增量的基线。重发天然幂等，不用对账 */
  stateVector: Uint8Array
  revision: number
  /** 这次推送没带来新东西（重发），库没被碰 */
  noop: boolean
}

export interface FlowUpdateRejected {
  ok: false
  reason: 'not-found' | 'too-large'
  message: string
}

export type FlowUpdateResult = FlowUpdateAccepted | FlowUpdateRejected

/** 把 `?sv=` 解成状态向量。必须真的解一次：`Buffer.from` 对任何输入都能凑出字节，垃圾传到 lib0 才炸就是 500 了 */
export function decodeStateVectorParam(raw: string): Uint8Array | null {
  const bytes = new Uint8Array(Buffer.from(raw, 'base64url'))
  if (bytes.byteLength === 0) return null
  try {
    Y.decodeStateVector(bytes)
    return bytes
  } catch {
    return null
  }
}

/**
 * 画布内容的另一条写入通道：一次 HTTP 请求送来一段 Yjs 增量（docs/16）。事实源在库里，每次现读现合并现写回，
 * 写的和协同落库是同一行，所以排同一条队。和协同的不同：还没写库、没广播，超限的可以事前整段拒掉；投影每次都写。
 */
@Injectable()
export class FlowWriter {
  constructor(
    @Inject(FlowDocStore) private readonly docs: FlowDocStore,
    @Inject(FlowPersistence) private readonly persistence: FlowPersistence,
  ) {}

  async apply(flowId: string, update: Uint8Array): Promise<FlowUpdateResult> {
    if (update.byteLength > COLLAB_LIMITS.message) {
      return { ok: false, reason: 'too-large', message: `单次提交 ${update.byteLength} 字节，超过上限 ${COLLAB_LIMITS.message}` }
    }
    const room = roomOf(flowId)
    return this.persistence.enqueueWrite(room, () => this.merge(flowId, room, update))
  }

  private async merge(flowId: string, room: string, update: Uint8Array): Promise<FlowUpdateResult> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const row = await this.docs.read(flowId, { liveProject: true, legacy: true })
      if (!row) return { ok: false, reason: 'not-found', message: '画布不存在' }

      const doc = new Y.Doc()
      try {
        const base = stateFromRow(row)
        if (base) Y.applyUpdate(doc, base, REST_ORIGIN)
        const before = Y.encodeStateVector(doc)

        Y.applyUpdate(doc, update, REST_ORIGIN)

        // 量的是合并之后的规模：删到线内就放行。能事前拒，所以不用协同那边的软硬两级
        const bytes = Y.encodeStateAsUpdate(doc).byteLength
        if (bytes > COLLAB_LIMITS.document) {
          return { ok: false, reason: 'too-large', message: `画布状态 ${bytes} 字节，超过上限 ${COLLAB_LIMITS.document}` }
        }

        const pruned = pruneDanglingEdges(doc)
        const after = Y.encodeStateVector(doc)
        // 幂等就落在这里：同一段推一百次，只有第一次留痕
        if (pruned === 0 && sameBytes(before, after)) return { ok: true, stateVector: after, revision: row.revision, noop: true }

        const written = await this.docs.compareAndWrite(flowId, row.revision, { ydoc: Y.encodeStateAsUpdate(doc), projection: readGraphFromDoc(doc) })
        // 被抢先（重来）或画布刚被删（重读时返回 null）。这不是给客户端的乐观锁，客户端看不到冲突
        if (!written) continue

        await this.persistence.rememberStoredVersion(room, doc).catch((err: unknown) => {
          console.warn(`[collab] ${room} 的状态向量没记住，下一轮会多写一次库`, err)
        })
        return { ok: true, stateVector: after, revision: row.revision + 1, noop: false }
      } finally {
        doc.destroy()
      }
    }
    // 必须抛：返回 ok 客户端会把基线往前推，那段内容就再也补不回来了
    throw new Error(`[collab] ${flowId} 连续 ${MAX_WRITE_ATTEMPTS} 次都被抢先写入`)
  }

  /**
   * 读出这张画布的 Yjs 状态；带上客户端的状态向量就只给差量。状态向量给的是服务端自己的那份：
   * 客户端要是拿合并后的本地状态当基线，离线攒的改动就再也推不出去了。画布不存在或已软删 = null。
   */
  async read(flowId: string, since?: Uint8Array): Promise<{ update: Uint8Array; stateVector: Uint8Array } | null> {
    const row = await this.docs.read(flowId, { liveProject: true, legacy: true })
    if (!row) return null

    const doc = new Y.Doc()
    try {
      const base = stateFromRow(row)
      if (base) Y.applyUpdate(doc, base, REST_ORIGIN)
      return { update: Y.encodeStateAsUpdate(doc, since), stateVector: Y.encodeStateVector(doc) }
    } finally {
      doc.destroy()
    }
  }
}
