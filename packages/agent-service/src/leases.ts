import { leaseAgentOf, leaseKey, type NodeLease, type NodeLeaseRegistry } from '@learning/agent-core/occupancy'
import { Cluster, type SharedMap, stringCodec } from '@learning/cluster'
import { Inject, Injectable } from '@nestjs/common'
import { AGENT_OPTIONS, type AgentOptions } from './options.js'

function parseLease(raw: string | undefined): NodeLease | null {
  if (raw === undefined) return null
  try {
    const value = JSON.parse(raw) as Partial<NodeLease> | null
    if (!value || typeof value.runId !== 'string' || typeof value.conversationId !== 'string') return null
    const owner = value.owner
    if (!owner || typeof owner.id !== 'string' || typeof owner.name !== 'string') return null
    return {
      runId: value.runId,
      agentId: leaseAgentOf(value as Pick<NodeLease, 'agentId'>),
      conversationId: value.conversationId,
      owner: { id: owner.id, name: owner.name, avatarUrl: typeof owner.avatarUrl === 'string' ? owner.avatarUrl : null },
      instanceId: typeof value.instanceId === 'string' ? value.instanceId : '',
      since: typeof value.since === 'number' ? value.since : 0,
    }
  } catch {
    return null
  }
}

/**
 * 节点占用的登记表（docs/20 §3.10.8）落在共享层：`single` 是进程内存，`redis` 是 Redis。占用只经服务端写（编排层包装网关工具时）。
 *
 * - 键 `<flowId>:<nodeId>`，值是 `NodeLease` 的 JSON，TTL = `agent.leaseTtlMs`；
 * - 续期 / 转交只走 `compareAndSet`，释放只走 `deleteIfEquals`，**从不 `set` / `delete`**：过期后被别人占走的键，旧持有者不能盖掉也不能删掉。
 *   比较的是编码后的字符串，所以用 `stringCodec` 自己 `JSON.stringify`：持有者交回它写进去的那份对象，序列化结果逐字相同。
 */
@Injectable()
export class AgentLeases implements NodeLeaseRegistry {
  readonly ttlMs: number
  readonly instanceId: string
  private readonly table: SharedMap<string>

  constructor(@Inject(Cluster) cluster: Cluster, @Inject(AGENT_OPTIONS) options: Pick<AgentOptions, 'leaseTtlMs'>) {
    this.ttlMs = options.leaseTtlMs
    this.instanceId = cluster.instanceId
    this.table = cluster.createMap('agent-node-lease', stringCodec)
  }

  claim(flowId: string, nodeId: string, lease: NodeLease): Promise<boolean> {
    return this.table.claim(leaseKey(flowId, nodeId), JSON.stringify(lease), this.ttlMs)
  }

  async get(flowId: string, nodeId: string): Promise<NodeLease | null> {
    return parseLease(await this.table.get(leaseKey(flowId, nodeId)))
  }

  renew(flowId: string, nodeId: string, lease: NodeLease): Promise<boolean> {
    const raw = JSON.stringify(lease)
    return this.table.compareAndSet(leaseKey(flowId, nodeId), raw, raw, this.ttlMs)
  }

  transfer(flowId: string, nodeId: string, from: NodeLease, to: NodeLease): Promise<boolean> {
    return this.table.compareAndSet(leaseKey(flowId, nodeId), JSON.stringify(from), JSON.stringify(to), this.ttlMs)
  }

  release(flowId: string, nodeId: string, lease: NodeLease): Promise<boolean> {
    return this.table.deleteIfEquals(leaseKey(flowId, nodeId), JSON.stringify(lease))
  }

  async list(flowId: string): Promise<Map<string, NodeLease>> {
    const prefix = `${flowId}:`
    const out = new Map<string, NodeLease>()
    for (const [key, raw] of await this.table.entries(prefix)) {
      const lease = parseLease(raw)
      if (lease) out.set(key.slice(prefix.length), lease)
    }
    return out
  }
}
