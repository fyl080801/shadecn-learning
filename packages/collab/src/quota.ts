import { Cluster, type SharedMap, stringCodec } from '@learning/cluster'
import { Inject, Injectable } from '@nestjs/common'
import * as Y from 'yjs'

export const COLLAB_LIMITS = {
  /** 单条消息的字节上限 */
  message: 1024 * 1024,
  /** 文档状态的字节上限（软限）。**必须 ≥ `GRAPH_LIMITS.bytes`**（2MB），不能反过来：两者之间是「内容合法、投影超限」的降级 */
  document: 20 * 1024 * 1024,
} as const

/** 硬限 = 软限 × 这个系数。到硬限房间锁写，所以软硬之间必须留出删除的余地 */
export const HARD_LIMIT_FACTOR = 1.25
/** 共享标记的存活时间，防止某个实例崩在「已锁写」上把房间永远钉死 */
const SHARED_MARK_TTL = 5 * 60_000
const BYTES_CHECK_INTERVAL = 5000
/** 软限已超时缩短复量间隔：不快点复量，删回去迟迟解不了标记 */
export const BYTES_CHECK_INTERVAL_OVERSIZED = 1000
/** 窗口内攒够这么多更新字节也复量：堵住「五秒里灌几百 MB」 */
const BYTES_ACCUMULATE_TRIGGER = 128 * 1024

/**
 * 画布内容的配额，只量字节。**只能事前挡，不能事后回滚**：更新一旦应用并广播就收不回来，所以度量放 `onChange`，拦截靠下一条消息读 {@link locked}。
 * - 软限：只标记和告警，写入照常。删除是唯一的自救路径，不能拦。
 * - 硬限：锁写，粘到散场重开。
 *
 * 本地 Map 不能撤：判定在每条消息上同步跑，不能加 Redis 往返。判定结果顺手写共享层（不等），复量那一拍把别的实例的拉回来（`docs/14`）。
 */
@Injectable()
export class CollabQuota {
  private readonly oversized = new Map<string, string>()
  private readonly lockedRooms = new Map<string, string>()
  private readonly lastBytesCheck = new Map<string, number>()
  private readonly bytesSinceCheck = new Map<string, number>()
  private readonly sharedOversized: SharedMap<string>
  private readonly sharedLocked: SharedMap<string>

  constructor(@Inject(Cluster) cluster: Cluster) {
    this.sharedOversized = cluster.createMap('quota-oversized', stringCodec)
    this.sharedLocked = cluster.createMap('quota-locked', stringCodec)
  }

  /** 超过软限没有；返回原因。超软限**不拒写** */
  violation(documentName: string): string | null {
    return this.oversized.get(documentName) ?? null
  }

  /** 被锁写没有；返回原因。锁到散场为止 */
  locked(documentName: string): string | null {
    return this.lockedRooms.get(documentName) ?? null
  }

  /**
   * 每次改动后量一次规模。字节要序列化整个文档才量得出来，所以节流：没到复量时机的轮次什么都不改。
   * @param updateBytes 这条更新多大，攒给复量的触发器
   * @returns 锁写原因；没锁返回 null
   */
  check(documentName: string, doc: Y.Doc, updateBytes = 0): string | null {
    const alreadyLocked = this.lockedRooms.get(documentName)
    if (alreadyLocked) return alreadyLocked

    const bytes = this.measureThrottled(documentName, doc, updateBytes)
    if (bytes === null) return null

    if (bytes > COLLAB_LIMITS.document * HARD_LIMIT_FACTOR) return this.lock(documentName, `文档 ${bytes} 字节，顶到硬限`)

    if (bytes > COLLAB_LIMITS.document) {
      const reason = `文档 ${bytes} 字节，超过上限 ${COLLAB_LIMITS.document}`
      if (!this.oversized.has(documentName)) console.warn(`[collab] ${documentName} 超出配额（仍可写入，删回去即恢复）：${reason}`)
      this.oversized.set(documentName, reason)
      void this.sharedOversized.set(documentName, reason, SHARED_MARK_TTL).catch(() => undefined)
    } else if (this.oversized.delete(documentName)) {
      console.log(`[collab] ${documentName} 规模回到配额以内，标记解除`)
      void this.sharedOversized.delete(documentName).catch(() => undefined)
    }
    return null
  }

  /** 把别的实例的判定拉回本地。只补不删：远端说「没有」不代表本地判错了。共享层抖动不影响编辑 */
  private pullSharedMarks(documentName: string): void {
    void Promise.all([this.sharedOversized.get(documentName), this.sharedLocked.get(documentName)])
      .then(([remoteOversized, remoteLocked]) => {
        if (remoteLocked && !this.lockedRooms.has(documentName)) {
          this.lockedRooms.set(documentName, remoteLocked)
          console.warn(`[collab] ${documentName} 已被其它实例锁写：${remoteLocked}`)
        }
        if (remoteOversized && !this.oversized.has(documentName)) this.oversized.set(documentName, remoteOversized)
      })
      .catch(() => undefined)
  }

  private measureThrottled(documentName: string, doc: Y.Doc, updateBytes: number): number | null {
    const accumulated = (this.bytesSinceCheck.get(documentName) ?? 0) + updateBytes
    const interval = this.oversized.has(documentName) ? BYTES_CHECK_INTERVAL_OVERSIZED : BYTES_CHECK_INTERVAL
    const now = Date.now()
    const checked = this.lastBytesCheck.get(documentName) ?? 0

    if (now - checked < interval && accumulated < BYTES_ACCUMULATE_TRIGGER) {
      this.bytesSinceCheck.set(documentName, accumulated)
      return null
    }

    this.lastBytesCheck.set(documentName, now)
    this.bytesSinceCheck.set(documentName, 0)
    this.pullSharedMarks(documentName)
    return Y.encodeStateAsUpdate(doc).byteLength
  }

  private lock(documentName: string, reason: string): string {
    this.lockedRooms.set(documentName, reason)
    void this.sharedLocked.set(documentName, reason, SHARED_MARK_TTL).catch(() => undefined)
    console.warn(`[collab] ${documentName} 顶到硬限，房间锁写（散场重开后重新判）：${reason}`)
    return reason
  }

  /** 房间散场：只清本地。别的实例可能还开着这个房间；共享标记有 TTL，判定也可重算 */
  forget(documentName: string): void {
    this.oversized.delete(documentName)
    this.lockedRooms.delete(documentName)
    this.lastBytesCheck.delete(documentName)
    this.bytesSinceCheck.delete(documentName)
  }
}
