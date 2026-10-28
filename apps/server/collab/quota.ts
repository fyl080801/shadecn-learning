import * as Y from 'yjs'
import { sharedMap, stringCodec } from '../cluster/index.ts'

/**
 * 画布内容的配额。
 *
 * 换成 CRDT 之后，内容不再经过任何 REST 接口 —— 没有了 `parseGraph` 那道关，
 * 服务端一度对写进来的东西**零校验**：任何项目成员都能通过 WebSocket 塞进
 * 任意大小的文档。这个模块把上限补回来。
 *
 * **量的只有字节数，没有节点 / 连线条数** —— 那两个上限是刻意去掉的，理由写在
 * `GRAPH_LIMITS` 的注释里（一句话：它们是产品判断而不是护栏，而资源那一面字节数已经管住了）。
 *
 * 字节这条留着，因为它挡的是一件**自伤**的事：只要房间里有人在编辑，`storeFlowState`
 * 每 2 秒（持续编辑最长 10 秒）就把**整份文档全量**写一次库。文档涨到几百 MB，就等于
 * 每 2 秒往库里灌几百 MB，一个项目成员就能触发，而除了这道关没有第二道拦它。
 *
 * **配额分两级，这不是装饰**：
 * - **软限**（{@link COLLAB_LIMITS}.document）：超过只是标记 + 告警，写入照常。必须放行写入，
 *   否则谁也删不了东西，房间就永远卡在超限那一刻 —— 而删除正是唯一的自救路径。
 *   规模缩回软限以内，标记在**下一次复量**时解除（字节数是节流量的，见
 *   {@link BYTES_CHECK_INTERVAL_OVERSIZED}；条数那条是 O(1) 所以曾经能当场解，现在没有了）。
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
  /**
   * 文档状态的字节上限（Yjs 二进制）。
   *
   * **必须 ≥ `GRAPH_LIMITS.bytes`**，而且这里就是**故意大一个量级**：投影那个数管的是
   * 会出现在 HTTP 响应里的 JSON，这个数管的是只在 WebSocket 上走的内容。两者之间那段
   * （内容合法、投影超限）是已经处理好的降级 —— 投影跳过本次写入、留上一份，内容不受影响。
   * 详见 `GRAPH_LIMITS` 的注释。
   *
   * 20MB 的由来：它要大到正常画布（哪怕节点里粘了整篇文档）永远够不着，
   * 又要小到「每 2 秒全量写一次库」还是笔划算的开销。
   */
  document: 20 * 1024 * 1024,
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
/**
 * 软限已超时把间隔缩短：不快点复量，删回去的动作就迟迟解不了标记。
 *
 * 导出只是为了让测试别把这个数再抄一遍 —— 「删回去多久才解标记」现在**只能**
 * 由它决定（条数那道 O(1) 的关去掉之后，没有别的东西能当场翻案）。
 */
export const BYTES_CHECK_INTERVAL_OVERSIZED = 1000
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
 * 量的只有字节数，而它要序列化整个文档，所以按下面两个触发条件节流 ——
 * **没到复量时机的那些轮次什么都不改**，维持上一次的判定。这是条数那道关去掉之后
 * 的直接后果：`Y.Map.size` 是 O(1)、每次都能查，字节数不是。代价是删回去之后
 * 标记要等下一次复量（超限时是 {@link BYTES_CHECK_INTERVAL_OVERSIZED}）才解除。
 *
 * @param updateBytes 这条更新本身多大 —— 攒给字节复量的触发器用
 * @returns 锁写原因；没锁返回 null
 */
export function checkQuota(documentName: string, doc: Y.Doc, updateBytes = 0): string | null {
  const alreadyLocked = locked.get(documentName)
  if (alreadyLocked) return alreadyLocked

  const bytes = measureBytesThrottled(documentName, doc, updateBytes)
  // 这轮没到复量的时机：不新判，也不动上一次的标记
  if (bytes === null) return null

  if (bytes > COLLAB_LIMITS.document * HARD_LIMIT_FACTOR) {
    return lock(documentName, `文档 ${bytes} 字节，顶到硬限`)
  }

  if (bytes > COLLAB_LIMITS.document) {
    const reason = `文档 ${bytes} 字节，超过上限 ${COLLAB_LIMITS.document}`
    // 只在**进入**超限状态时告警：字节数每次复量都不一样，比对原因字符串等于每秒刷一条
    if (!oversized.has(documentName)) {
      console.warn(`[collab] ${documentName} 超出配额（仍可写入，删回去即恢复）：${reason}`)
    }
    oversized.set(documentName, reason)
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
 * （可能是本地刚判出来还没写上去）。解除靠各实例自己复量时重算 —— 删回线内之后，
 * 最迟一个复量周期（超限期间是 {@link BYTES_CHECK_INTERVAL_OVERSIZED}）标记就没了。
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
 * 共享标记自带 TTL，而且这类判定是**可重算的** —— 文档要真超限，重开之后第一次
 * `checkQuota` 就会复量（`lastBytesCheck` 一起清了，所以那一次必量）并重新写上去。
 * 所以标记过期没有后果，最坏是多接受一小段写入，这与配额「事后记账」的语义一致。
 */
export function forgetQuota(documentName: string): void {
  oversized.delete(documentName)
  locked.delete(documentName)
  lastBytesCheck.delete(documentName)
  bytesSinceCheck.delete(documentName)
}
