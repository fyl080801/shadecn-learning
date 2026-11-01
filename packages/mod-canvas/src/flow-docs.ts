import type { FlowDocRow, FlowDocStore, FlowDocWrite } from './contract.ts'
import { db } from '@shadecn/server-kit/db'
import { Flow } from './entities.ts'
import { GRAPH_LIMITS, readGraph } from './flow-types.ts'

/**
 * 「画布内容存取」（`./contract.ts` 的 `FlowDocStore`）的实现，经 `canvas` 服务交给协同 ——
 * 协同包不认识 MikroORM，`Flow` 表上它要的几步都在这里。
 *
 * 两条规矩（`.claude/rules/database.md`）在这里守着：
 * - CAS = `nativeUpdate(Flow, { id, revision: 读到的 }, { revision: 读到的 + 1, … })`，返回受影响行数；
 * - `nativeUpdate` 不触发 `onUpdate`，**`updatedAt` 自己写**，不然列表页按「最近修改」排序时编辑过的画布纹丝不动。
 */
export const flowDocs: FlowDocStore = {
  async read(flowId, options): Promise<FlowDocRow | null> {
    const where = options.liveProject
      ? { id: flowId, deletedAt: null, project: { deletedAt: null } }
      : { id: flowId, deletedAt: null }
    // ydoc / graph 是 lazy 的：要什么显式列什么。graph 只在要迁移老数据时才读（一张画布的投影可以有 2MB）
    const row = await db().findOne(Flow, where, {
      fields: options.legacy ? ['ydoc', 'graph', 'revision'] : ['ydoc', 'revision'],
    })
    if (!row) return null

    const ydoc = row.ydoc && row.ydoc.length > 0 ? new Uint8Array(row.ydoc) : null
    return {
      ydoc,
      revision: row.revision,
      // 老数据（还没被 Yjs 接管过）：graph JSON 解析成图，坏数据退化成空图（readGraph 不抛）
      legacy: options.legacy && !ydoc ? readGraph(row.graph) : null,
    }
  },

  async compareAndWrite(flowId, expectedRevision, write) {
    const count = await db().nativeUpdate(
      Flow,
      { id: flowId, deletedAt: null, revision: expectedRevision },
      {
        ydoc: Buffer.from(write.ydoc),
        revision: expectedRevision + 1,
        updatedAt: new Date(),
        ...projectionColumns(flowId, write),
      },
    )
    return count > 0
  },
}

/**
 * 投影的那几列。超过 `GRAPH_LIMITS.bytes` 的**不写**：写了在读的那头也会被 `parseGraph` 判超限、降级成空图，
 * 反而把「detail 空图、复制出空画布」埋进去。留着上一份还能看（计数会旧，内容一个字节不受影响）。
 */
function projectionColumns(
  flowId: string,
  write: FlowDocWrite,
): { graph: string; nodeCount: number; edgeCount: number } | Record<string, never> {
  if (!write.projection) return {}
  const serialized = JSON.stringify(write.projection)
  const bytes = Buffer.byteLength(serialized)
  if (bytes > GRAPH_LIMITS.bytes) {
    console.warn(`[collab] flow:${flowId} 的投影 ${bytes} 字节超过 GRAPH_LIMITS.bytes，跳过本次投影写入`)
    return {}
  }
  return {
    graph: serialized,
    nodeCount: write.projection.nodes.length,
    edgeCount: write.projection.edges.length,
  }
}
