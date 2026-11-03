import {
  parseConversationSlot,
  parseReplayRecord,
  parseRunRecord,
  runRecordKey,
  slotKey,
  type ConversationSlot,
  type ReplayEntry,
  type ReplayRecord,
  type RunRecord,
  type RunRegistry,
  type StopCommand,
} from '@learning/agent-core/run-registry'
import { Cluster, type LogEntry, type SharedChannel, type SharedLog, type SharedMap, stringCodec } from '@learning/cluster'
import { Inject, Injectable } from '@nestjs/common'
import { AGENT_OPTIONS, type AgentOptions } from './options.js'

function replayEntries(entries: LogEntry<string>[]): ReplayEntry[] {
  return entries.flatMap((entry) => {
    const record = parseReplayRecord(entry.value)
    return record ? [{ cursor: entry.id, record }] : []
  })
}

/**
 * 运行中轮次的共享登记（docs/20 §3.10.10）落在共享层：`single` 是进程内存，`redis` 是 Redis。
 *
 * | 东西 | 共享层 | 键 |
 * |---|---|---|
 * | 任务登记 | `SharedMap` `agent-run`（TTL） | `<flowId>:<runId>` → `RunRecord` |
 * | 会话槽位 | `SharedMap` `agent-conversation`（TTL，`claim` / `compareAndSet` / `deleteIfEquals`） | `<flowId>:<conversationId>` |
 * | 补发日志 | `SharedLog` `agent-replay` | runId |
 * | 停止指令 | `SharedChannel` `agent-stop` | 频道 = 持有副本的 `instanceId` |
 *
 * 值都用 `stringCodec` + 自己 `JSON.stringify`，理由同 `leases.ts`。TTL 全是 `agent.leaseTtlMs`，持有副本每 1/3 TTL 续期（编排层的心跳）。
 */
@Injectable()
export class AgentRuns implements RunRegistry {
  readonly ttlMs: number
  readonly instanceId: string
  private readonly runs: SharedMap<string>
  private readonly slots: SharedMap<string>
  private readonly replay: SharedLog<string>
  private readonly stops: SharedChannel<string>

  constructor(@Inject(Cluster) cluster: Cluster, @Inject(AGENT_OPTIONS) options: Pick<AgentOptions, 'leaseTtlMs'>) {
    this.ttlMs = options.leaseTtlMs
    this.instanceId = cluster.instanceId
    this.runs = cluster.createMap('agent-run', stringCodec)
    this.slots = cluster.createMap('agent-conversation', stringCodec)
    this.replay = cluster.createLog('agent-replay', stringCodec)
    this.stops = cluster.createChannel('agent-stop', stringCodec)
  }

  putRun(flowId: string, record: RunRecord): Promise<void> {
    return this.runs.set(runRecordKey(flowId, record.runId), JSON.stringify(record), this.ttlMs)
  }

  releaseRun(flowId: string, record: RunRecord): Promise<boolean> {
    return this.runs.deleteIfEquals(runRecordKey(flowId, record.runId), JSON.stringify(record))
  }

  async getRun(flowId: string, runId: string): Promise<RunRecord | null> {
    return parseRunRecord(await this.runs.get(runRecordKey(flowId, runId)))
  }

  async listRuns(flowId: string): Promise<RunRecord[]> {
    const out: RunRecord[] = []
    for (const [, raw] of await this.runs.entries(`${flowId}:`)) {
      const record = parseRunRecord(raw)
      if (record) out.push(record)
    }
    return out
  }

  claimSlot(flowId: string, conversationId: string, slot: ConversationSlot): Promise<boolean> {
    return this.slots.claim(slotKey(flowId, conversationId), JSON.stringify(slot), this.ttlMs)
  }

  renewSlot(flowId: string, conversationId: string, slot: ConversationSlot): Promise<boolean> {
    const raw = JSON.stringify(slot)
    return this.slots.compareAndSet(slotKey(flowId, conversationId), raw, raw, this.ttlMs)
  }

  releaseSlot(flowId: string, conversationId: string, slot: ConversationSlot): Promise<boolean> {
    return this.slots.deleteIfEquals(slotKey(flowId, conversationId), JSON.stringify(slot))
  }

  async getSlot(flowId: string, conversationId: string): Promise<ConversationSlot | null> {
    return parseConversationSlot(await this.slots.get(slotKey(flowId, conversationId)))
  }

  async busyConversations(flowId: string): Promise<Set<string>> {
    const prefix = `${flowId}:`
    return new Set((await this.slots.entries(prefix)).map(([key]) => key.slice(prefix.length)))
  }

  async appendReplay(runId: string, record: ReplayRecord, maxLen: number): Promise<void> {
    await this.replay.append(runId, JSON.stringify(record), { maxLen, ttlMs: this.ttlMs })
  }

  async readReplay(runId: string, after: string | null): Promise<ReplayEntry[]> {
    return replayEntries(await this.replay.read(runId, after))
  }

  async waitReplay(runId: string, after: string | null, blockMs: number): Promise<ReplayEntry[]> {
    return replayEntries(await this.replay.wait(runId, after, blockMs))
  }

  async keepReplay(runId: string): Promise<void> {
    await this.replay.expire(runId, this.ttlMs)
  }

  sendStop(target: string, command: StopCommand): Promise<void> {
    return this.stops.publish(target, JSON.stringify(command))
  }

  onStop(handler: (command: StopCommand) => void): Promise<() => Promise<void>> {
    return this.stops.subscribe(this.instanceId, (raw) => {
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
  }
}
