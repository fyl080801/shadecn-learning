import { Cluster, defineRequest } from '@learning/cluster'
import type { FlowGraph } from '@learning/contracts/flow-graph'
import { DataAccess } from '@learning/data-access'
import { Inject, Injectable } from '@nestjs/common'
import { Flow } from './entities.js'
import { GRAPH_LIMITS, readGraph } from './flow-types.js'

/** 读到的一行画布内容 */
export interface FlowDocRow {
  /** `Flow.ydoc`：Yjs 状态，**事实源**。空 / 没有 = null */
  ydoc: Uint8Array | null
  /** 服务端的 CAS 计数 */
  revision: number
  /** `ydoc` 为空时库里那份 graph 解析出来的图（坏数据已退化成空图）。只在 `read(..., { legacy: true })` 且 `ydoc` 为空时给 */
  legacy: FlowGraph | null
}

export interface FlowDocReadOptions {
  /** 只认所属项目也没删的画布（进房、REST 读写）；落库只看画布本身没删（项目刚删时房间里那份照样写进去） */
  liveProject: boolean
  /** 要不要带上 graph（见 {@link FlowDocRow.legacy}）。落库不要：一张画布的投影可以有 2MB */
  legacy: boolean
}

export interface FlowDocWrite {
  /** 新的 Yjs 状态 */
  ydoc: Uint8Array
  /** 顺带写的派生投影（列表计数、缩略图读的 `graph`）。不给就只写 `ydoc`。超过 `GRAPH_LIMITS.bytes` 的跳过投影，只写内容 */
  projection?: FlowGraph
}

/**
 * 「把这张画布在内存里的内容立刻落一次库」：画布模块要**读库里的内容**再做事（复制画布）之前发，持有活内容的模块（协同）用 `cluster.bus.handle` 登记。
 * 回话的值没有含义，到了就说明「这个实例上的那份已经写进库了」。
 */
export const CANVAS_FLUSH_CONTENT = defineRequest<{ flowId: string }, null>('canvas.flush-content')

/** 等回话的上限：一次落库是读 → 合并 → CAS 写，正常几十毫秒；超时就按「没开着」读库 */
export const FLUSH_CONTENT_TIMEOUT_MS = 5_000

/**
 * `Flow` 表上协同要的那几步：协同模块不认识实体，经这里存取画布内容。
 * - CAS = `nativeUpdate(Flow, { id, revision: 读到的 }, { revision: 读到的 + 1, … })`，返回受影响行数；
 * - `nativeUpdate` 不触发 `onUpdate`，**`updatedAt` 自己写**，不然列表页按「最近修改」排序时编辑过的画布纹丝不动。
 */
@Injectable()
export class FlowDocStore {
  constructor(
    @Inject(DataAccess) private readonly dataAccess: DataAccess,
    @Inject(Cluster) private readonly cluster: Cluster,
  ) {}

  async read(flowId: string, options: FlowDocReadOptions): Promise<FlowDocRow | null> {
    const where = options.liveProject
      ? { id: flowId, deletedAt: null, project: { deletedAt: null } }
      : { id: flowId, deletedAt: null }
    // ydoc / graph 是 lazy 的：要什么显式列什么
    const row = await this.dataAccess.em().findOne(Flow, where, {
      fields: options.legacy ? ['ydoc', 'graph', 'revision'] : ['ydoc', 'revision'],
    })
    if (!row) return null

    const ydoc = row.ydoc && row.ydoc.length > 0 ? new Uint8Array(row.ydoc) : null
    return { ydoc, revision: row.revision, legacy: options.legacy && !ydoc ? readGraph(row.graph) : null }
  }

  /** 写入是一次 CAS：`where revision = expectedRevision`，返回是否真的写进去了（false = 被抢先 / 已删，调用方重读重来） */
  async compareAndWrite(flowId: string, expectedRevision: number, write: FlowDocWrite): Promise<boolean> {
    const count = await this.dataAccess.em().nativeUpdate(
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
  }

  /**
   * 凡是要**读库里的画布内容**再做事的接口（复制画布）先调它：内容的事实源是内存里的 Y.Doc，库里那份只在防抖窗口和散场时更新。
   *
   * 发给**所有**登记了的实例（房间可能同时开在好几个副本上），等它们回话或超时。**从不抛错**：没有内容持有者、某个实例超时或落库失败，
   * 都只记一笔然后照常往下走，调用方读到的最差是上一次落库的内容。
   */
  async flush(flowId: string): Promise<void> {
    try {
      const result = await this.cluster.bus.request(CANVAS_FLUSH_CONTENT, { flowId }, { timeoutMs: FLUSH_CONTENT_TIMEOUT_MS })
      if (result.missing.length > 0 || result.failures.length > 0) {
        const failures = result.failures.map((item) => `${item.instance}: ${item.error}`).join('; ')
        console.warn(`[canvas] 画布 ${flowId} 落库请求未全部完成（超时 ${result.missing.join(',') || '无'}；失败 ${failures || '无'}），按库里现有内容继续`)
      }
    } catch (err) {
      console.warn(`[canvas] 画布 ${flowId} 落库请求失败，按库里现有内容继续`, err)
    }
  }
}

/**
 * 投影的那几列。超过 `GRAPH_LIMITS.bytes` 的**不写**：写了在读的那头也会被 `parseGraph` 判超限、降级成空图，
 * 反而把「详情空图、复制出空画布」埋进去。留着上一份还能看（计数会旧，内容一个字节不受影响）。
 */
function projectionColumns(flowId: string, write: FlowDocWrite): { graph: string; nodeCount: number; edgeCount: number } | Record<string, never> {
  if (!write.projection) return {}
  const serialized = JSON.stringify(write.projection)
  const bytes = Buffer.byteLength(serialized)
  if (bytes > GRAPH_LIMITS.bytes) {
    console.warn(`[canvas] flow:${flowId} 的投影 ${bytes} 字节超过 GRAPH_LIMITS.bytes，跳过本次投影写入`)
    return {}
  }
  return { graph: serialized, nodeCount: write.projection.nodes.length, edgeCount: write.projection.edges.length }
}
