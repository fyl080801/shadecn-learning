import {
  parseConversationSlot,
  parseReplayRecord,
  parseRunRecord,
  runRecordKey,
  slotKey,
  type ReplayEntry,
  type RunRecord,
  type RunRegistry,
  type StopCommand,
} from '@shadecn/agent/run-registry'
import {
  sharedChannel,
  sharedLog,
  sharedMap,
  stringCodec,
  type LogEntry,
  type SharedChannel,
  type SharedLog,
  type SharedMap,
} from '../cluster/index.ts'
import { agentConfig, instanceId } from '../config.ts'

/**
 * 运行中轮次的共享登记（docs/20 §3.10.10，F14）落在共享层：单副本是进程内存，多副本是 redis。
 *
 * | 东西 | 共享层 | 键 |
 * |---|---|---|
 * | 任务登记 | `SharedMap` `agent-run`（TTL） | `<flowId>:<runId>` → `RunRecord` |
 * | 会话槽位 | `SharedMap` `agent-conversation`（TTL，`claim` / `compareAndSet` / `deleteIfEquals`） | `<flowId>:<conversationId>` |
 * | 补发日志 | `SharedLog` `agent-replay`（redis stream，`MAXLEN` + 整份 TTL） | runId |
 * | 停止指令 | `SharedChannel` `agent-stop`（redis pub/sub） | 频道 = 持有副本的 `INSTANCE_ID` |
 *
 * 值都用 `stringCodec` + 自己 `JSON.stringify`：比较后删 / 比较后写比的是编码后的字符串，
 * 持有者交回它写进去的那份对象，序列化结果逐字相同（同 `leases.ts`）。
 * TTL 全是 `AGENT_LEASE_TTL_MS`，持有副本每 1/3 TTL 续期（编排层的心跳）。
 *
 * 表在模块顶层声明（共享层的惰性代理，`initCluster()` 之后才定后端）；测试可以 {@link createSharedRunRegistry} 自建一份。
 */

export interface RunRegistryTables {
  runs: SharedMap<string>
  slots: SharedMap<string>
  replay: SharedLog<string>
  stops: SharedChannel<string>
}

function replayEntries(entries: LogEntry<string>[]): ReplayEntry[] {
  return entries.flatMap((entry) => {
    const record = parseReplayRecord(entry.value)
    return record ? [{ cursor: entry.id, record }] : []
  })
}

export function createSharedRunRegistry(
  tables: RunRegistryTables,
  options: { ttlMs: number; instanceId: string },
): RunRegistry {
  const { ttlMs } = options
  return {
    ttlMs,
    instanceId: options.instanceId,

    putRun: (flowId, record) => tables.runs.set(runRecordKey(flowId, record.runId), JSON.stringify(record), ttlMs),
    releaseRun: (flowId, record) => tables.runs.deleteIfEquals(runRecordKey(flowId, record.runId), JSON.stringify(record)),
    async getRun(flowId, runId) {
      return parseRunRecord(await tables.runs.get(runRecordKey(flowId, runId)))
    },
    async listRuns(flowId) {
      const out: RunRecord[] = []
      for (const [, raw] of await tables.runs.entries(`${flowId}:`)) {
        const record = parseRunRecord(raw)
        if (record) out.push(record)
      }
      return out
    },

    claimSlot: (flowId, conversationId, slot) => tables.slots.claim(slotKey(flowId, conversationId), JSON.stringify(slot), ttlMs),
    renewSlot: (flowId, conversationId, slot) => {
      const raw = JSON.stringify(slot)
      return tables.slots.compareAndSet(slotKey(flowId, conversationId), raw, raw, ttlMs)
    },
    releaseSlot: (flowId, conversationId, slot) =>
      tables.slots.deleteIfEquals(slotKey(flowId, conversationId), JSON.stringify(slot)),
    async getSlot(flowId, conversationId) {
      return parseConversationSlot(await tables.slots.get(slotKey(flowId, conversationId)))
    },
    async busyConversations(flowId) {
      const prefix = `${flowId}:`
      return new Set((await tables.slots.entries(prefix)).map(([key]) => key.slice(prefix.length)))
    },

    async appendReplay(runId, record, maxLen) {
      await tables.replay.append(runId, JSON.stringify(record), { maxLen, ttlMs })
    },
    async readReplay(runId, after) {
      return replayEntries(await tables.replay.read(runId, after))
    },
    async waitReplay(runId, after, blockMs) {
      return replayEntries(await tables.replay.wait(runId, after, blockMs))
    },
    async keepReplay(runId) {
      await tables.replay.expire(runId, ttlMs)
    },

    sendStop: (target, command) => tables.stops.publish(target, JSON.stringify(command)),
    onStop(handler) {
      return tables.stops.subscribe(options.instanceId, (raw) => {
        let command: StopCommand
        try {
          command = JSON.parse(raw) as StopCommand
        } catch {
          console.warn('[agent] 收到格式不对的停止指令，丢弃')
          return
        }
        if (typeof command?.flowId !== 'string' || typeof command.runId !== 'string' || typeof command.reason !== 'string') return
        handler(command)
      })
    },
  }
}

/** 本服务的那一份：TTL 取 `AGENT_LEASE_TTL_MS`，副本标识取 `INSTANCE_ID` */
export const agentRunRegistry: RunRegistry = createSharedRunRegistry(
  {
    runs: sharedMap<string>('agent-run', stringCodec),
    slots: sharedMap<string>('agent-conversation', stringCodec),
    replay: sharedLog<string>('agent-replay', stringCodec),
    stops: sharedChannel<string>('agent-stop', stringCodec),
  },
  { ttlMs: agentConfig.leaseTtlMs, instanceId },
)
