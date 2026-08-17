import * as Y from 'yjs'
import { sharedMap, stringCodec } from '../cluster/index.ts'
import { GRAPH_LIMITS } from '../store/flow-types.ts'
import { edgesMap, nodesMap } from './flow-doc.ts'

/**
 * 画布内容的配额。
 *
 * 换成 CRDT 之后，内容不再经过任何 REST 接口 —— 没有了 `parseGraph` 那道关，
 * 服务端一度对写进来的东西**零校验**：任何项目成员都能通过 WebSocket 塞进
 * 任意大小、任意条数的文档。这个模块把上限补回来。
 *
 * 上限从 `GRAPH_LIMITS` 派生，不另抄一份数字 —— 两套上限一旦漂移，
 * 「协同这边合法、投影那边超限」的文档会在列表 / 复制那条路上读成空图。
 *
 * **配额分两级，这不是装饰**：
 * - **软限**（= `GRAPH_LIMITS`）：超过只是标记 + 告警，写入照常。必须放行写入，
 *   否则谁也删不了东西，房间就永远卡在超限那一刻 —— 而删除正是唯一的自救路径。
 *   规模缩回软限以内，标记自动解除。
 * - **硬限**（软限 × {@link HARD_LIMIT_FACTOR}）：真正的天花板。到这儿房间被锁写
 *   （连接置 `readOnly`，Hocuspocus 会 NACK 后续写入但**不断连**），直到散场重开。
 *   软硬之间的余量就是留给「删回去」的操作空间。
 *
 * **只能事前挡，不能事后回滚**：Yjs 的更新一旦应用并广播出去就收不回来了，
 * 所以度量放在 `onChange`（事后记账），拦截靠 `beforeHandleMessage` 读
 * {@link quotaLocked} 的结果（下一条消息生效）。
 */

export const COLLAB_LIMITS = {
  /** 单条消息的字节上限。正常一次编辑只有几十到几百字节，1MB 已经离谱了 */
  message: 1024 * 1024,
  /** 文档状态的字节上限（Yjs 二进制，和投影 JSON 不是同一种度量，量级对齐即可） */
  document: GRAPH_LIMITS.bytes,
  /** 单画布节点上限 */
  nodes: GRAPH_LIMITS.nodes,
  /** 单画布连线上限 */
  edges: GRAPH_LIMITS.edges,
} as const

/** 硬限 = 软限 × 这个系数。到硬限房间锁写，所以软硬之间必须留出删除的余地 */
export const HARD_LIMIT_FACTOR = 1.25

/** 超过软限（可写、可自救）的房间：房间名 → 原因 */
const oversized = new Map<string, string>()

/** 顶到硬限（锁写，直到散场重开）的房间：房间名 → 原因 */
const locked = new Map<string, string>()

/**
 * 上面两张表在多副本下的共享副本。
 *
 * **本地那两个 Map 不能撤**：`quotaLocked()` 在 `beforeHandleMessage` 里被**同步**调用，
 * 每条消息一次 —— 那条路上加一次 Redis 往返是不能接受的。所以是「本地判定 + 共享传播」：
 * 判定结果顺手写进共享层（不等结果），复量那一拍顺手把别的实例的判定拉回来。
 *
 * 代价是标记有几秒的传播延迟，超限房间可能在别的实例上多接受一小段写入。
 * 这和配额本身的语义是一致的 —— 它本来就是「事后记账、下一条消息才生效」，
 * 而不是一道同步闸门（见文件头）。
 */
const sharedOversized = sharedMap<string>('quota-oversized', stringCodec)
const sharedLocked = sharedMap<string>('quota-locked', stringCodec)

/**
 * 共享标记的存活时间，每次复量续一次。
 *
 * 纯兜底：正常散场由 `forgetQuota` 清掉，这个 TTL 是为了防止某个实例崩在
 * 「已锁写」状态上，把一个早就恢复正常的房间永远钉死。
 */
const SHARED_MARK_TTL = 5 * 60_000

/**
 * 字节数要序列化整个文档才量得出来，不能每条消息都来一遍。
 * 两个触发条件任一满足就量：距上次量过去了一个间隔，或这期间收进来的
 * 更新字节数已经攒到 {@link BYTES_ACCUMULATE_TRIGGER} —— 后者堵住了
 * 「窗口内高频塞大消息、五秒里灌进几百 MB」这条路：超量最多超出一个触发阈值。
 */
const BYTES_CHECK_INTERVAL = 5000
/** 软限已超时把间隔缩短：不快点复量，删回去的动作就迟迟解不了标记 */
const BYTES_CHECK_INTERVAL_OVERSIZED = 1000
const BYTES_ACCUMULATE_TRIGGER = 128 * 1024
const lastBytesCheck = new Map<string, number>()
const bytesSinceCheck = new Map<string, number>()

/** 这个房间超过软限没有；返回原因，正常返回 null。超软限**不拒写** */
export function quotaViolation(documentName: string): string | null {
  return oversized.get(documentName) ?? null
}

/** 这个房间被锁写没有；返回原因，正常返回 null。锁到散场为止 */
export function quotaLocked(documentName: string): string | null {
  return locked.get(documentName) ?? null
}

/**
 * 每次改动后量一次规模，更新软限 / 硬限两级标记。
 *
 * 节点 / 连线数是 `Y.Map.size`，O(1)，每次都查（也因此软限标记能在删回去后立即解除）；
 * 字节数按上面的两个触发条件节流。
 *
 * @param updateBytes 这条更新本身多大 —— 攒给字节复量的触发器用
 * @returns 锁写原因；没锁返回 null
 */
export function checkQuota(documentName: string, doc: Y.Doc, updateBytes = 0): string | null {
  const alreadyLocked = locked.get(documentName)
  if (alreadyLocked) return alreadyLocked

  const nodes = nodesMap(doc).size
  const edges = edgesMap(doc).size

  if (nodes > COLLAB_LIMITS.nodes * HARD_LIMIT_FACTOR) {
    return lock(documentName, `节点数 ${nodes} 顶到硬限 ${COLLAB_LIMITS.nodes * HARD_LIMIT_FACTOR}`)
  }
  if (edges > COLLAB_LIMITS.edges * HARD_LIMIT_FACTOR) {
    return lock(documentName, `连线数 ${edges} 顶到硬限 ${COLLAB_LIMITS.edges * HARD_LIMIT_FACTOR}`)
  }

  let reason: string | null = null
  if (nodes > COLLAB_LIMITS.nodes) {
    reason = `节点数 ${nodes} 超过上限 ${COLLAB_LIMITS.nodes}`
  } else if (edges > COLLAB_LIMITS.edges) {
    reason = `连线数 ${edges} 超过上限 ${COLLAB_LIMITS.edges}`
  }

  const bytes = measureBytesThrottled(documentName, doc, updateBytes)
  if (bytes !== null) {
    if (bytes > COLLAB_LIMITS.document * HARD_LIMIT_FACTOR) {
      return lock(documentName, `文档 ${bytes} 字节，顶到硬限`)
    }
    if (reason === null && bytes > COLLAB_LIMITS.document) {
      reason = `文档 ${bytes} 字节，超过上限 ${COLLAB_LIMITS.document}`
    }
  } else if (reason === null && oversized.get(documentName)?.startsWith('文档')) {
    // 这轮没到量字节的时机 —— 字节引起的软限标记先留着，等下次量了再定
    reason = oversized.get(documentName) ?? null
  }

  if (reason) {
    if (oversized.get(documentName) !== reason) {
      oversized.set(documentName, reason)
      console.warn(`[collab] ${documentName} 超出配额（仍可写入，删回去即恢复）：${reason}`)
    }
    void sharedOversized.set(documentName, reason, SHARED_MARK_TTL).catch(() => undefined)
  } else if (oversized.delete(documentName)) {
    console.log(`[collab] ${documentName} 规模回到配额以内，标记解除`)
    void sharedOversized.delete(documentName).catch(() => undefined)
  }

  return null
}

/**
 * 把别的实例的判定拉回本地。
 *
 * 挂在复量那一拍上，不另起定时器 —— 复量的节奏（1～5 秒）正好也是标记该有的粒度。
 * **只补不删**：远端说「有」就补上，远端说「没有」不代表本地那条判错了
 * （可能是本地刚判出来还没写上去）。解除靠各实例自己每次 `checkQuota` 重算，
 * 节点/连线数是 O(1) 的 `Y.Map.size`，删回去当场就能解。
 *
 * Redis 抖动一律吞掉：配额是防滥用的护栏，不该因为缓存不可用就拦住正常编辑。
 */
function pullSharedMarks(documentName: string): void {
  void Promise.all([sharedOversized.get(documentName), sharedLocked.get(documentName)])
    .then(([remoteOversized, remoteLocked]) => {
      if (remoteLocked && !locked.has(documentName)) {
        locked.set(documentName, remoteLocked)
        console.warn(`[collab] ${documentName} 已被其它实例锁写：${remoteLocked}`)
      }
      if (remoteOversized && !oversized.has(documentName)) {
        oversized.set(documentName, remoteOversized)
      }
    })
    .catch(() => undefined)
}

/** 到时机就量一次文档字节数；没到返回 null（表示「这轮没量」） */
function measureBytesThrottled(documentName: string, doc: Y.Doc, updateBytes: number): number | null {
  const accumulated = (bytesSinceCheck.get(documentName) ?? 0) + updateBytes
  const interval = oversized.has(documentName)
    ? BYTES_CHECK_INTERVAL_OVERSIZED
    : BYTES_CHECK_INTERVAL
  const now = Date.now()
  const checked = lastBytesCheck.get(documentName) ?? 0

  if (now - checked < interval && accumulated < BYTES_ACCUMULATE_TRIGGER) {
    bytesSinceCheck.set(documentName, accumulated)
    return null
  }

  lastBytesCheck.set(documentName, now)
  bytesSinceCheck.set(documentName, 0)
  // 借这一拍把别的实例的判定同步过来，省一个定时器
  pullSharedMarks(documentName)
  return Y.encodeStateAsUpdate(doc).byteLength
}

function lock(documentName: string, reason: string): string {
  locked.set(documentName, reason)
  void sharedLocked.set(documentName, reason, SHARED_MARK_TTL).catch(() => undefined)
  console.warn(`[collab] ${documentName} 顶到硬限，房间锁写（散场重开后重新判）：${reason}`)
  return reason
}

/**
 * 房间散场时清掉记录，下次打开重新判。
 *
 * **只清本地，不碰共享层**：别的实例可能还开着这个房间，删掉共享标记等于替它撤销判定。
 * 共享标记自带 TTL，而且这类判定是**可重算的** —— 文档要真超限，下一次
 * `checkQuota`（节点/连线数是 O(1) 的 `Y.Map.size`）会当场重新判出来并重新写上去。
 * 所以标记过期没有后果，最坏是多接受一小段写入，这与配额「事后记账」的语义一致。
 */
export function forgetQuota(documentName: string): void {
  oversized.delete(documentName)
  locked.delete(documentName)
  lastBytesCheck.delete(documentName)
  bytesSinceCheck.delete(documentName)
}
