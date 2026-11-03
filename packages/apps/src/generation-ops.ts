import { fromYEdge, fromYNode } from '@learning/contracts/flow-doc'
import type { FlowNodeRecord } from '@learning/contracts/flow-graph'
import { collectionKey } from '@learning/contracts/flow-collection'
import { NODE_FORM_KEY, NODE_GENERATION_PREFIX, nodeFormOf, ORIGINAL_GENERATION_ID, portsOf, readGenerations, type NodeForm } from '@learning/contracts/flow-node-types'
import { FlowOpError, nodeMapOf, writeNodeFields, type FlowOpContext } from '@learning/contracts/flow-ops-core'
import * as Y from 'yjs'

/**
 * 写回节点的三个原子操作（`recordGeneration` → `attachAsset`、`appendGeneratedText`）和它们要的读函数，**从 `packages/shared/src/flow-ops.ts` 逐字摘出来**。
 *
 * 不复制整个 `flow-ops.ts`：它的闭包还有 `agent.ts`、`director-*.ts`、`flow-layout.ts`（带 `@dagrejs/dagre`），约 6000 行，这一步一行都用不上。
 * 第 8 步 agent 要整份 `flow-ops` 时，把它按 `@learning/contracts` 的规则整文件复制进去，这个文件就删掉。
 * 下面每个函数的文本由 `test/generation-ops.test.ts` 和原文逐字比较：文档形状对不上时节点会静默写坏，所以不放宽。**要改先改 `packages/shared`，再摘过来。**
 */

export function readNodeRecord(ctx: FlowOpContext, id: string): FlowNodeRecord | null {
  const map = nodeMapOf(ctx, id)
  return map ? fromYNode(id, map) : null
}

function requireNodeRecord(ctx: FlowOpContext, id: string, what = '节点'): FlowNodeRecord {
  const record = readNodeRecord(ctx, id)
  if (!record) throw new FlowOpError('NODE_NOT_FOUND', `${what} ${id} 不存在`)
  return record
}

export function hasIncomingEdges(ctx: FlowOpContext, nodeId: string): boolean {
  for (const [id, value] of ctx.edges.entries()) {
    if (!(value instanceof Y.Map) || value.get('target') !== nodeId) continue
    const edge = fromYEdge(id, value)
    if (edge && readNodeRecord(ctx, edge.source)) return true
  }
  return false
}

export function attachAsset(
  ctx: FlowOpContext,
  nodeId: string,
  asset: { src: string; poster?: string },
): NodeForm {
  const node = requireNodeRecord(ctx, nodeId)
  if (nodeFormOf(node.type, node.data) === null) {
    throw new FlowOpError('NO_FORMS', `${node.type} 节点不能挂素材`)
  }
  const form: NodeForm = hasIncomingEdges(ctx, nodeId) ? 'generate' : 'asset'
  writeNodeFields(ctx, nodeId, 'data', {
    set: {
      src: asset.src,
      ...(asset.poster !== undefined ? { poster: asset.poster } : {}),
      [NODE_FORM_KEY]: form,
    },
  })
  return form
}

export function recordGeneration(
  ctx: FlowOpContext,
  nodeId: string,
  generation: { id: string; src: string; poster?: string; createdAt: number },
): NodeForm {
  if (!generation.id) throw new FlowOpError('INVALID_GENERATION', '生成记录缺少 id')
  const before = requireNodeRecord(ctx, nodeId).data
  const previousSrc = typeof before.src === 'string' ? before.src.trim() : ''
  const seed: Record<string, unknown> = {}
  if (previousSrc && previousSrc !== generation.src && readGenerations(before).length === 0) {
    const previousPoster = typeof before.poster === 'string' ? before.poster.trim() : ''
    seed[collectionKey(NODE_GENERATION_PREFIX, ORIGINAL_GENERATION_ID)] = {
      src: previousSrc,
      ...(previousPoster ? { poster: previousPoster } : {}),
      createdAt: generation.createdAt - 1,
    }
  }
  const form = attachAsset(ctx, nodeId, generation)
  const entry = {
    src: generation.src,
    ...(generation.poster ? { poster: generation.poster } : {}),
    createdAt: generation.createdAt,
  }
  writeNodeFields(ctx, nodeId, 'data', {
    set: { ...seed, [collectionKey(NODE_GENERATION_PREFIX, generation.id)]: entry },
  })
  return form
}

export function appendGeneratedText(ctx: FlowOpContext, nodeId: string, text: string): boolean {
  const node = requireNodeRecord(ctx, nodeId)
  if (portsOf(node.type, 'outputs')[0]?.dataType !== 'text') return false
  const generated = text.trim()
  if (!generated) return false
  const current = typeof node.data.text === 'string' ? node.data.text.trimEnd() : ''
  writeNodeFields(ctx, nodeId, 'data', { set: { text: current.trim() ? `${current}\n\n${generated}` : generated } })
  return true
}
