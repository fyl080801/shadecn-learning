import type { AgentUserView } from '@shadecn/shared/agent'

/**
 * 节点占用的登记表（docs/20 §3.10.8）—— **服务端**接口，本包只认这个抽象，不认识 `apps/server/cluster`。
 *
 * - 键 `<flowId>:<nodeId>`，值 {@link NodeLease}（哪一轮、哪个会话、谁、哪个副本、从什么时候），带 TTL；
 * - **占用** = {@link NodeLeaseRegistry.claim}（不存在才写，原子）；
 * - **续期 / 转交 / 释放都只在值仍是自己时生效**（比较后写 / 比较后删）：过期后被别人占走的键，
 *   旧持有者续不回来、也删不掉；
 * - 不进 Y.Doc、没有给模型的「释放」工具：持有者结束就释放，崩溃了靠 TTL 过期。
 *
 * 宿主（apps/server `agent/leases.ts`）用共享层的 `SharedMap` 实现（单副本内存、多副本 redis）；
 * 本包的测试用 {@link createMemoryLeaseRegistry}。`createAgentRuntime` 的 `leases` 是必填，理由同 `store`：
 * 忘了接就编译不过，而不是悄悄变成「谁都拦不住谁」。
 *
 * **比较的口径**是值的 JSON 序列化（和 `SharedMap` 的 codec 一致），所以持有者必须原样保存它写进去的那份值、
 * 续期 / 释放时原样交回 —— 换一个字段顺序相同但重新拼出来的对象也行，换了字段顺序就对不上了。
 */

export interface NodeLease {
  runId: string
  conversationId: string
  /** 发起人（「某某的助手」里的某某）；不带邮箱 */
  owner: AgentUserView
  /** 持有它的副本（多副本下谁在续期） */
  instanceId: string
  /** 占上的时刻，UTC epoch 毫秒 */
  since: number
}

export interface NodeLeaseRegistry {
  /** 条目的 TTL（毫秒，`AGENT_LEASE_TTL_MS`）；持有者每 1/3 TTL 续期一次 */
  readonly ttlMs: number
  /** 本副本的标识，写进 {@link NodeLease.instanceId} */
  readonly instanceId: string
  /** 占用：键不存在时写入并返回 true；已被占（不论是谁）返回 false、原样不动 */
  claim(flowId: string, nodeId: string, lease: NodeLease): Promise<boolean>
  /** 当前占用者；没有 / 已过期为 null */
  get(flowId: string, nodeId: string): Promise<NodeLease | null>
  /** 续期：值仍是 `lease` 时重设 TTL 并返回 true；已过期 / 已易主返回 false */
  renew(flowId: string, nodeId: string, lease: NodeLease): Promise<boolean>
  /**
   * 转交（父 run → 子 run，docs/20 §3.10.8「转交给子 run」）：值仍是 `from` 时原子地换成 `to` 并重设 TTL。
   * **预留**：子 agent 还没实现，现在没有调用方。
   */
  transfer(flowId: string, nodeId: string, from: NodeLease, to: NodeLease): Promise<boolean>
  /** 释放：只删自己的（值仍是 `lease` 才删）；返回删没删 */
  release(flowId: string, nodeId: string, lease: NodeLease): Promise<boolean>
  /** 这张画布上此刻的全部占用：节点 id → 占用者（读类工具标注、展示用） */
  list(flowId: string): Promise<Map<string, NodeLease>>
}

/** 登记表的键：节点 id 的字符集里没有 `:`（`[A-Za-z0-9_-]`），按画布前缀扫描不会串 */
export const leaseKey = (flowId: string, nodeId: string) => `${flowId}:${nodeId}`

export interface MemoryLeaseRegistryOptions {
  ttlMs?: number
  instanceId?: string
  /** 测试注入的时钟 */
  now?: () => number
}

/** 进程内存的实现：本包测试用；语义与宿主的 `SharedMap` 实现一致（按 JSON 比较、惰性过期） */
export function createMemoryLeaseRegistry(options: MemoryLeaseRegistryOptions = {}): NodeLeaseRegistry & {
  /** 测试用：直接看表里的原始条目 */
  readonly entries: Map<string, { raw: string; expiresAt: number }>
} {
  const ttlMs = options.ttlMs ?? 30_000
  const now = options.now ?? Date.now
  const entries = new Map<string, { raw: string; expiresAt: number }>()
  const live = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now()) {
      entries.delete(key)
      return null
    }
    return entry
  }
  const put = (key: string, lease: NodeLease) => entries.set(key, { raw: JSON.stringify(lease), expiresAt: now() + ttlMs })
  return {
    ttlMs,
    instanceId: options.instanceId ?? 'local',
    entries,
    async claim(flowId, nodeId, lease) {
      const key = leaseKey(flowId, nodeId)
      if (live(key)) return false
      put(key, lease)
      return true
    },
    async get(flowId, nodeId) {
      const entry = live(leaseKey(flowId, nodeId))
      return entry ? (JSON.parse(entry.raw) as NodeLease) : null
    },
    async renew(flowId, nodeId, lease) {
      const key = leaseKey(flowId, nodeId)
      if (live(key)?.raw !== JSON.stringify(lease)) return false
      put(key, lease)
      return true
    },
    async transfer(flowId, nodeId, from, to) {
      const key = leaseKey(flowId, nodeId)
      if (live(key)?.raw !== JSON.stringify(from)) return false
      put(key, to)
      return true
    },
    async release(flowId, nodeId, lease) {
      const key = leaseKey(flowId, nodeId)
      if (live(key)?.raw !== JSON.stringify(lease)) return false
      entries.delete(key)
      return true
    },
    async list(flowId) {
      const prefix = `${flowId}:`
      const out = new Map<string, NodeLease>()
      for (const key of [...entries.keys()]) {
        if (!key.startsWith(prefix)) continue
        const entry = live(key)
        if (entry) out.set(key.slice(prefix.length), JSON.parse(entry.raw) as NodeLease)
      }
      return out
    },
  }
}

// —— 哪些写算占用（docs/20 §3.10.8「只有改节点的 data 才算」）——

/**
 * 一次工具调用**执行之前**就知道会写哪些节点的 `data`（新建节点的 id 执行后才有，见 {@link createdNodeIds}）。
 * 这是策略，不在工具实现里：编排层（`session.ts`）包装网关工具时调它，和能力判权同一层。
 *
 * - `update_node` 给了 `data` / `removeData` → 那个节点；只改 `metadata` 不算；
 * - `delete_elements` → 点名的 id 里**是节点的**（连线不算；节点 vs 连线要看文档，由调用方 `isNode` 判）；
 * - 导演台技能（`director`）的写类工具 → `nodeId`（场景 `dc.*` 在 `data` 里）；
 * - 其余（连线、move / resize / group / ungroup / auto_layout、读类）→ 不算。
 *
 * `ungroup` 虽然删掉分组框，但按需求表不算（分组框没有业务数据，docs/20 §3.10.8 只列「删除节点」）。
 */
export function dataWriteTargets(
  call: { name: string; skillId: string | null; writes: boolean; args: unknown },
  isNode: (id: string) => boolean,
): string[] {
  const args = (call.args ?? {}) as Record<string, unknown>
  if (call.name === 'update_node') {
    const data = args.data
    const remove = args.removeData
    const touchesData =
      (typeof data === 'object' && data !== null && Object.keys(data).length > 0) || (Array.isArray(remove) && remove.length > 0)
    return touchesData && typeof args.id === 'string' ? [args.id] : []
  }
  if (call.name === 'delete_elements') {
    const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string') : []
    return [...new Set(ids)].filter(isNode)
  }
  if (call.skillId === 'director' && call.writes && typeof args.nodeId === 'string') return [args.nodeId]
  return []
}

/** 这次调用新建的节点（执行后才知道 id，执行后占用）：`add_node` / `duplicate_node` 的第一个 elementId 是新节点 */
export function createdNodeIds(name: string, elementIds: readonly string[]): string[] {
  if (name === 'add_node' || name === 'duplicate_node') return elementIds.slice(0, 1)
  return []
}
