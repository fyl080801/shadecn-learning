import { EventEmitter } from 'node:events'
import type { AgentRunEntry, AgentStreamEvent } from '@shadecn/shared/agent'

/**
 * 运行中轮次的共享登记（docs/20 §3.10.10，F14）—— **服务端**接口，本包只认这个抽象，不认识 `apps/server/cluster`。
 * 和节点占用（`occupancy.ts` 的 `NodeLeaseRegistry`）同一个注入方式：宿主用共享层实现（单副本内存、多副本 redis），
 * 本包测试用 {@link createMemoryRunRegistry}；`createAgentRuntime` 的 `runRegistry` 必填。
 *
 * 四样东西，都是「这一轮在跑」的状态，都随持有副本的心跳（每 1/3 TTL）续期、崩溃后一个 TTL 内过期：
 *
 * 1. **任务登记** `<flowId>:<runId>` → {@link RunRecord}（任务列表那一项 + 持有副本）。任务列表 = 按画布前缀读全量。
 *    只有持有副本写这个键（runId 全局唯一），所以更新是覆盖写；结束时比较后删。
 * 2. **会话槽位** `<flowId>:<conversationId>` → {@link ConversationSlot}：一个会话同时一轮。占 = 不存在才写（原子），
 *    续期 / 释放都比较后做 —— 过期后被别的副本占走的槽位，旧持有者续不回来、也删不掉。
 * 3. **补发日志**（每轮一份，键 runId）：一条 {@link ReplayRecord} = runner 上报的一批事件映射之后的全部帧
 *    （按批合并，文字增量不逐帧写），带从 1 起连续的 `seq`。读的一方靠 `seq` 判断有没有漏（溢出后裁剪、写失败都会断号）。
 * 4. **停止指令**：发给持有副本（按登记里的 `instanceId`）的发布 / 订阅，只送达此刻在听的副本。
 */

/** 任务登记里的一条：任务列表那一项（`expiresAt` = 持有者最近一次续期 + TTL）+ 持有它的副本 */
export interface RunRecord extends AgentRunEntry {
  instanceId: string
}

/** 会话槽位的值：哪一轮、在哪个副本上 */
export interface ConversationSlot {
  runId: string
  instanceId: string
}

/** 补发日志的一条：一批帧。`overflow` = 从这一条起补发缓冲已超上限（新来的订阅者接不回完整序列） */
export interface ReplayRecord {
  seq: number
  events: AgentStreamEvent[]
  overflow?: true
}

/** 读出来的一条补发：`cursor` 只能原样交回（接着读的起点） */
export interface ReplayEntry {
  cursor: string
  record: ReplayRecord
}

/** 停止指令：停哪张画布上的哪一轮、原因（权限已在收到请求的副本上判过） */
export interface StopCommand {
  flowId: string
  runId: string
  reason: string
}

export interface RunRegistry {
  /** 登记、槽位、补发日志的 TTL（`AGENT_LEASE_TTL_MS`）；持有者每 1/3 TTL 续期 */
  readonly ttlMs: number
  /** 本副本的标识 */
  readonly instanceId: string

  // —— 任务登记 ——
  /** 写（覆盖）这一轮的登记并重设 TTL —— 进列表、占用变化、续期都走它 */
  putRun(flowId: string, record: RunRecord): Promise<void>
  /** 删登记：值仍是 `record`（按 JSON 比较）才删 */
  releaseRun(flowId: string, record: RunRecord): Promise<boolean>
  getRun(flowId: string, runId: string): Promise<RunRecord | null>
  /** 这张画布上此刻登记着的全部轮次（未排序） */
  listRuns(flowId: string): Promise<RunRecord[]>

  // —— 会话槽位 ——
  claimSlot(flowId: string, conversationId: string, slot: ConversationSlot): Promise<boolean>
  /** 续期：值仍是 `slot` 才重设 TTL；已过期 / 已易主返回 false */
  renewSlot(flowId: string, conversationId: string, slot: ConversationSlot): Promise<boolean>
  releaseSlot(flowId: string, conversationId: string, slot: ConversationSlot): Promise<boolean>
  getSlot(flowId: string, conversationId: string): Promise<ConversationSlot | null>
  /** 这张画布上此刻有一轮在跑的会话 id */
  busyConversations(flowId: string): Promise<Set<string>>

  // —— 补发日志 ——
  /** 追加一条并把整份日志的 TTL 重设为 {@link ttlMs}；`maxLen` = 只留最近这么多条 */
  appendReplay(runId: string, record: ReplayRecord, maxLen: number): Promise<void>
  /** `after` 之后（不含）的全部；`after` 为 null 从头 */
  readReplay(runId: string, after: string | null): Promise<ReplayEntry[]>
  /** 阻塞读：有新的立刻返回，否则等到有、或 `blockMs` 到点（空数组） */
  waitReplay(runId: string, after: string | null, blockMs: number): Promise<ReplayEntry[]>
  /** 续期整份日志（持有者心跳）；这一轮结束后不再续，一个 TTL 后自然删掉 */
  keepReplay(runId: string): Promise<void>

  // —— 停止指令 ——
  sendStop(instanceId: string, command: StopCommand): Promise<void>
  /** 听发给本副本（{@link instanceId}）的停止指令；返回退订函数 */
  onStop(handler: (command: StopCommand) => void): Promise<() => Promise<void>>
}

export const runRecordKey = (flowId: string, runId: string) => `${flowId}:${runId}`
export const slotKey = (flowId: string, conversationId: string) => `${flowId}:${conversationId}`

/** 登记的值形状不对（被别的版本写坏、手工改过）就当不存在 */
export function parseRunRecord(raw: string | undefined | null): RunRecord | null {
  if (raw === undefined || raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<RunRecord> | null
    if (!value || typeof value.runId !== 'string' || typeof value.conversationId !== 'string') return null
    if (typeof value.instanceId !== 'string' || typeof value.startedAt !== 'number') return null
    const owner = value.owner
    if (!owner || typeof owner.id !== 'string' || typeof owner.name !== 'string') return null
    return {
      runId: value.runId,
      conversationId: value.conversationId,
      conversationTitle: typeof value.conversationTitle === 'string' ? value.conversationTitle : '',
      owner: { id: owner.id, name: owner.name, avatarUrl: typeof owner.avatarUrl === 'string' ? owner.avatarUrl : null },
      startedAt: value.startedAt,
      ...(typeof value.nodeId === 'string' ? { nodeId: value.nodeId } : {}),
      occupies: Array.isArray(value.occupies) ? value.occupies.filter((id): id is string => typeof id === 'string') : [],
      ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}),
      instanceId: value.instanceId,
    }
  } catch {
    return null
  }
}

export function parseConversationSlot(raw: string | undefined | null): ConversationSlot | null {
  if (raw === undefined || raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<ConversationSlot> | null
    if (!value || typeof value.runId !== 'string' || typeof value.instanceId !== 'string') return null
    return { runId: value.runId, instanceId: value.instanceId }
  } catch {
    return null
  }
}

export function parseReplayRecord(raw: string): ReplayRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ReplayRecord> | null
    if (!value || typeof value.seq !== 'number' || !Array.isArray(value.events)) return null
    return { seq: value.seq, events: value.events, ...(value.overflow ? { overflow: true as const } : {}) }
  } catch {
    return null
  }
}

// —— 进程内存的实现（本包测试用）——

/**
 * 几个「副本」共用的内存后端：同一个 hub 上建的多个 {@link createMemoryRunRegistry}（各自的 `instanceId`）
 * 读写同一份登记 / 槽位 / 日志、听同一条停止总线 —— 本包测试拿它模拟多副本。
 */
export interface MemoryRunHub {
  readonly runs: Map<string, { raw: string; expiresAt: number }>
  readonly slots: Map<string, { raw: string; expiresAt: number }>
  readonly logs: Map<string, { entries: { id: number; raw: string }[]; expiresAt: number }>
  readonly bus: EventEmitter
  /** 等新补发条目的人（runId → 叫醒函数） */
  readonly waiters: Map<string, Set<() => void>>
  nextId: number
}

export function createMemoryRunHub(): MemoryRunHub {
  const bus = new EventEmitter()
  bus.setMaxListeners(0)
  return { runs: new Map(), slots: new Map(), logs: new Map(), bus, waiters: new Map(), nextId: 0 }
}

export interface MemoryRunRegistryOptions {
  ttlMs?: number
  instanceId?: string
  /** 测试注入的时钟 */
  now?: () => number
  /** 和别的「副本」共用的后端；不给就自己一份 */
  hub?: MemoryRunHub
}

/** 进程内存的实现：语义与宿主的共享层实现一致（按 JSON 比较、惰性过期、日志按 seq 连续） */
export function createMemoryRunRegistry(options: MemoryRunRegistryOptions = {}): RunRegistry & { readonly hub: MemoryRunHub } {
  const ttlMs = options.ttlMs ?? 30_000
  const instanceId = options.instanceId ?? 'local'
  const now = options.now ?? Date.now
  const hub = options.hub ?? createMemoryRunHub()

  const live = (table: Map<string, { raw: string; expiresAt: number }>, key: string) => {
    const entry = table.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now()) {
      table.delete(key)
      return null
    }
    return entry
  }
  const liveLog = (runId: string) => {
    const log = hub.logs.get(runId)
    if (!log) return null
    if (log.expiresAt <= now()) {
      hub.logs.delete(runId)
      return null
    }
    return log
  }
  const after = (runId: string, cursor: string | null): ReplayEntry[] => {
    const log = liveLog(runId)
    if (!log) return []
    const from = cursor === null ? -Infinity : Number(cursor)
    return log.entries.flatMap((entry) => {
      if (entry.id <= from) return []
      const record = parseReplayRecord(entry.raw)
      return record ? [{ cursor: String(entry.id), record }] : []
    })
  }

  return {
    ttlMs,
    instanceId,
    hub,
    async putRun(flowId, record) {
      hub.runs.set(runRecordKey(flowId, record.runId), { raw: JSON.stringify(record), expiresAt: now() + ttlMs })
    },
    async releaseRun(flowId, record) {
      const key = runRecordKey(flowId, record.runId)
      if (live(hub.runs, key)?.raw !== JSON.stringify(record)) return false
      hub.runs.delete(key)
      return true
    },
    async getRun(flowId, runId) {
      return parseRunRecord(live(hub.runs, runRecordKey(flowId, runId))?.raw)
    },
    async listRuns(flowId) {
      const prefix = `${flowId}:`
      const out: RunRecord[] = []
      for (const key of [...hub.runs.keys()]) {
        if (!key.startsWith(prefix)) continue
        const record = parseRunRecord(live(hub.runs, key)?.raw)
        if (record) out.push(record)
      }
      return out
    },
    async claimSlot(flowId, conversationId, slot) {
      const key = slotKey(flowId, conversationId)
      if (live(hub.slots, key)) return false
      hub.slots.set(key, { raw: JSON.stringify(slot), expiresAt: now() + ttlMs })
      return true
    },
    async renewSlot(flowId, conversationId, slot) {
      const key = slotKey(flowId, conversationId)
      const raw = JSON.stringify(slot)
      if (live(hub.slots, key)?.raw !== raw) return false
      hub.slots.set(key, { raw, expiresAt: now() + ttlMs })
      return true
    },
    async releaseSlot(flowId, conversationId, slot) {
      const key = slotKey(flowId, conversationId)
      if (live(hub.slots, key)?.raw !== JSON.stringify(slot)) return false
      hub.slots.delete(key)
      return true
    },
    async getSlot(flowId, conversationId) {
      return parseConversationSlot(live(hub.slots, slotKey(flowId, conversationId))?.raw)
    },
    async busyConversations(flowId) {
      const prefix = `${flowId}:`
      const out = new Set<string>()
      for (const key of [...hub.slots.keys()]) {
        if (key.startsWith(prefix) && live(hub.slots, key)) out.add(key.slice(prefix.length))
      }
      return out
    },
    async appendReplay(runId, record, maxLen) {
      let log = liveLog(runId)
      if (!log) {
        log = { entries: [], expiresAt: 0 }
        hub.logs.set(runId, log)
      }
      hub.nextId += 1
      log.entries.push({ id: hub.nextId, raw: JSON.stringify(record) })
      if (log.entries.length > maxLen) log.entries.splice(0, log.entries.length - maxLen)
      log.expiresAt = now() + ttlMs
      const waiting = hub.waiters.get(runId)
      hub.waiters.delete(runId)
      for (const wake of waiting ?? []) wake()
    },
    async readReplay(runId, cursor) {
      return after(runId, cursor)
    },
    waitReplay(runId, cursor, blockMs) {
      const ready = after(runId, cursor)
      if (ready.length > 0) return Promise.resolve(ready)
      return new Promise((resolve) => {
        const set = hub.waiters.get(runId) ?? new Set<() => void>()
        hub.waiters.set(runId, set)
        const wake = () => {
          clearTimeout(timer)
          set.delete(wake)
          resolve(after(runId, cursor))
        }
        const timer = setTimeout(() => {
          set.delete(wake)
          resolve([])
        }, Math.max(1, blockMs))
        set.add(wake)
      })
    },
    async keepReplay(runId) {
      const log = liveLog(runId)
      if (log) log.expiresAt = now() + ttlMs
    },
    async sendStop(target, command) {
      const raw = JSON.stringify(command)
      queueMicrotask(() => hub.bus.emit(`stop:${target}`, raw))
    },
    async onStop(handler) {
      const listener = (raw: string) => {
        try {
          handler(JSON.parse(raw) as StopCommand)
        } catch (err) {
          console.error('[agent] 处理停止指令出错', err)
        }
      }
      hub.bus.on(`stop:${instanceId}`, listener)
      return async () => {
        hub.bus.off(`stop:${instanceId}`, listener)
      }
    },
  }
}
