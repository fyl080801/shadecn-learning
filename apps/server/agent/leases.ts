import { leaseKey, type NodeLease, type NodeLeaseRegistry } from '@shadecn/agent/occupancy'
import { sharedMap, stringCodec, type SharedMap } from '../cluster/index.ts'
import { agentConfig, instanceId } from '../config.ts'

/**
 * 节点占用的登记表（docs/20 §3.10.8）落在共享层：单副本是进程内存，多副本是 redis —— 和协同层的独占登记同一套 `SharedMap`。
 *
 * - 键 `<flowId>:<nodeId>`，值是 `NodeLease` 的 JSON，TTL = `AGENT_LEASE_TTL_MS`；
 * - **占用只经服务端写**（编排层 `session.ts` 包装网关工具时），前端、runner 都碰不到这张表；
 * - 续期 / 转交用 `compareAndSet`、释放用 `deleteIfEquals`：比较的是**编码后的字符串**，所以这里用 `stringCodec`
 *   并由自己 `JSON.stringify` —— 持有者交回的是它写进去的那份对象，序列化结果逐字相同。
 *   **释放只走 `deleteIfEquals`**，从不 `delete`：过期后被别人占走的键，旧持有者收尾时不能把它删掉。
 *
 * 表在模块顶层声明（共享层的惰性代理，`initCluster()` 之后才定后端）；测试可以 {@link createSharedLeaseRegistry} 自建一份。
 */

function parseLease(raw: string | undefined): NodeLease | null {
  if (raw === undefined) return null
  try {
    const value = JSON.parse(raw) as Partial<NodeLease> | null
    if (!value || typeof value.runId !== 'string' || typeof value.conversationId !== 'string') return null
    const owner = value.owner
    if (!owner || typeof owner.id !== 'string' || typeof owner.name !== 'string') return null
    return {
      runId: value.runId,
      conversationId: value.conversationId,
      owner: { id: owner.id, name: owner.name, avatarUrl: typeof owner.avatarUrl === 'string' ? owner.avatarUrl : null },
      instanceId: typeof value.instanceId === 'string' ? value.instanceId : '',
      since: typeof value.since === 'number' ? value.since : 0,
    }
  } catch {
    return null
  }
}

export function createSharedLeaseRegistry(
  table: SharedMap<string>,
  options: { ttlMs: number; instanceId: string },
): NodeLeaseRegistry {
  const { ttlMs } = options
  return {
    ttlMs,
    instanceId: options.instanceId,
    claim: (flowId, nodeId, lease) => table.claim(leaseKey(flowId, nodeId), JSON.stringify(lease), ttlMs),
    async get(flowId, nodeId) {
      return parseLease(await table.get(leaseKey(flowId, nodeId)))
    },
    renew: (flowId, nodeId, lease) => {
      const raw = JSON.stringify(lease)
      return table.compareAndSet(leaseKey(flowId, nodeId), raw, raw, ttlMs)
    },
    transfer: (flowId, nodeId, from, to) =>
      table.compareAndSet(leaseKey(flowId, nodeId), JSON.stringify(from), JSON.stringify(to), ttlMs),
    release: (flowId, nodeId, lease) => table.deleteIfEquals(leaseKey(flowId, nodeId), JSON.stringify(lease)),
    async list(flowId) {
      const prefix = `${flowId}:`
      const out = new Map<string, NodeLease>()
      for (const [key, raw] of await table.entries(prefix)) {
        const lease = parseLease(raw)
        if (lease) out.set(key.slice(prefix.length), lease)
      }
      return out
    },
  }
}

const table = sharedMap<string>('agent-node-lease', stringCodec)

/** 本服务的那一份：TTL 取 `AGENT_LEASE_TTL_MS`，副本标识取 `INSTANCE_ID` */
export const agentNodeLeases: NodeLeaseRegistry = createSharedLeaseRegistry(table, {
  ttlMs: agentConfig.leaseTtlMs,
  instanceId,
})
